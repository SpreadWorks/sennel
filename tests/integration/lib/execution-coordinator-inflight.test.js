import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessExecutionCoordinator, ProcessExecutionRuntime, ProcessExecutionGrant } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutorIdentity, ChildExitObservation, ProcessOutputState, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-values.js";
import { ManagedProcessMessage } from "../../../src/lib/managed-process-protocol.js";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { RuntimeStandaloneRequestDocument } from "../../../src/lib/process-execution-request-block.js";
import { ManagedOutputSnapshot } from "../../../src/lib/managed-process-output.js";
import { managedMonotonicNow } from "../../../src/lib/managed-stop-operation.js";
import { ReadOnlyInvocationWorkspace } from "../../../src/lib/readonly-invocation-workspace.js";
import { ProcessExecutionControlEndpoint } from "../../../src/lib/process-execution-endpoint.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { InitialInventoryObservationGate, InitialInventoryCatchCheckpoint }
  from "../../support/infrastructure/initial-inventory-observation.js";

class ExclusiveBarrier {
  constructor() {
    this.entered = new Promise((resolve) => { this.markEntered = resolve; });
    this.released = new Promise((resolve) => { this.release = resolve; });
  }
  async hold() { this.markEntered(); await this.released; }
}

function fixture(t, { beforeClose = null, beforeConstruct = null } = {}) {
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
  beforeConstruct?.({ root, endpoint });
  coordinator = new ProcessExecutionCoordinator({ mainRoot: root,
    endpoint,
    publishResponse(response) {
      new AtomicFile(path.join(responses, `${response.requestId}.json`)).write(JSON.stringify(response), { exclusive: true });
    } });
  return { root, coordinator, grant: coordinator.grant };
}

function committedRequest(coordinator, requestId) {
  const envelope = JSON.parse(coordinator.store.requestFile(coordinator.executionId, requestId).read());
  return RuntimeStandaloneRequestDocument.fromEnvelope(coordinator.executionId, requestId, envelope).requestRecord();
}

function eventsRequest(grant, requestId = randomUUID()) {
  return new ManagedProcessMessage(grant, "events", { grant, data: {} }, { requestId });
}

test("a first-start inventory reader reobserves genuine registry absence after the staged writer commits", { timeout: 45000 }, async t => {
  const gate = new InitialInventoryObservationGate();
  let checkpoint;
  let worker, observed, writerHook, coordinator, grant, call, request;
  let writerBefore, stageObservation, writerFinished, observation;
  const proofPath = path.join(testTemporaryRoot().path, `initial-inventory-observation-${randomUUID()}.json`);
  const saveProof = (cause = null) => {
    const target = cause === null ? proofPath : `${proofPath}.failure.json`;
    fs.writeFileSync(target, JSON.stringify({ writerBefore, stageObservation, writerFinished,
      writerInitialCaptureCompleted: writerBefore?.captureCompleted === true,
      observationReceived: observation !== undefined, observation, checkpoint: checkpoint?.toJSON(),
      requestId: request?.requestId,
      actualRecordCorruptError: observation?.error?.typedControlFailure === true
        && observation.error.reason === "record-corrupt" && observation.error.code === "PROCESS_EXECUTION_RECORD_CORRUPT",
      originalFailure: cause === null ? null : { name: cause.name, code: cause.code,
        message: cause.message, stack: String(cause.stack).split("\n").slice(0, 10).join("\n") },
      regressionQualification: "Requires every fixture premise before the final success assertion, and a separate same-input after-fix pass; other errors or exhausted setup timing do not qualify" }, null, 2), { flag: "wx" });
  };
  t.after(async () => {
    gate.abort();
    writerHook?.mock.restore();
    if (worker) await worker.terminate();
  });
  try {
    checkpoint = InitialInventoryCatchCheckpoint.capture(
      new URL("../../../src/lib/process-execution-runtime.js", import.meta.url));
    const value = fixture(t, {
      beforeConstruct({ root }) {
        worker = new Worker(new URL("../../fixtures/process-runtime-initial-inventory-observer.mjs", import.meta.url),
          { workerData: { mainRoot: root, state: gate.buffer, checkpoint: checkpoint.toJSON() } });
        observed = once(worker, "message").then(([result]) => result,
          error => ({ workerError: { name: error.name, message: error.message, stack: error.stack } }));
        assert.equal(gate.wait("ready"), true, "bootstrap must finish before initial absence is observed");
        const original = AtomicFile.prototype.readSnapshot;
        const prefix = path.join(root, ".sennel", "process-runtime") + path.sep;
        writerHook = t.mock.method(AtomicFile.prototype, "readSnapshot", function () {
          const snapshot = Reflect.apply(original, this, []);
          if (writerBefore === undefined && this.filePath.startsWith(prefix)
            && path.basename(this.filePath) === "registry.json") {
            writerBefore = { filePath: this.filePath, captureCompleted: true, missing: snapshot === null };
            gate.mark("start");
            writerBefore.readerCaptured = gate.wait("before");
          }
          return snapshot;
        });
      },
      async beforeClose() {
        if (!coordinator) return;
        coordinator.store.faultInjector = () => {};
        if (call) {
          const revoked = await coordinator.handle(new ManagedProcessMessage(grant, "revoke-reservation", { grant,
            data: { call: { callId: call.callId, capability: call.capability, bindingDigest: grant.bindingDigest } } }));
          assert.equal(revoked.payload.ok, true);
        }
      },
    });
    ({ coordinator, grant } = value);
    writerHook.mock.restore();
    writerHook = null;
    request = new ManagedProcessMessage(grant, "reserve", { grant, data: { binding: null, graceMs: 500 } });
    coordinator.store.faultInjector = ({ phase, filePath, tempPath }) => {
      if (stageObservation !== undefined || phase !== "before-runtime-dependency-temp-close"
        || !filePath.includes(`${path.sep}requests${path.sep}`)
        || path.basename(path.dirname(filePath)) !== "blocks") return;
      const snapshot = coordinator.store.file.readSnapshot();
      stageObservation = { phase, filePath, tempPath, exists: fs.existsSync(tempPath),
        transitionAbsent: coordinator.store.transition.readSnapshot() === null,
        registry: snapshot === null ? null : { digest: snapshot.digest, identity: snapshot.identity.toJSON(), bytes: snapshot.byteLength } };
      gate.mark("stage");
      stageObservation.readerReachedAfter = gate.wait("after");
    };
    const reserved = await coordinator.handle(request);
    assert.equal(reserved.payload.ok, true);
    call = reserved.payload.value;
    coordinator.store.faultInjector = () => {};
    const snapshot = coordinator.store.file.readSnapshot();
    writerFinished = { transitionAbsent: coordinator.store.transition.readSnapshot() === null,
      admissionAbsent: coordinator.store.admission.inspect() === null,
      registry: snapshot === null ? null : { digest: snapshot.digest, identity: snapshot.identity.toJSON(), bytes: snapshot.byteLength } };
    gate.mark("done");
    observation = await observed;
    saveProof();
    t.diagnostic(JSON.stringify({ proofPath, requestId: request.requestId, checkpoint: checkpoint.toJSON(),
      timingPremise: observation.timingPremise, elapsedMs: observation.elapsedMs,
      reads: observation.reads?.map(({ ordinal, catchSide, captureCompleted, snapshot, startedElapsedMs, completedElapsedMs }) =>
        ({ ordinal, catchSide, captureCompleted, snapshot, startedElapsedMs, completedElapsedMs })),
      observerError: observation.error }));
    assert.equal(observation.workerError, undefined, JSON.stringify(observation));
    assert.equal(observation.setupInterrupted, undefined, JSON.stringify(observation));
    assert.deepEqual(writerBefore, { filePath: coordinator.store.file.filePath,
      captureCompleted: true, missing: true, readerCaptured: true });
    assert.equal(stageObservation?.exists, true, JSON.stringify(stageObservation));
    assert.equal(stageObservation.transitionAbsent, true);
    assert.equal(stageObservation.readerReachedAfter, true);
    assert.equal(observation.timingPremise, true, "the warmed real writer must finish inside the unchanged observation window");
    const [before, inventoryRead, after] = observation.reads;
    assert.equal(before.captureCompleted, true);
    assert.equal(before.snapshot, null, "the original snapshot method must capture actual absence");
    assert.deepEqual(inventoryRead.snapshot, stageObservation.registry);
    assert.equal(after.catchSide, true, JSON.stringify(after));
    assert.equal(after.captureCompleted, true);
    assert.deepEqual(after.snapshot, writerFinished.registry);
    assert.notEqual(after.snapshot, null);
    assert.equal(writerFinished.transitionAbsent, true);
    assert.equal(writerFinished.admissionAbsent, true);
    assert.equal(observation.error, undefined, JSON.stringify(observation.error));
    const execution = observation.inventory.executions.find(entry => entry.executionId === coordinator.executionId);
    assert.equal(execution.ownerEpoch, grant.ownerEpoch);
    assert.equal(execution.requests.find(entry => entry.requestId === request.requestId).operation, "reserve");
    assert.equal(execution.calls.length, 1);
    assert.equal(execution.calls[0].callId, call.callId);
    assert.equal(execution.calls[0].status, "intent");
    assert.equal(execution.calls[0].receipt, null);
  } catch (cause) {
    testTemporaryRoot().retainOnUnconfirmedExecution();
    try { saveProof(cause); }
    catch (proofFailure) {
      throw new AggregateError([cause, proofFailure], "Initial inventory failure proof could not be saved", { cause });
    }
    t.diagnostic(JSON.stringify({ proofPath, writerBefore, stageObservation, writerFinished,
      observerError: observation?.error, observerElapsedMs: observation?.elapsedMs, originalFailure: cause.message }));
    throw cause;
  } finally {
    gate.abort();
    writerHook?.mock.restore();
    if (coordinator) coordinator.store.faultInjector = () => {};
  }
});

