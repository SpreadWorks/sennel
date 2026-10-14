import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { ProcessExecutionRuntime, captureProcessExecutionCheckoutIdentity, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { FlowHandoffAuthorityLease } from "../../../src/lib/flow-handoff-authority-lease.js";
import { WorktreeFlowBindingStore, WorktreeFlowIdentity } from "../../../src/lib/worktree-flow-binding.js";
import { captureFlowProcessExecutionBinding } from "../../../src/flow/lib/process-runtime-admission.js";
import { FlowProcessStopEvidence } from "../../../src/flow/lib/process-runtime-evidence.js";
import { WorkerArtifactHandoffCoordinator, materializeSourceWorkerEffect, sealParentMaterializedSourceWorkerEffect } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { sourceStepRegistration } from "../../../src/flow/engine/composition/source-step.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

async function scenario(t, callback, { worktree = false } = {}) {
  const mainRoot = createTmpDir("source-process-stop-");
  t.after(() => removeTmpDir(mainRoot));
  fs.writeFileSync(path.join(mainRoot, "product.js"), "export const value = 1;\n");
  initGitRepo(mainRoot);
  commitAll(mainRoot, "source process stop baseline");
  const branch = "source-stop-worker";
  const root = worktree ? path.join(mainRoot, ".sennel", "worktree", branch) : mainRoot;
  if (worktree) {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    execFileSync("git", ["worktree", "add", "-b", branch, root, "main"], { cwd: mainRoot, stdio: "pipe" });
  }
  const specId = "source-process-stop";
  if (worktree) new WorktreeFlowBindingStore({ worktreePath: root }).save(new WorktreeFlowIdentity({
    runId: "source-process-stop-run", issue: null, specId, worktreePath: root,
  }));
  const manager = new FlowManager({ root, mainRoot, specId, inWorktree: worktree });
  new CanonicalFlowFixture({ flowManager: manager, specId, runId: "source-process-stop-run",
    execution: { mode: worktree ? "worktree" : "direct", baseBranch: "main", featureBranch: worktree ? branch : null }, specRecord: {
    goal: "Persist source process stop authority.",
    requirements: [{ id: "R1", desc: "Read a stopped source worker through canonical authority.", task_ids: ["T1"], testable: false }],
  } }).create().addTask({ id: "T1", title: "Source stop", goal: "Validate the source receipt.", origin: "plan", added_round: 0, status: "pending" })
    .registerActive().activate("implement");
  const ctx = { root, mainRoot, executionRoot: root, specId, flowManager: manager, flowState: manager.loadReadOnly(specId), config: {} };
  const coordinator = new WorkerArtifactHandoffCoordinator();
  const invocation = { id: "source-process-stop-invocation", target: { digest: crypto.createHash("sha256").update("target").digest("hex") },
    action: { digest: crypto.createHash("sha256").update("action").digest("hex"), nextAction: { step: "implement" } } };
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot, executionRoot: root, runId: ctx.flowState.runId, specId });
  const lease = new FlowHandoffAuthorityLease({ mainRoot, executionRoot: root });
  try {
    return await runtime.enter(async () => {
      lease.acquire();
      try {
        const request = coordinator.createRequest({ ctx, state: ctx.flowState, invocation });
        coordinator.startSourceWorker({ ctx, request, invocation });
        let evidence;
        const effect = { version: 1, stepId: "implement", completionStatus: "done", issues: [], overview: null, triage: null, repair: null, noChangeReason: null };
        const result = await executeManagedProcess(process.execPath, ["-e",
          `require('node:fs').writeFileSync('product.js', 'export const value = 2;\\n');process.stdout.write(${JSON.stringify(JSON.stringify(effect))});`], {
          cwd: root, timeoutMs: 40000, graceMs: 100, maxBuffer: 4096, kind: "provider",
          processExecutionBinding: captureFlowProcessExecutionBinding(ctx, { executionContract: request.executionContract,
            dispatchInvocationId: request.dispatchInvocationId, requestDigest: request.requestDigest }),
          onProcessExecutionStop(receipt) { evidence = new FlowProcessStopEvidence(receipt); },
        });
        assert.equal(result.code, 0);
        const reload = () => new FlowManager({ root, mainRoot, specId, inWorktree: worktree });
        return await callback({ root, mainRoot, manager, specId, ctx, request, coordinator, evidence, result, reload });
      } finally { lease.release(); }
    });
  } finally { await runtime.close(); }
}

