import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionBinding, captureProcessExecutionCheckoutIdentity, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { ManagedProcessMessage, managedRequest } from "../../../src/lib/managed-process-protocol.js";
import { ProcessExecutionCanonicalAcknowledgement, executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { DEFAULT_REGISTERED_CHILD_GRACE_MS } from "../../../src/lib/agent-timeout.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("runtime-archive-");
  const owned = [];
  t.after(async () => {
    try { for (const runtime of owned) if (!runtime.closed) await runtime.close(); }
    catch (error) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw error; }
    removeTmpDir(root);
  });
  const options = { mainRoot: root, executionRoot: root, runId: "archive-run", specId: "archive-spec" };
  const acquire = async (extra = {}) => { const runtime = await ProcessExecutionRuntime.acquire({ ...options, ...extra }); owned.push(runtime); return runtime; };
  const key = crypto.createHash("sha256").update(JSON.stringify(root)).digest("hex");
  const directory = path.join(root, ".sennel", "process-runtime", key);
  return { root, options, acquire, directory };
}

test("closed runtime executions leave bounded active metadata and archived receipts survive a fresh coordinator", async (t) => {
  const { root, acquire, directory } = fixture(t);
  const protectedFile = path.join(root, "protected-state.json"); fs.writeFileSync(protectedFile, '{"budget":0,"attempt":1}');
  const expected = fs.readFileSync(protectedFile);
  const callBinding = new ProcessExecutionBinding({ runId: "archive-run", specId: "archive-spec", attemptId: "exact-attempt" });
  let firstReceipt;
  for (let index = 0; index < 3; index++) {
    const published = [];
    const runtime = await acquire({ binding: { runId: "archive-run", specId: "archive-spec", metadata: "x".repeat(6 * 1024 * 1024) },
      eventWriter(event) { published.push(event.toJSON()); return ProcessExecutionCanonicalAcknowledgement.fromEvent(event); } });
    if (index === 0) {
      const result = await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "process.stdout.write('archived-output')"], {
        timeoutMs: 60000, graceMs: 100, maxBuffer: 1024, processExecutionBinding: callBinding,
      }));
      assert.equal(result.stdout, "archived-output"); firstReceipt = result.processExecutionStopReceipt.toJSON();
      const saved = runtime.inspect().executions.find((entry) => entry.executionId === runtime.executionId);
      assert.deepEqual(published.map((event) => event.type), ["reserved", "started", "exited", "result-finalized"]);
      assert.deepEqual(published, saved.events);
      assert.deepEqual(saved.eventAcknowledgements, published.map((event) => ({ eventId: event.eventId, eventDigest: executionValueDigest(event) })));
    }
    await runtime.close();
    const activeBytes = fs.readFileSync(path.join(directory, "registry.json"));
    assert.ok(activeBytes.length < 2048);
    assert.deepEqual(JSON.parse(activeBytes).payload.executions, []);
    assert.equal(fs.readdirSync(path.join(directory, "archives")).length, index + 1);
  }
  const next = await acquire();
  assert.equal(next.ownerEpoch, 4);
  assert.equal(next.inspect().executions.length, 4);
  assert.deepEqual(next.stopReceipts(callBinding).map((receipt) => receipt.toJSON()), [firstReceipt]);
  assert.deepEqual(fs.readFileSync(protectedFile), expected);
  await next.close();
});

