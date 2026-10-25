import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-runtime.js";
import { AgentTimeoutError } from "../../../src/lib/process-supervisor.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { RuntimeChildExecution } from "../../../src/lib/runtime-package.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { RuntimeRegistryPublicationFailure } from "../../support/infrastructure/runtime-registry-publication-failure.js";

const runtimeURL = pathToFileURL(path.resolve("src/lib/process-execution-runtime.js")).href;
const managedURL = pathToFileURL(path.resolve("src/lib/managed-process.js")).href;
function fixture(t) {
  const mainRoot = createTmpDir("runtime-control-");
  t.after(() => removeQuiescentRuntimeFixture({ mainRoot }));
  return { mainRoot, runId: "control-run", specId: "control-spec" };
}
function control() { return new ProcessExecutionControlFailure("receipt-delivery-failed", "Callback could not save its observation"); }
function isControl(error) { return error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_RECEIPT_DELIVERY_FAILED"; }
async function freshRead(options) {
  const delivery = new RuntimeChildExecution({ root: options.mainRoot });
  const child = delivery.spawnNode("--input-type=module", ["-e", `
    import {ProcessExecutionRuntime,ProcessExecutionControlFailure} from ${JSON.stringify(runtimeURL)};
    const root=ProcessExecutionRuntime.inspect(${JSON.stringify(options)}).executions[0];
    const failure=root.calls[0].controlFailure===null?null:ProcessExecutionControlFailure.fromStored(root.calls[0].controlFailure);
    process.stdout.write(JSON.stringify({failure:failure?.toJSON()??null,receipt:root.calls[0].receipt,outcome:root.calls[0].outcome,status:root.status}));
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes; }); child.stderr.on("data", (bytes) => { stderr += bytes; });
  const [code, signal] = await once(child, "exit"); delivery.close();
  assert.equal(code, 0, stderr); assert.equal(signal, null);
  return JSON.parse(stdout);
}

test("authenticated call failure survives physical receipt, fresh-process readback and completed checkout reuse", async (t) => {
  const options = fixture(t), runtime = await ProcessExecutionRuntime.acquire(options);
  let deliveredReceipt;
  await assert.rejects(runtime.enter(() => executeManagedProcess(process.execPath, ["-e", ""], {
    cwd: options.mainRoot, timeoutMs: 10000,
    onProcessExecutionStop(receipt) { deliveredReceipt = receipt; throw control(); },
  })), isControl);
  assert.equal(deliveredReceipt.observation.kind, "exited");
  const call = runtime.inspect().executions[0].calls[0];
  const saved = ProcessExecutionControlFailure.fromStored(call.controlFailure);
  assert.equal(saved.executionId, runtime.executionId); assert.equal(saved.callId, call.callId);
  assert.deepEqual(ProcessExecutionControlFailure.fromStored(saved.toJSON()).toJSON(), saved.toJSON());
  assert.throws(() => ProcessExecutionControlFailure.fromStored({ ...saved.toJSON(), code: "PROCESS_EXECUTION_FOREIGN" }), TypeError);
  assert.throws(() => ProcessExecutionControlFailure.fromStored({ ...saved.toJSON(), unknown: true }), TypeError);
  await runtime.close(); assert.equal(runtime.closed, true);
  const reloaded = await freshRead(options);
  assert.deepEqual(reloaded.failure, saved.toJSON()); assert.equal(reloaded.receipt.observation.kind, "exited");
  assert.equal(reloaded.status, "closed");
  const next = await ProcessExecutionRuntime.acquire(options); assert.equal(next.ownerEpoch, 2); await next.close();
});

test("a forged physical call capability cannot record a failure or change its authoritative call", async (t) => {
  const options = fixture(t), runtime = await ProcessExecutionRuntime.acquire(options), call = await runtime.reserveCall();
  const before = runtime.inspect(), capability = call.capability; call.capability = crypto.randomUUID();
  await assert.rejects(runtime.recordCallControlFailure(call, control()), { code: "PROCESS_EXECUTION_BINDING_MISMATCH" });
  assert.deepEqual(runtime.inspect(), before); call.capability = capability;
  await runtime.revokeCall(call); await runtime.close();
});

test("uncertain control-failure persistence preserves its transition marker and refuses all subsequent admission", async (t) => {
  const options = fixture(t);
  const fault = new RuntimeRegistryPublicationFailure(options.mainRoot, { callFact: "controlFailure" });
  const runtime = await ProcessExecutionRuntime.acquire({ ...options, environment: fault.environment });
  try {
    const call = await runtime.reserveCall();
    assert.equal(fs.existsSync(fault.witness), false, "startup and reservation must not trigger the fault");
    await assert.rejects(runtime.recordCallControlFailure(call, control()), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
    assert.deepEqual(JSON.parse(fs.readFileSync(fault.witness, "utf8")), {
      boundary: "after-publication", callFact: "controlFailure", callId: call.callId,
      target: runtime.store.file.filePath, phase: "readback", errorCode: "EIO",
    });
    assert.equal(fs.existsSync(runtime.store.transition.filePath), true);
    assert.throws(() => ProcessExecutionRuntime.inspect(options), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
    await assert.rejects(runtime.reserveCall(), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
    await assert.rejects(runtime.close(), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  } finally {
    testTemporaryRoot().retainOnUnconfirmedExecution();
    // Intentional fixture termination is an actual exit observation, not normal product closure.
    // No business child was launched and no process receipt is reconstructed.
    const child = runtime.control.child;
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit"); child.ref(); child.kill(); await stopped;
    }
  }
});

test("a live coordinator retains diagnostics while closing completed calls after host loss", { timeout: 30000 }, async (t) => {
  const options = fixture(t);
  const delivery = new RuntimeChildExecution({ root: options.mainRoot });
  const child = delivery.spawnNode("--input-type=module", ["-e", `
    import {ProcessExecutionRuntime,ProcessExecutionControlFailure} from ${JSON.stringify(runtimeURL)};
    import {executeManagedProcess} from ${JSON.stringify(managedURL)};
    const runtime=await ProcessExecutionRuntime.acquire(${JSON.stringify(options)});
    try { await runtime.enter(()=>executeManagedProcess(process.execPath,['-e',''],{
      cwd:${JSON.stringify(options.mainRoot)},timeoutMs:10000,
      onProcessExecutionStop(){throw new ProcessExecutionControlFailure('receipt-delivery-failed','saved diagnostic');}
    })); } catch(error) { if(error.code!=='PROCESS_EXECUTION_RECEIPT_DELIVERY_FAILED') throw error; }
    process.send({executionId:runtime.executionId,ownerLock:runtime.store.ownerLock.lockPath});
    process.on('message',()=>{});
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  const terminal = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await terminal; }
    delivery.close();
  });
  const [{ executionId: oldId, ownerLock }] = await Promise.race([
    once(child, "message"), terminal.then(() => assert.fail(`Host exited before saving its receipt: ${stderr}`)),
  ]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const changes = fs.promises.watch(path.dirname(ownerLock), { signal: controller.signal });
  const closed = (async () => {
    for await (const _change of changes) {
      const inventory = ProcessExecutionRuntime.inspect(options);
      if (inventory.slot === null && !fs.existsSync(ownerLock)) return inventory;
    }
    assert.fail("Coordinator did not publish completed host-loss closure");
  })();
  child.kill(); await terminal;
  let inventory;
  try { inventory = await closed; }
  finally { clearTimeout(timer); controller.abort(); await changes.return(); }
  const old = inventory.executions.find((entry) => entry.executionId === oldId);
  assert.equal(old.status, "closed"); assert.equal(old.closure.recovery, true);
  assert.equal(old.calls[0].controlFailure.code, "PROCESS_EXECUTION_RECEIPT_DELIVERY_FAILED");
  assert.equal(old.calls[0].receipt.observation.kind, "exited");
  const next = await ProcessExecutionRuntime.acquire(options);
  assert.equal(next.ownerEpoch, 2); await next.close();
});

