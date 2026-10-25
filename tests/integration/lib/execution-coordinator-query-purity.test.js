import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutorIdentity, ChildExitObservation, ProcessOutputState, ProcessExecutionStopReceipt, executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { managedRequest } from "../../../src/lib/managed-process-protocol.js";
import { currentRuntimePackage } from "../../../src/lib/runtime-package.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

// Compatibility coverage: this must pass before and after the query optimizations.
// The real handle stays parked on stdin; only the public owning executor APIs
// register its actual spawn/exit and produce its final receipt.
test("nonmutating coordinator queries preserve registry bytes, durable replay and response isolation while an owned child runs", { timeout: 120000 }, async (t) => {
  const root = createTmpDir("coordinator-query-purity-");
  let runtime, call, executor, child, terminal, receipt;
  const finishChild = async () => {
    if (child === undefined || receipt !== undefined) return receipt;
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    const [code, signal] = await terminal;
    assert.equal(code, 0); assert.equal(signal, null);
    const observation = new ChildExitObservation({ executor, kind: "exited", code, signal,
      observedAt: new Date().toISOString() });
    await runtime.observeCall(call, { type: "exit", observation: observation.toJSON() });
    const maximum = 0;
    const stdout = await runtime.persistCallOutput(call, { executor, stream: "stdout", maximum, bytes: Buffer.alloc(0) });
    const stderr = await runtime.persistCallOutput(call, { executor, stream: "stderr", maximum, bytes: Buffer.alloc(0) });
    receipt = await runtime.finishCall(call, { observation,
      outcome: { code, output: { maximum, stdout, stderr } },
      output: new ProcessOutputState({ stdoutBytes: 0, stderrBytes: 0, completion: "complete", cutoffAt: new Date().toISOString() }) });
    return receipt;
  };
  t.after(async () => {
    try { await finishChild(); if (runtime !== undefined) await runtime.close(); }
    finally { removeQuiescentRuntimeFixture({ mainRoot: root }); }
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, binding: { contract: "query-purity" } });
  call = await runtime.reserveCall();
  executor = new ProcessExecutorIdentity({ executorId: randomUUID(), executorSession: randomUUID(), launchClaim: randomUUID() });
  await runtime.claimLaunch(call, { executor });
  child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  terminal = once(child, "exit");
  await once(child, "spawn");
  await runtime.observeCall(call, { type: "started", executor: executor.toJSON(), startedAt: new Date().toISOString() });
  const registryBytes = () => runtime.store.admission.runExclusiveAsync(() => fs.readFileSync(runtime.store.file.filePath));
  const before = await registryBytes();
  const originalRoot = JSON.parse(before).payload.executions.find(e => e.executionId === runtime.executionId);
  assert.equal(originalRoot.calls[0].status, "running");
  assert.equal(originalRoot.calls[0].receipt, null);
  assert.equal(originalRoot.calls[0].timeoutMs, null);
  assert.equal(originalRoot.calls[0].stopOperation, null);
  assert.deepEqual(originalRoot.events.map(e => e.type), ["reserved", "started"]);
  assert.deepEqual(originalRoot.eventAcknowledgements, []);
  const grant = runtime.remoteGrant();
  const saved = new Map();
  for (const operation of ["authenticate", "events", "runtime-snapshot", "read-control"]) {
    const payload = { grant, data: operation === "read-control"
      ? { call: call.controlTarget(), executor: executor.toJSON() } : {} };
    const requestId = randomUUID();
    const response = await managedRequest(grant, operation, payload, { requestId });
    assert.equal(response.ok, true);
    if (operation === "authenticate") {
      assert.equal(response.value.record.executionId, runtime.executionId);
      assert.deepEqual(response.value.record.binding, { contract: "query-purity" });
    } else if (operation === "events") {
      assert.deepEqual(response.value, originalRoot.events);
    } else if (operation === "runtime-snapshot") {
      assert.equal(response.value.revision, currentRuntimePackage().revision);
      assert.equal(response.value.encoding, "gzip-base64");
    } else {
      assert.deepEqual(response.value, { stopSignal: null, stopRequested: false, stopRemainingMs: null,
        timedOut: false, aborted: false, descendantsSettled: true, status: "running", controlFailure: null });
    }
    const expected = JSON.parse(JSON.stringify(response));
    const ledger = runtime.store.requestFile(runtime.executionId, requestId);
    const completedBytes = ledger.read();
    const envelope = JSON.parse(completedBytes);
    assert.deepEqual(Object.keys(envelope), ["payload", "digest"]);
    assert.equal(envelope.digest, executionValueDigest(envelope.payload));
    assert.equal(envelope.payload.requestId, requestId);
    assert.equal(envelope.payload.operation, operation);
    assert.equal(envelope.payload.payloadDigest, executionValueDigest(payload));
    assert.match(envelope.payload.authorizationDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(envelope.payload.response, expected);
    // Mutate nested returned data, not the immutable request or a stored record.
    if (operation === "authenticate") response.value.record.binding.contract = "caller mutation";
    else if (operation === "events") response.value[0].binding.contract = "caller mutation";
    else if (operation === "runtime-snapshot") response.value.body = "caller mutation";
    else response.value.status = "caller mutation";
    assert.deepEqual(await managedRequest(grant, operation, payload, { requestId }), expected);
    assert.deepEqual(ledger.read(), completedBytes, "an exact replay must not rewrite its completed receipt");
    assert.deepEqual(await managedRequest(grant, operation, payload), expected,
      "a fresh query must not retain caller mutations");
    assert.deepEqual(await registryBytes(), before);
    saved.set(operation, { requestId, expected, completedBytes, ledger });
  }
  const events = saved.get("events");
  await assert.rejects(managedRequest(grant, "events", { grant, data: { changed: true } },
    { requestId: events.requestId }), { code: "PROCESS_EXECUTION_REQUEST_MISMATCH" });
  const rejectedId = randomUUID();
  const forged = { ...grant, capability: randomUUID() };
  await assert.rejects(managedRequest(forged, "events", { grant: forged, data: {} },
    { requestId: rejectedId }), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
  assert.equal(runtime.store.requestFile(runtime.executionId, rejectedId).read(), null);
  assert.deepEqual(events.ledger.read(), events.completedBytes);
  assert.deepEqual(await registryBytes(), before);
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  const completed = await finishChild();
  assert.ok(completed instanceof ProcessExecutionStopReceipt);
  assert.equal(completed.callId, call.callId);
  assert.equal(completed.observation.kind, "exited");
  assert.equal(completed.observation.code, 0);
  assert.equal(completed.output.stdoutBytes, 0); assert.equal(completed.output.stderrBytes, 0);
  await runtime.close();
  assert.equal(runtime.closed, true);
  const closed = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions.find(e => e.executionId === runtime.executionId);
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.calls[0].receipt, completed.toJSON());
});
