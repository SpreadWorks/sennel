import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { ProcessExecutionRuntime, ProcessExecutionHistoricalInventory,
  ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

function fixture(t, { cleanupRunId } = {}) {
  const mainRoot = createTmpDir("process-history-");
  const executionRoot = path.join(mainRoot, "checkout");
  const runId = "history-run", specId = "history-spec";
  t.after(() => removeQuiescentRuntimeFixture({ mainRoot, executionRoot, runId: cleanupRunId ?? runId, specId }));
  fs.mkdirSync(executionRoot);
  return { mainRoot, executionRoot, runId, specId };
}

function savedBytes(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => [entry.name, entry.isDirectory() ? savedBytes(path.join(directory, entry.name))
      : fs.readFileSync(path.join(directory, entry.name)).toString("base64")]);
}

// Outcome -> legal producer -> durable readback:
// exact descriptor/timing/IDs: managed command/provider -> receipt -> history;
// unfinished remains unfinished: reserve -> no permit/receipt -> history;
// confirmed stop observations: output barrier -> abort -> stop receipt -> history;
// archived old run remains visible: close -> new owner -> checkout removal -> history;
// corruption/missing source: normal retained inventory -> boundary damage -> strict refusal.
test("managed history preserves actual argument positions, timing, exact IDs and receipts without writes", async (t) => {
  const options = fixture(t);
  const binding = { flowVersionId: "version-one", attemptId: "attempt-one", outboxAttemptId: "outbox-one" };
  const runtime = await ProcessExecutionRuntime.acquire({ ...options, binding });
  t.after(async () => { if (!runtime.closed) await runtime.close(); });
  const results = await runtime.enter(() => Promise.all(["command", "provider"].map((kind) => executeManagedProcess(process.execPath,
    ["-e", "process.stdout.write('done')", "private-token", path.join(options.executionRoot, "secret")], {
      runtime, kind, cwd: options.executionRoot, timeoutMs: 20000, logicalInvocationId: `${kind}-logical`,
      providerAttemptId: `${kind}-provider`, measurementId: `${kind}-measurement`, observationBinding: binding,
    }))));
  assert.deepEqual(results.map((result) => result.stdout), ["done", "done"]);
  const before = savedBytes(path.join(options.mainRoot, ".sennel"));
  const history = ProcessExecutionRuntime.readHistoricalInventory({ ...options, checkoutIdentity: runtime.checkoutIdentity });
  assert.ok(history instanceof ProcessExecutionHistoricalInventory);
  assert.equal(history.executions[0].executionId, runtime.executionId);
  assert.equal(history.digest, ProcessExecutionRuntime.readHistoricalInventory(options).digest);
  const calls = history.executions[0].calls;
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.binding, binding);
    assert.deepEqual(call.invocation.observationBinding, binding);
    assert.equal(call.invocation.measurementId, `${call.invocation.kind}-measurement`);
    assert.equal(call.invocation.command.program.value, null);
    assert.equal(call.invocation.command.program.reason, "absolute-path");
    assert.deepEqual(call.invocation.command.argv.map((argument) => argument.position), [0, 1, 2, 3]);
    assert.ok(call.invocation.command.argv.every((argument) => argument.value === null && argument.reason === "not-public"));
    assert.equal(call.invocation.command.cwd.value, "execution-root");
    assert.equal(call.invocation.command.complete, false);
    assert.equal(JSON.stringify(call.invocation.command).includes("private-token"), false);
    assert.equal(call.outcome.providerStarted, true);
    assert.deepEqual(results.find((result) => result.processExecutionStopReceipt.callId === call.callId).timing, call.outcome.timing);
    assert.ok(Date.parse(call.invocation.reservedAt) <= Date.parse(call.outcome.timing.startedAt));
    assert.ok(Date.parse(call.outcome.timing.startAcceptedAt) <= Date.parse(call.outcome.timing.startedAt));
    assert.ok(Date.parse(call.outcome.timing.finishedAt) >= Date.parse(call.outcome.timing.startedAt));
    assert.ok(call.outcome.timing.durationMs >= 0);
    assert.equal(call.outcome.timing.stopRequestedAt, null);
    assert.equal(call.receipt.outcomeDigest, executionValueDigest(call.outcome));
    assert.equal(call.status, "stopped");
    assert.equal(call.parentCallId, null);
  }
  assert.deepEqual(savedBytes(path.join(options.mainRoot, ".sennel")), before);
  await runtime.close();
});

