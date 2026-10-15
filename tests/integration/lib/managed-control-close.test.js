import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { managedControlFailure, managedRequest } from "../../../src/lib/managed-process-protocol.js";
import { ManagedControlPolicy } from "../../../src/lib/managed-control-policy.js";
import { managedMonotonicNow } from "../../../src/lib/managed-stop-operation.js";
import { ManagedStopOperationStore } from "../../../src/lib/managed-stop-store.js";
import { requestManagedLauncherStop } from "../../../src/lib/managed-process.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const runtimeURL = new URL("../../../src/lib/process-execution-runtime.js", import.meta.url).href;
const protocolURL = new URL("../../../src/lib/managed-process-protocol.js", import.meta.url).href;
const identityURL = new URL("../../../src/lib/process-identity.js", import.meta.url).href;
const stopURL = new URL("../../../src/lib/managed-stop-operation.js", import.meta.url).href;
const envelopeURL = new URL("../../../src/lib/flow-envelope.js", import.meta.url).href;
const policyURL = new URL("../../../src/lib/managed-control-policy.js", import.meta.url).href;

async function killOwned(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
}

async function refusingLauncher(t, call) {
  const config = { executionId: call.executionId, callId: call.callId, ownerToken: call.ownerToken,
    capability: call.capability, endpoint: call.endpoint, helloPath: call.helloPath, outcomePath: call.outcomePath };
  // The external socket/process boundary accepts the stop request, then reports
  // a stop failure. The runtime, durable record writers and identity checks are real.
  let child;
  t.after(() => killOwned(child));
  child = spawn(process.execPath, ["--input-type=module", "-e", `
    import net from 'node:net';
    import {ProcessIdentitySource} from ${JSON.stringify(identityURL)};
    import {ManagedProcessMessage,ManagedRequestAcceptance,writeManagedRecord} from ${JSON.stringify(protocolURL)};
    import {ManagedStopOperation} from ${JSON.stringify(stopURL)};
    import {ProcessExecutionControlFailure} from ${JSON.stringify(runtimeURL)};
    const call=${JSON.stringify(config)};
    const launcherIdentity=new ProcessIdentitySource().createOwner(call.ownerToken);
    const record={...call,launcherIdentity,pgid:process.pid,members:[launcherIdentity],state:'waiting',
      providerIdentity:null,outcome:null,controlFailure:null,startRequest:null,stopRequest:null,stopOperation:null};
    const server=net.createServer(socket=>{
      socket.on('error',()=>{});
      let input='';
      socket.on('data',bytes=>{
        input+=bytes;
        if(!input.includes('\\n'))return;
        const request=ManagedProcessMessage.from(JSON.parse(input.slice(0,input.indexOf('\\n'))));
        request.assertPayload();
        if(!request.matches(call)||request.operation!=='stop')throw new Error('Fixture received an unauthorized operation');
        if(record.stopRequest!==null&&!record.stopRequest.matches(request))throw new Error('Stop request was renewed');
        record.stopRequest??=new ManagedRequestAcceptance(request);
        record.stopOperation??=ManagedStopOperation.fromPayload(request.payload);
        record.state='stopping';
        writeManagedRecord(call.outcomePath,record);
        const failure=new ProcessExecutionControlFailure('stop-unconfirmed','Fixture launcher could not stop');
        socket.end(JSON.stringify(request.respond({error:failure.withContext(call).toJSON()}))+'\\n');
      });
    });
    server.listen(call.endpoint,()=>{
      writeManagedRecord(call.helloPath,record);
      process.send({launcherIdentity,endpoint:call.endpoint,pgid:process.pid,members:[launcherIdentity]});
    });
  `], { detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  const hello = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`Launcher fixture exited: ${code}/${signal}: ${stderr}`)));
  });
  return { child, hello };
}