test("pre-publication capacity refusal keeps the visible registry complete and the same owner usable", async (t) => {
  const { acquire, directory } = fixture(t); const runtime = await acquire();
  const file = path.join(directory, "registry.json"), before = runtime.inspect();
  const invocation = { content: "x".repeat(17 * 1024 * 1024) }, grant = runtime.remoteGrant();
  await assert.rejects(runtime.reserveCall({ invocation }),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_RECORD_CAPACITY");
  const committed = runtime.inspect();
  const root = committed.executions.find((entry) => entry.executionId === runtime.executionId);
  const accepted = root.requests.at(-1);
  assert.equal(accepted.operation, "reserve");
  assert.equal(accepted.response.ok, false);
  const failure = ProcessExecutionControlFailure.fromStored(accepted.response.error);
  assert.equal(failure.code, "PROCESS_EXECUTION_RECORD_CAPACITY");
  assert.deepEqual(accepted.response, { ok: false, error: failure.toJSON() });
  const request = new ManagedProcessMessage(grant, "reserve", { grant, data: { binding: runtime.binding.toJSON(),
    invocation, timeoutMs: null, graceMs: DEFAULT_REGISTERED_CHILD_GRACE_MS } }, { requestId: accepted.requestId });
  assert.equal(accepted.payloadDigest, request.payloadDigest);
  const expected = JSON.parse(JSON.stringify(before));
  expected.executions.find((entry) => entry.executionId === runtime.executionId).requests.push(accepted);
  assert.equal(executionValueDigest(committed), executionValueDigest(expected),
    "only the exact reserve acceptance and completed refusal may be added for an oversized intent");
  assert.deepEqual(root.calls, []); assert.deepEqual(root.events, []);
  assert.deepEqual(fs.readdirSync(runtime.store.callsAuthority.directory), []);
  assert.equal(runtime.stopReceipts().length, 0);
  assert.equal(fs.existsSync(path.join(directory, "transition.json")), false);
  const refused = fs.readFileSync(file);
  await assert.rejects(managedRequest(grant, "reserve", request.payload, { requestId: request.requestId }),
    (error) => {
      assert.ok(error instanceof ProcessExecutionControlFailure);
      assert.equal(error.code, "PROCESS_EXECUTION_RECORD_CAPACITY");
      assert.ok(error.cause instanceof ProcessExecutionControlFailure);
      assert.deepEqual(error.cause.toJSON(), failure.toJSON());
      return true;
    });
  assert.equal(fs.readFileSync(file).equals(refused), true, "the same request must replay its exact completed refusal");
  const reserve = runtime.reserveCall;
  runtime.reserveCall = function (options) {
    console.error(JSON.stringify({ capacityFollowupInputSizes: {
      invocationBytes: Buffer.byteLength(JSON.stringify(options)),
      launchBytes: Buffer.byteLength(JSON.stringify(options.launch ?? null)),
      environmentBytes: Buffer.byteLength(JSON.stringify(options.launch?.env ?? null)),
    } }));
    return Reflect.apply(reserve, this, [options]);
  };
  let result;
  try {
    result = await runtime.enter(() => executeManagedProcess(process.execPath,
      ["-e", "process.stdout.write('same owner remains usable')"], { timeoutMs: 10000 }));
  } catch (error) {
    const pending = [{ error, path: [] }], seen = new Set();
    for (let index = 0; index < pending.length && index < 12; index++) {
      const { error: failure, path: causePath } = pending[index];
      if (failure == null || seen.has(failure)) continue;
      seen.add(failure);
      console.error(JSON.stringify({ capacityFollowupFailure: {
        causePath, name: failure.name ?? null, code: failure.code ?? null,
        messageHead: String(failure.message ?? "").slice(0, 512),
        primaryCause: failure instanceof ProcessExecutionControlFailure ? failure.primaryCause.toJSON() : null,
        communication: failure instanceof ProcessExecutionControlFailure ? failure.communication?.toJSON() ?? null : null,
        diagnostic: failure instanceof ProcessExecutionControlFailure ? failure.diagnostic?.toJSON() ?? null : null,
        hasStopReceipt: failure.processExecutionStopReceipt !== undefined,
      } }));
      if (failure instanceof AggregateError) for (const [ordinal, member] of failure.errors.entries()) pending.push({ error: member, path: [...causePath, "errors", ordinal] });
      if (failure.cause != null) pending.push({ error: failure.cause, path: [...causePath, "cause"] });
    }
    throw error;
  } finally { runtime.reserveCall = reserve; }
  assert.equal(result.stdout, "same owner remains usable");
  assert.equal(result.processExecutionStopReceipt.observation.kind, "exited");
  await runtime.close();
});

test("archive deletion cannot erase a completed epoch or grant a new checkout execution", async (t) => {
  const { acquire, directory, options } = fixture(t); const runtime = await acquire(); await runtime.close();
  fs.unlinkSync(path.join(directory, "archives", `${runtime.executionId}.json`));
  await assert.rejects(ProcessExecutionRuntime.acquire(options),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_RECORD_MISSING");
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "registry.json"))).payload.ownerEpoch, 1);
});

test("repository identity comparison shares main authority and keeps full checkout matching separate", (t) => {
  const { root } = fixture(t); const other = path.join(root, "other"); fs.mkdirSync(other);
  const main = captureProcessExecutionCheckoutIdentity({ mainRoot: root });
  const checkout = captureProcessExecutionCheckoutIdentity({ mainRoot: root, executionRoot: other });
  assert.equal(main.matchesRepository(checkout), true);
  assert.equal(main.matches(checkout), false);
});