for (const decisionKind of ["failure", "timeout", "callback"]) {
  const name = decisionKind === "failure"
    ? "stored control refusal after physical exit is surfaced with its exact receipt and closed fresh history"
    : decisionKind === "timeout"
      ? "stored timeout decision after physical exit is surfaced with its exact receipt and closed fresh history"
      : "stored control refusal and receipt callback failure retain the first refusal, actual receipt and both local causes";
  test(name, async (t) => {
    const options = fixture(t), runtime = await ProcessExecutionRuntime.acquire(options);
    t.after(async () => { if (!runtime.closed) await runtime.close(); });
    const originalPersist = runtime.persistCallOutput;
    const expectedOutput = "late-control-output";
    const callbackCause = decisionKind === "callback" ? new Error("owned receipt callback sentinel") : null;
    let injected = 0, actualCall, actualExecutor, decision, reported, deliveredReceipt, actualExit;
    runtime.persistCallOutput = async (call, data) => {
      const result = await originalPersist.call(runtime, call, data);
      if (data.stream === "stderr" && injected === 0) {
        const saved = runtime.inspect().executions.find(e => e.executionId === runtime.executionId)
          .calls.find(entry => entry.callId === call.callId);
        assert.equal(saved.observation.kind, "exited");
        assert.equal(saved.observation.code, 0); assert.equal(saved.observation.signal, null);
        assert.equal(saved.receipt, null);
        assert.deepEqual(saved.executor, data.executor.toJSON());
        actualCall = call; actualExecutor = data.executor; injected++;
        // A real owning-coordinator decision after actual output persistence,
        // before final control/receipt. This does not claim wall-time expiry.
        decision = decisionKind === "timeout"
          ? await runtime.beginCallStop(call, { reason: "timeout", graceMs: 500 })
          : await runtime.recordCallControlFailure(call, decisionKind === "callback"
            ? new ProcessExecutionControlFailure("output-observer-failed", "Stored first control refusal") : control());
      }
      return result;
    };
    try {
      await assert.rejects(runtime.enter(() => executeManagedProcess(process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(expectedOutput)})`], {
          cwd: options.mainRoot, timeoutMs: 10000, graceMs: 500, maxBuffer: 1024,
          onSpawn(child) { actualExit = once(child, "exit"); },
          onProcessExecutionStop(receipt) {
            deliveredReceipt = receipt;
            if (callbackCause !== null) throw callbackCause;
          },
        })), error => {
        reported = error;
        return decisionKind === "failure" ? isControl(error) : decisionKind === "timeout"
          ? error instanceof AgentTimeoutError
          : error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_OUTPUT_OBSERVER_FAILED";
      });
    } finally { runtime.persistCallOutput = originalPersist; }
    assert.equal(injected, 1);
    assert.deepEqual(await actualExit, [0, null]);
    assert.equal(reported.stdout, expectedOutput); assert.equal(reported.stderr, "");
    assert.equal(reported.signal, null); assert.equal(reported.killed, false);
    assert.ok(deliveredReceipt instanceof ProcessExecutionStopReceipt);
    assert.equal(reported.processExecutionStopReceipt, deliveredReceipt);
    assert.equal(deliveredReceipt.stopEvidence.status, "confirmed");
    assert.equal(deliveredReceipt.callId, actualCall.callId);
    assert.equal(deliveredReceipt.observation.kind, "exited");
    assert.equal(deliveredReceipt.observation.code, 0); assert.equal(deliveredReceipt.observation.signal, null);
    const saved = runtime.inspect().executions.find(e => e.executionId === runtime.executionId)
      .calls.find(call => call.callId === actualCall.callId);
    assert.deepEqual(saved.executor, actualExecutor.toJSON());
    assert.deepEqual(saved.receipt, deliveredReceipt.toJSON());
    assert.equal(saved.output.stdoutBytes, Buffer.byteLength(expectedOutput));
    assert.equal(saved.output.stderrBytes, 0); assert.equal(saved.output.completion, "complete");
    assert.equal(saved.outcome.code, 0); assert.equal(saved.outcome.signal, null);
    assert.equal(saved.outcome.finalAction, null); assert.equal(saved.outcome.aborted, false);
    if (decisionKind !== "timeout") {
      assert.deepEqual(reported.toJSON(), decision.toJSON());
      assert.deepEqual(saved.controlFailure, decision.toJSON());
      assert.equal(saved.outcome.timedOut, false); assert.equal(saved.stopOperation, null);
    } else {
      assert.equal(saved.controlFailure, null);
      assert.equal(saved.outcome.timedOut, true);
      assert.deepEqual(saved.stopOperation, decision.toJSON());
      assert.equal(deliveredReceipt.stopOperation.reason, "timeout");
      assert.equal(deliveredReceipt.stopOperation.graceMs, 500);
      assert.equal(deliveredReceipt.stopOperation.deadline, deliveredReceipt.stopOperation.startedAt + 3000);
    }
    if (callbackCause !== null) {
      const pending = [reported], visited = new Set();
      let retainedCallback = false, combinedFailures = false;
      while (pending.length !== 0) {
        const error = pending.pop();
        if (!(error instanceof Error) || visited.has(error)) continue;
        visited.add(error); retainedCallback ||= error === callbackCause;
        if (error instanceof AggregateError) {
          combinedFailures ||= error.errors.length === 2
            && error.errors[0] instanceof ProcessExecutionControlFailure
            && error.errors[0].code === decision.code
            && error.errors[1] instanceof ProcessExecutionControlFailure
            && error.errors[1].code === "PROCESS_EXECUTION_RECEIPT_DELIVERY_FAILED"
            && error.errors[1].cause === callbackCause;
          pending.push(...error.errors);
        }
        pending.push(error.cause);
      }
      assert.equal(retainedCallback, true); assert.equal(combinedFailures, true);
    }
    await runtime.close(); assert.equal(runtime.closed, true);
    const reloaded = await freshRead(options);
    assert.equal(reloaded.status, "closed");
    assert.deepEqual(reloaded.receipt, saved.receipt);
    assert.deepEqual(reloaded.outcome, saved.outcome);
    assert.deepEqual(reloaded.failure, saved.controlFailure);
    const next = await ProcessExecutionRuntime.acquire(options);
    assert.equal(next.ownerEpoch, 2); await next.close();
  });
}