async function freshEnvelope(t, options) {
  let child;
  t.after(() => killOwned(child));
  child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {ProcessExecutionRuntime,ProcessExecutionControlFailure} from ${JSON.stringify(runtimeURL)};
    import {Envelope} from ${JSON.stringify(envelopeURL)};
    const inventory=ProcessExecutionRuntime.inspect(${JSON.stringify(options)});
    const root=inventory.executions[0],call=root.calls[0];
    const failure=ProcessExecutionControlFailure.fromStored(call.controlFailure);
    const envelope=Envelope.fail('run','close',failure.code,failure.message,{processExecutionControlFailure:failure.toJSON()});
    process.stdout.write(JSON.stringify({envelope:envelope.toJSON(),slot:inventory.slot,status:root.status,
      receipt:call.receipt,stopOperation:call.stopOperation}));
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes; });
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, stderr); assert.equal(signal, null);
  return JSON.parse(stdout);
}

// Refusal -> authentic live launcher -> accepted stop -> typed communication
// failure -> runtime registry -> fresh reader/envelope -> unchanged second stop.
test("close persists accepted stop refusal across fresh readback without renewing the stop operation", async (t) => {
  const mainRoot = createTmpDir("managed-close-");
  t.after(() => removeTmpDir(mainRoot));
  const options = { mainRoot, runId: "close-run", specId: "close-spec" };
  const runtime = await ProcessExecutionRuntime.acquire(options);
  const call = await runtime.reserveCall();
  const { child, hello } = await refusingLauncher(t, call);
  await call.authorizeStart(hello);
  let first;
  await assert.rejects(runtime.close(), (error) => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.equal(error.code, "PROCESS_EXECUTION_STOP_UNCONFIRMED");
    assert.equal(error.executionId, runtime.executionId); assert.equal(error.callId, call.callId);
    assert.equal(error.communication.operation, "stop");
    assert.equal(error.communication.cutoff, "refused");
    assert.equal(error.communication.acceptance, "accepted");
    assert.equal(error.communication.stopConfirmation, "unknown");
    assert.equal(error.communication.attempts.length, 1);
    assert.equal(error.communication.attempts[0].outcome, "refused");
    first = error.toJSON(); return true;
  });
  const inventory = runtime.inspect(), saved = inventory.executions[0].calls[0];
  assert.deepEqual(saved.controlFailure, first);
  assert.equal(saved.receipt, null);
  assert.equal(inventory.slot, runtime.executionId);
  assert.equal(inventory.executions[0].accepting, false);
  assert.equal(runtime.closed, false);
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);

  const reloaded = await freshEnvelope(t, options);
  assert.deepEqual(ProcessExecutionControlFailure.fromEnvelope(reloaded.envelope).toJSON(), first);
  assert.deepEqual(reloaded.stopOperation, saved.stopOperation);
  assert.equal(reloaded.receipt, null); assert.equal(reloaded.status, "stopping");
  assert.equal(reloaded.slot, runtime.executionId);
  const publicJSON = JSON.stringify(reloaded.envelope);
  assert.equal(publicJSON.includes(call.ownerToken), false);
  assert.equal(publicJSON.includes(call.capability), false);
  assert.equal(/ownerToken|capability|environment|stack/.test(publicJSON), false);

  await assert.rejects(runtime.close(), (error) => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.deepEqual(error.communication.toJSON(), first.communication);
    assert.deepEqual(error.primaryCause.toJSON(), first.primaryCause);
    return true;
  });
  const retried = runtime.inspect().executions[0].calls[0];
  assert.deepEqual(retried.stopOperation, saved.stopOperation);
  assert.deepEqual(retried.controlFailure, first);
  assert.equal(retried.receipt, null);
  assert.equal(runtime.closed, false);
});

async function coordinator(t, options, { primary = false, graceMs = 1000, beginStop = true } = {}) {
  let child;
  t.after(() => killOwned(child));
  child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {ProcessExecutionRuntime} from ${JSON.stringify(runtimeURL)};
    import {managedRequest,managedControlFailure} from ${JSON.stringify(protocolURL)};
    import {ManagedControlPolicy} from ${JSON.stringify(policyURL)};
    const runtime=await ProcessExecutionRuntime.acquire(${JSON.stringify(options)});
    const call=await runtime.reserveCall();
    process.on('message',async hello=>{
      await call.authorizeStart(hello);
      const operation=${beginStop}?await runtime.beginCallStop(call,{reason:'abort',graceMs:${graceMs}}):null;
      if(${primary}) {
        try { await managedRequest(call,'status',{}, {policy:new ManagedControlPolicy({initialMs:5}),
          request:async()=>{throw managedControlFailure('PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE','Fixture connection lost')}}); }
        catch(error) { await runtime.recordCallControlFailure(call,error); }
      }
      process.send({operation:operation?.toJSON()??null});
    });
    process.send({executionId:call.executionId,callId:call.callId,ownerToken:call.ownerToken,
      capability:call.capability,endpoint:call.endpoint,helloPath:call.helloPath,outcomePath:call.outcomePath});
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  const call = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`Coordinator exited before reservation: ${code}/${signal}: ${stderr}`)));
  });
  return { child, call };
}

