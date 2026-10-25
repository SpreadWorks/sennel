import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessExecutionCoordinator, ProcessExecutionRuntime, ProcessExecutionGrant } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutorIdentity, ChildExitObservation, ProcessOutputState, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-values.js";
import { ManagedProcessMessage } from "../../../src/lib/managed-process-protocol.js";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { ManagedOutputSnapshot } from "../../../src/lib/managed-process-output.js";
import { managedMonotonicNow } from "../../../src/lib/managed-stop-operation.js";
import { ReadOnlyInvocationWorkspace } from "../../../src/lib/readonly-invocation-workspace.js";
import { ProcessExecutionControlEndpoint } from "../../../src/lib/process-execution-endpoint.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

class ExclusiveBarrier {
  constructor() {
    this.entered = new Promise((resolve) => { this.markEntered = resolve; });
    this.released = new Promise((resolve) => { this.release = resolve; });
  }
  async hold() { this.markEntered(); await this.released; }
}

function fixture(t, { beforeClose = null } = {}) {
  const root = createTmpDir("coordinator-inflight-");
  let coordinator;
  t.after(async () => {
    try {
      await beforeClose?.();
      if (coordinator && !coordinator.released) {
        const grant = coordinator.grant;
        const closed = await coordinator.handle(new ManagedProcessMessage(grant, "close", { grant, data: {} }));
        assert.deepEqual(closed.payload, { ok: true, value: { closed: true } });
        const released = await coordinator.handle(new ManagedProcessMessage(grant, "release-root", { grant, data: {} }));
        assert.equal(released.payload.ok, true);
      }
    } catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
    removeTmpDir(root);
  });
  const endpointWorkspace = ReadOnlyInvocationWorkspace.create();
  const endpoint = ProcessExecutionControlEndpoint.create(endpointWorkspace.processRuntimeStorage(), root).toJSON();
  const { responses } = endpoint.mailbox;
  coordinator = new ProcessExecutionCoordinator({ mainRoot: root,
    endpoint,
    publishResponse(response) {
      new AtomicFile(path.join(responses, `${response.requestId}.json`)).write(JSON.stringify(response), { exclusive: true });
    } });
  return { root, coordinator, grant: coordinator.grant };
}

function eventsRequest(grant, requestId = randomUUID()) {
  return new ManagedProcessMessage(grant, "events", { grant, data: {} }, { requestId });
}

// This is the real shared TCP/mailbox coordinator boundary and physical store
// lock. No transport timing, provider, child launch, sleep or shorter budget.
test("an identical in-flight request receives its first committed response before an unrelated blocked FIFO job exits", async (t) => {
  const { coordinator, grant } = fixture(t);
  const preceding = new ExclusiveBarrier(), following = new ExclusiveBarrier();
  const jobs = [];
  let winner, firstResponse, repeatedResponse;
  const message = eventsRequest(grant);
  try {
    jobs.push(coordinator.store.exclusive(() => preceding.hold()));
    await preceding.entered;
    const first = coordinator.handle(message); jobs.push(first);
    jobs.push(coordinator.store.exclusive(() => following.hold()));
    // A separately decoded retry shares the complete original wire identity.
    const duplicate = coordinator.handle(ManagedProcessMessage.from(JSON.parse(JSON.stringify(message)))); jobs.push(duplicate);
    const outcome = Promise.race([
      duplicate.then((response) => ({ response })),
      following.entered.then(() => null),
    ]);
    preceding.release();
    firstResponse = await first;
    winner = await outcome;
    if (winner !== null) repeatedResponse = winner.response;
  } finally {
    preceding.release(); following.release();
    const settled = await Promise.allSettled(jobs);
    for (const result of settled) assert.equal(result.status, "fulfilled", result.reason?.message);
  }
  assert.notEqual(winner, null, "a retry must receive the already executing request's response without waiting behind unrelated work");
  assert.deepEqual(firstResponse.payload, { ok: true, value: [] });
  assert.deepEqual(repeatedResponse, firstResponse);
  assert.equal(repeatedResponse.respondsTo(message), true);
  const ledger = JSON.parse(coordinator.store.requestFile(coordinator.executionId, message.requestId).read()).payload;
  assert.equal(ledger.requestId, message.requestId);
  assert.deepEqual(ledger.response, firstResponse.payload);
  assert.deepEqual(coordinator.store.readInventory().executions[0].calls, []);
});