test("a public inventory reader reobserves an owned request stage before its publication journal is selected", { timeout: 45000 }, async t => {
  const { root, coordinator, grant } = fixture(t);
  const state = new Int32Array(new SharedArrayBuffer(8));
  let worker;
  t.after(async () => {
    Atomics.store(state, 0, 1); Atomics.notify(state, 0);
    Atomics.store(state, 1, 1); Atomics.notify(state, 1);
    if (worker) await worker.terminate();
  });
  worker = new Worker(new URL("../../fixtures/process-runtime-inventory-observer.mjs", import.meta.url),
    { workerData: { mainRoot: root, state: state.buffer } });
  assert.deepEqual((await once(worker, "message"))[0], { phase: "ready" });
  const observed = once(worker, "message");
  let staged = false;
  coordinator.store.faultInjector = ({ phase, filePath, tempPath }) => {
    if (staged || phase !== "before-runtime-dependency-temp-close"
      || !filePath.includes(`${path.sep}requests${path.sep}`)) return;
    staged = true;
    assert.equal(coordinator.store.transition.readSnapshot(), null);
    assert.equal(fs.existsSync(tempPath), true);
    Atomics.store(state, 0, 1); Atomics.notify(state, 0);
    assert.notEqual(Atomics.wait(state, 1, 0, 20000), "timed-out", "the independently scheduled reader must reach the preparation window");
  };
  const request = new ManagedProcessMessage(grant, "reserve", { grant, data: { binding: null, graceMs: 500 } });
  const reserved = await coordinator.handle(request);
  coordinator.store.faultInjector = () => {};
  assert.equal(staged, true);
  assert.equal(reserved.payload.ok, true);
  const call = reserved.payload.value;
  try {
    const result = (await observed)[0];
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    const saved = result.inventory.executions.find(entry => entry.executionId === coordinator.executionId);
    // The first publication accepts the request before its operation executes.
    // A coherent live read may therefore precede the call's reservation.
    const accepted = saved.requests.find(entry => entry.requestId === request.requestId);
    assert.ok(accepted, "the reader must observe the committed acceptance whose preparation it crossed");
    assert.equal(accepted.operation, "reserve");
    assert.equal(saved.ownerEpoch, grant.ownerEpoch);
    for (const entry of saved.calls) {
      assert.equal(entry.callId, call.callId);
      assert.equal(entry.status, "intent");
      assert.equal(entry.receipt, null);
    }
  } finally {
    const revoked = await coordinator.handle(new ManagedProcessMessage(grant, "revoke-reservation", { grant,
      data: { call: { callId: call.callId, capability: call.capability, bindingDigest: grant.bindingDigest } } }));
    assert.equal(revoked.payload.ok, true);
  }
});

test("published writer exclusion never makes a stable foreign request block valid", async t => {
  const { coordinator, grant } = fixture(t);
  const response = await coordinator.handle(new ManagedProcessMessage(grant, "reserve",
    { grant, data: { binding: null, graceMs: 500 } }));
  assert.equal(response.payload.ok, true);
  const call = response.payload.value;
  const revoked = await coordinator.handle(new ManagedProcessMessage(grant, "revoke-reservation", { grant,
    data: { call: { callId: call.callId, capability: call.capability, bindingDigest: grant.bindingDigest } } }));
  assert.equal(revoked.payload.ok, true);
  const directory = coordinator.store.requestBlockDirectory(coordinator.executionId, { create: false }).directory;
  const foreign = path.join(directory, `${randomUUID()}.json`);
  fs.writeFileSync(foreign, "foreign block");
  try {
    coordinator.store.admission.runExclusive(() => {
      assert.equal(coordinator.store.admission.ownerSession, coordinator.store.ownerLock.ownerSession);
      assert.throws(() => coordinator.store.readConsistentInventory(), error => {
        assert.equal(error.code, "PROCESS_EXECUTION_DURABILITY_UNCERTAIN");
        assert.equal(error.cause.code, "PROCESS_EXECUTION_RECORD_CORRUPT");
        return true;
      });
      assert.equal(fs.readFileSync(foreign, "utf8"), "foreign block");
    });
  } finally { fs.unlinkSync(foreign); }
});

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
  const ledger = committedRequest(coordinator, message.requestId);
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
  const ledger = committedRequest(coordinator, message.requestId);
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

import { ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { executionValueDigest } from "../../../src/lib/process-execution-values.js";

function cohortReserve(grant, data = {}, requestId = randomUUID()) {
  return new ManagedProcessMessage(grant, "reserve", { grant,
    data: { binding: null, timeoutMs: null, graceMs: 500, ...data } }, { requestId });
}
function cohortPublicationObserver(t, coordinator, root, requestIds, beforeSave = () => {}) {
  const observed = [];
  const save = coordinator.store.save.bind(coordinator.store);
  t.mock.method(coordinator.store, "save", (registry, options) => {
    beforeSave(registry.executions.find((entry) => entry.executionId === coordinator.executionId));
    const result = save(registry, options);
    // Reopen through the real independent strict reader, without changing the
    // writer Store's observations or passing its returned logical result on.
    const history = ProcessExecutionRuntime.inspect({ mainRoot: root });
    const current = history.executions.find((entry) => entry.executionId === coordinator.executionId);
    observed.push({ calls: current.calls, events: current.events,
      requests: current.requests.filter((entry) => requestIds.includes(entry.requestId)) });
    return result;
  });
  return observed;
}
async function revokeCohortIntents(coordinator, grant) {
  const root = coordinator.store.readInventory().executions.find((entry) => entry.executionId === coordinator.executionId);
  for (const call of root.calls.filter((entry) => entry.status === "intent")) {
    const response = await coordinator.handle(new ManagedProcessMessage(grant, "revoke-reservation", { grant, data: {
      call: { callId: call.callId, capability: call.capability, bindingDigest: executionValueDigest(call.binding) },
      reason: "cancelled-before-launch",
    } }));
    assert.equal(response.payload.ok, true);
  }
}

test("a call context refuses a replaced retained directory without changing the registry or foreign contents", { timeout: 30000 }, async (t) => {
  const { coordinator, grant } = fixture(t);
  const reserved = await coordinator.handle(cohortReserve(grant));
  assert.equal(reserved.payload.ok, true);
  const execution = coordinator.store.read().executions.find((entry) => entry.executionId === coordinator.executionId);
  const call = execution.calls.find((entry) => entry.callId === reserved.payload.value.callId);
  const context = coordinator.store.callContext(execution, call);
  const directory = path.dirname(context.outcomePath), original = `${directory}.fixture-original`;
  const before = coordinator.store.file.read();
  fs.renameSync(directory, original);
  fs.mkdirSync(directory);
  const foreign = path.join(directory, "foreign.txt");
  fs.writeFileSync(foreign, "another generation\n");
  try {
    assert.throws(() => coordinator.store.callContext(execution, call),
      (error) => RealDirectoryAuthority.isAuthorityFailure(error));
    assert.deepEqual(coordinator.store.file.read(), before);
    assert.equal(fs.readFileSync(foreign, "utf8"), "another generation\n");
    assert.equal(fs.existsSync(context.outcomePath), false);
  } finally {
    // Only the test's deliberate replacement is removed. Restore the actual
    // original inode before legally revoking this never-launched reservation.
    fs.rmSync(directory, { recursive: true });
    fs.renameSync(original, directory);
    await revokeCohortIntents(coordinator, grant);
  }
});

test("logical request coalescing persists every pending identity before reservations and publishes exact replayable results", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const messages = [cohortReserve(grant), cohortReserve(grant)];
  const ids = messages.map((message) => message.requestId);
  const observed = cohortPublicationObserver(t, coordinator, root, ids);
  let released = false;
  const first = coordinator.handle(messages[0]).then((response) => { released = true; return response; });
  const duplicate = coordinator.handle(ManagedProcessMessage.from(JSON.parse(JSON.stringify(messages[0]))));
  const second = coordinator.handle(messages[1]);
  const [one, two, repeated] = await Promise.all([first, second, duplicate]);
  assert.equal(released, true);
  assert.deepEqual(repeated, one);
  for (const [index, response] of [one, two].entries()) {
    assert.equal(response.respondsTo(messages[index]), true);
    assert.equal(response.payload.ok, true);
  }
  const accepted = observed.find((entry) => entry.requests.length === 2 && entry.requests.every((request) => request.response === null));
  assert.ok(accepted, "the actual common publication must durably accept both identities before either reservation");
  assert.deepEqual(accepted.requests.map((request) => request.requestId), ids);
  assert.deepEqual(accepted.calls, []); assert.deepEqual(accepted.events, []);
  const committed = observed.at(-1);
  assert.deepEqual(committed.requests.map((request) => request.requestId), ids);
  assert.deepEqual(committed.requests.map((request) => request.response), [one.payload, two.payload]);
  assert.deepEqual(committed.calls.map((call) => call.callId), [one.payload.value.callId, two.payload.value.callId]);
  assert.deepEqual(committed.events.map((event) => event.type), ["reserved", "reserved"]);
  assert.equal(new Set(committed.calls.map((call) => call.callId)).size, 2);
  assert.equal(new Set(committed.calls.map((call) => call.capability)).size, 2);
  const beforeReplay = executionValueDigest(ProcessExecutionRuntime.inspect({ mainRoot: root }));
  assert.deepEqual(await coordinator.handle(messages[0]), one);
  assert.deepEqual(await coordinator.handle(messages[1]), two);
  assert.equal(executionValueDigest(ProcessExecutionRuntime.inspect({ mainRoot: root })), beforeReplay);
  await revokeCohortIntents(coordinator, grant);
});

test("cohort publication preserves a valid admission change made at the save boundary", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const messages = [cohortReserve(grant), cohortReserve(grant)];
  const ids = messages.map((message) => message.requestId);
  let changed = false;
  cohortPublicationObserver(t, coordinator, root, ids, (record) => {
    if (record.requests.filter((request) => ids.includes(request.requestId) && request.response?.ok).length !== 2) return;
    record.accepting = false;
    changed = true;
  });
  const responses = await Promise.all(messages.map((message) => coordinator.handle(message)));
  assert.equal(changed, true);
  assert.equal(responses.every((response) => response.payload.ok), true);
  const cold = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  assert.equal(cold.accepting, false);
  assert.deepEqual(cold.requests.map((request) => request.response), responses.map((response) => response.payload));
  const later = await coordinator.handle(cohortReserve(grant));
  assert.equal(later.payload.ok, false);
  assert.equal(ProcessExecutionControlFailure.fromStored(later.payload.error).code, "PROCESS_EXECUTION_REGISTRATION_CLOSED");
  await revokeCohortIntents(coordinator, grant);
});

