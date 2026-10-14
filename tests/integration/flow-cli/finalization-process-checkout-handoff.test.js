import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FinalizationWorktreeScenario } from "../../support/infrastructure/finalization-worktree-scenario.js";
import { installCommandProcessFake } from "../../support/infrastructure/command-process-fake.js";
import RunFinalizeCleanupCommand from "../../../src/flow/lib/run-finalize-cleanup.js";
import { captureFinalizationProcessAuthority } from "../../../src/flow/lib/finalization-process-authority.js";
import RunFinalizeSyncCommand from "../../../src/flow/lib/run-finalize-sync.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { runManagedCmdAsync } from "../../../src/lib/process.js";
import { RepositoryFlowOperationLock } from "../../../src/lib/repository-maintenance-lock.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";

// One lawful Prepare -> Report producer; no cloned Git worktree or fabricated
// finalization selection. Real Docs CLI rendering is separately covered by the
// common admission test. Only its external process is replaced here, by real
// managed Node children (and their actual durable receipts).
test("one continuing dispatch transfers physical worktree ownership to main for sync and cleanup", { timeout: 1500000 }, async (t) => {
  const cleanup = [];
  const producerContext = new Proxy(t, { get(target, property) {
    if (property === "after") return (callback) => cleanup.push(callback);
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  let retained = false;
  let flow;
  const operations = [];
  const acquire = RepositoryFlowOperationLock.prototype.acquire;
  t.mock.method(RepositoryFlowOperationLock.prototype, "acquire", function (...args) {
    const observation = { path: this.lockPath, requestedToken: this.operationOwnerToken,
      stack: new Error().stack };
    try { const result = acquire.apply(this, args); observation.token = result; observation.borrowed = this.borrowed; return result; }
    catch (error) { observation.error = { code: error.code, message: error.message, stack: error.stack }; throw error; }
    finally { operations.push(observation); if (operations.length > 40) operations.shift(); }
  });
  t.after(async () => { if (!retained) for (const callback of cleanup) await callback(); });
  try {
  flow = await FinalizationWorktreeScenario.prepare(producerContext);
  assert.equal(flow.current(), "finalize-commit");
  const runId = flow.state().runId;
  const specId = flow.specId;
  const originalRoot = flow.worktreePath;
  let mainRuntime;
  let docsCalls = 0;
  flow.docsProcess.mock.restore();
  const replacement = installCommandProcessFake(RunFinalizeSyncCommand, async (command, args, options) => {
    docsCalls += 1;
    assert.equal(command, process.execPath);
    assert.ok(args[0].endsWith("/src/docs.js"));
    assert.equal(args[1], "build");
    assert.equal(options.cwd, flow.mainRoot);
    mainRuntime = ProcessExecutionRuntime.current();
    assert.equal(mainRuntime.executionRoot, flow.mainRoot);
    assert.equal(mainRuntime.runId, runId);
    const old = ProcessExecutionRuntime.inspect({ mainRoot: flow.mainRoot, executionRoot: originalRoot });
    assert.equal(old.slot, null);
    assert.ok(old.executions.length > 0);
    assert.ok(old.executions.every((execution) => execution.status === "closed"
      && execution.calls.every((call) => call.receipt?.stopEvidence.status === "confirmed")));
    const busy = (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_BUSY";
    await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: flow.mainRoot, executionRoot: originalRoot }), busy);
    await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: flow.mainRoot }), busy);
    const script = `
      import fs from 'node:fs';
      import {runManagedCmdAsync} from ${JSON.stringify(new URL("../../../src/lib/process.js", import.meta.url).href)};
      const child = await runManagedCmdAsync(process.execPath,['-e','process.stdout.write("Generated from the merged implementation.\\\\n")'],{cwd:process.cwd(),timeout:20000});
      if(!child.ok)throw new Error('Nested documentation process failed');
      fs.writeFileSync('docs/overview.md',child.stdout);
    `;
    return runManagedCmdAsync(command, ["--input-type=module", "-e", script], { ...options, timeout: 40000 });
  }, "executeEffect");
  t.after(() => replacement.mock.restore());
  const result = await flow.dispatch(16);
  assert.notEqual(result.ok, false, JSON.stringify(result));
  assert.equal(docsCalls, 1);
  assert.equal(mainRuntime.root.closed, true);
  assert.equal(fs.existsSync(originalRoot), false);
  const manager = new FlowManager({ root: flow.mainRoot, mainRoot: flow.mainRoot, specId });
  const state = manager.canonicalState(specId);
  assert.equal(state.runId, runId);
  assert.equal(state.lifecycle.state, "finalized");
  const completedCleanup = manager.readCurrentStepSettlement({ specId, stepId: "finalize-cleanup", completed: true });
  assert.equal(completedCleanup.result.kind, "finalize-cleanup-completed");
  const main = ProcessExecutionRuntime.inspect({ mainRoot: flow.mainRoot });
  assert.equal(main.slot, null);
  const calls = main.executions.flatMap((execution) => execution.calls);
  assert.ok(calls.some((call) => call.parentCallId !== null));
  assert.ok(calls.every((call) => call.receipt?.stopEvidence.status === "confirmed"));
  const old = ProcessExecutionRuntime.inspectRetainedClosedCheckout({ mainRoot: flow.mainRoot,
    executionRoot: originalRoot, runId, specId });
  assert.equal(old.slot, null);
  assert.ok(old.executions.every((execution) => execution.status === "closed"));
  assert.match(fs.readFileSync(path.join(flow.mainRoot, "docs/overview.md"), "utf8"), /Generated from the merged implementation/);
  const replayContext = { root: flow.mainRoot, mainRoot: flow.mainRoot, executionRoot: flow.mainRoot,
    flowManager: manager, flowState: manager.loadReadOnly(specId), specId };
  const authority = captureFinalizationProcessAuthority(replayContext, "finalize-cleanup");
  assert.equal(authority.sourceRoot, originalRoot);
  assert.equal(authority.sourceRemoval.cleanupReceiptId, completedCleanup.receipt.id);
  const activities = manager.activityLedger(specId);
  const replay = await new RunFinalizeCleanupCommand().execute(replayContext);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.deepEqual(manager.activityLedger(specId), activities);
  assert.equal(fs.existsSync(originalRoot), false);
  } catch (error) {
    if (flow) {
      retained = true;
      fs.writeFileSync(".tmp/c2f6/finalization-checkout-whole-dispatch-failure.json", JSON.stringify({
        root: flow.root, mainRoot: flow.mainRoot, worktreePath: flow.worktreePath, specId: flow.specId,
        state: flow.state().toJSON(), operations, error: { message: error.message, stack: error.stack },
      }, null, 2));
    }
    throw error;
  }
});