test("dead-owner recovery persists stop refusal and preserves the original operation across another acquire", async (t) => {
  const mainRoot = createTmpDir("managed-recovery-");
  let owner, launcher;
  t.after(async () => {
    await killOwned(owner); await killOwned(launcher);
    removeTmpDir(mainRoot);
  });
  const options = { mainRoot, runId: "recovery-run", specId: "recovery-spec" };
  const reserved = await coordinator(t, options);
  owner = reserved.child;
  const { call } = reserved;
  const external = await refusingLauncher(t, call);
  launcher = external.child;
  const authorized = once(owner, "message");
  owner.send(external.hello);
  const [{ operation }] = await authorized;
  const before = ProcessExecutionRuntime.inspect(options);
  assert.equal(before.executions[0].status, "active");
  assert.equal(before.executions[0].calls[0].status, "running");
  assert.deepEqual(before.executions[0].calls[0].stopOperation, operation);
  assert.equal(before.executions[0].calls[0].controlFailure, null);
  await killOwned(owner);

  let first;
  await assert.rejects(ProcessExecutionRuntime.acquire(options), (error) => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.equal(error.code, "PROCESS_EXECUTION_STOP_UNCONFIRMED");
    assert.equal(error.executionId, call.executionId); assert.equal(error.callId, call.callId);
    assert.equal(error.communication.operation, "stop");
    assert.equal(error.communication.acceptance, "accepted");
    assert.equal(error.communication.stopConfirmation, "unknown");
    first = error.toJSON(); return true;
  });
  const stopped = ProcessExecutionRuntime.inspect(options), original = stopped.executions[0];
  assert.equal(stopped.executions.length, 1);
  assert.equal(stopped.slot, call.executionId);
  assert.equal(original.status, "stopping"); assert.equal(original.accepting, false);
  assert.equal(original.calls.length, 1); assert.equal(original.calls[0].receipt, null);
  assert.deepEqual(original.calls[0].stopOperation, operation);
  assert.deepEqual(original.calls[0].controlFailure, first);
  assert.deepEqual(original.coordinatorIdentity, before.executions[0].coordinatorIdentity);
  assert.equal(original.calls[0].launcherIdentity.pid, launcher.pid);

  const reloaded = await freshEnvelope(t, options);
  assert.deepEqual(ProcessExecutionControlFailure.fromEnvelope(reloaded.envelope).toJSON(), first);
  assert.deepEqual(reloaded.stopOperation, operation);
  assert.equal(reloaded.receipt, null);
  assert.equal(reloaded.status, "stopping");
  await assert.rejects(ProcessExecutionRuntime.acquire(options), (error) => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.deepEqual(error.communication.toJSON(), first.communication);
    assert.deepEqual(error.primaryCause.toJSON(), first.primaryCause);
    return true;
  });
  const retried = ProcessExecutionRuntime.inspect(options);
  assert.equal(retried.ownerEpoch, before.ownerEpoch);
  assert.equal(retried.executions.length, 1);
  assert.equal(retried.slot, call.executionId);
  assert.deepEqual(retried.executions[0].calls, original.calls);
  assert.equal(launcher.exitCode, null); assert.equal(launcher.signalCode, null);
});

