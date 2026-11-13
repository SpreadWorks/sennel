import { ProcessExecutionCanonicalAcknowledgement } from "../../../src/lib/process-execution-values.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { RuntimePackageSnapshot } from "../../../src/lib/runtime-package-snapshot.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionCall, ProcessExecutionControlFailure, ProcessExecutionBindingSelection, ProcessExecutionReservationRevocation } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutorIdentity, ChildExitObservation, ProcessOutputState, ProcessExecutionControlObservation, ProcessExecutionInvocationDisclosure, executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { managedRequest, ManagedProcessMessage, ManagedRequestTransportCohort } from "../../../src/lib/managed-process-protocol.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { runCmd } from "../../../src/lib/process.js";
import { currentRuntimePackage, RuntimeChildExecution } from "../../../src/lib/runtime-package.js";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { RuntimeStandaloneRequestDocument } from "../../../src/lib/process-execution-request-block.js";
import { NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";
import { ManagedStopOperationStore } from "../../../src/lib/managed-stop-store.js";
import { ManagedControlPolicy } from "../../../src/lib/managed-control-policy.js";
import { ManagedAdmissionPublicationGate } from "../../support/infrastructure/managed-admission-publication-gate.js";
import { ManagedRuntimeStartupReadGate } from "../../support/infrastructure/managed-runtime-startup-read-gate.js";
import { waitForRuntimeHostClosure } from "../../support/infrastructure/runtime-host-closure.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function replyLossEnvironment(operation, { failSocket = false } = {}) {
  const source = `import net from 'node:net';
    const end = net.Socket.prototype.end;
    let dropped = false;
    net.Socket.prototype.end = function(chunk, ...args) {
      if (!dropped && typeof chunk === 'string' && chunk.startsWith('{')) {
        const response = JSON.parse(chunk);
        if (response.operation === ${JSON.stringify(operation)} && response.payload.ok === true) {
          dropped = true;
          ${failSocket
            ? "return this.destroy(Object.assign(new Error('Lost TCP acknowledgement'), { code: 'ECONNRESET' }));"
            : "return end.call(this, undefined, ...args);"}
        }
      }
      return end.call(this, chunk, ...args);
    };`;
  return { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=data:text/javascript;base64,${Buffer.from(source).toString("base64")}`.trim() };
}

async function fixture(t, options = {}) {
  const root = createTmpDir("execution-coordinator-");
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, ...options });
  t.after(async () => {
    try { if (!runtime.closed) await runtime.close(); }
    catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
    removeTmpDir(root);
  });
  return { root, runtime };
}
function executorIdentity() {
  return new ProcessExecutorIdentity({ executorId: randomUUID(), executorSession: randomUUID(), launchClaim: randomUUID() });
}
async function observeActualChild(runtime, call, executor, { beforeExitPublication = null } = {}) {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const completion = once(child, "exit");
  await once(child, "spawn");
  await runtime.observeCall(call, { type: "started", executor: executor.toJSON(), startedAt: new Date().toISOString() });
  const [code, signal] = await completion;
  const observation = new ChildExitObservation({ executor, kind: "exited", code, signal, observedAt: new Date().toISOString() });
  await beforeExitPublication?.(observation);
  await runtime.observeCall(call, { type: "exit", observation: observation.toJSON() });
  return observation;
}
async function finishObservedCall(runtime, call, { observation, outcome = { code: 0 } }) {
  const maximum = 0;
  const stdout = await runtime.persistCallOutput(call, { executor: observation.executor, stream: "stdout", maximum, bytes: Buffer.alloc(0) });
  const stderr = await runtime.persistCallOutput(call, { executor: observation.executor, stream: "stderr", maximum, bytes: Buffer.alloc(0) });
  return runtime.finishCall(call, { observation, outcome: { ...outcome, output: { maximum, stdout, stderr } }, output: output() });
}
function output() { return new ProcessOutputState({ stdoutBytes: 0, stderrBytes: 0, completion: "complete", cutoffAt: new Date().toISOString() }); }

test("a committed coordinator response reaches its TCP caller before the next queued admission can block publication", { timeout: 45000 }, async (t) => {
  const root = createTmpDir("coordinator-response-publication-");
  const firstId = randomUUID();
  const secondId = randomUUID();
  const gate = new ManagedAdmissionPublicationGate(root, firstId, secondId);
  let runtime, first, second;
  let holding = false;
  t.after(async () => {
    gate.close();
    if (holding) runtime.store.admission.release();
    await Promise.allSettled([first, second].filter(Boolean));
    try { await runtime?.close(); }
    catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
    removeTmpDir(root);
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: gate.coordinatorEnvironment() });
  const grant = runtime.remoteGrant();
  const policy = new ManagedControlPolicy();
  // This separate host owns the same physical admission FileLock while both
  // real TCP frames enter the coordinator's existing FIFO.
  runtime.store.admission.acquire();
  holding = true;
  let firstSlotDeadline = null;
  first = managedRequest(grant, "authenticate", { grant, data: {} }, { requestId: firstId, policy,
    onWait(deadline) {
      firstSlotDeadline ??= deadline - policy.budgetMs + policy.responseDeadlineMs(1);
      // Release the actual second transaction at the original response boundary
      // only to settle the failing scenario; it is not a longer response budget.
      if (performance.now() >= firstSlotDeadline && gate.blocked) gate.release();
    } });
  first.catch(() => {});
  await gate.waitForFrames([firstId]);
  second = managedRequest(grant, "authenticate", { grant, data: {} }, { requestId: secondId, policy });
  second.catch(() => {});
  await gate.waitForFrames([secondId]);
  runtime.store.admission.release();
  holding = false;
  let firstResponse;
  let beforeRelease;
  try { firstResponse = await first; beforeRelease = !gate.released; }
  finally { gate.release(); }
  const secondResponse = await second;
  assert.equal(firstResponse.ok, true);
  assert.equal(firstResponse.value.record.executionId, runtime.executionId);
  assert.equal(secondResponse.ok, true);
  assert.equal(secondResponse.value.record.executionId, runtime.executionId);
  assert.deepEqual(gate.observation(), { requestId: secondId, links: 2 });
  for (const requestId of [firstId, secondId]) {
    const envelope = JSON.parse(runtime.store.requestFile(runtime.executionId, requestId).read());
    const saved = RuntimeStandaloneRequestDocument.fromEnvelope(runtime.executionId, requestId, envelope).requestRecord();
    assert.equal(saved.requestId, requestId);
    assert.equal(saved.operation, "authenticate");
    assert.equal(saved.response.ok, true);
  }
  await runtime.close();
  const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root });
  assert.equal(historical.executions[0].status, "closed");
  assert.deepEqual(historical.executions[0].calls, []);
  assert.equal(beforeRelease, true, "the committed first response must reach its TCP caller before the second transaction is released");
});

test("real registered execution persists exact exit/output receipts, durable outbox, closed history and successor archives", async (t) => {
  const { runtime, root } = await fixture(t);
  const events = [];
  const privateArgument = "private-argv-never-published";
  const privateEnvironment = "private-env-never-published";
  await runtime.withBinding({ contract: "immutable" }, async () => {
    const current = ProcessExecutionRuntime.current();
    const result = await executeManagedProcess(process.execPath, ["-e", "process.stdout.write('literal output')", privateArgument], {
      runtime: current, timeoutMs: 5000, env: { ...process.env, SENNEL_TEST_PRIVATE_VALUE: privateEnvironment },
    });
    assert.equal(result.stdout, "literal output");
    const receipt = result.processExecutionStopReceipt;
    assert.equal(receipt.schemaVersion, 4);
    assert.equal(receipt.scope, "registered-executions");
    assert.equal(receipt.observation.kind, "exited");
    assert.equal(receipt.observation.code, 0);
    assert.equal(receipt.output.stdoutBytes, Buffer.byteLength("literal output"));
    assert.equal(receipt.output.completion, "complete");
    assert.deepEqual(receipt.binding.toJSON(), { contract: "immutable" });
    assert.equal(Object.hasOwn(receipt.toJSON(), "pgid"), false);
    const privateInvocation = current.inspect().executions[0].calls[0].invocation;
    assert.equal(receipt.invocationDigest, executionValueDigest(privateInvocation));
    assert.deepEqual(receipt.invocation.toJSON(), ProcessExecutionInvocationDisclosure.capture(privateInvocation).invocation.toJSON());
    for (const sentinel of [privateArgument, privateEnvironment]) assert.equal(JSON.stringify(receipt).includes(sentinel), false);
  }, { eventWriter: (event) => { events.push(event); return ProcessExecutionCanonicalAcknowledgement.fromEvent(event); } });
  assert.deepEqual(events.map((event) => event.type), ["reserved", "started", "exited", "result-finalized"]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
  const durableEvents = runtime.inspect().executions[0].events;
  for (const published of [events, durableEvents]) {
    const serialized = JSON.stringify(published);
    assert.equal(serialized.includes(privateArgument), false);
    assert.equal(serialized.includes(privateEnvironment), false);
  }
  assert.equal(Object.hasOwn(events[0].payload.invocation, "actualCommand"), false);
  assert.equal(Object.hasOwn(events[0].payload.invocation, "launch"), false);
  const privateCall = runtime.inspect().executions[0].calls[0];
  assert.equal(privateCall.invocation.launch.args.at(-1), privateArgument);
  assert.equal(privateCall.invocation.launch.env.SENNEL_TEST_PRIVATE_VALUE, privateEnvironment);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 4);
  assert.equal(events.every((event) => event.binding.toJSON().contract === "immutable"), true);
  await runtime.drainEvents((event) => { assert.fail(`Already acknowledged event ${event.eventId}`); });
  await runtime.close();
  const archivePath = path.join(runtime.store.archivesAuthority.directory, `${runtime.executionId}.json`);
  assert.equal(fs.existsSync(archivePath), true);
  const archive = new AtomicFile(archivePath, { directoryAuthority: runtime.store.archivesAuthority });
  const committed = archive.read();
  const changed = JSON.parse(committed);
  const archivedCall = changed.payload.execution.calls[0];
  // A literal invocation remains the current alternative to its original
  // reservation reference. Prove that representation before corrupting it.
  archivedCall.invocation = JSON.parse(JSON.stringify(privateCall.invocation));
  delete archivedCall.invocationRequest;
  changed.digest = executionValueDigest(changed.payload);
  try {
    archive.write(JSON.stringify(changed));
    assert.deepEqual(ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0].calls[0].invocation, privateCall.invocation);
    archivedCall.invocation.launch.env.SENNEL_TEST_PRIVATE_VALUE = "replaced-private-input";
    changed.digest = executionValueDigest(changed.payload);
    archive.write(JSON.stringify(changed));
    assert.throws(() => ProcessExecutionRuntime.inspect({ mainRoot: root }), { code: "PROCESS_EXECUTION_REGISTRY_FAILED" });
  } finally { archive.write(committed); }
  await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: root, binding: { contract: "immutable" } }, (evidence) => {
    assert.equal(evidence.calls[0].invocationDigest, executionValueDigest(privateCall.invocation));
    assert.equal(evidence.calls[0].receipt.invocationDigest, evidence.calls[0].invocationDigest);
    for (const sentinel of [privateArgument, privateEnvironment]) {
      assert.equal(JSON.stringify(evidence.toJSON()).includes(sentinel), false);
      assert.equal(JSON.stringify(evidence.calls.map((call) => call.toStored())).includes(sentinel), false);
    }
  });
  const closed = runtime.inspect();
  assert.equal(closed.slot, null);
  assert.equal(closed.executions[0].status, "closed");
  const successor = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  await successor.close();
  const history = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root });
  assert.deepEqual(history.executions.map((record) => record.ownerEpoch), [1, 2]);
  assert.equal(history.executions[0].calls[0].receipt.scope, "registered-executions");
  assert.equal(fs.existsSync(path.join(runtime.store.archivesAuthority.directory, `${runtime.executionId}.json`)), true);
  const beforeRecovery = fs.readFileSync(runtime.store.file.filePath);
  const summary = await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: root, binding: { contract: "immutable" } }, (evidence) => {
    assert.equal(evidence.assertCurrent(), evidence);
    assert.equal(evidence.calls.length, 1);
    return evidence.toJSON();
  });
  const repeated = await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: root, binding: { contract: "immutable" } }, (evidence) => evidence.toJSON());
  assert.deepEqual(repeated, summary);
  assert.deepEqual(fs.readFileSync(runtime.store.file.filePath), beforeRecovery);
});

test("a failed finish discards staged output and outcome while its exact refusal replays before a lawful finish", async (t) => {
  const { runtime, root } = await fixture(t);
  const call = await runtime.reserveCall();
  const executor = executorIdentity();
  await runtime.claimLaunch(call, { executor });
  const observation = await observeActualChild(runtime, call, executor);
  const maximum = 0;
  const stdout = await runtime.persistCallOutput(call, { executor, stream: "stdout", maximum, bytes: Buffer.alloc(0) });
  const stderr = await runtime.persistCallOutput(call, { executor, stream: "stderr", maximum, bytes: Buffer.alloc(0) });
  const outcome = { code: 0, output: { maximum, stdout, stderr } };
  const before = runtime.inspect().executions[0].calls[0];
  assert.equal(before.status, "exited");
  assert.equal(before.outcome, null);
  assert.equal(before.output, null);
  assert.equal(before.receipt, null);

  const grant = runtime.remoteGrant();
  const requestId = randomUUID();
  const payload = { grant, data: { call: call.controlTarget(), observation: observation.toJSON(), outcome,
    output: new ProcessOutputState({ stdoutBytes: 1, stderrBytes: 0, completion: "complete", cutoffAt: new Date().toISOString() }).toJSON() } };
  // finish stages both fields before comparing them with the real persisted
  // empty streams. Its refusal must discard that working graph completely.
  await assert.rejects(managedRequest(grant, "finish", payload, { requestId }), { code: "PROCESS_EXECUTION_OUTPUT_MISMATCH" });
  const refused = runtime.inspect().executions[0];
  const refusal = refused.requests.find((entry) => entry.requestId === requestId);
  assert.equal(refusal.response.error.code, "PROCESS_EXECUTION_OUTPUT_MISMATCH");
  const registryAfterRefusal = runtime.store.file.read();
  assert.deepEqual(refused.calls[0], before);
  await assert.rejects(managedRequest(grant, "finish", payload, { requestId }), { code: "PROCESS_EXECUTION_OUTPUT_MISMATCH" });
  assert.deepEqual(runtime.store.file.read(), registryAfterRefusal);
  assert.deepEqual(runtime.inspect().executions[0].calls[0], before);

  const receipt = await runtime.finishCall(call, { observation, outcome, output: output() });
  assert.equal(receipt.observation.code, 0);
  assert.equal(receipt.output.stdoutBytes, 0);
  assert.equal(receipt.output.stderrBytes, 0);
  const completed = runtime.inspect().executions[0];
  assert.equal(completed.calls.length, 1);
  assert.equal(completed.events.filter((event) => event.type === "result-finalized").length, 1);
  await runtime.close();
  const history = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root });
  const saved = history.executions[0];
  assert.equal(saved.status, "closed");
  assert.deepEqual(saved.calls[0].receipt, receipt.toJSON());
  assert.deepEqual(saved.requests.find((entry) => entry.requestId === requestId), refusal);
});

test("one durable launch claim replays its response and rejects changed request identity before any second claim", async (t) => {
  const { runtime } = await fixture(t);
  const call = await runtime.reserveCall();
  const executor = executorIdentity();
  const grant = runtime.remoteGrant();
  const payload = { grant, data: { call: call.controlTarget(), executor: executor.toJSON() } };
  const requestId = randomUUID();
  const first = await managedRequest(grant, "claim-launch", payload, { requestId });
  const replay = await managedRequest(grant, "claim-launch", payload, { requestId });
  assert.deepEqual(replay, first);
  await assert.rejects(managedRequest(grant, "begin-stop", payload, { requestId }), { code: "PROCESS_EXECUTION_REQUEST_MISMATCH" });
  await assert.rejects(managedRequest(grant, "read-control", payload, { requestId }), { code: "PROCESS_EXECUTION_REQUEST_MISMATCH" });
  await assert.rejects(runtime.claimLaunch(call, { executor: executorIdentity() }), { code: "PROCESS_EXECUTION_START_REFUSED" });
  const observation = await observeActualChild(runtime, call, executor);
  await finishObservedCall(runtime, call, { observation });
});

test("public synchronous execution preserves an explicitly null scope through the root grant and fresh history", async (t) => {
  const binding = { contract: "owning-root-origin" };
  const { runtime, root } = await fixture(t, { binding });
  const effect = path.join(root, "null-scope-effect.txt");
  const literal = "null scope 日本語 $HOME&value";
  const result = await runtime.withBinding(null, () => {
    assert.equal(ProcessExecutionRuntime.current().binding.toJSON(), null);
    return runCmd(process.execPath, ["-e",
      "require('node:fs').writeFileSync(process.argv[1],process.argv[2]);process.stdout.write(process.argv[2])", effect, literal],
    { cwd: root, timeout: 5000 });
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, literal);
  assert.equal(fs.readFileSync(effect, "utf8"), literal);
  assert.equal(result.processExecutionStopReceipt.binding.toJSON(), null);
  const inventory = runtime.inspect();
  assert.deepEqual(inventory.executions[0].binding, binding);
  assert.equal(inventory.executions[0].calls.length, 1);
  assert.equal(inventory.executions[0].calls[0].binding, null);
  await runtime.close();
  const history = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).inventory;
  const call = history.executions.flatMap((execution) => execution.calls)[0];
  assert.equal(call.binding, null);
  assert.equal(call.receipt.binding, null);
  assert.deepEqual(call.receipt, result.processExecutionStopReceipt.toJSON());
});

test("child exit fences nested admission before output finalization and root capability clients never own coordinator closure", async (t) => {
  const { runtime } = await fixture(t);
  const parent = await runtime.reserveCall({ binding: { contract: "nested" } });
  const executor = executorIdentity();
  await runtime.claimLaunch(parent, { executor });
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const completion = once(child, "exit");
  await once(child, "spawn");
  await runtime.observeCall(parent, { type: "started", executor: executor.toJSON(), startedAt: new Date().toISOString() });
  const borrowed = await ProcessExecutionRuntime.fromRemoteGrant(JSON.parse(parent.executionEnvironment().SENNEL_PROCESS_EXECUTION_SCOPE));
  const grant = borrowed.remoteGrant();
  const unacknowledged = runtime.inspect().executions[0].events[0].eventId;
  await assert.rejects(managedRequest(grant, "ack-events", { grant, data: { eventIds: [unacknowledged] } }), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
  assert.equal(runtime.inspect().executions[0].eventAcknowledgements.map((fact) => fact.eventId).includes(unacknowledged), false);
  const [code, signal] = await completion;
  const observation = new ChildExitObservation({ executor, kind: "exited", code, signal, observedAt: new Date().toISOString() });
  await runtime.observeCall(parent, { type: "exit", observation: observation.toJSON() });
  await assert.rejects(borrowed.reserveCall(), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
  const saved = runtime.inspect().executions[0].calls[0];
  assert.equal(saved.accepting, false);
  assert.equal(saved.status, "exited");
  assert.equal(saved.receipt, null);
  await finishObservedCall(runtime, parent, { observation });
  await borrowed.close();
  const rootClient = await ProcessExecutionRuntime.fromRemoteGrant(runtime.remoteGrant());
  await rootClient.close();
  assert.equal(runtime.inspect().executions[0].status, "active");
  assert.equal(runtime.closed, false);
});

test("authenticated mailbox returns the fixed runtime revision and rejects a forged owner session", async (t) => {
  const { runtime } = await fixture(t);
  const grant = { ...runtime.remoteGrant(), transport: "mailbox" };
  const response = await managedRequest(grant, "runtime-snapshot", { grant, data: {} });
  const wire = runtime.decodeResponse(response);
  assert.equal(wire.schemaVersion, 1);
  assert.equal(wire.encoding, "gzip-base64");
  assert.equal(wire.revision, currentRuntimePackage().revision);
  const decoded = gunzipSync(Buffer.from(wire.body, "base64"), { maxOutputLength: 32 * 1024 * 1024 });
  assert.equal(decoded.length, wire.decodedByteLength);
  assert.equal(createHash("sha256").update(decoded).digest("hex"), wire.digest);
  const snapshot = JSON.parse(decoded.toString("utf8"));
  assert.equal(RuntimePackageSnapshot.fromDelivery(snapshot).identity.revision, currentRuntimePackage().revision);
  assert.equal(snapshot.identity.revision, currentRuntimePackage().revision);
  assert.equal(snapshot.resources.some(([name]) => name === "src/lib/execution-coordinator.js"), true);
  const forged = { ...grant, ownerSession: randomUUID() };
  await assert.rejects(managedRequest(forged, "authenticate", { grant: forged, data: {} }), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
});

test("authenticated mailbox remains functional when native directory watching is unavailable", async (t) => {
  const preload = Buffer.from("import fs from 'node:fs';fs.watch=()=>{throw Object.assign(new Error('directory watches unavailable'),{code:'ENOSYS'})};").toString("base64");
  const { runtime } = await fixture(t, { environment: { ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=data:text/javascript;base64,${preload}`.trim() } });
  const grant = { ...runtime.remoteGrant(), transport: "mailbox" };
  const response = await managedRequest(grant, "authenticate", { grant, data: {} });
  assert.equal(runtime.decodeResponse(response).grant.ownerSession, runtime.ownerSession);
  await assert.rejects(runtime.reserveCall({ invocation: { actualCommand: {
    kind: "native", executable: process.execPath, args: ["-e", ""], cwd: null, env: null, stdio: "pipe",
  } } }), { code: "PROCESS_EXECUTION_CONTROL_FAILED" });
  assert.equal(runtime.inspect().executions[0].calls.length, 0);
  assert.deepEqual(fs.readdirSync(runtime.store.callsAuthority.directory), []);
  const result = await executeManagedProcess(process.execPath, ["-e", "process.stdout.write('watch fallback')"], { runtime, timeoutMs: 10000 });
  assert.equal(result.stdout, "watch fallback");
  assert.equal(result.processExecutionStopReceipt.observation.kind, "exited");
});