test("a changed second archive observation validates new bytes even with the same file identity", async (t) => {
  const { root, acquire, directory } = fixture(t);
  const runtime = await acquire();
  const result = await runtime.enter(() => executeManagedProcess(process.execPath,
    ["-e", "process.stdout.write('archive-observation')"], { timeoutMs: 10000 }));
  assert.equal(result.stdout, "archive-observation");
  const expectedReceipt = result.processExecutionStopReceipt.toJSON();
  await runtime.close();
  const successor = await acquire();
  await successor.close();
  const archives = path.join(directory, "archives");
  const archivePath = path.join(archives, `${runtime.executionId}.json`);
  const original = fs.readFileSync(archivePath);
  const identity = fs.statSync(archivePath, { bigint: true });
  const changed = JSON.parse(original);
  changed.payload.unexpectedObservationField = true;
  changed.digest = crypto.createHash("sha256").update(JSON.stringify(changed.payload)).digest("hex");
  const replacement = Buffer.from(JSON.stringify(changed));
  const readDirectory = fs.readdirSync;
  let observations = 0;
  let mutated = false;
  fs.readdirSync = function (directoryPath, ...args) {
    if (path.resolve(directoryPath) === archives) {
      observations++;
      if (observations === 2) {
        fs.writeFileSync(archivePath, replacement);
        const after = fs.statSync(archivePath, { bigint: true });
        assert.equal(after.dev, identity.dev);
        assert.equal(after.ino, identity.ino);
        assert.deepEqual(fs.readFileSync(archivePath), replacement);
        mutated = true;
      }
    }
    return readDirectory.call(this, directoryPath, ...args);
  };
  try {
    assert.throws(() => ProcessExecutionRuntime.inspect({ mainRoot: root }), (error) => {
      assert.ok(error instanceof ProcessExecutionControlFailure);
      assert.equal(error.code, "PROCESS_EXECUTION_REGISTRY_FAILED");
      assert.ok(error.cause instanceof TypeError);
      assert.equal(error.cause.message, "Runtime record has missing or unknown fields");
      return true;
    });
    assert.equal(mutated, true);
    assert.ok(observations >= 2);
  } finally {
    fs.readdirSync = readDirectory;
    fs.writeFileSync(archivePath, original);
  }
  const fresh = ProcessExecutionRuntime.inspect({ mainRoot: root });
  const restored = fresh.executions.find((entry) => entry.executionId === runtime.executionId);
  assert.deepEqual(restored.calls[0].receipt, expectedReceipt);
  assert.equal(restored.status, "closed");
  assert.equal(fresh.slot, null);
  assert.deepEqual(fs.readFileSync(archivePath), original);
});


test("warmed cross-request archive reads reject changed bytes and missing history without accepting a new request", { timeout: 60000 }, async (t) => {
  const { root, acquire, directory } = fixture(t);
  const first = await acquire();
  const result = await first.enter(() => executeManagedProcess(process.execPath,
    ["-e", "process.stdout.write('warm-archive')"], { timeoutMs: 10000 }));
  assert.equal(result.stdout, "warm-archive");
  const receipt = result.processExecutionStopReceipt.toJSON();
  await first.close();
  const next = await acquire();
  const grant = next.remoteGrant();
  const events = () => managedRequest(grant, "events", { grant, data: {} });
  assert.deepEqual(await events(), { ok: true, value: [] });
  assert.deepEqual(await events(), { ok: true, value: [] });
  const archive = path.join(directory, "archives", `${first.executionId}.json`);
  const original = fs.readFileSync(archive);
  const beforeIdentity = fs.statSync(archive, { bigint: true });
  const registry = path.join(directory, "registry.json");
  const beforeRegistry = fs.readFileSync(registry);
  const changed = JSON.parse(original);
  changed.payload.unexpectedArchiveField = true;
  changed.digest = executionValueDigest(changed.payload);
  try {
    fs.writeFileSync(archive, JSON.stringify(changed));
    const afterIdentity = fs.statSync(archive, { bigint: true });
    assert.equal(afterIdentity.dev, beforeIdentity.dev);
    assert.equal(afterIdentity.ino, beforeIdentity.ino);
    await assert.rejects(events(), (error) => error instanceof ProcessExecutionControlFailure
      && error.code === "PROCESS_EXECUTION_REGISTRY_FAILED");
    assert.deepEqual(fs.readFileSync(registry), beforeRegistry);
    fs.writeFileSync(archive, original);
    assert.deepEqual(await events(), { ok: true, value: [] });
    fs.unlinkSync(archive);
    await assert.rejects(events(), (error) => error instanceof ProcessExecutionControlFailure
      && error.code === "PROCESS_EXECUTION_RECORD_MISSING");
    assert.deepEqual(fs.readFileSync(registry), beforeRegistry);
  } finally {
    fs.writeFileSync(archive, original);
  }
  assert.deepEqual(await events(), { ok: true, value: [] });
  const restored = next.inspect().executions.find((execution) => execution.executionId === first.executionId);
  assert.equal(restored.status, "closed");
  assert.deepEqual(restored.calls[0].receipt, receipt);
  assert.deepEqual(fs.readFileSync(archive), original);
  await next.close();
  const fresh = ProcessExecutionRuntime.inspect({ mainRoot: root });
  assert.equal(fresh.slot, null);
  assert.ok(fresh.executions.every((execution) => execution.status === "closed"));
  assert.deepEqual(fresh.executions.find((execution) => execution.executionId === first.executionId).calls[0].receipt, receipt);
});