test("an already queued bounded arrival stream shares one durable acceptance and completion", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const messages = Array.from({ length: 8 }, () => cohortReserve(grant));
  const ids = messages.map((message) => message.requestId);
  const observed = cohortPublicationObserver(t, coordinator, root, ids);
  const pending = messages.slice(0, 2).map((message) => coordinator.handle(message));
  // A filled delivery queue exposes successive already-prepared inputs on
  // consecutive I/O turns. There is no elapsed-time sleep or absent peer.
  await new Promise((resolve) => {
    let index = 2;
    const deliver = () => {
      pending.push(coordinator.handle(messages[index++]));
      if (index === messages.length) resolve();
      else setImmediate(deliver);
    };
    setImmediate(deliver);
  });
  const responses = await Promise.all(pending);
  const publications = [...observed];
  const current = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  for (const [index, response] of responses.entries()) {
    assert.equal(response.respondsTo(messages[index]), true);
    assert.equal(response.payload.ok, true);
  }
  assert.deepEqual(current.requests.filter((request) => ids.includes(request.requestId)).map((request) => request.response),
    responses.map((response) => response.payload));
  // Close this successful reservation-only lifetime before the cost assertion;
  // a failed assessment never re-enters a failed or unconfirmed runtime.
  await revokeCohortIntents(coordinator, grant);
  assert.equal((await coordinator.handle(new ManagedProcessMessage(grant, "close", { grant, data: {} }))).payload.ok, true);
  assert.equal((await coordinator.handle(new ManagedProcessMessage(grant, "release-root", { grant, data: {} }))).payload.ok, true);
  assert.equal(publications.length, 2, "the bounded arriving stream must share its two durable publication boundaries");
  assert.deepEqual(publications[0].requests.map((request) => request.requestId), ids);
  assert.equal(publications[0].requests.every((request) => request.response === null), true);
  assert.deepEqual(publications[0].calls, []);
  assert.deepEqual(publications[1].requests.map((request) => request.response), responses.map((response) => response.payload));
  assert.equal(publications[1].calls.length, messages.length);
});

test("cohort readiness neither waits for absent peers nor crosses an intervening FIFO job", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const messages = Array.from({ length: 4 }, () => cohortReserve(grant));
  const barrier = new ExclusiveBarrier();
  let delivered = 0, laterDelivered = false, held, later, blocked;
  const first = messages.slice(0, 2).map((message) => coordinator.handle(message)
    .then((response) => { delivered++; return response; }));
  await new Promise((resolve) => setImmediate(() => {
    first.push(coordinator.handle(messages[2]).then((response) => { delivered++; return response; }));
    held = coordinator.store.exclusive(() => barrier.hold());
    later = coordinator.handle(messages[3]).then((response) => { laterDelivered = true; return response; });
    resolve();
  }));
  let responses, last;
  try {
    await barrier.entered;
    blocked = { delivered, laterDelivered,
      current: ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0] };
    responses = await Promise.all(first);
  } finally {
    barrier.release();
    await held;
    last = await later;
  }
  await revokeCohortIntents(coordinator, grant);
  assert.equal((await coordinator.handle(new ManagedProcessMessage(grant, "close", { grant, data: {} }))).payload.ok, true);
  assert.equal((await coordinator.handle(new ManagedProcessMessage(grant, "release-root", { grant, data: {} }))).payload.ok, true);
  assert.equal(blocked.delivered, 3, "the underfilled earlier group must deliver before work requiring a later peer");
  assert.equal(blocked.laterDelivered, false);
  assert.deepEqual(blocked.current.requests.map((request) => request.requestId), messages.slice(0, 3).map((message) => message.requestId));
  assert.equal(blocked.current.calls.length, 3);
  for (const [index, response] of [...responses, last].entries()) {
    assert.equal(response.respondsTo(messages[index]), true);
    assert.equal(response.payload.ok, true);
  }
});

test("cohort publication rejects a globally invalid save input and retains only pending acceptances", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const messages = [cohortReserve(grant), cohortReserve(grant)];
  const ids = messages.map((message) => message.requestId);
  let changed = false;
  cohortPublicationObserver(t, coordinator, root, ids, (record) => {
    if (record.requests.filter((request) => ids.includes(request.requestId) && request.response?.ok).length !== 2) return;
    record.hostConnected = false;
    changed = true;
  });
  const results = await Promise.allSettled(messages.map((message) => coordinator.handle(message)));
  assert.equal(changed, true);
  assert.equal(results.every((result) => result.status === "rejected" && result.reason.code === "PROCESS_EXECUTION_REGISTRY_FAILED"), true);
  const cold = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  assert.equal(cold.hostConnected, true);
  assert.deepEqual(cold.calls, []);
  assert.deepEqual(cold.events, []);
  assert.deepEqual(cold.requests.map((request) => request.requestId), ids);
  assert.equal(cold.requests.every((request) => request.response === null), true);
});

test("logical request coalescing preserves a successful request beside a lawful refusal and accepts subsequent work", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const messages = [cohortReserve(grant), cohortReserve(grant, { timeoutMs: -1 })];
  const responses = await Promise.all(messages.map((message) => coordinator.handle(message)));
  assert.equal(responses[0].payload.ok, true);
  assert.equal(responses[1].payload.ok, false);
  const failure = ProcessExecutionControlFailure.fromStored(responses[1].payload.error);
  assert.equal(failure.code, "PROCESS_EXECUTION_CONTROL_FAILED");
  const current = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  assert.deepEqual(current.requests.map((request) => request.requestId), messages.map((message) => message.requestId));
  assert.deepEqual(current.requests.map((request) => request.response), responses.map((response) => response.payload));
  assert.equal(current.calls.length, 1); assert.equal(current.calls[0].callId, responses[0].payload.value.callId);
  assert.deepEqual((await coordinator.handle(messages[1])).payload, responses[1].payload);
  const later = await coordinator.handle(cohortReserve(grant));
  assert.equal(later.payload.ok, true);
  assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0].calls.length, 2);
  await revokeCohortIntents(coordinator, grant);
});

test("logical request coalescing retains all accepted requests without granting results when completion publication fails", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const messages = [cohortReserve(grant), cohortReserve(grant)];
  const ids = messages.map((message) => message.requestId);
  let injected = false;
  const observed = cohortPublicationObserver(t, coordinator, root, ids, (record) => {
    const requests = record.requests.filter((request) => ids.includes(request.requestId));
    if (!injected && requests.length === 2 && requests.every((request) => request.response?.ok)) {
      injected = true; throw new Error("injected coalesced completion publication failure");
    }
  });
  const results = await Promise.allSettled(messages.map((message) => coordinator.handle(message)));
  assert.equal(injected, true);
  assert.equal(observed.some((entry) => entry.requests.length === 2 && entry.requests.every((request) => request.response === null)), true);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.code, "PROCESS_EXECUTION_REGISTRY_FAILED");
  }
  const current = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  assert.deepEqual(current.calls, []); assert.deepEqual(current.events, []);
  assert.deepEqual(current.requests.map((request) => request.requestId), ids);
  assert.equal(current.requests.every((request) => request.response === null), true);
  const digest = executionValueDigest(current);
  for (const message of messages) await assert.rejects(coordinator.handle(message), { code: "PROCESS_EXECUTION_REQUEST_UNCONFIRMED" });
  assert.equal(executionValueDigest(ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0]), digest);
});

