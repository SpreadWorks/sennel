import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";
import { executeManagedProcess, withReadOnlyManagedProcessScope } from "../../../src/lib/managed-process.js";
import { readFlowProcessStops } from "../../../src/flow/lib/process-runtime-admission.js";
import { FlowProcessStopEvidence } from "../../../src/flow/lib/process-runtime-evidence.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

for (const closed of [false, true]) {
  test(`Flow stop readback selects canonical receipts under read-only scratch with ${closed ? "closed" : "active"} owner`, { timeout: 120000 }, async t => {
    const root = createTmpDir("flow-stop-readback-");
    let runtime;
    let scratchRuntime;
    let workspace;
    t.after(async () => {
      if (runtime !== undefined && !runtime.closed) await runtime.close();
      removeQuiescentRuntimeFixture({ mainRoot: root, cleanup: () => removeTmpDir(root) });
      if (workspace !== undefined && fs.existsSync(workspace.path) && scratchRuntime.closed && workspace.pendingExecutionCount === 0) {
        workspace.complete({ generation: workspace.generation, normalExit: true, resourcesReleased: true });
        workspace.cleanup({ generation: workspace.generation });
      }
    });
    runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
    const invoke = label => new NativeExecutableInvocation({ executable: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(label)})`], cwd: root });
    const canonical = await runtime.enter(() => executeManagedProcess(invoke("canonical"), [], { timeoutMs: 20000 }));
    assert.equal(canonical.stdout, "canonical");
    const expected = canonical.processExecutionStopReceipt;
    assert.equal(expected.stopEvidence.status, "confirmed");
    if (closed) await runtime.close();
    const registryBefore = hash(fs.readFileSync(runtime.store.file.filePath));

    await withReadOnlyManagedProcessScope({ mainRoot: root }, async (scope, scratch) => {
      scratchRuntime = scope;
      workspace = scratch;
      const local = await executeManagedProcess(invoke("scratch"), [], { timeoutMs: 20000 });
      assert.equal(local.stdout, "scratch");
      assert.notEqual(local.processExecutionStopReceipt.executionId, expected.executionId);
      const evidence = readFlowProcessStops({ mainRoot: root, executionRoot: root });
      assert.equal(evidence.length, 1);
      assert.ok(evidence[0] instanceof FlowProcessStopEvidence);
      assert.deepEqual(evidence[0].toJSON(), expected.toJSON());
      assert.equal(evidence[0].assertCheckout(runtime.checkoutIdentity), evidence[0]);
      assert.equal(hash(fs.readFileSync(runtime.store.file.filePath)), registryBefore);
      const saved = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions
        .find(entry => entry.executionId === runtime.executionId);
      assert.equal(saved.status, closed ? "closed" : "active");
      assert.equal(runtime.closed, closed);
      if (!closed) assert.throws(() => ProcessExecutionRuntime.assertQuiescent({ mainRoot: root }),
        { code: "PROCESS_EXECUTION_BUSY" });
    });
    assert.equal(scratchRuntime.closed, true);
    assert.equal(fs.existsSync(workspace.path), false);
    assert.deepEqual(readFlowProcessStops({ mainRoot: root }).map(evidence => evidence.toJSON()), [expected.toJSON()]);
    assert.equal(hash(fs.readFileSync(runtime.store.file.filePath)), registryBefore);
  });
}
