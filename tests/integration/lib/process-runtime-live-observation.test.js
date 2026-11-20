import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { ChildExitObservation, ProcessExecutorIdentity, ProcessOutputState } from "../../../src/lib/process-execution-values.js";
import { runManagedControlSync, closeSynchronousExecutionBridge } from "../../../src/lib/process-execution-sync.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

async function fixture(t, beforeClose = async () => {}) {
  const root = createTmpDir("runtime-live-observation-");
  let runtime;
  t.after(async () => {
    if (runtime) { await beforeClose(); await runtime.close(); }
    closeSynchronousExecutionBridge();
    removeTmpDir(root);
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  return { root, runtime };
}

test("read-only inventory reobserves a committed request publication crossing its captured registry generation", { timeout: 45000 }, async t => {
  const { root, runtime } = await fixture(t);
  const grant = runtime.remoteGrant();
  runtime.decodeResponse(runManagedControlSync(grant, "events", {}));
  const read = runtime.store.file.readSnapshot.bind(runtime.store.file);
  let reads = 0, reserved;
  t.mock.method(runtime.store.file, "readSnapshot", () => {
    const snapshot = read();
    if (++reads === 2) {
      // The independent coordinator commits through its normal producer while
      // this reader retains the original registry, before reading its blocks.
      reserved = runtime.decodeResponse(runManagedControlSync(grant, "reserve", { binding: null, graceMs: 500 }));
    }
    return snapshot;
  });
  try {
    const observed = runtime.store.readConsistentInventory();
    assert.ok(reserved);
    const call = observed.executions.find(entry => entry.executionId === runtime.executionId).calls[0];
    assert.equal(call.callId, reserved.callId);
    assert.equal(call.status, "intent");
    assert.equal(call.receipt, null);
    assert.deepEqual(ProcessExecutionRuntime.inspect({ mainRoot: root }), observed);
  } finally {
    if (reserved) runtime.decodeResponse(runManagedControlSync(grant, "revoke-reservation", { call: {
      callId: reserved.callId, capability: reserved.capability, bindingDigest: grant.bindingDigest,
    } }));
  }
});

test("stable foreign request blocks are rejected on the first inventory observation", async t => {
  const { runtime } = await fixture(t);
  const call = await runtime.reserveCall();
  await runtime.revokeCall(call);
  const directory = runtime.store.requestBlockDirectory(runtime.executionId, { create: false }).directory;
  const foreign = path.join(directory, `${randomUUID()}.json`);
  fs.writeFileSync(foreign, "foreign block");
  const read = runtime.store.readInventory.bind(runtime.store);
  let observations = 0;
  t.mock.method(runtime.store, "readInventory", () => { observations++; return read(); });
  try {
    assert.throws(() => runtime.store.readConsistentInventory(), { code: "PROCESS_EXECUTION_RECORD_CORRUPT" });
    assert.equal(observations, 1);
    assert.equal(fs.readFileSync(foreign, "utf8"), "foreign block");
  } finally { fs.unlinkSync(foreign); }
});

class RegisteredChild {
  constructor(runtime) { this.runtime = runtime; this.executor = new ProcessExecutorIdentity({ executorId: randomUUID(), executorSession: randomUUID(), launchClaim: randomUUID() }); }
  async start() {
    this.call = await this.runtime.reserveCall();
    await this.runtime.claimLaunch(this.call, { executor: this.executor });
    this.child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
    this.exited = once(this.child, "exit");
    await once(this.child, "spawn");
    await this.runtime.observeCall(this.call, { type: "started", executor: this.executor.toJSON(), startedAt: new Date().toISOString() });
    return this;
  }
  async finish() {
    if (!this.child || this.receipt) return;
    this.child.stdin.end();
    const [code, signal] = await this.exited;
    const observation = new ChildExitObservation({ executor: this.executor, kind: "exited", code, signal, observedAt: new Date().toISOString() });
    await this.runtime.observeCall(this.call, { type: "exit", observation: observation.toJSON() });
    const maximum = 0;
    const stdout = await this.runtime.persistCallOutput(this.call, { executor: this.executor, stream: "stdout", maximum, bytes: Buffer.alloc(0) });
    const stderr = await this.runtime.persistCallOutput(this.call, { executor: this.executor, stream: "stderr", maximum, bytes: Buffer.alloc(0) });
    this.receipt = await this.runtime.finishCall(this.call, { observation, outcome: { code, signal, output: { maximum, stdout, stderr } },
      output: new ProcessOutputState({ stdoutBytes: 0, stderrBytes: 0, completion: "complete", cutoffAt: new Date().toISOString() }) });
    return this.receipt;
  }
}

test("a stopping parent retains its existing child's authenticated control observation while new nested admissions stay fenced", { timeout: 45000 }, async t => {
  let parent, borrowed, child, unclaimed;
  const { root, runtime } = await fixture(t, async () => {
    if (unclaimed) await borrowed.revokeCall(unclaimed);
    await child?.finish(); await parent?.finish(); await borrowed?.close();
  });
  parent = new RegisteredChild(runtime);
  await parent.start();
  const grant = JSON.parse(parent.call.executionEnvironment().SENNEL_PROCESS_EXECUTION_SCOPE);
  borrowed = await ProcessExecutionRuntime.fromRemoteGrant(grant);
  child = await new RegisteredChild(borrowed).start();
  unclaimed = await borrowed.reserveCall();
  const before = await borrowed.observeCallControl(child.call, { executor: child.executor });
  assert.equal(before.control.stopRequested, false);
  await runtime.beginCallStop(parent.call, { reason: "abort" });
  const stopped = await borrowed.observeCallControl(child.call, { executor: child.executor, after: before });
  assert.equal(stopped.control.stopRequested, true);
  assert.equal(stopped.control.aborted, true);
  assert.equal(stopped.control.status, "running");
  assert.notEqual(stopped.publicationDigest, before.publicationDigest);
  await assert.rejects(ProcessExecutionRuntime.fromRemoteGrant(grant), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
  await assert.rejects(borrowed.reserveCall(), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
  await assert.rejects(borrowed.claimLaunch(unclaimed, { executor: child.executor }), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
  const forged = new ProcessExecutorIdentity({ executorId: randomUUID(), executorSession: randomUUID(), launchClaim: randomUUID() });
  await assert.rejects(borrowed.observeCallControl(child.call, { executor: forged }), { code: "PROCESS_EXECUTION_EXECUTOR_MISMATCH" });
  await borrowed.revokeCall(unclaimed); unclaimed = null;
  const childReceipt = await child.finish();
  const parentReceipt = await parent.finish();
  assert.equal(childReceipt.stopEvidence.confirmed, true);
  assert.equal(parentReceipt.stopEvidence.confirmed, true);
  assert.ok(parentReceipt.descendants.some(entry => entry.callId === child.call.callId));
  await borrowed.close();
  await runtime.close();
  const saved = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions.find(entry => entry.executionId === runtime.executionId);
  assert.deepEqual(saved.calls.find(entry => entry.callId === child.call.callId).receipt, childReceipt.toJSON());
  assert.deepEqual(saved.calls.find(entry => entry.callId === parent.call.callId).receipt, parentReceipt.toJSON());
});