test("logical request coalescing leaves no accepted identity after failed acceptance and permits a fresh same-ID attempt", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const messages = [cohortReserve(grant), cohortReserve(grant)];
  const ids = messages.map((message) => message.requestId);
  let injected = false;
  cohortPublicationObserver(t, coordinator, root, ids, (record) => {
    if (!injected && record.requests.filter((request) => ids.includes(request.requestId)).length === 2) {
      injected = true; throw new Error("injected coalesced acceptance publication failure");
    }
  });
  const failed = await Promise.allSettled(messages.map((message) => coordinator.handle(message)));
  assert.equal(injected, true);
  assert.equal(failed.every((result) => result.status === "rejected" && result.reason.code === "PROCESS_EXECUTION_REGISTRY_FAILED"), true);
  const unchanged = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  assert.deepEqual(unchanged.requests, []); assert.deepEqual(unchanged.calls, []); assert.deepEqual(unchanged.events, []);
  const retried = await Promise.all(messages.map((message) => coordinator.handle(message)));
  assert.equal(retried.every((response) => response.payload.ok), true);
  const current = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  assert.deepEqual(current.requests.map((request) => request.requestId), ids);
  assert.equal(current.calls.length, 2);
  await revokeCohortIntents(coordinator, grant);
});

test("logical request coalescing cannot cross an intervening Store FIFO admission or delay its first committed response", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const following = new ExclusiveBarrier();
  const messages = [cohortReserve(grant), cohortReserve(grant)];
  const jobs = [];
  let first, second, winner;
  try {
    first = coordinator.handle(messages[0]); jobs.push(first);
    jobs.push(coordinator.store.exclusive(() => following.hold()));
    second = coordinator.handle(messages[1]); jobs.push(second);
    winner = await Promise.race([first.then((response) => ({ response })), following.entered.then(() => null)]);
  } finally {
    following.release();
    const settled = await Promise.allSettled(jobs);
    for (const result of settled) assert.equal(result.status, "fulfilled", result.reason?.message);
  }
  assert.notEqual(winner, null, "the first real response must be delivered before the next FIFO body may block");
  assert.equal(winner.response.payload.ok, true);
  assert.equal((await second).payload.ok, true);
  const current = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  assert.deepEqual(current.requests.map((request) => request.requestId), messages.map((message) => message.requestId));
  assert.equal(current.calls.length, 2);
  await revokeCohortIntents(coordinator, grant);
});

test("logical request coalescing claims actual executors and preserves their native exit receipts through reload", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const reserved = await Promise.all([cohortReserve(grant), cohortReserve(grant)].map((message) => coordinator.handle(message)));
  assert.equal(reserved.every((response) => response.payload.ok), true);
  const calls = reserved.map((response) => ({ callId: response.payload.value.callId,
    capability: response.payload.value.capability, bindingDigest: grant.bindingDigest }));
  const executors = calls.map(() => new ProcessExecutorIdentity({ executorId: randomUUID(), executorSession: randomUUID(), launchClaim: randomUUID() }));
  const messages = calls.map((call, index) => new ManagedProcessMessage(grant, "claim-launch", {
    grant, data: { call, executor: executors[index].toJSON() },
  }));
  const ids = messages.map((message) => message.requestId);
  const observed = cohortPublicationObserver(t, coordinator, root, ids);
  const permits = await Promise.all(messages.map((message) => coordinator.handle(message)));
  assert.equal(permits.every((response) => response.payload.ok), true);
  const pending = observed.find((entry) => entry.requests.length === 2 && entry.requests.every((request) => request.response === null));
  assert.ok(pending);
  assert.equal(pending.calls.every((call) => call.status === "intent" && call.executor === null && call.permit === null), true);
  const claimed = observed.at(-1);
  assert.equal(claimed.calls.every((call) => call.status === "claimed"), true);
  assert.deepEqual(claimed.calls.map((call) => call.executor), executors.map((executor) => executor.toJSON()));
  assert.deepEqual(claimed.requests.map((request) => request.response), permits.map((response) => response.payload));
  assert.deepEqual(claimed.calls.map((call) => call.permit), permits.map((response) => response.payload.value));
  const observations = await Promise.all(calls.map(async (call, index) => {
    const effect = path.join(root, `executor-${index}.effect`);
    const child = spawn(process.execPath, ["-e", `require('node:fs').appendFileSync(${JSON.stringify(effect)},'effect\\n')`], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit"), closed = once(child, "close");
    const bytes = { stdout: [], stderr: [] };
    for (const stream of ["stdout", "stderr"]) child[stream].on("data", (part) => bytes[stream].push(part));
    await once(child, "spawn");
    const started = await coordinator.handle(new ManagedProcessMessage(grant, "observe", { grant,
      data: { call, type: "started", executor: executors[index].toJSON(), startedAt: new Date().toISOString() } }));
    assert.equal(started.payload.ok, true);
    const [code, signal] = await exited; await closed;
    assert.equal(code, 0); assert.equal(signal, null);
    assert.equal(fs.readFileSync(effect, "utf8"), "effect\n");
    assert.equal(Buffer.concat(bytes.stdout).length, 0); assert.equal(Buffer.concat(bytes.stderr).length, 0);
    const observation = new ChildExitObservation({ executor: executors[index], kind: "exited", code, signal, observedAt: new Date().toISOString() });
    const stopped = await coordinator.handle(new ManagedProcessMessage(grant, "observe", { grant,
      data: { call, type: "exit", observation: observation.toJSON() } }));
    assert.equal(stopped.payload.ok, true);
    return observation;
  }));
  const receipts = [];
  for (const [index, call] of calls.entries()) {
    const output = { maximum: 0 };
    for (const stream of ["stdout", "stderr"]) {
      const snapshot = ManagedOutputSnapshot.capture(Buffer.alloc(0), 0);
      const persisted = await coordinator.handle(new ManagedProcessMessage(grant, "persist-call-output", { grant, data: {
        call, executor: executors[index].toJSON(), stream, maximum: 0,
        snapshot: snapshot.toJSON(), offset: 0, bytes: "",
      } }));
      assert.equal(persisted.payload.ok, true); assert.equal(persisted.payload.value.complete, true);
      assert.deepEqual(persisted.payload.value.snapshot, snapshot.toJSON()); output[stream] = snapshot.toJSON();
    }
    const completed = await coordinator.handle(new ManagedProcessMessage(grant, "finish", { grant, data: {
      call, observation: observations[index].toJSON(), outcome: { code: 0, signal: null, output },
      output: new ProcessOutputState({ stdoutBytes: 0, stderrBytes: 0, completion: "complete", cutoffAt: new Date().toISOString() }).toJSON(),
    } }));
    assert.equal(completed.payload.ok, true);
    const receipt = new ProcessExecutionStopReceipt(completed.payload.value);
    assert.equal(receipt.callId, call.callId); assert.deepEqual(receipt.executor.toJSON(), executors[index].toJSON());
    assert.equal(receipt.stopEvidence.status, "confirmed"); assert.equal(receipt.observation.code, 0);
    receipts.push(receipt);
  }
  const reloaded = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  assert.equal(reloaded.calls.length, 2);
  assert.deepEqual(reloaded.calls.map((call) => call.receipt), receipts.map((receipt) => receipt.toJSON()));
  const digest = executionValueDigest(reloaded);
  for (const [index, message] of messages.entries()) assert.deepEqual(await coordinator.handle(message), permits[index]);
  assert.equal(executionValueDigest(ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0]), digest);
  for (let index = 0; index < calls.length; index++) assert.equal(fs.readFileSync(path.join(root, `executor-${index}.effect`), "utf8"), "effect\n");
});

