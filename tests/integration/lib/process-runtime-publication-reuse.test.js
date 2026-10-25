import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionStopReceipt, executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { RuntimeRegistryPublicationFailure } from "../../support/infrastructure/runtime-registry-publication-failure.js";

// Compatibility: these same public outcomes must hold before and after reuse
// of a decoded registry whose freshly captured physical image is identical.
for (const [mutation, expectedCode] of [
  ["malformed-registry", "PROCESS_EXECUTION_REGISTRY_FAILED"],
  ["changed-registry", "PROCESS_EXECUTION_RECORD_CORRUPT"],
  ["replaced-registry", null],
  ["changed-anchor", "PROCESS_EXECUTION_AUTHORITY_MISMATCH"],
  ["changed-archive", "PROCESS_EXECUTION_REGISTRY_FAILED"],
  ["unexpected-call-directory", "PROCESS_EXECUTION_RECORD_MISSING"],
]) {
  test(`fresh runtime readback after atomic publication handles ${mutation}`, { timeout: 60000 }, async (t) => {
    const root = createTmpDir(`runtime-publication-${mutation}-`);
    let predecessor, runtime, completed = false;
    t.after(async () => {
      try {
        if (completed) await runtime.close();
      } finally {
        for (const owned of [runtime, predecessor]) {
          const child = owned?.control.child;
          if (child !== undefined && child.exitCode === null && child.signalCode === null) {
            // Test cleanup observes only its actual owned coordinator handle.
            // This is not a product receipt or recovery of uncertain metadata.
            const stopped = once(child, "exit"); child.ref(); child.kill(); await stopped;
          }
        }
        removeQuiescentRuntimeFixture({ mainRoot: root });
      }
    });
    let archivePath = null;
    if (mutation === "changed-archive") {
      predecessor = await ProcessExecutionRuntime.acquire({ mainRoot: root });
      await predecessor.close();
      archivePath = path.join(predecessor.store.archivesAuthority.directory, `${predecessor.executionId}.json`);
    }
    const fault = new RuntimeRegistryPublicationFailure(root, { boundary: "after-readback", mutation, archivePath });
    runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: fault.environment });
    assert.equal(fs.existsSync(fault.witness), false, "startup must not trigger the receipt-bound fault");
    if (archivePath !== null) {
      const archive = JSON.parse(fs.readFileSync(archivePath, "utf8"));
      assert.equal(archive.payload.execution.executionId, predecessor.executionId);
      assert.equal(archive.payload.execution.status, "closed");
    }
    const effect = path.join(root, "child-effects"), stdout = "saved-output\n", observedOutput = [];
    const execute = () => executeManagedProcess(process.execPath, ["-e",
      `require('node:fs').appendFileSync(${JSON.stringify(effect)},'effect\\n');process.stdout.write(${JSON.stringify(stdout)})`],
    { runtime, timeoutMs: 10000, onStdout(bytes) { observedOutput.push(Buffer.from(bytes)); } });
    let result;
    if (expectedCode === null) { result = await execute(); completed = true; }
    else await assert.rejects(execute(), error => error instanceof ProcessExecutionControlFailure
      && error.code === expectedCode && error.processExecutionStopReceipt === undefined);

    const witness = JSON.parse(fs.readFileSync(fault.witness, "utf8"));
    assert.equal(witness.boundary, "after-readback");
    assert.equal(witness.mutation, mutation); assert.equal(witness.callFact, "receipt");
    assert.equal(witness.phase, "after-readback-before-store-read");
    assert.equal(witness.publicationReadbackCompleted, true);
    assert.equal(witness.target, runtime.store.file.filePath);
    assert.match(witness.callId, /^[0-9a-f-]{36}$/);
    assert.equal(witness.sameRegistryIdentity, mutation !== "replaced-registry");
    assert.equal(witness.sameRegistryBytes, !["malformed-registry", "changed-registry"].includes(mutation));
    if (mutation === "malformed-registry") assert.equal(fs.readFileSync(witness.target, "utf8"), "{");
    else if (mutation === "changed-registry") {
      const changed = JSON.parse(fs.readFileSync(witness.target, "utf8"));
      assert.equal(changed.payload.executions.at(-1).runId, "changed-after-publication");
      assert.equal(changed.digest, executionValueDigest(changed.payload));
    } else if (mutation === "changed-anchor") {
      assert.equal(witness.mutationPath, runtime.store.anchor.filePath);
      assert.equal(JSON.parse(fs.readFileSync(witness.mutationPath, "utf8")).executionRoot,
        path.join(root, "changed-after-publication"));
    } else if (mutation === "changed-archive") {
      assert.equal(witness.mutationPath, archivePath);
      const changed = JSON.parse(fs.readFileSync(archivePath, "utf8"));
      assert.equal(changed.payload.unexpectedReadbackField, true);
      assert.equal(changed.digest, executionValueDigest(changed.payload));
    } else if (mutation === "unexpected-call-directory") {
      assert.equal(path.dirname(witness.mutationPath), runtime.store.callsAuthority.directory);
      assert.equal(fs.lstatSync(witness.mutationPath).isDirectory(), true);
      const current = JSON.parse(fs.readFileSync(witness.target, "utf8"));
      assert.equal(current.payload.executions.flatMap(e => e.calls).some(c => c.callId === path.basename(witness.mutationPath)), false);
    }
    assert.equal(fs.readFileSync(effect, "utf8"), "effect\n");
    assert.equal(Buffer.concat(observedOutput).toString("utf8"), stdout);
    const physical = JSON.parse(fs.readFileSync(path.join(runtime.store.callsAuthority.directory, witness.callId, "outcome.json"), "utf8"));
    assert.equal(physical.callId, witness.callId); assert.equal(physical.state, "finished");
    assert.equal(physical.observation.kind, "exited"); assert.equal(physical.observation.code, 0);
    assert.equal(physical.receipt.callId, witness.callId);
    assert.equal(physical.receipt.output.stdoutBytes, Buffer.byteLength(stdout));
    assert.equal(fs.readFileSync(path.join(runtime.store.callsAuthority.directory, witness.callId, "stdout.bin"), "utf8"), stdout);
    if (expectedCode === null) {
      assert.equal(result.code, 0); assert.equal(result.stdout, stdout);
      assert.ok(result.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt);
      assert.equal(result.processExecutionStopReceipt.callId, witness.callId);
      await runtime.close();
      const closed = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions.find(e => e.executionId === runtime.executionId);
      assert.equal(closed.status, "closed");
      assert.deepEqual(closed.calls[0].receipt, result.processExecutionStopReceipt.toJSON());
      assert.equal(fs.existsSync(runtime.store.transition.filePath), false);
    } else {
      assert.equal(fs.existsSync(runtime.store.transition.filePath), true);
      assert.equal(fs.existsSync(runtime.store.ownerLock.lockPath), true);
      assert.throws(() => ProcessExecutionRuntime.inspect({ mainRoot: root }), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
      await assert.rejects(runtime.reserveCall(), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
      await assert.rejects(runtime.close(), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
      assert.equal(runtime.closed, false);
      assert.equal(fs.readFileSync(effect, "utf8"), "effect\n", "refusal must not repeat the physical child effect");
    }
  });
}