async function holdManagedRecord(t, file) {
  const lockURL = new URL("../../../src/lib/file-lock.js", import.meta.url).href;
  const authorityURL = new URL("../../../src/lib/real-directory-authority.js", import.meta.url).href;
  let child;
  t.after(() => killOwned(child));
  child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {FileLock} from ${JSON.stringify(lockURL)};
    import {RealDirectoryAuthority} from ${JSON.stringify(authorityURL)};
    const lock=new FileLock({directoryAuthority:new RealDirectoryAuthority(${JSON.stringify(path.dirname(file))}),
      fileName:${JSON.stringify(path.basename(file) + ".lock")},kind:'managed-process-record',authority:{file:${JSON.stringify(file)}}});
    lock.acquire();process.send('locked');
    process.on('message',()=>{lock.release();process.disconnect()});
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; });
  const [ready] = await once(child, "message");
  assert.equal(ready, "locked", stderr);
  return async () => {
    const exited = once(child, "exit"); child.send("release"); await exited;
  };
}

async function connectionFailure(call) {
  let failure;
  await assert.rejects(managedRequest(call, "status", {}, {
    policy: new ManagedControlPolicy({ initialMs: 5 }),
    request: async () => { throw managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Fixture connection lost"); },
  }), (error) => { failure = error; return error instanceof ProcessExecutionControlFailure; });
  return failure;
}

async function recordConnectionFailure(runtime, call) {
  return (await runtime.recordCallControlFailure(call, await connectionFailure(call))).toJSON();
}

// A first stop and optional primary failure are produced by their real APIs.
// The external record writer then holds a lock across the original deadline.
// Refusal must survive registry publication, another process's readback, and
// the next close/handoff/recovery decision without issuing a permit or receipt.
for (const scenario of [
  { route: "close", stage: "outcome", primary: true },
  { route: "handoff", stage: "hello", primary: false },
  { route: "recovery", stage: "outcome", primary: true },
  { route: "begin", stage: "outcome", primary: true },
]) {
  test(`stop preparation ${scenario.route} preserves deadline and durable failure under ${scenario.stage} contention`, async (t) => {
    const mainRoot = createTmpDir("managed-stop-preparation-");
    let runtime, owner, launcher;
    t.after(async () => {
      await killOwned(owner); await killOwned(launcher);
      runtime?.store.ownerLock.release();
      removeTmpDir(mainRoot);
    });
    const options = { mainRoot, runId: "preparation-run", specId: "preparation-spec" };
    let call, operation;
    if (scenario.route === "recovery") {
      const reserved = await coordinator(t, options, { primary: true, graceMs: 100 });
      owner = reserved.child; call = reserved.call;
      const external = await refusingLauncher(t, call); launcher = external.child;
      const begun = once(owner, "message"); owner.send(external.hello);
      [{ operation }] = await begun;
      await killOwned(owner);
    } else {
      runtime = await ProcessExecutionRuntime.acquire(options);
      call = await runtime.reserveCall();
      const external = await refusingLauncher(t, call); launcher = external.child;
      // Handoff covers interruption after hello publication, before start permit.
      if (scenario.stage !== "hello") await call.authorizeStart(external.hello);
      if (scenario.route !== "begin") operation = (await runtime.beginCallStop(call, { reason: "abort", graceMs: 100 })).toJSON();
      if (scenario.primary) await recordConnectionFailure(runtime, call);
    }
    const before = ProcessExecutionRuntime.inspect(options), original = before.executions[0].calls[0];
    const release = await holdManagedRecord(t, scenario.stage === "hello" ? call.helloPath : call.outcomePath);
    const invoke = () => scenario.route === "recovery" ? ProcessExecutionRuntime.acquire(options)
      : scenario.route === "handoff" ? runtime.sealForCheckoutHandoff()
        : scenario.route === "begin" ? runtime.beginCallStop(call, { reason: "abort", graceMs: 100 }) : runtime.close();
    const started = managedMonotonicNow();
    let failure;
    await assert.rejects(invoke(), (error) => {
      assert.ok(error instanceof ProcessExecutionControlFailure); failure = error.toJSON(); return true;
    });
    const elapsed = managedMonotonicNow() - started;
    const saved = ProcessExecutionRuntime.inspect(options), stopped = saved.executions[0].calls[0];
    t.diagnostic(JSON.stringify({ route: scenario.route, elapsed, remainingAtStart: operation ? operation.deadline - started : 2200,
      returnedCode: failure.code, savedCode: stopped.controlFailure?.code, returnedEqualsSaved: JSON.stringify(failure) === JSON.stringify(stopped.controlFailure) }));
    await release();
    assert.deepEqual(stopped.controlFailure, failure, "returned preparation failure must be the persisted first failure");
    if (scenario.primary) assert.deepEqual(failure, original.controlFailure, "preparation must retain original primary and communication");
    else assert.equal(failure.code, "PROCESS_EXECUTION_RECORD_UNREADABLE");
    assert.equal(failure.executionId, call.executionId); assert.equal(failure.callId, call.callId);
    assert.ok(elapsed < Math.max(0, operation ? operation.deadline - started : 2200) + 750,
      "preparation must consume the existing stop budget, not the independent five-second record lock budget");
    if (operation) assert.deepEqual(stopped.stopOperation, operation);
    else {
      operation = stopped.stopOperation;
      assert.ok(operation, "initial stop decision must be durable before contended preparation");
      assert.equal(operation.reason, "abort"); assert.equal(operation.graceMs, 100);
      assert.ok(operation.deadline <= started + 2200 + 100);
    }
    assert.equal(stopped.receipt, null); assert.deepEqual(stopped.permit, original.permit);
    assert.equal(saved.slot, call.executionId); assert.equal(saved.ownerEpoch, before.ownerEpoch);
    assert.equal(saved.executions.length, 1); assert.equal(saved.executions[0].calls.length, 1);
    assert.equal(launcher.exitCode, null); assert.equal(launcher.signalCode, null);
    const reloaded = await freshEnvelope(t, options);
    assert.deepEqual(ProcessExecutionControlFailure.fromEnvelope(reloaded.envelope).toJSON(), failure);
    assert.deepEqual(reloaded.stopOperation, operation); assert.equal(reloaded.receipt, null);
    // Begin has already selected a stop; close is the next production consumer.
    const retry = scenario.route === "begin" ? () => runtime.close() : invoke;
    await assert.rejects(retry(), (error) => {
      assert.ok(error instanceof ProcessExecutionControlFailure);
      assert.deepEqual(error.toJSON(), failure); return true;
    });
    const retried = ProcessExecutionRuntime.inspect(options);
    assert.equal(retried.ownerEpoch, before.ownerEpoch); assert.equal(retried.slot, call.executionId);
    assert.equal(retried.executions.length, 1); assert.equal(retried.executions[0].calls.length, 1);
    assert.deepEqual(retried.executions[0].calls[0].stopOperation, operation);
    assert.deepEqual(retried.executions[0].calls[0].controlFailure, failure);
    assert.deepEqual(retried.executions[0].calls[0].permit, original.permit);
    assert.equal(retried.executions[0].calls[0].receipt, null);
    assert.equal(retried.executions[0].accepting, false);
  });
}

test("stop preparation admission expiry preserves predecessor ownership and successor ordering", async (t) => {
  const mainRoot = createTmpDir("managed-stop-admission-");
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(async () => { release(); runtime.store.ownerLock.release(); removeTmpDir(mainRoot); });
  const call = await runtime.reserveCall();
  const operation = await runtime.beginCallStop(call, { reason: "abort", graceMs: 100 });
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const predecessor = runtime.store.exclusive(async () => { enter(); await gate; });
  await entered;
  let rejected = false, expiredRan = false, successorRan = false;
  const expired = runtime.store.exclusive(() => { expiredRan = true; }, { deadline: operation.deadline })
    .then(() => null, error => { rejected = true; return error; });
  await delay(Math.max(0, operation.remainingMs()) + 150);
  const rejectedWhileHeld = rejected;
  const successor = runtime.store.exclusive(() => { successorRan = true; });
  await nextTurn();
  const successorEnteredEarly = successorRan;
  release();
  const [, error] = await Promise.all([predecessor, expired, successor]);
  assert.equal(rejectedWhileHeld, true, "deadline must reject queued admission while its predecessor remains held");
  assert.ok(error instanceof ProcessExecutionControlFailure);
  assert.equal(expiredRan, false, "timed-out admission cannot execute later");
  assert.equal(successorEnteredEarly, false, "timeout must not release its predecessor's ownership");
  assert.equal(successorRan, true);
  const inventory = runtime.inspect();
  assert.deepEqual(inventory.executions[0].calls[0].stopOperation, operation.toJSON());
  assert.equal(inventory.executions[0].calls[0].receipt, null);
  assert.equal(inventory.executions[0].calls.length, 1);
});

test("stop preparation rejects a foreign capability before creating stop authority", async (t) => {
  const mainRoot = createTmpDir("managed-stop-authority-");
  let runtime, launcher;
  t.after(async () => {
    await killOwned(launcher); runtime?.store.ownerLock.release(); removeTmpDir(mainRoot);
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot });
  const call = await runtime.reserveCall();
  const external = await refusingLauncher(t, call); launcher = external.child;
  await call.authorizeStart(external.hello);
  const before = runtime.inspect();
  const forged = { executionId: call.executionId, callId: call.callId, ownerToken: call.ownerToken,
    capability: crypto.randomUUID(), endpoint: call.endpoint, helloPath: call.helloPath, outcomePath: call.outcomePath };
  await assert.rejects(requestManagedLauncherStop(forged, { graceMs: 100 }), { code: "PROCESS_EXECUTION_AUTHORITY_MISMATCH" });
  assert.equal(fs.existsSync(`${call.outcomePath}.stop`), false, "an unauthenticated caller cannot publish the first stop decision");
  assert.deepEqual(runtime.inspect(), before);
  assert.equal(launcher.exitCode, null); assert.equal(launcher.signalCode, null);
});

test("stop preparation branch guard persists a newly observed communication failure before contended preparation", async (t) => {
  const mainRoot = createTmpDir("managed-stop-first-failure-");
  let runtime, launcher;
  t.after(async () => {
    await killOwned(launcher); runtime?.store.ownerLock.release(); removeTmpDir(mainRoot);
  });
  const options = { mainRoot, runId: "first-failure-run", specId: "first-failure-spec" };
  runtime = await ProcessExecutionRuntime.acquire(options);
  const call = await runtime.reserveCall();
  const external = await refusingLauncher(t, call); launcher = external.child;
  await call.authorizeStart(external.hello);
  const primary = await connectionFailure(call);
  const expected = primary.withContext(call).toJSON();
  const before = runtime.inspect(), original = before.executions[0].calls[0];
  assert.equal(original.controlFailure, null); assert.equal(original.stopOperation, null);
  const release = await holdManagedRecord(t, call.outcomePath);
  const started = managedMonotonicNow();
  await assert.rejects(runtime.beginCallStop(call, { reason: "control-failure", graceMs: 100, controlFailure: primary }), error => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.deepEqual(error.toJSON(), expected); return true;
  });
  const elapsed = managedMonotonicNow() - started;
  await release();
  const saved = runtime.inspect(), stopped = saved.executions[0].calls[0];
  assert.ok(elapsed < 2950, "first failure preparation must establish its stop deadline before waiting");
  assert.deepEqual(stopped.controlFailure, expected);
  assert.equal(stopped.stopOperation.reason, "control-failure"); assert.equal(stopped.stopOperation.graceMs, 100);
  assert.ok(stopped.stopOperation.deadline <= started + 2300);
  assert.equal(stopped.receipt, null); assert.deepEqual(stopped.permit, original.permit);
  assert.equal(saved.ownerEpoch, before.ownerEpoch); assert.equal(saved.slot, call.executionId);
  assert.equal(saved.executions.length, 1); assert.equal(saved.executions[0].calls.length, 1);
  const reloaded = await freshEnvelope(t, options);
  assert.deepEqual(ProcessExecutionControlFailure.fromEnvelope(reloaded.envelope).toJSON(), expected);
  assert.deepEqual(reloaded.stopOperation, stopped.stopOperation); assert.equal(reloaded.receipt, null);
  await assert.rejects(runtime.close(), error => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.deepEqual(error.toJSON(), expected); return true;
  });
  const retried = runtime.inspect();
  assert.deepEqual(retried.executions[0].calls, saved.executions[0].calls);
  assert.equal(retried.slot, call.executionId); assert.equal(retried.ownerEpoch, before.ownerEpoch);
  assert.equal(retried.executions[0].accepting, false);
  assert.equal(launcher.exitCode, null); assert.equal(launcher.signalCode, null);
  t.diagnostic(JSON.stringify({ route: "initial-communication-failure", elapsed, returnedEqualsSaved: true }));
});