function snapshot(manager, specId) {
  return { state: manager.canonicalState(specId).toJSON(), catalog: manager.artifactCatalog(specId).toJSON(), activities: manager.activityLedger(specId) };
}

test("managed source stop persists before source publication and survives a fresh canonical reader", async (t) => {
  await scenario(t, ({ manager, specId, ctx, request, coordinator, evidence, result, reload }) => {
    coordinator.finishSourceWorker({ ctx, request, processStopEvidence: evidence });
    const authority = reload().readSourceHandoffAuthority({ specId, identity: request.sourceHandoffIdentity });
    assert.equal(authority.event.kind, "worker-exited");
    assert.deepEqual(authority.event.processStopEvidence.toJSON(), evidence.toJSON());
    assert.equal(manager.canonicalState(specId).attempt.id, request.executionContract.attemptId);
    materializeSourceWorkerEffect({ request, responseText: result.stdout });
    sealParentMaterializedSourceWorkerEffect({ request });
    const preparation = coordinator.prepareSourceStepHandoff({ ctx, request, mutationAuthority: coordinator.sourceMutationAuthority({ ctx, request }) });
    sourceStepRegistration("implement").create({ ctx, request, preparation, handoffCoordinator: coordinator }).step.execute();
    const settled = reload().readSourceHandoffAuthority({ specId, identity: request.sourceHandoffIdentity });
    assert.equal(settled.settlement.kind, "accepted");
    assert.deepEqual(settled.events.find((event) => event.kind === "worker-exited").processStopEvidence.toJSON(), evidence.toJSON());
  });
});

test("a source stop from another checkout is refused without canonical changes or rollback", async (t) => {
  await scenario(t, ({ root, manager, specId, ctx, request, coordinator, evidence, reload }) => {
    const otherRoot = createTmpDir("source-stop-other-checkout-");
    t.after(() => removeTmpDir(otherRoot));
    const foreign = new FlowProcessStopEvidence(new ProcessExecutionStopReceipt({ ...evidence.toJSON(),
      checkoutIdentity: captureProcessExecutionCheckoutIdentity({ mainRoot: otherRoot }).toJSON() }));
    const before = snapshot(manager, specId);
    assert.throws(() => coordinator.finishSourceWorker({ ctx, request, processStopEvidence: foreign }), { code: "PROCESS_EXECUTION_STOP_CHECKOUT_MISMATCH" });
    assert.deepEqual(snapshot(reload(), specId), before);
    assert.equal(fs.readFileSync(path.join(root, "product.js"), "utf8"), "export const value = 2;\n");
    assert.equal(reload().readSourceHandoffAuthority({ specId, identity: request.sourceHandoffIdentity }).event.kind, "start-intent");
  });
});

test("retained source stop remains readable from main after its worker worktree is removed", async (t) => {
  const retained = await scenario(t, ({ root, mainRoot, specId, ctx, request, coordinator, evidence, result }) => {
    coordinator.finishSourceWorker({ ctx, request, processStopEvidence: evidence });
    materializeSourceWorkerEffect({ request, responseText: result.stdout });
    sealParentMaterializedSourceWorkerEffect({ request });
    const preparation = coordinator.prepareSourceStepHandoff({ ctx, request,
      mutationAuthority: coordinator.sourceMutationAuthority({ ctx, request }) });
    sourceStepRegistration("implement").create({ ctx, request, preparation, handoffCoordinator: coordinator }).step.execute();
    return { root, mainRoot, specId, identity: request.sourceHandoffIdentity, receipt: evidence.toJSON() };
  }, { worktree: true });
  execFileSync("git", ["worktree", "remove", "--force", retained.root], { cwd: retained.mainRoot, stdio: "pipe" });
  assert.equal(fs.existsSync(retained.root), false);
  const reader = new FlowManager({ root: retained.mainRoot, mainRoot: retained.mainRoot, specId: retained.specId, inWorktree: false });
  const before = snapshot(reader, retained.specId);
  const authority = reader.readSourceHandoffAuthority({ specId: retained.specId, identity: retained.identity });
  assert.equal(authority.settlement.kind, "accepted");
  assert.deepEqual(authority.events.find((event) => event.kind === "worker-exited").processStopEvidence.toJSON(), retained.receipt);
  assert.deepEqual(snapshot(reader, retained.specId), before);
});
