import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionFailureDiagnostic } from "../../../src/lib/process-execution-values.js";
import { executeManagedProcess, readManagedSettlement } from "../../../src/lib/managed-process.js";
import { writeManagedRecord } from "../../../src/lib/managed-process-protocol.js";
import { AgentProcessStopEvidence } from "../../../src/lib/agent-failure.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const mainRoot = createTmpDir("diagnostic-runtime-");
  t.after(() => removeTmpDir(mainRoot));
  return { mainRoot, runId: "diagnostic-run", specId: "diagnostic-spec" };
}

test("managed receipt failure preserves typed diagnostic through registry, fresh process and parent envelope", async (t) => {
  const options = fixture(t), runtime = await ProcessExecutionRuntime.acquire(options);
  let original;
  await assert.rejects(executeManagedProcess(process.execPath, ["-e", "process.stdout.write('settled')"], {
    runtime, timeoutMs: 5000, graceMs: 100,
    onProcessExecutionStop(receipt) {
      const { pid, bootIdentity, startFingerprint } = receipt.launcherIdentity;
      const diagnostic = new ProcessExecutionFailureDiagnostic({ executionId: receipt.executionId, callId: receipt.callId,
        operation: "receipt-delivery", role: "launcher", birth: { pid, bootIdentity, startFingerprint }, originalPgid: receipt.pgid,
        primaryCause: { code: "PROCESS_EXECUTION_RECEIPT_DELIVERY_FAILED", message: "Receipt consumer refused delivery" } });
      original = new ProcessExecutionControlFailure("receipt-delivery-failed", "Receipt consumer refused delivery",
        { executionId: receipt.executionId, callId: receipt.callId, diagnostic });
      throw original;
    },
  }), (error) => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.equal(error.executionId, original.executionId); assert.equal(error.callId, original.callId);
    assert.deepEqual(error.diagnostic.toJSON(), original.diagnostic.toJSON());
    assert.deepEqual(error.primaryCause.toJSON(), original.primaryCause.toJSON()); return true;
  });
  const root = runtime.inspect().executions.find((entry) => entry.executionId === runtime.executionId), call = root.calls[0];
  assert.deepEqual(call.controlFailure.diagnostic, original.diagnostic.toJSON());
  assert.deepEqual(call.controlFailure.primaryCause, original.primaryCause.toJSON());
  assert.equal(call.receipt.stopEvidence.status, "confirmed");
  await runtime.close();
  const runtimeURL = pathToFileURL(path.resolve("src/lib/process-execution-runtime.js")).href;
  const envelopeURL = pathToFileURL(path.resolve("src/lib/flow-envelope.js")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {ProcessExecutionRuntime,ProcessExecutionControlFailure} from ${JSON.stringify(runtimeURL)};
    import {Envelope} from ${JSON.stringify(envelopeURL)};
    const root=ProcessExecutionRuntime.inspect(${JSON.stringify(options)}).executions[0];
    const failure=ProcessExecutionControlFailure.fromStored(root.calls[0].controlFailure);
    const envelope=Envelope.fail('run','diagnostic',failure.code,failure.message,{processExecutionControlFailure:failure.toJSON()});
    process.stdout.write(JSON.stringify({envelope:envelope.toJSON(),status:root.status,receipt:root.calls[0].receipt}));
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes; }); child.stderr.on("data", (bytes) => { stderr += bytes; });
  const [code, signal] = await once(child, "exit"); assert.equal(code, 0, stderr); assert.equal(signal, null);
  const reloaded = JSON.parse(stdout), restored = ProcessExecutionControlFailure.fromEnvelope(reloaded.envelope);
  assert.deepEqual(restored.toJSON(), call.controlFailure);
  assert.equal(reloaded.status, "closed"); assert.deepEqual(reloaded.receipt, call.receipt);
  const publicEnvelope = JSON.stringify(reloaded.envelope);
  assert.equal(publicEnvelope.includes(call.capability), false);
  assert.equal(publicEnvelope.includes(root.coordinatorIdentity.ownerToken), false);
  assert.equal(/ownerToken|capability|stack/.test(publicEnvelope), false);
});

test("legacy control-failed outcomes cannot gain settlement from exit zero or absent current PIDs", (t) => {
  const { mainRoot } = fixture(t);
  const call = { executionId: crypto.randomUUID(), callId: crypto.randomUUID(), ownerToken: crypto.randomUUID(), capability: crypto.randomUUID(),
    outcomePath: path.join(mainRoot, "outcome.json"), helloPath: path.join(mainRoot, "hello.json") };
  for (const [controlFailure, code] of [[{ code: "PROCESS_EXECUTION_IDENTITY_UNKNOWN", message: "Old group escape refusal" }, "PROCESS_EXECUTION_FAILURE_EVIDENCE_MISSING"],
    [null, "PROCESS_EXECUTION_FAILURE_EVIDENCE_MISSING"],
    [{ schemaVersion: 0, code: "PROCESS_EXECUTION_IDENTITY_UNKNOWN", message: "Unsupported evidence" }, "PROCESS_EXECUTION_FAILURE_EVIDENCE_UNSUPPORTED"]]) {
    const record = { ...call, state: "control-failed", launcherIdentity: { pid: 2147483647, bootIdentity: "old-boot", startFingerprint: "0", ownerToken: call.ownerToken },
      pgid: 2147483647, members: [], outcome: { code: 0 }, controlFailure };
    writeManagedRecord(call.outcomePath, record);
    const before = fs.readFileSync(call.outcomePath);
    assert.throws(() => readManagedSettlement(call), (error) => {
      assert.ok(error instanceof ProcessExecutionControlFailure); assert.equal(error.code, code);
      assert.equal(error.executionId, call.executionId); assert.equal(error.callId, call.callId); assert.equal(error.retryable, false); return true;
    });
    assert.deepEqual(fs.readFileSync(call.outcomePath), before);
  }
});

test("a sibling call cannot adopt another call's primary failure during runtime persistence", async (t) => {
  const options = fixture(t), runtime = await ProcessExecutionRuntime.acquire(options);
  const source = await runtime.reserveCall(), sibling = await runtime.reserveCall();
  const failure = new ProcessExecutionControlFailure("observation-unknown", "Original physical call failed", {
    executionId: runtime.executionId, callId: source.callId });
  const before = runtime.inspect();
  await assert.rejects(runtime.recordCallControlFailure(sibling, failure), { code: "PROCESS_EXECUTION_REGISTRY_FAILED" });
  assert.deepEqual(runtime.inspect(), before);
  for (const call of [source, sibling]) await runtime.finishCall(call, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() });
  await runtime.close();
});