test("stop preparation branch guard rejects foreign recovery binding before reading contended stop authority", async (t) => {
  const mainRoot = createTmpDir("managed-stop-foreign-recovery-");
  let owner, launcher;
  t.after(async () => { await killOwned(owner); await killOwned(launcher); removeTmpDir(mainRoot); });
  const options = { mainRoot, runId: "original-run", specId: "original-spec" };
  const reserved = await coordinator(t, options, { beginStop: false }); owner = reserved.child;
  const { call } = reserved;
  const external = await refusingLauncher(t, call); launcher = external.child;
  const authorized = once(owner, "message"); owner.send(external.hello);
  const [{ operation }] = await authorized; assert.equal(operation, null);
  // The shared writer can publish a first stop before the coordinator mirrors it.
  const shared = new ManagedStopOperationStore(call).claim({ reason: "abort", graceMs: 100 });
  await killOwned(owner);
  const before = ProcessExecutionRuntime.inspect(options);
  assert.equal(before.executions[0].calls[0].stopOperation, null);
  assert.equal(before.executions[0].calls[0].controlFailure, null);
  const directory = path.resolve(path.dirname(call.outcomePath), "../..");
  const protectedFiles = [path.join(directory, "registry.json"), path.join(directory, "authority.json"), `${call.outcomePath}.stop`];
  const contents = protectedFiles.map(file => fs.readFileSync(file));
  const release = await holdManagedRecord(t, `${call.outcomePath}.stop`);
  for (const foreign of [{ runId: "foreign-run" }, { specId: "foreign-spec" }]) {
    const started = managedMonotonicNow();
    await assert.rejects(ProcessExecutionRuntime.acquire({ ...options, ...foreign }), { code: "PROCESS_EXECUTION_BINDING_MISMATCH" });
    assert.ok(managedMonotonicNow() - started < 1000, "binding rejection must precede waiting for another run's stop sidecar");
    assert.deepEqual(ProcessExecutionRuntime.inspect(options), before);
    for (const [index, file] of protectedFiles.entries()) assert.deepEqual(fs.readFileSync(file), contents[index]);
  }
  await release();
  assert.deepEqual(new ManagedStopOperationStore(call).read().toJSON(), shared.toJSON());
  assert.equal(launcher.exitCode, null); assert.equal(launcher.signalCode, null);
});