test("history reads live owner reservations without promoting an unfinished call to stopped", async (t) => {
  const options = fixture(t);
  const runtime = await ProcessExecutionRuntime.acquire(options);
  t.after(async () => { if (!runtime.closed) await runtime.close(); });
  const call = await runtime.reserveCall({ invocation: { commandId: "not-launched" } });
  const before = savedBytes(path.join(options.mainRoot, ".sennel"));
  const history = ProcessExecutionRuntime.readHistoricalInventory(options);
  assert.equal(history.inventory.slot, runtime.executionId);
  assert.equal(history.executions[0].calls[0].status, "intent");
  assert.equal(history.executions[0].calls[0].receipt, null);
  assert.equal(history.executions[0].calls[0].outcome, null);
  assert.deepEqual(savedBytes(path.join(options.mainRoot, ".sennel")), before);
  const revocation = await runtime.revokeCall(call);
  assert.equal(revocation.scope, "unlaunched-reservation");
  const revoked = ProcessExecutionRuntime.readHistoricalInventory(options).executions[0].calls[0];
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.receipt, null);
  assert.deepEqual(revoked.revocation, revocation.toJSON());
  await runtime.close();
});

test("a stopped managed call retains its stop observation separately from reservation, start and physical finish", async (t) => {
  const options = fixture(t);
  const runtime = await ProcessExecutionRuntime.acquire(options);
  t.after(async () => { if (!runtime.closed) await runtime.close(); });
  const controller = new AbortController();
  const reason = new Error("controlled-stop");
  await assert.rejects(runtime.enter(() => executeManagedProcess(process.execPath,
    ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
      timeoutMs: 20000, graceMs: 100, abortSignal: controller.signal,
      onStdout() { controller.abort(reason); },
    })), (error) => error === reason);
  const before = savedBytes(path.join(options.mainRoot, ".sennel"));
  const call = ProcessExecutionRuntime.readHistoricalInventory(options).executions[0].calls[0];
  assert.equal(call.status, "stopped");
  assert.equal(call.outcome.aborted, true);
  assert.equal(call.outcome.providerStarted, true);
  assert.ok(Date.parse(call.outcome.timing.stopRequestedAt) >= Date.parse(call.outcome.timing.startedAt));
  assert.ok(Date.parse(call.outcome.timing.finishedAt) >= Date.parse(call.outcome.timing.stopRequestedAt));
  assert.ok(call.outcome.timing.durationMs >= 0);
  assert.equal(call.receipt.observation.kind, "exited");
  assert.equal(call.receipt.outcomeDigest, executionValueDigest(call.outcome));
  assert.deepEqual(reason.timing, call.outcome.timing);
  assert.deepEqual(savedBytes(path.join(options.mainRoot, ".sennel")), before);
  await runtime.close();
});

test("an output barrier exposes the registered start without writes, then the same call closes with its receipt", async (t) => {
  const options = fixture(t);
  const runtime = await ProcessExecutionRuntime.acquire(options);
  t.after(async () => { if (!runtime.closed) await runtime.close(); });
  const controller = new AbortController();
  const reason = new Error("barrier-stop");
  let running;
  let barrierFailure;
  await assert.rejects(runtime.enter(() => executeManagedProcess(process.execPath,
    ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
      timeoutMs: 20000, graceMs: 100, abortSignal: controller.signal,
      onStdout() {
        try {
          running = ProcessExecutionRuntime.readHistoricalInventory(options).executions[0].calls[0];
          assert.equal(running.status, "running");
          assert.equal(running.outcome, null);
          assert.equal(running.receipt, null);
          assert.equal(running.observation, null);
          assert.ok(Date.parse(running.startedAt));
          assert.equal("launcherObservation" in running, false);
          runtime.store.admission.runExclusive(() => {
            const directory = path.join(options.mainRoot, ".sennel");
            const before = savedBytes(directory);
            const history = ProcessExecutionRuntime.readHistoricalInventory(options);
            assert.deepEqual(history.executions[0].calls[0], running);
            assert.equal(history.digest, ProcessExecutionRuntime.readHistoricalInventory(options).digest);
            assert.deepEqual(savedBytes(directory), before);

            const hadCallDirectory = fs.existsSync(path.join(runtime.store.callsAuthority.directory, running.callId));
            const callDirectory = runtime.store.callDirectory(running.callId);
            const file = path.join(callDirectory, "outcome.json");
            const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
            try {
              if (saved !== null) fs.unlinkSync(file);
              // The coordinator inventory is authoritative even while the child runs.
              // A private executor spool is not a second observational truth source.
              assert.deepEqual(ProcessExecutionRuntime.readHistoricalInventory(options).executions[0].calls[0], running);
              fs.writeFileSync(file, "{");
              assert.deepEqual(ProcessExecutionRuntime.readHistoricalInventory(options).executions[0].calls[0], running);
            } finally {
              if (saved === null) {
                if (fs.existsSync(file)) fs.unlinkSync(file);
              } else fs.writeFileSync(file, saved);
              if (!hadCallDirectory) fs.rmdirSync(callDirectory);
            }
            assert.deepEqual(savedBytes(directory), before);
          });
        } catch (error) { barrierFailure = error; }
        finally { controller.abort(reason); }
      },
    })), (error) => error === reason);
  if (barrierFailure) throw barrierFailure;
  assert.ok(running);
  const before = savedBytes(path.join(options.mainRoot, ".sennel"));
  const stopped = ProcessExecutionRuntime.readHistoricalInventory(options).executions[0].calls[0];
  assert.equal(stopped.callId, running.callId);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.observation.kind, "exited");
  assert.equal(stopped.outcome.timing.startedAt, running.startedAt);
  assert.equal(stopped.receipt.outcomeDigest, executionValueDigest(stopped.outcome));
  assert.deepEqual(savedBytes(path.join(options.mainRoot, ".sennel")), before);
  // A private executor spool does not replace the retained coordinator receipt.
  fs.unlinkSync(path.join(runtime.store.callsAuthority.directory, stopped.callId, "outcome.json"));
  const retiredBytes = savedBytes(path.join(options.mainRoot, ".sennel"));
  assert.deepEqual(ProcessExecutionRuntime.readHistoricalInventory(options).executions[0].calls[0], stopped);
  assert.deepEqual(savedBytes(path.join(options.mainRoot, ".sennel")), retiredBytes);
  await runtime.close();
});