test("an in-flight request refuses changed operation, content, or authorization instead of sharing its response", async (t) => {
  const { coordinator, grant } = fixture(t);
  const barrier = new ExclusiveBarrier();
  const message = eventsRequest(grant);
  const held = coordinator.store.exclusive(() => barrier.hold());
  const checks = [];
  let first;
  try {
    await barrier.entered;
    first = coordinator.handle(message);
    const changedGrant = { ...grant, capability: randomUUID() };
    const altered = [
      new ManagedProcessMessage(grant, "authenticate", message.payload, { requestId: message.requestId }),
      new ManagedProcessMessage(grant, "events", { grant, data: { changed: true } }, { requestId: message.requestId }),
      new ManagedProcessMessage({ ...grant, capability: randomUUID() }, "events", message.payload, { requestId: message.requestId }),
      new ManagedProcessMessage(changedGrant, "events", { grant: changedGrant, data: {} }, { requestId: message.requestId }),
      new ManagedProcessMessage(grant, "events", { grant, data: { changed: true } }, { requestId: message.requestId, payloadDigest: message.payloadDigest }),
    ];
    for (const changed of altered) checks.push(assert.rejects(coordinator.handle(changed), { code: "PROCESS_EXECUTION_REQUEST_MISMATCH" }));
  } finally {
    barrier.release();
    await held;
    if (first) assert.equal((await first).payload.ok, true);
    await Promise.all(checks);
  }
  const another = eventsRequest(grant);
  assert.notEqual(another.requestId, message.requestId);
  assert.equal((await coordinator.handle(another)).payload.ok, true);
  assert.notEqual(coordinator.store.requestFile(coordinator.executionId, another.requestId).read(), null);
});

test("a settled response cannot replay past a fresh ownership check after cooperative coordinator release", async (t) => {
  const { coordinator, grant, root } = fixture(t);
  const message = eventsRequest(grant);
  const first = await coordinator.handle(message);
  assert.deepEqual((await coordinator.handle(ManagedProcessMessage.from(JSON.parse(JSON.stringify(message))))).payload, first.payload);
  // A settled leader's authority cannot be reused, and a rejected attempt cannot
  // poison a subsequent valid request carrying the same UUID.
  const invalid = new ManagedProcessMessage({ ...grant, capability: randomUUID() }, "events", message.payload, { requestId: message.requestId });
  await assert.rejects(coordinator.handle(invalid), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
  assert.deepEqual((await coordinator.handle(ManagedProcessMessage.from(JSON.parse(JSON.stringify(message))))).payload, first.payload);
  assert.deepEqual((await coordinator.handle(new ManagedProcessMessage(grant, "close", { grant, data: {} }))).payload,
    { ok: true, value: { closed: true } });
  assert.equal((await coordinator.handle(new ManagedProcessMessage(grant, "release-root", { grant, data: {} }))).payload.ok, true);
  const before = coordinator.store.file.read();
  await assert.rejects(coordinator.handle(ManagedProcessMessage.from(JSON.parse(JSON.stringify(message)))),
    { code: "PROCESS_EXECUTION_OWNERSHIP_CHANGED" });
  assert.deepEqual(coordinator.store.file.read(), before);
  const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root });
  assert.equal(historical.executions[0].status, "closed");
  assert.deepEqual(historical.executions[0].calls, []);
});