test("logical request coalescing preserves serial first admission at the unchanged physical capacity boundary", async (t) => {
  const { root, coordinator, grant } = fixture(t);
  // Each binding and its future private receipt individually fits the original
  //16MiB sink. Two such call bindings plus required framing cannot share one
  // canonical registry. This is ordinary input through the real capacity API.
  const binding = { content: "x".repeat(8 * 1024 * 1024) };
  const messages = [cohortReserve(grant, { binding }), cohortReserve(grant, { binding })];
  const responses = await Promise.all(messages.map((message) => coordinator.handle(message)));
  assert.equal(responses[0].payload.ok, true, "group preparation must preserve the lawful first serial reservation");
  assert.equal(responses[1].payload.ok, false);
  assert.equal(ProcessExecutionControlFailure.fromStored(responses[1].payload.error).code, "PROCESS_EXECUTION_RECORD_CAPACITY");
  const reloaded = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  assert.equal(reloaded.calls.length, 1); assert.equal(reloaded.calls[0].callId, responses[0].payload.value.callId);
  assert.deepEqual(reloaded.calls[0].binding, binding);
  assert.deepEqual(reloaded.requests.map((request) => request.requestId), messages.map((message) => message.requestId));
  assert.deepEqual(reloaded.requests.map((request) => request.response), responses.map((response) => response.payload));
  await revokeCohortIntents(coordinator, grant);
  const revoked = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0].calls[0];
  assert.equal(revoked.status, "revoked"); assert.equal(revoked.receipt, null);
  assert.equal(revoked.revocation.callId, responses[0].payload.value.callId);
});


// Native children supply these observations and bytes. No internal call,
// observation, sealed output, receipt or authority is manufactured as a seed.
async function nativeCohortLeaves(coordinator, grant, root, count = 2) {
  const reserved = await Promise.all(Array.from({ length: count }, () => cohortReserve(grant)).map((message) => coordinator.handle(message)));
  assert.equal(reserved.every((response) => response.payload.ok), true);
  const calls = reserved.map((response) => ({ callId: response.payload.value.callId,
    capability: response.payload.value.capability, bindingDigest: grant.bindingDigest }));
  const executors = calls.map(() => new ProcessExecutorIdentity({ executorId: randomUUID(), executorSession: randomUUID(), launchClaim: randomUUID() }));
  const claim = await Promise.all(calls.map((call, index) => coordinator.handle(new ManagedProcessMessage(grant, "claim-launch", {
    grant, data: { call, executor: executors[index].toJSON() },
  }))));
  assert.equal(claim.every((response) => response.payload.ok), true);
  const native = await Promise.all(calls.map(async (call, index) => {
    const effect = path.join(root, `leaf-${index}.effect`);
    const child = spawn(process.execPath, ["-e", `require('node:fs').appendFileSync(${JSON.stringify(effect)},'once');process.stdout.write('leaf-${index}');process.stderr.write('error-${index}')`], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit"), closed = once(child, "close");
    const bytes = { stdout: [], stderr: [] };
    for (const stream of ["stdout", "stderr"]) child[stream].on("data", (part) => bytes[stream].push(part));
    await once(child, "spawn");
    const startedAt = new Date().toISOString();
    const [code, signal] = await exited; await closed;
    assert.equal(code, 0); assert.equal(signal, null);
    assert.equal(fs.readFileSync(effect, "utf8"), "once");
    const observation = new ChildExitObservation({ executor: executors[index], kind: "exited", code, signal, observedAt: new Date().toISOString() });
    return { call, executor: executors[index], startedAt, observation, effect,
      bytes: Object.fromEntries(Object.entries(bytes).map(([stream, parts]) => [stream, Buffer.concat(parts)])) };
  }));
  const message = (operation, leaf, data) => new ManagedProcessMessage(grant, operation, { grant, data: { call: leaf.call, ...data } });
  return {
    native,
    started: native.map((leaf) => message("observe", leaf, { type: "started", executor: leaf.executor.toJSON(), startedAt: leaf.startedAt })),
    exited: native.map((leaf) => message("observe", leaf, { type: "exit", observation: leaf.observation.toJSON() })),
    async finishMessages() {
      const messages = [];
      for (const leaf of native) {
        const output = { maximum: 1024 };
        for (const stream of ["stdout", "stderr"]) {
          const bytes = leaf.bytes[stream], snapshot = ManagedOutputSnapshot.capture(bytes, 1024);
          const persisted = await coordinator.handle(message("persist-call-output", leaf, { executor: leaf.executor.toJSON(), stream,
            maximum: 1024, snapshot: snapshot.toJSON(), offset: 0, bytes: bytes.toString("base64") }));
          assert.equal(persisted.payload.ok, true); assert.equal(persisted.payload.value.complete, true);
          assert.deepEqual(persisted.payload.value.snapshot, snapshot.toJSON()); output[stream] = snapshot.toJSON();
        }
        messages.push(message("finish", leaf, { observation: leaf.observation.toJSON(), outcome: { code: 0, signal: null, output },
          output: new ProcessOutputState({ stdoutBytes: leaf.bytes.stdout.length, stderrBytes: leaf.bytes.stderr.length,
            completion: "complete", cutoffAt: new Date().toISOString() }).toJSON() }));
      }
      return messages;
    },
  };
}

test("completed finish replays preserve the preceding independent shared publication and every real receipt", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const leaves = await nativeCohortLeaves(coordinator, grant, root, 3);
  for (const messages of [leaves.started, leaves.exited]) {
    const observed = await Promise.all(messages.map((message) => coordinator.handle(message)));
    assert.equal(observed.every((response) => response.payload.ok), true);
  }
  const messages = await leaves.finishMessages();
  const original = await coordinator.handle(messages[2]);
  assert.equal(original.payload.ok, true);
  const ids = messages.slice(0, 2).map((message) => message.requestId);
  const observed = cohortPublicationObserver(t, coordinator, root, ids);
  const responses = await Promise.all(messages.map((message) => coordinator.handle(message)));
  assert.equal(responses.every((response) => response.payload.ok), true);
  assert.deepEqual(responses[2], original);
  const pending = observed.find((entry) => entry.requests.length === 2
    && entry.requests.every((request) => request.response === null));
  assert.ok(pending, "both new finish identities must be durable together before either receipt, despite a later exact replay");
  assert.equal(pending.calls.slice(0, 2).every((call) => call.receipt === null && call.status === "exited"), true);
  assert.deepEqual(pending.calls[2].receipt, original.payload.value);
  assert.equal(observed.every((entry) => entry.requests.length === 0 || entry.requests.length === 2), true);
  const cold = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  assert.deepEqual(cold.calls.map((call) => call.receipt), responses.map((response) => response.payload.value));
  for (const [index, call] of cold.calls.entries()) {
    const receipt = new ProcessExecutionStopReceipt(call.receipt), leaf = leaves.native[index];
    assert.equal(receipt.stopEvidence.status, "confirmed");
    assert.equal(receipt.callId, leaf.call.callId);
    assert.deepEqual(receipt.observation.toJSON(), leaf.observation.toJSON());
    assert.equal(fs.readFileSync(leaf.effect, "utf8"), "once");
  }
  const digest = executionValueDigest(cold);
  for (const [index, message] of messages.entries()) {
    assert.deepEqual(await coordinator.handle(ManagedProcessMessage.from(JSON.parse(JSON.stringify(message)))), responses[index]);
  }
  assert.equal(executionValueDigest(ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0]), digest);
});