test("historical archives survive owner turnover, newer run and deleted checkout with exact source identity", async (t) => {
  const successorRunId = "newer-run";
  const options = fixture(t, { cleanupRunId: successorRunId });
  const runtime = await ProcessExecutionRuntime.acquire(options);
  const checkoutIdentity = runtime.checkoutIdentity;
  const completed = await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", ""], {
    cwd: options.executionRoot, timeoutMs: 10000, commandId: "reserved",
  }));
  const receipt = completed.processExecutionStopReceipt;
  assert.equal(receipt.observation.kind, "exited");
  await runtime.close();
  const successor = await ProcessExecutionRuntime.acquire({ ...options, runId: successorRunId });
  await successor.close();
  fs.rmdirSync(options.executionRoot);
  const before = savedBytes(path.join(options.mainRoot, ".sennel"));
  const history = ProcessExecutionRuntime.readHistoricalInventory({ ...options, checkoutIdentity });
  assert.equal(history.inventory.ownerEpoch, 2);
  assert.equal(history.inventory.executions.length, 2);
  assert.equal(history.executions.length, 1);
  assert.equal(history.executions[0].executionId, runtime.executionId);
  assert.equal(history.executions[0].calls[0].receipt.callId, receipt.callId);
  assert.deepEqual(history.checkoutIdentity.toJSON(), checkoutIdentity.toJSON());
  assert.deepEqual(savedBytes(path.join(options.mainRoot, ".sennel")), before);
  assert.throws(() => ProcessExecutionRuntime.readHistoricalInventory({ ...options,
    checkoutIdentity: { ...checkoutIdentity.toJSON(), checkoutInode: checkoutIdentity.checkoutInode + 1 } }),
  (error) => error.code === "PROCESS_EXECUTION_AUTHORITY_MISMATCH");
});

test("a referenced missing or corrupt runtime source fails instead of returning an empty history", async (t) => {
  const options = fixture(t);
  assert.throws(() => ProcessExecutionRuntime.readHistoricalInventory(options), ProcessExecutionControlFailure);
  assert.equal(fs.existsSync(path.join(options.mainRoot, ".sennel")), false);
  const runtime = await ProcessExecutionRuntime.acquire(options);
  await runtime.close();
  const successor = await ProcessExecutionRuntime.acquire(options);
  await successor.close();
  const archive = path.join(runtime.store.archivesAuthority.directory, `${runtime.executionId}.json`);
  fs.writeFileSync(archive, "{}");
  const before = savedBytes(path.join(options.mainRoot, ".sennel"));
  assert.throws(() => ProcessExecutionRuntime.readHistoricalInventory(options),
    (error) => error.code === "PROCESS_EXECUTION_RECORD_CORRUPT");
  assert.deepEqual(savedBytes(path.join(options.mainRoot, ".sennel")), before);
});