test("a queued request owns a stable validated snapshot despite later mutation by its direct caller", async (t) => {
  const { coordinator, grant } = fixture(t);
  const barrier = new ExclusiveBarrier();
  const held = coordinator.store.exclusive(() => barrier.hold());
  const message = eventsRequest(JSON.parse(JSON.stringify(grant)));
  const originalWire = JSON.stringify(message);
  let response, first;
  try {
    await barrier.entered;
    first = coordinator.handle(message);
    message.payload.grant.capability = randomUUID();
    barrier.release();
    response = await first;
  } finally {
    barrier.release();
    await Promise.allSettled([held, first].filter(Boolean));
  }
  assert.deepEqual(response.payload, { ok: true, value: [] });
  assert.equal(response.respondsTo(ManagedProcessMessage.from(JSON.parse(originalWire))), true);
  const replay = await coordinator.handle(ManagedProcessMessage.from(JSON.parse(originalWire)));
  assert.deepEqual(replay, response);
  const ledger = JSON.parse(coordinator.store.requestFile(coordinator.executionId, message.requestId).read()).payload;
  assert.equal(ledger.payloadDigest, JSON.parse(originalWire).payloadDigest);
  assert.deepEqual(ledger.response, response.payload);
});

async function assertTimeoutReadControl(t, { warm }) {
  let child, terminal, drained, receipt, actualCall, executor;
  const captured = { stdout: [], stderr: [] };
  let finishChild;
  const { coordinator, grant, root } = fixture(t, { beforeClose: async () => { await finishChild?.(); } });
  const request = async (operation, data = {}, authority = grant, requestId = randomUUID()) => {
    const message = new ManagedProcessMessage(authority, operation, { grant: authority, data }, { requestId });
    const response = await coordinator.handle(message);
    assert.equal(response.respondsTo(message), true);
    return ProcessExecutionRuntime.prototype.decodeResponse(response);
  };
  const reserved = await request("reserve", { binding: null, timeoutMs: warm ? 1000 : 100, graceMs: 500 });
  // The target and delegated grant use only this actual reservation's capability,
  // the same null binding requested above, and the actual claimed executor.
  actualCall = { callId: reserved.callId, capability: reserved.capability, bindingDigest: grant.bindingDigest };
  executor = new ProcessExecutorIdentity({ executorId: randomUUID(), executorSession: randomUUID(), launchClaim: randomUUID() });
  const permit = await request("claim-launch", { call: actualCall, executor: executor.toJSON() });
  assert.equal(permit.callId, actualCall.callId);
  child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "pipe", "pipe"] });
  terminal = once(child, "exit"); drained = once(child, "close");
  for (const stream of ["stdout", "stderr"]) child[stream].on("data", bytes => captured[stream].push(bytes));
  finishChild = async () => {
    if (receipt !== undefined) return receipt;
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    const [code, signal] = await terminal; await drained;
    assert.equal(code, 0); assert.equal(signal, null);
    const observation = new ChildExitObservation({ executor, kind: "exited", code, signal, observedAt: new Date().toISOString() });
    await request("observe", { call: actualCall, type: "exit", observation: observation.toJSON() });
    const maximum = 0, output = { maximum };
    for (const stream of ["stdout", "stderr"]) {
      const bytes = Buffer.concat(captured[stream]); assert.equal(bytes.length, 0);
      const snapshot = ManagedOutputSnapshot.capture(bytes, maximum);
      const saved = await request("persist-call-output", { call: actualCall, executor: executor.toJSON(), stream,
        maximum, snapshot: snapshot.toJSON(), offset: 0, bytes: bytes.toString("base64") });
      assert.equal(saved.complete, true); assert.deepEqual(saved.snapshot, snapshot.toJSON()); output[stream] = saved.snapshot;
    }
    receipt = new ProcessExecutionStopReceipt(await request("finish", { call: actualCall, observation: observation.toJSON(),
      outcome: { code, signal, timedOut: true, output },
      output: new ProcessOutputState({ stdoutBytes: 0, stderrBytes: 0, completion: "complete", cutoffAt: new Date().toISOString() }).toJSON() }));
    return receipt;
  };
  await once(child, "spawn");
  await request("observe", { call: actualCall, type: "started", executor: executor.toJSON(), startedAt: new Date().toISOString() });
  const started = coordinator.store.read().executions.find(entry => entry.executionId === coordinator.executionId);
  assert.deepEqual(started.events.map(event => event.type), ["reserved", "started"]);
  assert.equal(started.calls[0].stopOperation, null); assert.equal(started.calls[0].observation, null);
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  const timeoutDeadline = started.calls[0].startedMonotonic + started.calls[0].timeoutMs;
  assert.equal(coordinator.nextTickAt, timeoutDeadline);
  const data = { call: actualCall, executor: executor.toJSON() };
  if (warm) {
    const control = await request("read-control", data);
    assert.equal(control.timedOut, false); assert.equal(control.stopRequested, false);
    assert.equal(control.stopSignal, null); assert.equal(control.stopRemainingMs, null);
    assert.equal(control.status, "running"); assert.equal(control.aborted, false);
    assert.equal(control.descendantsSettled, true); assert.equal(control.controlFailure, null);
    assert.deepEqual((await request("events")).map(event => event.type), ["reserved", "started"]);
    assert.ok(managedMonotonicNow() < timeoutDeadline, "both warming queries must precede the actual published deadline");
    assert.equal(coordinator.nextTickAt, timeoutDeadline);
  }
  // Do not read the mutable store between warming and the post-deadline RPC.
  // This in-process kernel has no autonomous tick. Wait only for the stored
  // semantic deadline, including recheck if a platform timer wakes early.
  while (true) {
    const remaining = timeoutDeadline - managedMonotonicNow();
    if (remaining <= 0) break;
    await delay(Math.ceil(remaining));
  }
  const controlId = randomUUID();
  const first = await request("read-control", data, grant, controlId);
  const stopped = coordinator.store.read().executions.find(entry => entry.executionId === coordinator.executionId);
  const stop = stopped.calls[0].stopOperation.toJSON();
  assert.equal(first.timedOut, true); assert.equal(first.stopRequested, true); assert.equal(first.aborted, false);
  assert.equal(first.status, "running"); assert.equal(first.descendantsSettled, true);
  assert.equal(first.controlFailure, null);
  assert.equal(stop.reason, "timeout"); assert.equal(stop.graceMs, 500);
  assert.ok(stop.startedAt >= timeoutDeadline); assert.equal(stop.deadline, stop.startedAt + 3000);
  assert.ok(first.stopRemainingMs >= 0 && first.stopRemainingMs <= 3000);
  assert.ok(["SIGTERM", "SIGKILL"].includes(first.stopSignal));
  assert.equal(stopped.calls[0].accepting, false); assert.equal(stopped.calls[0].receipt, null);
  assert.deepEqual(stopped.events.map(event => event.type), ["reserved", "started", "stop-requested"]);
  const ledger = coordinator.store.requestFile(coordinator.executionId, controlId), completedBytes = ledger.read();
  assert.deepEqual(await request("read-control", data, grant, controlId), first);
  assert.deepEqual(ledger.read(), completedBytes);
  const second = await request("read-control", data);
  assert.ok(second.stopRemainingMs <= first.stopRemainingMs);
  const sameStop = coordinator.store.read().executions.find(entry => entry.executionId === coordinator.executionId);
  assert.deepEqual(sameStop.calls[0].stopOperation.toJSON(), stop);
  assert.equal(sameStop.events.filter(event => event.type === "stop-requested").length, 1);
  const borrowed = new ProcessExecutionGrant({ ...grant, callId: actualCall.callId,
    capability: actualCall.capability, executor: executor.toJSON() }).toJSON();
  await assert.rejects(request("reserve", { binding: null }, borrowed), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
  assert.equal(coordinator.store.read().executions[0].calls.length, 1);
  const completed = await finishChild();
  assert.equal(completed.observation.code, 0); assert.equal(completed.observation.signal, null);
  assert.equal(completed.stopEvidence.status, "confirmed"); assert.deepEqual(completed.stopOperation.toJSON(), stop);
  await request("close"); await request("release-root");
  assert.equal(coordinator.released, true);
  const historical = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions.find(entry => entry.executionId === coordinator.executionId);
  assert.equal(historical.status, "closed"); assert.equal(historical.calls.length, 1);
  assert.deepEqual(historical.calls[0].receipt, completed.toJSON());
  assert.equal(historical.calls[0].outcome.timedOut, true);
}

for (const warm of [false, true]) {
  test(warm ? "warm read-control refreshes the actual start deadline once and preserves its receipt through closure"
    : "first read-control after the actual start deadline commits one timeout stop and preserves its receipt through closure",
  { timeout: 30000 }, (t) => assertTimeoutReadControl(t, { warm }));
}