test("unsupported legacy registry refuses read-only inspection without modifying its bytes", async (t) => {
  const { runtime, root } = await fixture(t);
  await runtime.close();
  const original = fs.readFileSync(runtime.store.file.filePath);
  const envelope = JSON.parse(original);
  envelope.payload.version = 2;
  const { executionValueDigest } = await import("../../../src/lib/process-execution-values.js");
  envelope.digest = executionValueDigest(envelope.payload);
  new AtomicFile(runtime.store.file.filePath).write(JSON.stringify(envelope));
  const legacy = fs.readFileSync(runtime.store.file.filePath);
  assert.throws(() => ProcessExecutionRuntime.inspect({ mainRoot: root }), (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_RECORD_UNSUPPORTED");
  assert.deepEqual(fs.readFileSync(runtime.store.file.filePath), legacy);
});


test("leaf-first stop preserves the original grace and holds all parent signals until descendant closure", async (t) => {
  const { runtime } = await fixture(t);
  async function running(scope) {
    const call = await scope.reserveCall({ binding: { contract: "lineage" } });
    const executor = executorIdentity();
    await scope.claimLaunch(call, { executor });
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
    const completion = once(child, "exit");
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      // Teardown owns this exact handle; it does not mint missing call closure.
    });
    await once(child, "spawn");
    await scope.observeCall(call, { type: "started", executor: executor.toJSON(), startedAt: new Date().toISOString() });
    return { call, executor, child, completion, scope };
  }
  async function exited(entry) {
    entry.child.stdin.end();
    const [code, signal] = await entry.completion;
    const observation = new ChildExitObservation({ executor: entry.executor, kind: "exited", code, signal, observedAt: new Date().toISOString() });
    await entry.scope.observeCall(entry.call, { type: "exit", observation: observation.toJSON() });
    return observation;
  }
  const parent = await running(runtime);
  const borrowed = await ProcessExecutionRuntime.fromRemoteGrant(JSON.parse(parent.call.executionEnvironment().SENNEL_PROCESS_EXECUTION_SCOPE));
  const nested = await running(borrowed);
  const unused = await borrowed.reserveCall({ binding: { contract: "lineage" } });
  const revocation = await borrowed.revokeCall(unused);
  const operation = await runtime.beginCallStop(parent.call, { reason: "abort", graceMs: 500 });
  assert.throws(() => operation.remainingMs(), { code: "PROCESS_EXECUTION_CLOCK_SESSION_UNKNOWN" });
  const replay = await runtime.beginCallStop(parent.call, { reason: "timeout", graceMs: 10000 });
  assert.deepEqual(replay.toJSON(), operation.toJSON());
  let leafStop;
  for (const entry of [parent, nested]) {
    const saved = runtime.inspect().executions[0].calls.find((call) => call.callId === entry.call.callId);
    assert.deepEqual(new ManagedStopOperationStore(entry.call).read().toJSON(), saved.stopOperation);
    assert.equal(saved.stopOperation.clockSessionId, operation.clockSessionId);
    if (entry === nested) leafStop = saved.stopOperation;
  }
  assert.equal(leafStop.graceMs, 500);
  assert.equal(leafStop.deadline, leafStop.startedAt + 3000);
  const parentControl = await runtime.readCallControl(parent.call, { executor: parent.executor });
  const leafControl = await borrowed.readCallControl(nested.call, { executor: nested.executor });
  assert.equal(parentControl.stopSignal, null);
  const graceCutoffRemainingMs = leafStop.deadline - (leafStop.startedAt + leafStop.graceMs);
  if (leafControl.stopRemainingMs > graceCutoffRemainingMs) {
    assert.equal(leafControl.stopSignal, "SIGTERM");
  } else if (leafControl.stopRemainingMs < graceCutoffRemainingMs) {
    assert.equal(leafControl.stopSignal, "SIGKILL");
  } else {
    assert.equal(leafControl.stopRemainingMs, graceCutoffRemainingMs);
    // Rounded remaining time can coincide on either side of the exact grace cutoff.
    assert.ok(["SIGTERM", "SIGKILL"].includes(leafControl.stopSignal));
  }
  assert.equal(parentControl.stopRequested, true);
  assert.equal(parentControl.aborted, true);
  assert.equal(parentControl.stopRemainingMs >= 0 && parentControl.stopRemainingMs <= 3000, true);
  let escalated = leafControl;
  while (escalated.stopSignal === "SIGTERM") {
    assert.ok(escalated.stopRemainingMs > 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    escalated = await borrowed.readCallControl(nested.call, { executor: nested.executor });
  }
  assert.equal(escalated.stopSignal, "SIGKILL");
  assert.equal((await runtime.readCallControl(parent.call, { executor: parent.executor })).stopSignal, null);
  const first = runtime.inspect().executions[0].calls.find((call) => call.callId === nested.call.callId).stopOperation;
  assert.deepEqual(new ManagedStopOperationStore(nested.call).read().toJSON(), first);
  const parentObservation = await exited(parent);
  await assert.rejects(runtime.finishCall(parent.call, { observation: parentObservation, output: output(), outcome: { code: 0 } }),
    { code: "PROCESS_EXECUTION_DESCENDANTS_PENDING" });
  const unfinished = runtime.inspect().executions[0].calls.find((call) => call.callId === parent.call.callId);
  assert.equal(unfinished.receipt, null);
  assert.equal(unfinished.output, null);
  const nestedObservation = await exited(nested);
  const nestedReceipt = await finishObservedCall(borrowed, nested.call, { observation: nestedObservation });
  const ready = await runtime.readCallControl(parent.call, { executor: parent.executor });
  assert.equal(ready.stopSignal, null);
  assert.equal(ready.descendantsSettled, true);
  const parentReceipt = await finishObservedCall(runtime, parent.call, { observation: parentObservation });
  const { executionValueDigest } = await import("../../../src/lib/process-execution-values.js");
  assert.deepEqual(parentReceipt.toJSON().descendants, [
    { callId: nested.call.callId, closureKind: "child-exit", closureDigest: executionValueDigest(nestedReceipt) },
    { callId: unused.callId, closureKind: "reservation-revoked", closureDigest: executionValueDigest(revocation) },
  ]);
  await borrowed.close();
});

test("crashed coordinator never reclaims its published owner from a PID or absence of liveness", async (t) => {
  const root = createTmpDir("execution-coordinator-crash-");
  t.after(() => removeTmpDir(root));
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  const incomplete = await runtime.reserveCall();
  const terminal = once(runtime.control.child, "exit");
  runtime.control.child.ref();
  runtime.control.child.kill();
  await terminal;
  const before = fs.readFileSync(runtime.store.file.filePath);
  await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: root }), { code: "PROCESS_EXECUTION_BUSY" });
  assert.deepEqual(fs.readFileSync(runtime.store.file.filePath), before);
  assert.equal(fs.existsSync(runtime.store.ownerLock.lockPath), true);
  const retained = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions[0].calls[0];
  assert.equal(retained.callId, incomplete.callId);
  assert.equal(retained.receipt, null);
  assert.equal(retained.observation, null);
});

