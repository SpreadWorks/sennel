import assert from "node:assert/strict";
import { test } from "node:test";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { ProcessExecutionRuntime, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-runtime.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

async function fixture(t) {
  const root = createTmpDir("process-intent-cancellation-");
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    finally { removeQuiescentRuntimeFixture({ mainRoot: root }); }
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root, environment: {} });
  return { root, runtime };
}

for (const [name, source, cancelAt] of [
  ["short child cancelled by its intent observer", "process.stdout.write('finished');", "intent"],
  ["persisting child cancelled by its intent observer", "setInterval(() => {}, 1000);", "intent"],
  ["persisting child cancelled by its spawn observer", "setInterval(() => {}, 1000);", "spawn"],
]) {
  test(`${name} keeps abort reason and durable real-exit proof`, { timeout: 30000 }, async (t) => {
    const { root, runtime } = await fixture(t);
    const controller = new AbortController();
    const reason = Object.assign(new Error("caller cancelled the registered command"), { code: "CALLER_CANCELLED" });
    let child;
    let intent;
    await assert.rejects(runtime.enter(() => executeManagedProcess(process.execPath, ["-e", source], {
      cwd: root, timeoutMs: 5000, graceMs: 50, abortSignal: controller.signal,
      onSupervisorEvent(event) {
        if (event.type !== "intent") return;
        intent = event;
        if (cancelAt === "intent") controller.abort(reason);
      },
      onSpawn(value) {
        child = value;
        if (cancelAt === "spawn") controller.abort(reason);
      },
    })), (error) => {
      assert.equal(error, reason);
      assert.equal(error.code, "CALLER_CANCELLED");
      assert.ok(error.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt);
      assert.equal(error.processExecutionStopReceipt.observation.kind, "exited");
      assert.equal(error.processExecutionStopReceipt.stopOperation.reason, "abort");
      assert.equal(error.stopEvidence.confirmed, true);
      return true;
    });
    assert.ok(child, "the claimed launch must retain its actual child handle");
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    const receipt = reason.processExecutionStopReceipt;
    assert.equal(receipt.callId, intent.callId);
    assert.equal(receipt.executionId, intent.executionId);

    await runtime.close();
    const inventory = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).inventory;
    const calls = inventory.executions.flatMap((entry) => entry.calls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].outcome.aborted, true);
    assert.equal(calls[0].outcome.timedOut, false);
    assert.equal(calls[0].outcome.providerStarted, true);
    assert.equal(calls[0].observation.kind, "exited");
    assert.deepEqual(new ProcessExecutionStopReceipt(calls[0].receipt).toJSON(), receipt.toJSON());
  });
}