test("leaf request coalescing preserves durable observation acceptances and every native finish receipt through cold reload", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const leaves = await nativeCohortLeaves(coordinator, grant, root);
  const phases = [];
  for (const messages of [leaves.started, leaves.exited]) {
    const ids = messages.map((message) => message.requestId);
    const observed = cohortPublicationObserver(t, coordinator, root, ids, (incoming) => {
      if (!incoming.requests.some((request) => ids.includes(request.requestId))) return;
      assert.equal(incoming.requests.filter((request) => ids.includes(request.requestId)).length, 2,
        "a complete independent observation cohort is published together");
      for (const id of ids) assert.equal(committedRequest(coordinator, id).response, null,
        "every standalone acceptance is durable before the shared observed effect");
    });
    const responses = await Promise.all(messages.map((message) => coordinator.handle(message)));
    assert.equal(responses.every((response) => response.payload.ok), true);
    assert.ok(observed.some((entry) => entry.requests.length === 2));
    assert.equal(observed.every((entry) => entry.requests.length === 0 || entry.requests.length === 2), true);
    phases.push({ messages, responses });
  }
  const messages = await leaves.finishMessages();
  const ids = messages.map((message) => message.requestId);
  const observed = cohortPublicationObserver(t, coordinator, root, ids);
  const responses = await Promise.all(messages.map((message) => coordinator.handle(message)));
  assert.equal(responses.every((response) => response.payload.ok), true);
  const pending = observed.find((entry) => entry.requests.length === 2 && entry.requests.every((request) => request.response === null));
  assert.ok(pending, "both canonical pending finish identities precede any private finish publication");
  assert.equal(pending.calls.every((call) => call.receipt === null && call.status === "exited"), true);
  const cold = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  assert.deepEqual(cold.calls.map((call) => call.receipt), responses.map((response) => response.payload.value));
  for (const [index, call] of cold.calls.entries()) {
    const receipt = new ProcessExecutionStopReceipt(call.receipt), leaf = leaves.native[index];
    assert.equal(receipt.stopEvidence.status, "confirmed"); assert.equal(receipt.callId, leaf.call.callId);
    assert.deepEqual(receipt.observation.toJSON(), leaf.observation.toJSON());
    assert.equal(receipt.output.stdoutBytes, leaf.bytes.stdout.length); assert.equal(receipt.output.stderrBytes, leaf.bytes.stderr.length);
    assert.equal(fs.readFileSync(leaf.effect, "utf8"), "once");
  }
  phases.push({ messages, responses });
  const digest = executionValueDigest(cold);
  for (const phase of phases) for (const [index, message] of phase.messages.entries()) {
    assert.deepEqual(await coordinator.handle(ManagedProcessMessage.from(JSON.parse(JSON.stringify(message)))), phase.responses[index]);
  }
  assert.equal(executionValueDigest(ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0]), digest);
});


for (const phase of ["observation", "finish"]) {
  test(`leaf request coalescing retains every ${phase} acceptance after failed publication and permits explicit fresh executor reports`, { timeout: 30000 }, async (t) => {
    const { root, coordinator, grant } = fixture(t);
    const leaves = await nativeCohortLeaves(coordinator, grant, root);
    let messages;
    if (phase === "observation") messages = leaves.started;
    else {
      for (const reports of [leaves.started, leaves.exited]) {
        const responses = await Promise.all(reports.map((message) => coordinator.handle(message)));
        assert.equal(responses.every((response) => response.payload.ok), true);
      }
      messages = await leaves.finishMessages();
    }
    const ids = messages.map((message) => message.requestId);
    const sentinel = new Error(`injected ${phase} cohort completion publication failure`);
    let injected = false;
    cohortPublicationObserver(t, coordinator, root, ids, (incoming) => {
      const completed = incoming.requests.filter((request) => ids.includes(request.requestId) && request.response !== null);
      if (!injected && completed.length === messages.length) { injected = true; throw sentinel; }
    });
    const results = await Promise.allSettled(messages.map((message) => coordinator.handle(message)));
    assert.equal(injected, true);
    assert.equal(results.every((result) => result.status === "rejected" && result.reason.code === "PROCESS_EXECUTION_REGISTRY_FAILED"), true);
    const cold = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
    assert.equal(cold.calls.every((call) => call.receipt === null && call.status === (phase === "observation" ? "claimed" : "exited")), true);
    assert.equal(cold.events.some((event) => event.type === (phase === "observation" ? "started" : "result-finalized")), false);
    if (phase === "observation") {
      assert.equal(cold.requests.some((request) => ids.includes(request.requestId)), false);
      for (const id of ids) assert.equal(committedRequest(coordinator, id).response, null);
    } else {
      const accepted = cold.requests.filter((request) => ids.includes(request.requestId));
      assert.deepEqual(accepted.map((request) => request.requestId), ids);
      assert.equal(accepted.every((request) => request.response === null), true);
    }
    const digest = executionValueDigest(cold);
    for (const message of messages) await assert.rejects(coordinator.handle(message), { code: "PROCESS_EXECUTION_REQUEST_UNCONFIRMED" });
    assert.equal(executionValueDigest(ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0]), digest);
    // A separate explicit executor submission owns new request identities.
    // The rejected requests never replay effects or gain a fabricated receipt.
    const fresh = messages.map((message) => new ManagedProcessMessage(grant, message.operation, message.payload));
    assert.equal(fresh.every((message, index) => message.requestId !== messages[index].requestId), true);
    const completed = await Promise.all(fresh.map((message) => coordinator.handle(message)));
    assert.equal(completed.every((response) => response.payload.ok), true);
    if (phase === "observation") {
      assert.equal((await Promise.all(leaves.exited.map((message) => coordinator.handle(message)))).every((response) => response.payload.ok), true);
      const finishes = await leaves.finishMessages();
      assert.equal((await Promise.all(finishes.map((message) => coordinator.handle(message)))).every((response) => response.payload.ok), true);
    }
    const settled = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
    assert.equal(settled.calls.every((call) => new ProcessExecutionStopReceipt(call.receipt).stopEvidence.status === "confirmed"), true);
    for (const leaf of leaves.native) assert.equal(fs.readFileSync(leaf.effect, "utf8"), "once");
    for (const message of messages) await assert.rejects(coordinator.handle(message), { code: "PROCESS_EXECUTION_REQUEST_UNCONFIRMED" });
  });
}


