import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { AgentProcessStopEvidence } from "../../../src/lib/agent-failure.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const runtimeURL = pathToFileURL(path.resolve("src/lib/process-execution-runtime.js")).href;
const proofURL = pathToFileURL(path.resolve("src/lib/agent-failure.js")).href;
function fixture(t) {
  const mainRoot = createTmpDir("runtime-control-", { parent: path.resolve(".tmp/c2f6/runtime-control-fixtures") });
  t.after(() => removeTmpDir(mainRoot));
  return { mainRoot, runId: "control-run", specId: "control-spec" };
}
function control() { return new ProcessExecutionControlFailure("receipt-delivery-failed", "Callback could not save its observation"); }
function isControl(error) { return error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_RECEIPT_DELIVERY_FAILED"; }
async function freshRead(options) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {ProcessExecutionRuntime,ProcessExecutionControlFailure} from ${JSON.stringify(runtimeURL)};
    const root=ProcessExecutionRuntime.inspect(${JSON.stringify(options)}).executions[0];
    const failure=ProcessExecutionControlFailure.fromStored(root.calls[0].controlFailure);
    process.stdout.write(JSON.stringify({failure:failure.toJSON(),receipt:root.calls[0].receipt,status:root.status}));
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes; }); child.stderr.on("data", (bytes) => { stderr += bytes; });
  const [code, signal] = await once(child, "exit"); assert.equal(code, 0, stderr); assert.equal(signal, null);
  return JSON.parse(stdout);
}

test("authenticated call failure survives physical receipt, fresh-process readback and completed checkout reuse", async (t) => {
  const options = fixture(t), runtime = await ProcessExecutionRuntime.acquire(options);
  const call = await runtime.reserveCall();
  assert.equal(runtime.inspect().executions[0].calls[0].controlFailure, null);
  const saved = await runtime.recordCallControlFailure(call, control());
  assert.equal(saved.executionId, runtime.executionId); assert.equal(saved.callId, call.callId);
  assert.deepEqual(ProcessExecutionControlFailure.fromStored(saved.toJSON()).toJSON(), saved.toJSON());
  assert.throws(() => ProcessExecutionControlFailure.fromStored({ ...saved.toJSON(), code: "PROCESS_EXECUTION_FOREIGN" }), TypeError);
  assert.throws(() => ProcessExecutionControlFailure.fromStored({ ...saved.toJSON(), unknown: true }), TypeError);
  await assert.rejects(runtime.finishCall(call, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() }), isControl);
  await assert.rejects(runtime.finishCall(call, {}), isControl);
  await runtime.close(); assert.equal(runtime.closed, true);
  const reloaded = await freshRead(options);
  assert.deepEqual(reloaded.failure, saved.toJSON()); assert.equal(reloaded.receipt.stopEvidence.status, "confirmed");
  assert.equal(reloaded.status, "closed");
  const next = await ProcessExecutionRuntime.acquire(options); assert.equal(next.ownerEpoch, 2); await next.close();
});

test("a forged physical call capability cannot record a failure or change its authoritative call", async (t) => {
  const options = fixture(t), runtime = await ProcessExecutionRuntime.acquire(options), call = await runtime.reserveCall();
  const before = runtime.inspect(), capability = call.capability; call.capability = crypto.randomUUID();
  await assert.rejects(runtime.recordCallControlFailure(call, control()), { code: "PROCESS_EXECUTION_BINDING_MISMATCH" });
  assert.deepEqual(runtime.inspect(), before); call.capability = capability;
  await runtime.finishCall(call, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() }); await runtime.close();
});

test("uncertain control-failure persistence preserves its transition marker and refuses all subsequent admission", async (t) => {
  const options = fixture(t); let armed = false;
  const runtime = await ProcessExecutionRuntime.acquire({ ...options, faultInjector({ phase }) {
    if (armed && phase === "before-runtime-directory-fsync") throw new Error("control failure fsync unavailable");
  } });
  const call = await runtime.reserveCall(); armed = true;
  await assert.rejects(runtime.recordCallControlFailure(call, control()), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  assert.throws(() => ProcessExecutionRuntime.inspect(options), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  await assert.rejects(runtime.close(), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
});

test("a dead coordinator's saved diagnostic does not prevent admission after independently completed physical records", async (t) => {
  const options = fixture(t);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {ProcessExecutionRuntime,ProcessExecutionControlFailure} from ${JSON.stringify(runtimeURL)};
    import {AgentProcessStopEvidence} from ${JSON.stringify(proofURL)};
    const runtime=await ProcessExecutionRuntime.acquire(${JSON.stringify(options)}),call=await runtime.reserveCall();
    await runtime.finishCall(call,{notStarted:true,stopEvidence:AgentProcessStopEvidence.confirmed()});
    await runtime.recordCallControlFailure(call,new ProcessExecutionControlFailure('receipt-delivery-failed','saved diagnostic'));
    process.send(runtime.executionId); setInterval(()=>{},1000);
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped; } });
  const [oldId] = await once(child, "message"); const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped;
  const next = await ProcessExecutionRuntime.acquire(options);
  const old = next.inspect().executions.find((entry) => entry.executionId === oldId);
  assert.equal(old.status, "closed"); assert.equal(old.closure.recovery, true);
  assert.equal(old.calls[0].controlFailure.code, "PROCESS_EXECUTION_RECEIPT_DELIVERY_FAILED");
  assert.equal(old.calls[0].receipt.stopEvidence.status, "confirmed"); assert.equal(next.ownerEpoch, 2); await next.close();
});
