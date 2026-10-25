import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { SENNEL_BOOTSTRAP } from "../../support/infrastructure/node-bootstrap.js";
import { once } from "node:events";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ProcessExecutionRuntime, ProcessExecutionCall, ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionFailureDiagnostic } from "../../../src/lib/process-execution-values.js";
import { executeManagedProcess, readManagedSettlement } from "../../../src/lib/managed-process.js";
import { RepositoryLockAuthority } from "../../../src/lib/repository-control-lock.js";
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
      const diagnostic = new ProcessExecutionFailureDiagnostic({ executionId: receipt.executionId, callId: receipt.callId,
        operation: "receipt-delivery", role: "executor", phase: "stopped",
        executor: { executorId: receipt.executor.executorId, executorSession: receipt.executor.executorSession },
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
  assert.equal(new ProcessExecutionStopReceipt(call.receipt).stopEvidence.status, "confirmed");
  await runtime.close();
  const runtimeURL = pathToFileURL(path.resolve("src/lib/process-execution-runtime.js")).href;
  const envelopeURL = pathToFileURL(path.resolve("src/lib/flow-envelope.js")).href;
  const child = spawn(process.execPath, ["--import", SENNEL_BOOTSTRAP, "--input-type=module", "-e", `
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

test("actual baseline process-group outcome and receipt are rejected without conversion or writes", (t) => {
  const { mainRoot } = fixture(t);
  const seed = path.resolve("tests/fixtures/process-receipt-v1");
  const provenance = JSON.parse(fs.readFileSync(path.join(seed, "provenance.json"), "utf8"));
  for (const file of provenance.files) {
    const bytes = fs.readFileSync(path.join(seed, file.name));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  const bytes = fs.readFileSync(path.join(seed, "outcome.json"));
  const old = JSON.parse(bytes);
  const outcomePath = path.join(mainRoot, "outcome.json");
  fs.writeFileSync(outcomePath, bytes);
  const call = { executionId: old.executionId, callId: old.callId, ownerToken: old.ownerToken,
    capability: old.capability, outcomePath, recordLocks: new RepositoryLockAuthority(mainRoot) };
  const before = fs.readdirSync(mainRoot).sort();
  assert.throws(() => readManagedSettlement(call), (error) => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.equal(error.code, "PROCESS_EXECUTION_LEGACY_RECEIPT_FORMAT");
    assert.equal(error.executionId, call.executionId);
    assert.equal(error.callId, call.callId);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.deepEqual(fs.readdirSync(mainRoot).sort(), before);
  assert.deepEqual(fs.readFileSync(outcomePath), bytes);
});

test("a sibling call cannot adopt another call's primary failure during runtime persistence", async (t) => {
  const options = fixture(t), runtime = await ProcessExecutionRuntime.acquire(options);
  for (let index = 0; index < 2; index++) {
    await executeManagedProcess(process.execPath, ["-e", ""], { runtime, timeoutMs: 5000 });
  }
  const records = runtime.store.read().executions.at(-1).calls;
  const source = new ProcessExecutionCall(runtime, records[0]);
  const sibling = new ProcessExecutionCall(runtime, records[1]);
  const failure = new ProcessExecutionControlFailure("observation-unknown", "Original physical call failed", {
    executionId: runtime.executionId, callId: source.callId });
  const before = runtime.inspect().executions.at(-1);
  await assert.rejects(runtime.recordCallControlFailure(sibling, failure), { code: "PROCESS_EXECUTION_BINDING_MISMATCH" });
  const after = runtime.inspect().executions.at(-1);
  assert.deepEqual(after.calls, before.calls);
  assert.deepEqual(after.events, before.events);
  assert.equal(after.requests.length, before.requests.length + 1);
  assert.equal(after.requests.at(-1).response.ok, false);
  assert.equal(after.requests.at(-1).response.error.code, "PROCESS_EXECUTION_BINDING_MISMATCH");
  await runtime.close();
});