test("leaf request coalescing refuses a replaced earlier pending ledger generation and preserves exact request uncertainty", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const leaves = await nativeCohortLeaves(coordinator, grant, root);
  const messages = leaves.started, ids = messages.map((message) => message.requestId);
  let replaced = false;
  cohortPublicationObserver(t, coordinator, root, ids, (incoming) => {
    if (replaced || incoming.requests.filter((request) => ids.includes(request.requestId)).length !== 2) return;
    const earlier = coordinator.store.requestFile(coordinator.executionId, ids[0]);
    const bytes = earlier.read();
    assert.notEqual(bytes, null);
    earlier.write(bytes); // Same valid bytes; different actual atomic file generation.
    assert.deepEqual(earlier.read(), bytes);
    replaced = true;
  });
  const results = await Promise.allSettled(messages.map((message) => coordinator.handle(message)));
  assert.equal(replaced, true);
  assert.equal(results.every((result) => result.status === "rejected" && result.reason.code === "PROCESS_EXECUTION_AUTHORITY_MISMATCH"), true);
  const cold = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  assert.equal(cold.calls.every((call) => call.status === "claimed" && call.observation === null && call.receipt === null), true);
  assert.equal(cold.requests.some((request) => ids.includes(request.requestId)), false);
  assert.equal(cold.events.some((event) => event.type === "started"), false);
  for (const id of ids) assert.equal(committedRequest(coordinator, id).response, null);
  const digest = executionValueDigest(cold);
  for (const message of messages) await assert.rejects(coordinator.handle(message), { code: "PROCESS_EXECUTION_REQUEST_UNCONFIRMED" });
  assert.equal(executionValueDigest(ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0]), digest);
  const fresh = messages.map((message) => new ManagedProcessMessage(grant, message.operation, message.payload));
  assert.equal((await Promise.all(fresh.map((message) => coordinator.handle(message)))).every((response) => response.payload.ok), true);
  assert.equal((await Promise.all(leaves.exited.map((message) => coordinator.handle(message)))).every((response) => response.payload.ok), true);
  const finishes = await leaves.finishMessages();
  assert.equal((await Promise.all(finishes.map((message) => coordinator.handle(message)))).every((response) => response.payload.ok), true);
  const completed = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  assert.equal(completed.calls.every((call) => new ProcessExecutionStopReceipt(call.receipt).stopEvidence.status === "confirmed"), true);
  for (const leaf of leaves.native) assert.equal(fs.readFileSync(leaf.effect, "utf8"), "once");
});


test("serial fallback publishes each committed response before the next request is admitted", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const messages = [cohortReserve(grant), cohortReserve(grant, { timeoutMs: -1 })];
  let firstDelivered = false, retryDelivered = false, atSecondAdmission = null;
  const save = coordinator.store.save.bind(coordinator.store);
  t.mock.method(coordinator.store, "save", (registry, options) => {
    const incoming = registry.executions.find((entry) => entry.executionId === coordinator.executionId);
    if (atSecondAdmission === null && incoming.requests.some((request) => request.requestId === messages[1].requestId && request.response === null)) {
      const current = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
      atSecondAdmission = { firstDelivered, retryDelivered, current };
    }
    return save(registry, options);
  });
  const first = coordinator.handle(messages[0]).then((response) => { firstDelivered = true; return response; });
  const retry = coordinator.handle(ManagedProcessMessage.from(JSON.parse(JSON.stringify(messages[0]))))
    .then((response) => { retryDelivered = true; return response; });
  const second = coordinator.handle(messages[1]);
  const responses = await Promise.all([first, retry, second]);
  const current = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  await revokeCohortIntents(coordinator, grant);
  assert.ok(atSecondAdmission, "the later serial request must reach its real durable admission");
  assert.equal(atSecondAdmission.firstDelivered, true, "a committed result must reach its consumer before later serial publication can block");
  assert.equal(atSecondAdmission.retryDelivered, true, "the identical in-flight retry must receive the same committed result");
  assert.deepEqual(atSecondAdmission.current.requests.map((request) => request.requestId), [messages[0].requestId]);
  assert.deepEqual(atSecondAdmission.current.requests[0].response, responses[0].payload);
  assert.equal(atSecondAdmission.current.calls.length, 1);
  assert.deepEqual(responses[1], responses[0]);
  assert.equal(responses[0].payload.ok, true); assert.equal(responses[2].payload.ok, false);
  assert.deepEqual(current.requests.map((request) => request.response), [responses[0].payload, responses[2].payload]);
});

test("serial fallback preserves a completed replay when a later independent admission fails", { timeout: 30000 }, async (t) => {
  const { root, coordinator, grant } = fixture(t);
  const firstMessage = cohortReserve(grant);
  const original = await coordinator.handle(firstMessage);
  const secondMessage = cohortReserve(grant);
  const sentinel = new Error("injected later serial acceptance failure");
  let injected = false;
  const save = coordinator.store.save.bind(coordinator.store);
  t.mock.method(coordinator.store, "save", (registry, options) => {
    const incoming = registry.executions.find((entry) => entry.executionId === coordinator.executionId);
    if (!injected && incoming.requests.some((request) => request.requestId === secondMessage.requestId && request.response === null)) {
      injected = true; throw sentinel;
    }
    return save(registry, options);
  });
  const settled = await Promise.allSettled([coordinator.handle(firstMessage), coordinator.handle(secondMessage)]);
  const current = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0];
  const replay = await coordinator.handle(firstMessage);
  const later = await coordinator.handle(secondMessage);
  await revokeCohortIntents(coordinator, grant);
  assert.equal(injected, true);
  assert.equal(settled[0].status, "fulfilled", "a later failure must not replace an earlier exact committed replay");
  assert.deepEqual(settled[0].value, original);
  assert.equal(settled[1].status, "rejected");
  assert.equal(settled[1].reason.code, "PROCESS_EXECUTION_REGISTRY_FAILED");
  assert.equal(settled[1].reason.cause, sentinel);
  assert.deepEqual(current.requests.map((request) => request.requestId), [firstMessage.requestId]);
  assert.deepEqual(current.requests[0].response, original.payload); assert.equal(current.calls.length, 1);
  assert.deepEqual(replay, original); assert.equal(later.payload.ok, true);
});