test("lost coordinator response retains its prior real mailbox authority diagnostic and unknown call evidence", async (t) => {
  const root = createTmpDir("execution-coordinator-diagnostic-");
  t.after(() => removeTmpDir(root));
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  const call = await runtime.reserveCall();
  const requests = runtime.remoteGrant().endpoint.mailbox.requests;
  let timer;
  const diagnostic = new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message?.type !== "diagnostic") return;
      runtime.control.child.off("message", listener); clearTimeout(timer);
      resolve(ProcessExecutionControlFailure.fromStored(message.error));
    };
    runtime.control.child.on("message", listener);
    timer = setTimeout(() => { runtime.control.child.off("message", listener); reject(new Error("Mailbox authority refusal was not reported")); }, 10000);
  });
  fs.renameSync(requests, `${requests}-retained`);
  fs.mkdirSync(requests);
  const observed = await diagnostic;
  assert.equal(runtime.control.diagnostics.at(-1).code, observed.code);
  const terminal = once(runtime.control.child, "exit");
  runtime.control.child.ref(); runtime.control.child.kill();
  await terminal;
  const saved = fs.readFileSync(runtime.store.file.filePath);
  await assert.rejects(runtime.close(), (error) => error.code === "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE"
    && error.primaryCause.code === observed.primaryCause.code && error.cause instanceof AggregateError);
  assert.deepEqual(fs.readFileSync(runtime.store.file.filePath), saved);
  const retained = runtime.inspect().executions[0].calls.find((entry) => entry.callId === call.callId);
  assert.equal(retained.receipt, null);
  assert.equal(retained.observation, null);
  assert.equal(fs.existsSync(runtime.store.ownerLock.lockPath), true);
});

