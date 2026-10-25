import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess, withManagedProcessScope } from "../../../src/lib/managed-process.js";
import { ProcessExecutionStopReceipt, ProcessExecutorIdentity } from "../../../src/lib/process-execution-values.js";
import { managedControlFailure, managedRequest } from "../../../src/lib/managed-process-protocol.js";
import { ManagedControlPolicy } from "../../../src/lib/managed-control-policy.js";
import { managedMonotonicNow } from "../../../src/lib/managed-stop-operation.js";
import { ManagedStopOperationStore } from "../../../src/lib/managed-stop-store.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { SENNEL_BOOTSTRAP } from "../../support/infrastructure/node-bootstrap.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { RuntimeRegistryPublicationFailure } from "../../support/infrastructure/runtime-registry-publication-failure.js";

async function fixture(t) {
  const root = createTmpDir("managed-control-");
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  let verified = false;
  t.after(async () => {
    if (runtime.control.child.exitCode === null && runtime.control.child.signalCode === null) {
      const stopped = once(runtime.control.child, "exit"); runtime.control.child.ref(); runtime.control.child.kill(); await stopped;
    }
    if (verified) removeTmpDir(root); else testTemporaryRoot().retainOnUnconfirmedExecution();
  });
  return { root, runtime, verified() { verified = true; } };
}
async function freshEnvelope(root) {
  const child = spawn(process.execPath, ["--import", SENNEL_BOOTSTRAP, "--input-type=module", "-e", `
    import {ProcessExecutionRuntime,ProcessExecutionControlFailure} from ${JSON.stringify(new URL("../../../src/lib/process-execution-runtime.js", import.meta.url).href)};
    import {Envelope} from ${JSON.stringify(new URL("../../../src/lib/flow-envelope.js", import.meta.url).href)};
    const root=ProcessExecutionRuntime.inspect({mainRoot:${JSON.stringify(root)}}).executions[0];
    const failure=ProcessExecutionControlFailure.fromStored(root.calls[0].controlFailure);
    process.stdout.write(JSON.stringify({root,envelope:Envelope.fail('run','close',failure.code,failure.message,{processExecutionControlFailure:failure.toJSON()}).toJSON()}));
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes; }); child.stderr.on("data", (bytes) => { stderr += bytes; });
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, stderr); assert.equal(signal, null);
  return JSON.parse(stdout);
}

// The sole coordinator replaces the retired launcher stop/hello protocol.
// Its first operation/failure must survive another process's read and retries;
// neither missing observations nor a lost host capability can produce a receipt.
test("first stop and communication failure survive fresh readback without renewing the coordinator deadline", async (t) => {
  const value = await fixture(t), { runtime, root } = value;
  const call = await runtime.reserveCall();
  const executor = new ProcessExecutorIdentity({ executorId: crypto.randomUUID(), executorSession: crypto.randomUUID(), launchClaim: crypto.randomUUID() });
  await runtime.claimLaunch(call, { executor });
  let primary;
  await assert.rejects(managedRequest(call, "status", {}, {
    policy: new ManagedControlPolicy({ initialMs: 5 }),
    request: async () => { throw managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Fixture connection lost"); },
  }), (error) => { primary = error; return error instanceof ProcessExecutionControlFailure; });
  const firstFailure = await runtime.recordCallControlFailure(call, primary);
  const operation = await runtime.beginCallStop(call, { reason: "control-failure", graceMs: 100 });
  const before = runtime.inspect().executions[0].calls[0];
  const firstControl = await runtime.readCallControl(call, { executor });
  const reloaded = await freshEnvelope(root);
  assert.deepEqual(ProcessExecutionControlFailure.fromEnvelope(reloaded.envelope).toJSON(), firstFailure.toJSON());
  assert.deepEqual(reloaded.root.calls[0].controlFailure, firstFailure.toJSON());
  assert.deepEqual(reloaded.root.calls[0].stopOperation, operation.toJSON());
  assert.equal(reloaded.root.calls[0].observation, null);
  assert.equal(reloaded.root.calls[0].receipt, null);
  assert.equal(/ownerToken|capability|environment|stack/.test(JSON.stringify(reloaded.envelope)), false);
  const repeated = await runtime.beginCallStop(call, { reason: "timeout", graceMs: 10000 });
  assert.deepEqual(repeated.toJSON(), operation.toJSON());
  assert.deepEqual(new ManagedStopOperationStore(call).read().toJSON(), operation.toJSON());
  const replacement = new ProcessExecutionControlFailure("stop-unconfirmed", "Later refusal cannot replace the original connection loss");
  assert.deepEqual((await runtime.recordCallControlFailure(call, replacement)).toJSON(), firstFailure.toJSON());
  const control = await runtime.readCallControl(call, { executor });
  assert.equal(control.stopRequested, true);
  assert.equal(control.stopRemainingMs >= 0 && control.stopRemainingMs <= firstControl.stopRemainingMs, true);
  assert.equal(control.controlFailure.code, firstFailure.code);
  const saved = runtime.inspect().executions[0].calls[0];
  assert.deepEqual(saved.controlFailure, before.controlFailure);
  assert.deepEqual(saved.stopOperation, before.stopOperation);
  assert.equal(saved.receipt, null);
  let consumed = false;
  await assert.rejects(runtime.enter(() => ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: root, binding: { contract: "unknown-call" } }, () => { consumed = true; })),
    { code: "PROCESS_EXECUTION_STOP_UNCONFIRMED" });
  assert.equal(consumed, false);
  await assert.rejects(runtime.close(), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_STOP_UNCONFIRMED");
    assert.deepEqual(error.primaryCause.toJSON(), firstFailure.primaryCause.toJSON());
    assert.deepEqual(error.communication.toJSON(), firstFailure.communication.toJSON());
    return true;
  });
  assert.equal(runtime.closed, false);
  assert.deepEqual(runtime.inspect().executions[0].calls[0].controlFailure, firstFailure.toJSON());
  value.verified();
});

test("a typed child-publication failure remains primary when scope closure also refuses", { timeout: 60000 }, async (t) => {
  const root = createTmpDir("managed-control-primary-close-");
  const fault = new RuntimeRegistryPublicationFailure(root, { boundary: "after-publication", callFact: "receipt" });
  let runtime;
  t.after(async () => {
    testTemporaryRoot().retainOnUnconfirmedExecution();
    const child = runtime?.control?.child;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit"); child.ref(); child.kill(); await stopped;
    }
  });

  await assert.rejects(withManagedProcessScope({ standaloneRoot: root, readOnly: true, environment: fault.environment }, async (scope) => {
    runtime = scope;
    return executeManagedProcess(process.execPath, ["-e", "process.stdout.write('receipt before closure')"], {
      runtime: scope, timeoutMs: 10000,
    });
  }), (error) => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.ok(error.cause instanceof AggregateError);
    const [primary, closure] = error.cause.errors;
    assert.ok(primary instanceof ProcessExecutionControlFailure);
    assert.ok(closure instanceof ProcessExecutionControlFailure);
    assert.deepEqual(error.toJSON(), primary.toJSON());
    return true;
  });

  const witness = JSON.parse(fs.readFileSync(fault.witness, "utf8"));
  assert.equal(witness.boundary, "after-publication");
  assert.equal(witness.callFact, "receipt");
  const persisted = JSON.parse(fs.readFileSync(runtime.store.file.filePath, "utf8"));
  const call = persisted.payload.executions.at(-1).calls.find((entry) => entry.callId === witness.callId);
  const receipt = new ProcessExecutionStopReceipt(call?.receipt);
  assert.equal(receipt.callId, call.callId);
  assert.equal(receipt.executionId, persisted.payload.executions.at(-1).executionId);
  assert.equal(receipt.observation.kind, "exited");
  assert.equal(receipt.observation.code, 0);
  assert.equal(receipt.observation.signal, null);
  assert.equal(receipt.stopEvidence.confirmed, true);
});

test("expired runtime admission cannot run later or release its waiting predecessor", async (t) => {
  const value = await fixture(t), { runtime } = value;
  let release, enter;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { enter = resolve; });
  t.after(() => release());
  const predecessor = runtime.store.exclusive(async () => { enter(); await gate; });
  await entered;
  let expiredRan = false, successorRan = false;
  const expired = runtime.store.exclusive(() => { expiredRan = true; }, { deadline: managedMonotonicNow() });
  await assert.rejects(expired, { code: "PROCESS_EXECUTION_STOP_UNPROVEN" });
  const successor = runtime.store.exclusive(() => { successorRan = true; });
  await nextTurn();
  assert.equal(expiredRan, false);
  assert.equal(successorRan, false);
  release();
  await Promise.all([predecessor, successor]);
  assert.equal(expiredRan, false);
  assert.equal(successorRan, true);
  await runtime.close();
  value.verified();
});

test("foreign call capability refuses before first durable stop authority or call mutation", async (t) => {
  const value = await fixture(t), { runtime } = value;
  const call = await runtime.reserveCall();
  const before = runtime.inspect().executions[0].calls[0];
  const grant = runtime.remoteGrant();
  await assert.rejects(managedRequest(grant, "begin-stop", { grant, data: {
    call: { ...call.controlTarget(), capability: crypto.randomUUID() }, reason: "abort", graceMs: 100,
  } }), { code: "PROCESS_EXECUTION_BINDING_MISMATCH" });
  assert.equal(fs.existsSync(`${call.outcomePath}.stop`), false);
  assert.deepEqual(runtime.inspect().executions[0].calls[0], before);
  assert.equal(runtime.inspect().slot, runtime.executionId);
  value.verified();
});