test("stop preparation committed snapshot refuses uncertain registry before waiting on stop authority", async (t) => {
  const mainRoot = createTmpDir("managed-stop-uncommitted-");
  let runtime, armed = false;
  t.after(() => { runtime?.store.ownerLock.release(); removeTmpDir(mainRoot); });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot, faultInjector({ phase }) {
    if (armed && phase === "before-runtime-directory-fsync") throw new Error("Fixture registry directory fsync unavailable");
  } });
  const call = await runtime.reserveCall();
  new ManagedStopOperationStore(call).claim({ reason: "abort", graceMs: 100 });
  assert.equal(runtime.inspect().executions[0].calls[0].stopOperation, null);
  armed = true;
  await assert.rejects(runtime.recordCallControlFailure(call,
    new ProcessExecutionControlFailure("receipt-delivery-failed", "Fixture observation could not be delivered")),
  { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  const directory = path.resolve(path.dirname(call.outcomePath), "../..");
  const protectedFiles = ["registry.json", "transition.json", "authority.json"].map(file => path.join(directory, file));
  protectedFiles.push(`${call.outcomePath}.stop`);
  const contents = protectedFiles.map(file => fs.readFileSync(file));
  assert.equal(JSON.parse(contents[1]).executionId, runtime.executionId, "real failed publication must retain its transition marker");
  const release = await holdManagedRecord(t, `${call.outcomePath}.stop`);
  const started = managedMonotonicNow();
  await assert.rejects(runtime.close(), error => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.equal(error.code, "PROCESS_EXECUTION_DURABILITY_UNCERTAIN"); return true;
  });
  assert.ok(managedMonotonicNow() - started < 1000, "uncommitted state cannot select a stop or wait for its sidecar");
  for (const [index, file] of protectedFiles.entries()) assert.deepEqual(fs.readFileSync(file), contents[index]);
  assert.equal(runtime.closed, false);
  await release();
});