test("live coordinator closes after host loss only from complete retained child receipts and permits a successor", async (t) => {
  const root = createTmpDir("execution-coordinator-host-loss-");
  const runtimeModule = fileURLToPath(new URL("../../../src/lib/process-execution-runtime.js", import.meta.url));
  const managedModule = fileURLToPath(new URL("../../../src/lib/managed-process.js", import.meta.url));
  const bootstrap = fileURLToPath(new URL("../../../src/sennel.js", import.meta.url));
  const source = `
    const {ProcessExecutionRuntime} = await import(${JSON.stringify(runtimeModule)});
    const {executeManagedProcess} = await import(${JSON.stringify(managedModule)});
    const runtime = await ProcessExecutionRuntime.acquire({mainRoot: process.cwd()});
    const result = await executeManagedProcess(process.execPath, ["-e", "process.stdout.write('retained output')"], {runtime, timeoutMs: 10000});
    process.on("message", () => {});
    process.send({executionId: runtime.executionId, receipt: result.processExecutionStopReceipt.toJSON(), ownerLock: runtime.store.ownerLock.lockPath});
  `;
  const host = spawn(process.execPath, ["--import", bootstrap, "--input-type=module", "-e", source], {
    cwd: root, env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  host.stderr.on("data", (chunk) => { stderr += chunk; });
  const terminal = once(host, "exit");
  t.after(async () => {
    if (host.exitCode === null && host.signalCode === null) { host.kill(); await terminal; }
    removeTmpDir(root);
  });
  const published = await Promise.race([
    once(host, "message").then(([message]) => message),
    terminal.then(() => assert.fail(`Host exited before a child receipt: ${stderr}`)),
  ]);
  assert.equal(published.receipt.observation.kind, "exited");
  assert.equal(published.receipt.output.stdoutBytes, Buffer.byteLength("retained output"));
  const savedBefore = ProcessExecutionRuntime.inspect({ mainRoot: root });
  assert.equal(savedBefore.executions[0].status, "active");
  assert.deepEqual(savedBefore.executions[0].calls[0].receipt, published.receipt);
  const closed = waitForRuntimeHostClosure({ mainRoot: root,
    executionId: published.executionId, ownerLock: published.ownerLock });
  host.kill();
  const [, savedAfter] = await Promise.all([terminal, closed]);
  assert.equal(savedAfter.executions[0].status, "closed");
  assert.equal(savedAfter.executions[0].closure.recovery, true);
  assert.deepEqual(savedAfter.executions[0].calls[0].receipt, published.receipt);
  const successor = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  assert.equal(successor.ownerEpoch, 2);
  await successor.close();
  assert.deepEqual(ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions[0].calls[0].receipt, published.receipt);
});


test("independent coordinator fences timeout admission without an executor poll and preserves that first stop", async (t) => {
  const { runtime } = await fixture(t);
  const call = await runtime.reserveCall({ timeoutMs: 100 });
  const executor = executorIdentity();
  await runtime.claimLaunch(call, { executor });
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  const completion = once(child, "exit");
  await once(child, "spawn");
  let watcher;
  let timer;
  const autonomousStop = new Promise((resolve, reject) => {
    const check = () => {
      try {
        const saved = runtime.inspect().executions[0].calls.find((entry) => entry.callId === call.callId);
        if (saved.stopOperation !== null) resolve(saved);
      } catch (cause) { reject(cause); }
    };
    watcher = fs.watch(runtime.store.authority.directory, (_event, name) => { if (String(name) === "registry.json") check(); });
    timer = setTimeout(() => reject(new Error("Coordinator did not publish autonomous timeout")), 10000);
  });
  t.after(() => { watcher?.close(); clearTimeout(timer); });
  await runtime.observeCall(call, { type: "started", executor: executor.toJSON(), startedAt: new Date().toISOString() });
  const saved = await autonomousStop;
  watcher.close(); clearTimeout(timer);
  assert.equal(saved.stopOperation.reason, "timeout");
  assert.equal(saved.accepting, false);
  assert.equal(saved.receipt, null);
  const inherited = JSON.parse(call.executionEnvironment().SENNEL_PROCESS_EXECUTION_SCOPE);
  await assert.rejects(ProcessExecutionRuntime.fromRemoteGrant(inherited), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
  child.stdin.end();
  const [code, signal] = await completion;
  const observation = new ChildExitObservation({ executor, kind: "exited", code, signal, observedAt: new Date().toISOString() });
  await runtime.observeCall(call, { type: "exit", observation: observation.toJSON() });
  const receipt = await finishObservedCall(runtime, call, { observation, outcome: { code: 0, timedOut: true } });
  assert.deepEqual(receipt.toJSON().stopOperation, saved.stopOperation);
});


test("a failed TCP delivery preserves its committed response before any mailbox fallback request exists", async (t) => {
  const { runtime, root } = await fixture(t, { environment: replyLossEnvironment("revoke-reservation", { failSocket: true }) });
  const call = await runtime.reserveCall();
  const grant = runtime.remoteGrant();
  assert.notEqual(grant.endpoint.port, null);
  const message = new ManagedProcessMessage(grant, "revoke-reservation", { grant,
    data: { call: call.controlTarget(), reason: "unused-before-launch" } });
  const socket = net.createConnection({ host: grant.endpoint.host, port: grant.endpoint.port });
  const closed = new Promise(resolve => socket.once("close", resolve));
  let received = "", socketError = null;
  socket.on("error", cause => { socketError = cause; });
  socket.on("data", bytes => { received += bytes; });
  await once(socket, "connect");
  socket.write(`${JSON.stringify(message)}\n`);
  await closed;
  // A subsequent ordinary request crosses the coordinator's event loop. No
  // fallback has published the original request or re-entered its handler.
  const events = await managedRequest(grant, "events", { grant, data: {} });
  assert.equal(events.ok, true);
  const responseFile = path.join(grant.endpoint.mailbox.responses, `${message.requestId}.json`);
  const published = fs.existsSync(responseFile) ? fs.readFileSync(responseFile) : null;
  const requestAbsent = !fs.existsSync(path.join(grant.endpoint.mailbox.requests, `${message.requestId}.json`));
  await runtime.close();
  assert.equal(runtime.control.child.exitCode, 0);
  assert.equal(runtime.store.ownerLock.inspect(), null);
  const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions.find(e => e.executionId === runtime.executionId);
  assert.equal(historical.status, "closed");
  assert.equal(historical.calls[0].status, "revoked");
  assert.equal(historical.calls[0].executor, null);
  assert.equal(historical.requests.filter(r => r.requestId === message.requestId).length, 1);
  assert.equal(received, "");
  if (socketError !== null) assert.ok(socketError instanceof Error);
  assert.equal(requestAbsent, true);
  assert.notEqual(published, null, "Failed TCP delivery must retain the exact committed response before fallback");
  const response = ManagedProcessMessage.from(JSON.parse(published));
  assert.equal(response.respondsTo(message), true);
  assert.deepEqual(response.payload.value, historical.calls[0].revocation);
  assert.deepEqual(fs.readFileSync(responseFile), published);
});

test("lost terminating TCP reply replays from the authenticated mailbox after actual coordinator exit", { timeout: 45000 }, async (t) => {
  const root = createTmpDir("coordinator-terminating-reply-");
  let runtime;
  t.after(async () => {
    if (runtime && runtime.control.child.exitCode === null) await runtime.close();
    // Unknown ownership is retained if close refuses; cleanup follows actual exit.
    if (!runtime || runtime.control.child.exitCode === 0) removeTmpDir(root);
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: replyLossEnvironment("release-root") });
  const grant = runtime.remoteGrant();
  assert.equal((await managedRequest(grant, "close", { grant, data: {} })).value.closed, true);
  const message = new ManagedProcessMessage(grant, "release-root", { grant, data: {} });
  const socket = net.createConnection({ host: grant.endpoint.host, port: grant.endpoint.port });
  const closed = once(socket, "close");
  let received = "";
  socket.on("data", (bytes) => { received += bytes; });
  await once(socket, "connect");
  socket.write(`${JSON.stringify(message)}\n`);
  await closed;
  assert.equal(received, "");
  await runtime.control.waitForExit();
  assert.equal(runtime.control.child.exitCode, 0);
  assert.equal(runtime.store.ownerLock.inspect(), null);
  const before = fs.readFileSync(runtime.store.file.filePath);
  const published = fs.readFileSync(path.join(grant.endpoint.mailbox.responses, `${message.requestId}.json`));
  assert.equal(ManagedProcessMessage.from(JSON.parse(published)).respondsTo(message), true);
  const replay = await managedRequest(grant, message.operation, message.payload, { requestId: message.requestId });
  assert.deepEqual(replay, { ok: true, value: null });
  assert.deepEqual(fs.readFileSync(runtime.store.file.filePath), before);
  assert.deepEqual(fs.readFileSync(path.join(grant.endpoint.mailbox.responses, `${message.requestId}.json`)), published);
  await assert.rejects(managedRequest(grant, message.operation, { grant, data: { changed: true } }, { requestId: message.requestId }),
    { code: "PROCESS_EXECUTION_REQUEST_MISMATCH" });
  assert.deepEqual(fs.readFileSync(runtime.store.file.filePath), before);
});


test("unclaimed revocation replays lost acknowledgement, refuses late launch and proves zero consumption through closure and fresh recovery", async (t) => {
  const binding = { contract: "unclaimed-zero-consumption" };
  const { runtime, root } = await fixture(t, { binding, environment: replyLossEnvironment("revoke-reservation") });
  const effect = path.join(root, "provider-must-not-run");
  const privateArgument = "revoked-private-argv", privateEnvironment = "revoked-private-env";
  const command = new NativeExecutableInvocation({ executable: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(effect)},'effect')`, privateArgument], cwd: root,
    env: { ...process.env, SENNEL_TEST_PRIVATE_VALUE: privateEnvironment } });
  const call = await runtime.reserveCall({ invocation: { actualCommand: command.toJSON(), launch: command.resolvedLaunch().toJSON(), providerAttemptId: randomUUID() } });
  const grant = runtime.remoteGrant(), requestId = randomUUID();
  const payload = { grant, data: { call: call.controlTarget(), reason: "unused-prompt" } };
  const response = await managedRequest(grant, "revoke-reservation", payload, { requestId });
  const revocation = ProcessExecutionReservationRevocation.fromStored(runtime.decodeResponse(response));
  assert.equal(revocation.scope, "unlaunched-reservation");
  assert.equal(Object.hasOwn(revocation, "stopEvidence"), false);
  assert.deepEqual(await managedRequest(grant, "revoke-reservation", payload, { requestId }), response);
  assert.deepEqual((await runtime.revokeCall(call, { reason: "unused-prompt" })).toJSON(), revocation.toJSON());
  await assert.rejects(managedRequest(grant, "revoke-reservation", { grant, data: { ...payload.data, reason: "changed" } }, { requestId }), { code: "PROCESS_EXECUTION_REQUEST_MISMATCH" });
  await assert.rejects(runtime.claimLaunch(call, { executor: executorIdentity() }), { code: "PROCESS_EXECUTION_START_REFUSED" });
  const saved = runtime.inspect().executions[0];
  assert.equal(saved.requests.filter((entry) => entry.requestId === requestId).length, 1);
  assert.equal(saved.calls[0].status, "revoked");
  for (const field of ["receipt", "executor", "permit", "observation", "output"]) assert.equal(saved.calls[0][field], null);
  assert.deepEqual(saved.calls[0].revocation, revocation.toJSON());
  assert.equal(saved.calls[0].invocation.launch.args.at(-1), privateArgument);
  assert.equal(saved.calls[0].invocation.launch.env.SENNEL_TEST_PRIVATE_VALUE, privateEnvironment);
  assert.equal(revocation.invocationDigest, executionValueDigest(saved.calls[0].invocation));
  for (const sentinel of [privateArgument, privateEnvironment]) {
    assert.equal(JSON.stringify(revocation).includes(sentinel), false);
    assert.equal(JSON.stringify(saved.events).includes(sentinel), false);
  }
  assert.deepEqual(saved.events.map((event) => event.type), ["reserved", "result-finalized"]);
  assert.equal(saved.events[1].payload.completion, "revoked-before-launch");
  assert.equal(runtime.stopReceipts().length, 0);
  assert.equal(fs.existsSync(effect), false);
  const published = [];
  const barrier = await runtime.finalizeBinding(new ProcessExecutionBindingSelection(binding), (event) => {
    published.push(event.toJSON());
    return ProcessExecutionCanonicalAcknowledgement.fromEvent(event);
  });
  assert.deepEqual(published, saved.events);
  const eventReferences = published.map((event) => ({ eventId: event.eventId, sequence: event.sequence,
    eventDigest: executionValueDigest(event) }));
  assert.deepEqual(barrier.events.map((event) => event.toJSON()), eventReferences);
  const acknowledged = runtime.inspect().executions.find((entry) => entry.executionId === runtime.executionId);
  assert.deepEqual(acknowledged.eventAcknowledgements, eventReferences.map(({ eventId, eventDigest }) => ({ eventId, eventDigest })));
  assert.equal(barrier.callClosures[0].closureKind, "reservation-revoked");
  await runtime.close();
  await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: root, binding }, (evidence) => {
    assert.equal(evidence.calls.length, 1);
    assert.equal(evidence.calls[0].startPermitted, false);
    assert.equal(evidence.calls[0].receipt, null);
    assert.deepEqual(evidence.calls[0].revocation.toJSON(), revocation.toJSON());
    assert.deepEqual(evidence.calls[0].toStored().revocation, revocation.toJSON());
    assert.equal(evidence.receipts.length, 0);
    assert.equal(evidence.reservationRevocations.length, 1);
    assert.equal(evidence.calls[0].invocationDigest, revocation.invocationDigest);
    for (const sentinel of [privateArgument, privateEnvironment]) {
      assert.equal(JSON.stringify(evidence.toJSON()).includes(sentinel), false);
      assert.equal(JSON.stringify(evidence.calls[0].toStored()).includes(sentinel), false);
    }
    assert.equal(evidence.nonExecution, null, "a revoked reservation is explicit evidence, not absence of reservation");
  });
  const successor = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  const result = await executeManagedProcess(process.execPath, ["-e", "process.stdout.write('budget-reused')"], { runtime: successor, timeoutMs: 10000 });
  assert.equal(result.stdout, "budget-reused");
  await successor.close();
  assert.equal(fs.existsSync(effect), false);
});


test("unacknowledged startup returns finite original failure and retains a live owned reader payload until its actual exit", { timeout: 80000 }, async (t) => {
  const root = createTmpDir("coordinator-startup-noack-");
  const original = RuntimeChildExecution.prototype.spawnNode;
  let child = null, delivery = null, file = null, before = null, successor = null, verified = false;
  let gate = null;
  t.after(async () => {
    RuntimeChildExecution.prototype.spawnNode = original;
    gate?.close();
    await successor?.close();
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      child.ref(); const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    if (delivery !== null) assert.equal(delivery.closeAfterExecution(), true);
    if (verified) removeTmpDir(root); else testTemporaryRoot().retainOnUnconfirmedExecution();
  });
  gate = new ManagedRuntimeStartupReadGate(root);
  RuntimeChildExecution.prototype.spawnNode = function (...args) {
    delivery = this;
    const flag = this.environment.NODE_OPTIONS.split(/\s+/).find((value) => value.startsWith("--import=data:") && value.includes("#"));
    const configuration = JSON.parse(Buffer.from(flag.slice(flag.lastIndexOf("#") + 1), "base64url"));
    file = configuration.file; before = fs.readFileSync(file);
    child = original.apply(this, args);
    gate.observe(child);
    return child;
  };
  const started = performance.now();
  try {
    await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: root, environment: gate.coordinatorEnvironment() }),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_ADMISSION_FAILED"
      && error.primaryCause.code === "PROCESS_EXECUTION_ADMISSION_FAILED" && error.processExecutionStopReceipt === undefined);
  } finally { RuntimeChildExecution.prototype.spawnNode = original; }
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 30000 && elapsed < 60000, "the existing startup and control windows must return a finite refusal");
  assert.equal(gate.readAttempt(), file);
  assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: root }), null);
  // Windows Node terminates SIGTERM targets unconditionally; POSIX handlers
  // can retain the actual reader. Cleanup follows observed lifetime in both.
  if (process.platform !== "win32") {
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    assert.deepEqual(gate.stopRequest(), { signal: "SIGTERM", accepted: true });
    assert.ok(elapsed >= 44000);
  }
  const readerAlive = child.exitCode === null && child.signalCode === null;
  if (readerAlive) {
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(delivery.close(), false);
    assert.equal(fs.existsSync(path.join(path.dirname(file), "acknowledgement.json")), false);
  } else assert.equal(fs.existsSync(file), false);
  successor = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  await successor.close();
  const inventory = ProcessExecutionRuntime.inspect({ mainRoot: root });
  assert.equal(inventory.slot, null);
  assert.equal(inventory.executions.length, 1);
  assert.equal(inventory.executions[0].calls.length, 0);
  if (readerAlive) assert.deepEqual(fs.readFileSync(file), before);
  verified = true;
});


test("borrowed authentication exposes only its client view while nested execution works and root capability fabrication is refused", async (t) => {
  const { runtime } = await fixture(t);
  const binding = { contract: "borrowed-client-view" };
  const privateArgument = "other-call-private-argv", privateEnvironment = "other-call-private-env";
  const command = new NativeExecutableInvocation({ executable: process.execPath, args: ["-e", "", privateArgument],
    env: { ...process.env, SENNEL_TEST_PRIVATE_VALUE: privateEnvironment } });
  const sibling = await runtime.reserveCall({ binding, invocation: { actualCommand: command.toJSON(), launch: command.resolvedLaunch().toJSON() } });
  await runtime.revokeCall(sibling);
  const parent = await runtime.reserveCall({ binding });
  const executor = executorIdentity();
  await runtime.claimLaunch(parent, { executor });
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  const completion = once(child, "exit");
  await once(child, "spawn");
  await runtime.observeCall(parent, { type: "started", executor: executor.toJSON(), startedAt: new Date().toISOString() });
  let borrowed = null;
  try {
    const grant = JSON.parse(parent.executionEnvironment().SENNEL_PROCESS_EXECUTION_SCOPE);
    const response = runtime.decodeResponse(await managedRequest(grant, "authenticate", { grant, data: {} }));
    const root = runtime.inspect().executions[0];
    const exposed = JSON.stringify(response);
    for (const secret of [root.rootCapability, sibling.capability, privateArgument, privateEnvironment]) assert.equal(exposed.includes(secret), false);
    assert.equal(Object.hasOwn(response.record, "rootCapability"), false);
    assert.equal(Object.hasOwn(response.record, "calls"), false);
    const forged = { ...grant, callId: runtime.executionId, capability: parent.capability, executor: null,
      bindingDigest: runtime.binding.digest };
    await assert.rejects(managedRequest(forged, "ack-events", { grant: forged, data: { eventIds: [root.events[0].eventId] } }), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
    borrowed = await ProcessExecutionRuntime.fromRemoteGrant(grant);
    const result = await executeManagedProcess(process.execPath, ["-e", "process.stdout.write('nested-client-view')"], { runtime: borrowed, timeoutMs: 10000 });
    assert.equal(result.stdout, "nested-client-view");
    assert.equal(result.processExecutionStopReceipt.binding.toJSON().contract, binding.contract);
  } finally {
    child.stdin.end();
    const [code, signal] = await completion;
    const observation = new ChildExitObservation({ executor, kind: "exited", code, signal, observedAt: new Date().toISOString() });
    await runtime.observeCall(parent, { type: "exit", observation: observation.toJSON() });
    await finishObservedCall(runtime, parent, { observation });
    await borrowed?.close();
  }
});


for (const ignoresTermination of [false, true]) {
  test(`registered actual child ${ignoresTermination ? "ignores SIGTERM then escalates after original grace" : "exits on SIGTERM during original grace"}`, async (t) => {
    const { runtime } = await fixture(t);
    const abort = new AbortController(), requested = [];
    const source = `${ignoresTermination ? "process.on('SIGTERM',()=>process.stdout.write('ignored'));" : ""}process.stdout.write('ready');setInterval(()=>{},1000);`;
    let failure;
    try {
      await executeManagedProcess(process.execPath, ["-e", source], {
        runtime, timeoutMs: 10000, graceMs: 500, abortSignal: abort.signal,
        onStdout() { abort.abort(); },
        onSpawn(child) {
          const kill = child.kill.bind(child);
          child.kill = (signal) => { requested.push(signal); return kill(signal); };
        },
      });
    } catch (cause) { failure = cause; }
    assert.equal(failure?.code, "ABORT_ERR");
    const expected = ignoresTermination && process.platform !== "win32" ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"];
    assert.deepEqual(requested, expected);
    const call = runtime.inspect().executions[0].calls[0];
    assert.equal(call.outcome.finalAction, expected.at(-1));
    assert.equal(call.receipt.observation.kind, "exited");
    assert.equal(call.receipt.observation.signal, expected.at(-1));
    assert.equal(call.receipt.stopOperation.reason, "abort");
    assert.equal(call.receipt.stopOperation.graceMs, 500);
    assert.equal(call.graceMs, 500);
    assert.ok(call.receipt.stopOperation.deadline <= call.receipt.stopOperation.startedAt + 3000);
    assert.deepEqual(call.receipt.stopOperation, call.stopOperation);
    assert.deepEqual(new ManagedStopOperationStore(new ProcessExecutionCall(runtime, call)).read().toJSON(), call.stopOperation);
    // Windows Node implements both requests with unconditional termination;
    // POSIX can exercise the handler and must escalate within the same operation.
    assert.equal(failure.stdout, ignoresTermination && process.platform !== "win32" ? "readyignored" : "ready");
  });
}


// Compatibility coverage for owned mutable views of freshly validated bytes.
// The child, receipt and finalization fence all come from the existing public
// producer helpers; no ownership or completion fact is manufactured here.
async function mutableRegistryFixture(t) {
  const binding = { contract: "mutable-registry-isolation" };
  const { root, runtime } = await fixture(t, { binding });
  const call = await runtime.reserveCall();
  const executor = executorIdentity();
  await runtime.claimLaunch(call, { executor });
  const observation = await observeActualChild(runtime, call, executor);
  const receipt = await finishObservedCall(runtime, call, { observation });
  assert.equal(receipt.observation.code, 0);
  assert.equal(receipt.observation.signal, null);
  const selection = new ProcessExecutionBindingSelection(binding);
  const barrier = await runtime.finalizeBinding(selection, event => ProcessExecutionCanonicalAcknowledgement.fromEvent(event));
  assert.equal(barrier.callClosures[0].callId, call.callId);
  const grant = runtime.remoteGrant();
  const confirm = requestId => managedRequest(grant, "finalization-confirm", { grant,
    data: { selection: selection.toJSON(), fenceId: barrier.fenceId } }, requestId === undefined ? {} : { requestId });
  return { root, runtime, call, receipt, barrier, confirm };
}

test("publication preparation preserves bound control failure codes before any physical mutation", async (t) => {
  const { root, runtime } = await fixture(t);
  const call = await runtime.reserveCall();
  let failure, revocation;
  try {
    failure = await runtime.recordCallControlFailure(call,
      new ProcessExecutionControlFailure("endpoint-unavailable", "Control channel failed before launch"));
    assert.equal(failure.executionId, runtime.executionId);
    assert.equal(failure.callId, call.callId);
    await runtime.store.exclusive(store => {
      const before = store.file.readSnapshot();
      assert.equal(store.transition.read(), null);
      for (const identity of ["callId", "executionId"]) {
        const invalid = store.read();
        const execution = invalid.executions.find(entry => entry.executionId === runtime.executionId);
        const savedCall = execution.calls.find(entry => entry.callId === call.callId);
        assert.deepEqual(savedCall.controlFailure.toJSON(), failure.toJSON());
        if (identity === "callId") savedCall.callId = randomUUID();
        else execution.executionId = randomUUID();
        assert.throws(() => store.save(invalid), {
          name: "ProcessExecutionControlFailure", code: "PROCESS_EXECUTION_FAILURE_EVIDENCE_INVALID",
        });
        const after = store.file.readSnapshot();
        assert.deepEqual(after.bytes, before.bytes);
        assert.deepEqual(after.identity, before.identity);
        assert.equal(store.transition.read(), null);
      }
    });
  } finally {
    revocation = await runtime.revokeCall(call);
    await runtime.close();
    assert.equal(runtime.control.child.exitCode, 0);
    assert.equal(runtime.control.child.signalCode, null);
  }
  const closed = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions.find(entry => entry.executionId === runtime.executionId);
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.calls.find(entry => entry.callId === call.callId).controlFailure, failure.toJSON());
  assert.deepEqual(closed.calls.find(entry => entry.callId === call.callId).revocation, revocation.toJSON());
});

test("unstored mutable registry changes and rejected publication preparation preserve exact receipts and finalization replay", { timeout: 60000 }, async (t) => {
  const { root, runtime, call, receipt, barrier, confirm } = await mutableRegistryFixture(t);
  const requestId = randomUUID();
  const response = await confirm(requestId);
  assert.deepEqual(response, { ok: true, value: barrier.toJSON() });
  await runtime.store.exclusive(store => {
    const beforeBytes = store.file.read();
    const original = JSON.parse(JSON.stringify(store.read({ immutable: true })));
    const fork = store.read();
    const execution = fork.executions.find(entry => entry.executionId === runtime.executionId);
    const request = execution.requests.find(entry => entry.requestId === requestId);
    const fence = execution.finalizationFences.find(entry => entry.fenceId === barrier.fenceId);
    assert.notEqual(request.response, null);
    assert.notEqual(fence.cutoff, null); assert.notEqual(fence.barrier, null);
    assert.deepEqual(execution.calls[0].receipt.toJSON(), receipt.toJSON());
    // Deliberately uncommitted invalid edits exercise each owned mutable
    // container. They must never change another read or the physical source.
    execution.calls[0].status = "intent";
    request.response = null;
    fence.cutoff = null; fence.barrier = null;
    execution.closure = { unpublished: true };
    execution.events.pop(); execution.eventAcknowledgements.pop();
    execution.runtimeOnlyDispositions.push(null);
    execution.calls.pop(); execution.requests.pop(); execution.finalizationFences.pop();
    fork.slot = null; fork.executions.pop();
    assert.deepEqual(JSON.parse(JSON.stringify(store.read())), original);
    assert.deepEqual(store.file.read(), beforeBytes);
    // A caller-supplied invalid mutation must still take strict full graph
    // normalization before a transition or visible publication can begin.
    const invalid = store.read();
    invalid.executions.find(entry => entry.executionId === runtime.executionId).calls[0].status = "not-a-call-phase";
    assert.throws(() => store.save(invalid), { name: "TypeError", message: "Call status is invalid" });
    assert.equal(store.transition.read(), null);
    assert.deepEqual(store.file.read(), beforeBytes);
    assert.deepEqual(JSON.parse(JSON.stringify(store.read())), original);
  });
  const beforeReplay = runtime.store.file.read();
  assert.deepEqual(await confirm(requestId), response);
  assert.deepEqual(runtime.store.file.read(), beforeReplay);
  assert.deepEqual(await confirm(), response);
  await runtime.close();
  const closed = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions.find(entry => entry.executionId === runtime.executionId);
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.calls.find(entry => entry.callId === call.callId).receipt, receipt.toJSON());
  assert.deepEqual(closed.finalizationFences.find(entry => entry.fenceId === barrier.fenceId).barrier, barrier.toJSON());
  assert.deepEqual(closed.requests.find(entry => entry.requestId === requestId).response, response);
});

test("warmed mutating requests reject same-inode schema corruption and deleted registry bytes before acceptance", { timeout: 60000 }, async (t) => {
  const { root, runtime, call, receipt, barrier, confirm } = await mutableRegistryFixture(t);
  const readBytes = () => runtime.store.admission.runExclusiveAsync(() => runtime.store.file.read());
  for (const mode of ["same-inode-schema-change", "deleted-registry"]) {
    const requestId = randomUUID();
    const originalResponse = await confirm(requestId);
    assert.deepEqual(originalResponse, { ok: true, value: barrier.toJSON() });
    const originalBytes = await readBytes();
    const rejectedId = randomUUID();
    let changedBytes;
    try {
      await runtime.store.admission.runExclusiveAsync(() => {
        const file = runtime.store.file.filePath;
        const before = fs.statSync(file, { bigint: true });
        if (mode === "same-inode-schema-change") {
          const changed = JSON.parse(originalBytes);
          changed.payload.unexpectedMutableReadField = true;
          changed.digest = executionValueDigest(changed.payload);
          changedBytes = Buffer.from(JSON.stringify(changed));
          fs.writeFileSync(file, changedBytes);
          const after = fs.statSync(file, { bigint: true });
          assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
          assert.equal(JSON.parse(changedBytes).digest, executionValueDigest(changed.payload));
        } else fs.unlinkSync(file);
      });
      await assert.rejects(confirm(rejectedId), { code: mode === "same-inode-schema-change"
        ? "PROCESS_EXECUTION_REGISTRY_FAILED" : "PROCESS_EXECUTION_RECORD_MISSING" });
      if (changedBytes !== undefined) assert.deepEqual(await readBytes(), changedBytes);
      else assert.equal(fs.existsSync(runtime.store.file.filePath), false);
    } finally {
      // Restore only this test's exact saved bytes before any owned closure;
      // this is not runtime recovery, owner adoption or fabricated history.
      await runtime.store.admission.runExclusiveAsync(() => fs.writeFileSync(runtime.store.file.filePath, originalBytes));
    }
    assert.deepEqual(await confirm(requestId), originalResponse);
    assert.deepEqual(await readBytes(), originalBytes, "refusal and completed replay must not accept or append the rejected UUID");
    const restored = runtime.inspect().executions.find(entry => entry.executionId === runtime.executionId);
    assert.equal(restored.requests.some(entry => entry.requestId === rejectedId), false);
    assert.deepEqual(restored.calls.find(entry => entry.callId === call.callId).receipt, receipt.toJSON());
    assert.deepEqual(restored.finalizationFences.find(entry => entry.fenceId === barrier.fenceId).barrier, barrier.toJSON());
    assert.deepEqual(await confirm(), originalResponse);
  }
  await runtime.close();
  const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions.find(entry => entry.executionId === runtime.executionId);
  assert.equal(historical.status, "closed");
  assert.deepEqual(historical.calls.find(entry => entry.callId === call.callId).receipt, receipt.toJSON());
});


for (const transport of ["tcp", "mailbox"]) {
  test(`bounded ${transport} control observation releases admission, refuses changed bytes and wakes on actual exit publication`, { timeout: 45000 }, async t => {
    const { root, runtime } = await fixture(t);
    const call = await runtime.reserveCall();
    const executor = executorIdentity();
    await runtime.claimLaunch(call, { executor });
    const observe = after => observeControlVia(runtime, call, executor, transport, after);
    let pending, previous;
    const observation = await observeActualChild(runtime, call, executor, { beforeExitPublication: async () => {
      const first = await observe(null);
      assert.equal(first.control.status, "running");
      const started = performance.now();
      previous = await observe(first);
      assert.ok(performance.now() - started < new ManagedControlPolicy().budgetMs);
      assert.equal(previous.publicationDigest, first.publicationDigest);
      assert.deepEqual(previous.control, first.control);
      let settled = false;
      const refused = observe(previous); refused.then(() => { settled = true; }, () => { settled = true; });
      await runtime.readCallControl(call, { executor });
      assert.equal(settled, false, "the independent authenticated query must pass the released admission while the monitor waits");
      const original = fs.readFileSync(runtime.store.file.filePath);
      try {
        await runtime.store.admission.runExclusiveAsync(() => fs.writeFileSync(runtime.store.file.filePath, "{"));
        await assert.rejects(runtime.readCallControl(call, { executor }), { code: "PROCESS_EXECUTION_REGISTRY_FAILED" });
        await assert.rejects(refused, { code: "PROCESS_EXECUTION_REGISTRY_FAILED" });
        assert.equal(fs.readFileSync(runtime.store.file.filePath, "utf8"), "{");
      } finally {
        await runtime.store.admission.runExclusiveAsync(() => fs.writeFileSync(runtime.store.file.filePath, original));
      }
      previous = await observe(null);
      pending = observe(previous);
      settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
      assert.equal((await runtime.readCallControl(call, { executor })).status, "running");
      assert.equal(settled, false);
    } });
    const current = await pending;
    assert.equal(current.control.status, "exited");
    assert.notEqual(current.publicationDigest, previous.publicationDigest);
    const receipt = await finishObservedCall(runtime, call, { observation });
    assert.equal(receipt.observation.kind, "exited");
    assert.equal(receipt.observation.code, 0);
    await runtime.close();
    const stored = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions.find(entry => entry.executionId === runtime.executionId);
    assert.deepEqual(stored.calls.find(entry => entry.callId === call.callId).receipt, receipt.toJSON());
  });
}


function observeControlVia(runtime, call, executor, transport, after = null) {
  if (transport === "tcp") return runtime.observeCallControl(call, { executor, after });
  const grant = { ...runtime.remoteGrant(), transport };
  return managedRequest(grant, "read-control", { grant,
    data: { call: call.controlTarget(), executor: executor.toJSON(), afterControlObservation: after?.publicationDigest ?? null } })
    .then(response => ProcessExecutionControlObservation.fromStored(runtime.decodeResponse(response)));
}

for (const transport of ["tcp", "mailbox"]) {
  test(`${transport} control observation retains its cursor through unrelated reservations and revocations`, { timeout: 45000 }, async t => {
    const { root, runtime } = await fixture(t);
    const call = await runtime.reserveCall();
    const executor = executorIdentity();
    await runtime.claimLaunch(call, { executor });
    const observe = () => observeControlVia(runtime, call, executor, transport);
    let before, reserved, revoked;
    const observation = await observeActualChild(runtime, call, executor, { beforeExitPublication: async () => {
      before = await observe();
      const unrelated = await runtime.reserveCall();
      try { reserved = await observe(); }
      finally { await runtime.revokeCall(unrelated); }
      revoked = await observe();
    } });
    const receipt = await finishObservedCall(runtime, call, { observation });
    assert.equal(before.control.status, "running");
    assert.deepEqual(reserved.control, before.control);
    assert.deepEqual(revoked.control, before.control);
    assert.equal(reserved.publicationDigest, before.publicationDigest);
    assert.equal(revoked.publicationDigest, before.publicationDigest);
    assert.notEqual((await observe()).publicationDigest, before.publicationDigest);
    await runtime.close();
    const stored = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions.find(entry => entry.executionId === runtime.executionId);
    assert.deepEqual(stored.calls.find(entry => entry.callId === call.callId).receipt, receipt.toJSON());
  });
}


test("a committed replay in one TCP carrier arrives before a later serial acceptance is released", { timeout: 45000 }, async (t) => {
  const root = createTmpDir("coordinator-carrier-response-");
  const firstId = randomUUID(), secondId = randomUUID();
  const gate = new ManagedAdmissionPublicationGate(root, firstId, secondId, { operation: "observe" });
  const executions = [], jobs = [];
  let runtime;
  t.after(async () => {
    gate.close();
    await Promise.allSettled(jobs);
    await Promise.allSettled(executions.map((entry) => entry.exited));
    try { if (runtime && !runtime.closed) await runtime.close(); }
    catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
    removeTmpDir(root);
  });
  try {
    runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: gate.coordinatorEnvironment() });
    const grant = runtime.remoteGrant();
    assert.notEqual(grant.endpoint.port, null, "this case must exercise the actual TCP carrier");
    for (let index = 0; index < 2; index++) {
      const call = await runtime.reserveCall(), executor = executorIdentity();
      await runtime.claimLaunch(call, { executor });
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      const exited = once(child, "exit");
      const execution = { call, executor, exited };
      executions.push(execution);
      await once(child, "spawn");
      execution.startedAt = new Date().toISOString();
    }
    const messages = executions.map(({ call, executor, startedAt }, index) => new ManagedProcessMessage(grant, "observe", { grant,
      data: { call: call.controlTarget(), type: "started", executor: executor.toJSON(), startedAt },
    }, { requestId: index === 0 ? firstId : secondId }));
    const original = await managedRequest(grant, "observe", messages[0].payload, { requestId: firstId });
    assert.equal(original.ok, true);
    const policy = new ManagedControlPolicy(), transport = new ManagedRequestTransportCohort();
    let firstSlotDeadline = null;
    const first = managedRequest(grant, "observe", messages[0].payload, { requestId: firstId, policy,
      request: transport.createRequest(), onWait(deadline) {
        firstSlotDeadline ??= deadline - policy.budgetMs + policy.responseDeadlineMs(1);
        if (performance.now() >= firstSlotDeadline && gate.blocked) gate.release();
      } });
    jobs.push(first); first.catch(() => {});
    const second = managedRequest(grant, "observe", messages[1].payload, { requestId: secondId, policy,
      request: transport.createRequest() });
    jobs.push(second); second.catch(() => {});
    let response, beforeRelease;
    try { response = await first; beforeRelease = !gate.released; }
    finally { gate.release(); }
    const secondResponse = await second;
    assert.deepEqual(response, original); assert.equal(secondResponse.ok, true);
    assert.deepEqual(gate.sharedFrameRequestIds(), [firstId, secondId]);
    assert.deepEqual(gate.observation(), { requestId: secondId, links: 2 });
    const receipts = [];
    for (const { call, executor, exited } of executions) {
      const [code, signal] = await exited;
      assert.equal(code, 0); assert.equal(signal, null);
      const observation = new ChildExitObservation({ executor, kind: "exited", code, signal, observedAt: new Date().toISOString() });
      await runtime.observeCall(call, { type: "exit", observation: observation.toJSON() });
      receipts.push(await finishObservedCall(runtime, call, { observation }));
    }
    await runtime.close();
    const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions[0];
    assert.equal(historical.status, "closed");
    for (const [index, { call }] of executions.entries()) {
      assert.deepEqual(historical.calls.find((entry) => entry.callId === call.callId).receipt, receipts[index].toJSON());
    }
    assert.equal(beforeRelease, true, "one TCP carrier must publish an already committed member before a later independent write blocks it");
  } catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(cause); throw cause; }
});
