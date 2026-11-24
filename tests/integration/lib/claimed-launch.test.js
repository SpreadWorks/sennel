import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionClaimedLaunch } from "../../../src/lib/process-execution-runtime.js";
import { ChildExitObservation, ProcessOutputState, ProcessExecutorIdentity } from "../../../src/lib/process-execution-values.js";
import { DirectChildExecutor } from "../../../src/lib/direct-child-executor.js";
import { CommandLaunchDescriptor } from "../../../src/lib/command-invocation.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

async function fixture(t) {
  const root = createTmpDir("claimed-launch-");
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root });
  t.after(async () => {
    try { if (!runtime.closed) await runtime.close(); }
    catch (error) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw error; }
    removeTmpDir(root);
  });
  return { root, runtime };
}

test("normal native execution durably claims its reservation before the actual spawn", { timeout: 45000 }, async t => {
  const { root, runtime } = await fixture(t);
  let admission;
  const result = await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "process.stdout.write('claimed')"], {
    cwd: root, timeoutMs: 5000,
    onSupervisorEvent(event) {
      if (event.type !== "intent") return;
      const stored = runtime.store.read().executions.find(entry => entry.executionId === runtime.executionId);
      admission = stored.calls.find(call => call.callId === event.callId);
      assert.equal(admission.status, "claimed");
      assert.equal(admission.observation, null);
      assert.equal(admission.receipt, null);
      assert.equal(admission.permit.callId, admission.callId);
      assert.equal(stored.requests.filter(request => request.operation === "reserve-and-claim").length, 1);
      assert.equal(stored.requests.filter(request => ["reserve", "claim-launch"].includes(request.operation)).length, 0);
    },
  }));
  assert.ok(admission);
  assert.equal(result.stdout, "claimed");
  assert.equal(result.processExecutionStopReceipt.observation.kind, "exited");
  await runtime.close();
  const saved = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions.find(entry => entry.executionId === runtime.executionId);
  assert.deepEqual(saved.calls[0].receipt, result.processExecutionStopReceipt.toJSON());
});

test("an authenticated claimed launch cannot be consumed by a second native execution", { timeout: 45000 }, async t => {
  const { root, runtime } = await fixture(t);
  const identity = new ProcessExecutorIdentity({ executorId: randomUUID(), executorSession: randomUUID(), launchClaim: randomUUID() });
  const launch = await runtime.reserveClaimedCall({ executor: identity, timeoutMs: 5000 });
  assert.ok(launch instanceof ProcessExecutionClaimedLaunch);
  const command = new CommandLaunchDescriptor({ executable: process.execPath,
    args: ["-e", "require('node:fs').appendFileSync('effects','one\\n');process.stdout.write('once')"],
    cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: false });
  const options = { timeoutMs: 5000, exitDrainMs: 1000, maxBuffer: 1024 };
  const result = await new DirectChildExecutor(runtime, launch.call, launch).run(command, options);
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(new DirectChildExecutor(runtime, launch.call, launch).run(command, options), { code: "PROCESS_EXECUTION_START_REFUSED" });
  assert.equal(fs.readFileSync(path.join(root, "effects"), "utf8"), "one\n");
  assert.equal(result.stdout, "once");
  await runtime.close();
  const saved = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions.find(entry => entry.executionId === runtime.executionId);
  assert.equal(saved.calls.length, 1);
  assert.deepEqual(saved.calls[0].receipt, result.processExecutionStopReceipt.toJSON());
});

test("plain stored facts cannot manufacture a consumable claimed launch", { timeout: 45000 }, async t => {
  const { runtime } = await fixture(t);
  assert.throws(() => new ProcessExecutionClaimedLaunch(runtime, {}, null), { name: "TypeError" });
  assert.equal(runtime.inspect().executions.at(-1).calls.length, 0);
});


test("a closed client view cannot consume its accepted launch to spawn a native child", { timeout: 45000 }, async t => {
  const { root, runtime } = await fixture(t);
  const view = await ProcessExecutionRuntime.fromRemoteGrant(runtime.remoteGrant());
  const identity = new ProcessExecutorIdentity({ executorId: randomUUID(), executorSession: randomUUID(), launchClaim: randomUUID() });
  const launch = await view.reserveClaimedCall({ executor: identity, timeoutMs: 5000 });
  await view.close();
  assert.equal(view.closed, true);
  assert.equal(runtime.closed, false);
  const execution = new DirectChildExecutor(view, launch.call, launch);
  const command = new CommandLaunchDescriptor({ executable: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync('closed-client-spawn','unexpected')"],
    cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: false });
  let spawned = false, completion = null, startedAt = null, receipt;
  try {
    await assert.rejects(execution.run(command, { timeoutMs: 5000, exitDrainMs: 1000, maxBuffer: 0,
      onSpawn(child) {
        spawned = true; startedAt = new Date().toISOString(); completion = once(child, "exit");
      },
    }), { code: "PROCESS_EXECUTION_REGISTRATION_CLOSED" });
    assert.equal(spawned, false, "disposal must refuse before the real ChildProcess spawn event");
  } finally {
    // Client disposal leaves the owning runtime and its already accepted call
    // alive. Complete that one call using an actual handle, never an invented
    // exit or unlaunched revocation. If the faulty attempt spawned, observe that
    // exact handle; otherwise the still-open owner performs one normal empty
    // native execution solely to settle the accepted fixture call.
    let child = execution.child;
    if (child === null) {
      child = spawn(process.execPath, ["-e", ""], { cwd: root, stdio: "ignore" });
      completion = once(child, "exit");
      await once(child, "spawn");
      startedAt = new Date().toISOString();
    } else {
      child.ref();
      if (startedAt === null) await once(child, "spawn");
    }
    await runtime.observeCall(launch.call, { type: "started", executor: identity.toJSON(), startedAt });
    const [code, signal] = await completion;
    const observation = new ChildExitObservation({ executor: identity, kind: "exited", code, signal, observedAt: new Date().toISOString() });
    await runtime.observeCall(launch.call, { type: "exit", observation: observation.toJSON() });
    const stdout = await runtime.persistCallOutput(launch.call, { executor: identity, stream: "stdout", maximum: 0, bytes: Buffer.alloc(0) });
    const stderr = await runtime.persistCallOutput(launch.call, { executor: identity, stream: "stderr", maximum: 0, bytes: Buffer.alloc(0) });
    receipt = await runtime.finishCall(launch.call, { observation,
      outcome: { code, output: { maximum: 0, stdout, stderr } },
      output: new ProcessOutputState({ stdoutBytes: 0, stderrBytes: 0, completion: "incomplete", cutoffAt: new Date().toISOString() }) });
  }
  assert.equal(fs.existsSync(path.join(root, "closed-client-spawn")), false);
  await runtime.close();
  const saved = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions.find(entry => entry.executionId === runtime.executionId);
  assert.equal(saved.calls.length, 1);
  assert.deepEqual(saved.calls[0].receipt, receipt.toJSON());
});
