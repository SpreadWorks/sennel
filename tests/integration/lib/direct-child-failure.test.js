import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { testTemporaryRoot } from "../../test-environment.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { ProcessExecutionControlFailure } from "../../../src/lib/process-execution-values.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

async function runtimeFixture() {
  const root = createTmpDir("direct-child-failure-");
  return { root, runtime: await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root }) };
}

test("a throwing spawn observer retains the real child until its exit is durably recorded", { timeout: 30000 }, async () => {
  const { root, runtime } = await runtimeFixture();
  let child;
  const observerFailure = new Error("observer rejected a spawned child");
  try {
    let failure;
    try {
      await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        timeoutMs: 5000, graceMs: 50,
        onSpawn(value) { child = value; throw observerFailure; },
      }));
    } catch (error) { failure = error; }
    assert.ok(failure instanceof ProcessExecutionControlFailure);
    assert.equal(failure.reason, "spawn-observer-failed");
    assert.ok(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    const call = runtime.inspect().executions.flatMap((entry) => entry.calls)[0];
    assert.equal(call.observation.kind, "exited");
    assert.equal(call.receipt.scope, "registered-executions");
    assert.equal(call.controlFailure.reason, "spawn-observer-failed");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    await runtime.close(); removeTmpDir(root);
  }
});

test("a throwing output observer retains exit proof and reports the callback failure", { timeout: 30000 }, async () => {
  const { root, runtime } = await runtimeFixture();
  try {
    let failure;
    try {
      await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
        timeoutMs: 5000, graceMs: 50, onStdout() { throw new Error("output observer rejected bytes"); },
      }));
    } catch (error) { failure = error; }
    assert.ok(failure instanceof ProcessExecutionControlFailure);
    assert.equal(failure.reason, "output-observer-failed");
    const call = runtime.inspect().executions.flatMap((entry) => entry.calls)[0];
    assert.equal(call.observation.kind, "exited");
    assert.equal(call.receipt.scope, "registered-executions");
    assert.equal(call.controlFailure.reason, "output-observer-failed");
  } finally { await runtime.close(); removeTmpDir(root); }
});

test("a rejected launch intent remains unknown without a synthetic spawn failure receipt", { timeout: 40000 }, async () => {
  const { runtime } = await runtimeFixture();
  testTemporaryRoot().retainOnUnconfirmedExecution();
  let spawned = false;
  await assert.rejects(runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "process.exit(0)"], {
    timeoutMs: 5000, onSpawn() { spawned = true; },
    onSupervisorEvent(event) { if (event.type === "intent") throw new Error("intent observer unavailable"); },
  })), (error) => error instanceof ProcessExecutionControlFailure && error.reason === "intent-observer-failed");
  assert.equal(spawned, false);
  const call = runtime.inspect().executions.flatMap((entry) => entry.calls)[0];
  assert.equal(call.observation, null);
  assert.equal(call.receipt, null);
  assert.equal(call.controlFailure.reason, "intent-observer-failed");
  await assert.rejects(runtime.close(), (error) => error instanceof ProcessExecutionControlFailure);
});

test("a handle kill exception records unknown stop without inventing a receipt", { timeout: 40000 }, async () => {
  const { runtime } = await runtimeFixture();
  testTemporaryRoot().retainOnUnconfirmedExecution();
  let child;
  let killInvoked = false;
  try {
    let failure;
    try {
      await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "setTimeout(()=>{},3000)"], {
        timeoutMs: 50, graceMs: 50,
        onSpawn(value) { child = value; value.kill = () => { killInvoked = true; const error = new Error("handle denied stop"); error.code = "EPERM"; throw error; }; },
      }));
    } catch (error) { failure = error; }
    assert.ok(failure instanceof ProcessExecutionControlFailure);
    assert.equal(failure.reason, "stop-unconfirmed");
    assert.equal(killInvoked, true);
    assert.equal(failure.processExecutionStopReceipt, undefined);
    const call = runtime.inspect().executions.flatMap((entry) => entry.calls)[0];
    assert.equal(call.receipt, null);
    assert.equal(call.controlFailure.reason, "stop-unconfirmed");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      // The executor unrefs an unconfirmed child; this test owns the wait for its actual exit.
      child.ref();
      await once(child, "exit");
    }
    // The actual exit alone cannot reconstruct the missing executor receipt.
    // Preserve this unknown runtime's evidence instead of deleting its authority.
    await assert.rejects(runtime.close(), (error) => error instanceof ProcessExecutionControlFailure);
  }
});

function bridgeProbe(t, source) {
  const root = createTmpDir("bridge-failure-");
  t.after(() => removeTmpDir(root));
  const script = path.join(root, "probe.mjs");
  fs.writeFileSync(script, `const root = ${JSON.stringify(root)};\n${source}`);
  const result = spawnSync(process.execPath, ["--import", path.resolve("src/sennel.js"), script], {
    cwd: process.cwd(), encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "verified");
}

const bridgeModule = JSON.stringify(new URL("../../../src/lib/process-execution-sync.js", import.meta.url).href);
const invocationModule = JSON.stringify(new URL("../../../src/lib/command-invocation.js", import.meta.url).href);

test("worker termination rejects a pending bridge request without asserting child completion", { timeout: 125000 }, (t) => {
  bridgeProbe(t, `
    import assert from 'node:assert/strict';
    import { Worker } from 'node:worker_threads';
    import { ensureStandaloneExecutionGrant } from ${bridgeModule};
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...rest) {
      if (message.operation === 'scope') { this.terminate(); return; }
      return original.call(this, message, ...rest);
    };
    await assert.rejects(ensureStandaloneExecutionGrant(root), error => error.code === 'PROCESS_EXECUTION_BRIDGE_UNAVAILABLE' && error.processExecutionStopReceipt === undefined);
    process.stdout.write('verified');
    process.exit(0);
  `);
});

test("an async grant response remains owned while a synchronous command waits on the same bridge", { timeout: 125000 }, (t) => {
  bridgeProbe(t, `
    import assert from 'node:assert/strict';
    import { ensureStandaloneExecutionGrant, releaseStandaloneExecutionGrant, runCommandInSynchronousBridge, closeSynchronousExecutionBridge } from ${bridgeModule};
    import { NativeExecutableInvocation } from ${invocationModule};
    const grant = ensureStandaloneExecutionGrant(root);
    const result = runCommandInSynchronousBridge(new NativeExecutableInvocation({ executable: process.execPath, args: ['-e', "process.stdout.write('mixed')"], cwd: root }), { timeout: 5000 });
    assert.equal(result.stdout, 'mixed');
    assert.equal(result.processExecutionStopReceipt.scope, 'registered-executions');
    assert.ok((await grant).executionId);
    await releaseStandaloneExecutionGrant(root);
    closeSynchronousExecutionBridge();
    process.stdout.write('verified');
  `);
});
