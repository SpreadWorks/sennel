import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { specStepRegistration } from "../../../src/flow/engine/composition/spec.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { latestRepairBudget } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import RunSealHandoffCommand from "../../../src/flow/lib/run-seal-handoff.js";
import { Container } from "../../../src/lib/container.js";
import { WorkerArtifactHandoffCoordinator } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { reserveFixtureSpecGateRepairWorkerCall } from "../../support/infrastructure/spec-gate-repair-admission.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";

// Exercise the actual worker command with no canonical publication authority.
function sealAsWorker(request, mainRoot) {
  const previousRequest = process.env.SENNEL_FLOW_HANDOFF_REQUEST;
  const previousInvocation = process.env.SENNEL_FLOW_DISPATCH_INVOCATION_ID;
  const container = new Container();
  container.register("mainRoot", mainRoot);
  container.register("flowManager", {
    canonicalState() { throw new Error("worker seal cannot acquire canonical publication authority"); },
  });
  process.env.SENNEL_FLOW_HANDOFF_REQUEST = request.requestPath;
  process.env.SENNEL_FLOW_DISPATCH_INVOCATION_ID = request.dispatchInvocationId;
  try { return new RunSealHandoffCommand().execute({ container }); }
  finally {
    if (previousRequest === undefined) delete process.env.SENNEL_FLOW_HANDOFF_REQUEST;
    else process.env.SENNEL_FLOW_HANDOFF_REQUEST = previousRequest;
    if (previousInvocation === undefined) delete process.env.SENNEL_FLOW_DISPATCH_INVOCATION_ID;
    else process.env.SENNEL_FLOW_DISPATCH_INVOCATION_ID = previousInvocation;
  }
}

function durable(manager, specId) {
  return { state: manager.canonicalState(specId).toJSON(),
    catalog: manager.artifactCatalog(specId).toJSON(), activities: manager.activityLedger(specId),
    spec: manager.readArtifact({ specId, logicalKey: "spec.record",
      consumerNodeId: "spec-gate-repair" }).bytes.toString("utf8") };
}

function budget(manager, specId, attemptId, baseRevision) {
  return latestRepairBudget({ flowManager: manager, specId, attemptId, baseRevision,
    consumerNodeId: "spec-gate-repair" }).budget.snapshot();
}

// A worker can report this disposition using only the actual bounded manifest
// and reference, even when it cannot read the selected document.
function unavailable(request, reason) {
  const manifest = JSON.parse(fs.readFileSync(request.requestPath, "utf8"));
  const descriptor = manifest.inputs[0].descriptor;
  const reference = request.toPromptReference().toJSON();
  assert.equal(Object.hasOwn(manifest.inputs[0], "document"), false);
  return { version: 1, stage: "spec-gate-repair-input-unavailable",
    binding: { runId: manifest.runId, specId: manifest.specId, stepId: manifest.stepId,
      attemptId: descriptor.canonicalLocator.attemptId,
      attemptSequence: descriptor.canonicalLocator.attemptSequence,
      inputDigest: manifest.inputDigest, inputRevision: manifest.inputRevision,
      requestDigest: reference.requestDigest },
    ...descriptor.selectedIdentity, reason,
    explanation: "The selected input cannot be consumed within this worker invocation." };
}

for (const [mode, reason] of [["repair", "context-limit"], ["repair", "file-read-failed"],
  ["repair", "context-unavailable"]]) {
  test(`${mode} input unavailable seals, reloads and fails once without adopting a Spec (${reason})`, async () => {
    const value = await createSpecGateRepairScenario();
    try {
      const initial = durable(value.flowManager, value.specId);
      const request = value.coordinator.createRequest({ ctx: value.ctx,
        state: value.flowManager.load(value.specId), invocation: value.invocation });
      const context = request.inputs[0].document;
      assert.equal(context.mode, mode);
      const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
      const payload = unavailable(request, reason);
      reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) });
      const claimedBudget = budget(value.flowManager, value.specId, attemptId, context.baseRevision);
      assert.equal(claimedBudget.providerCallCount, 1);
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(payload));
      if (reason === "file-read-failed") {
        fs.unlinkSync(request.inputs[0].descriptor.deliveryPath(request.executionRoot));
      }
      const beforeSeal = durable(value.flowManager, value.specId);
      const sealed = sealAsWorker(request, value.root);
      assert.equal(sealed.ok, true, JSON.stringify(sealed));
      assert.equal(sealed.data.handoffPath, request.submissionPath);
      assert.equal(sealed.data.payloadCount, 1);
      assert.equal(request.hasSealedSubmission(), true);
      assert.deepEqual(durable(value.flowManager, value.specId), beforeSeal);

      // Reconstruct after seal: the parent must restore canonical input and
      // publish the typed disposition despite a missing delivery copy.
      const reloaded = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      const ctx = { ...value.ctx, flowManager: reloaded };
      const canonical = reloaded.canonicalState(value.specId);
      const lifecycle = reloaded.draftStepExecutionState({ binding: {
        runId: canonical.runId, specId: canonical.specId, stepId: "spec-gate-repair",
        attempt: canonical.attempt,
      } }).lifecycle;
      const coordinator = new WorkerArtifactHandoffCoordinator();
      const restored = coordinator.restoreClaimedDraftRequest({ ctx,
        state: reloaded.load(value.specId), lifecycle });
      await specStepRegistration("spec-gate-repair").create({ ctx, request: restored,
        handoffCoordinator: coordinator });
      const publishedBudget = budget(reloaded, value.specId, attemptId, context.baseRevision);
      assert.equal(publishedBudget.providerCallCount, 1);
      assert.ok(publishedBudget.aggregateCharacters > claimedBudget.aggregateCharacters);
      assert.equal(durable(reloaded, value.specId).spec, initial.spec);

      // Discard managers again after publication; no request or result is
      // passed through memory into the Step's persisted-input consumer.
      const finalManager = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      const finalCtx = { ...value.ctx, flowManager: finalManager };
      const prepared = await specStepRegistration("spec-gate-repair").create({ ctx: finalCtx,
        handoffCoordinator: new WorkerArtifactHandoffCoordinator() });
      const result = await prepared.step.execute();
      assert.equal(result.kind, "spec-gate-repair-error");
      assert.equal(result.error.code, "FLOW_SPEC_GATE_REPAIR_INPUT_UNAVAILABLE");
      assert.equal(result.error.data.reason, reason);
      const after = durable(finalManager, value.specId);
      assert.equal(after.spec, initial.spec);
      for (const logicalKey of ["spec.snapshot", "spec.gate.repair.audit"]) {
        assert.equal(after.catalog.artifacts.filter((entry) => entry.logicalKey === logicalKey).length,
          initial.catalog.artifacts.filter((entry) => entry.logicalKey === logicalKey).length);
      }
      assert.equal(finalManager.canonicalState(value.specId).attempt.failure.code, "FLOW_SPEC_GATE_REPAIR_INPUT_UNAVAILABLE");
      const receipts = after.activities.filter((entry) => entry.nodeId === "spec-gate-repair"
        && entry.result?.stepResult?.kind === "spec-gate-repair-error");
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].result.stepResult.error.code, "FLOW_SPEC_GATE_REPAIR_INPUT_UNAVAILABLE");
      assert.equal(receipts[0].result.draftSettlementReceipt.settlementKind, "failure");
      assert.deepEqual(budget(finalManager, value.specId, attemptId, context.baseRevision), publishedBudget);

      const replayManager = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      const replay = await specStepRegistration("spec-gate-repair").create({
        ctx: { ...finalCtx, flowManager: replayManager },
        handoffCoordinator: new WorkerArtifactHandoffCoordinator() });
      assert.equal(replay.completed, true);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.stepResult.toJSON(), result.toJSON());
      assert.equal(replay.receipt.id, receipts[0].result.draftSettlementReceipt.id);
      assert.deepEqual(durable(replayManager, value.specId), after);
      assert.deepEqual(budget(replayManager, value.specId, attemptId, context.baseRevision), publishedBudget);
    } finally { removeTmpDir(value.root); }
  });
}

test("a mixed or foreign input-unavailable response cannot seal or publish its retained claim", async () => {
  const value = await createSpecGateRepairScenario();
  try {
    const request = value.coordinator.createRequest({ ctx: value.ctx,
      state: value.flowManager.load(value.specId), invocation: value.invocation });
    const payload = unavailable(request, "context-limit");
    reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request,
      prompt: JSON.stringify(request.toPromptReference()) });
    const before = durable(value.flowManager, value.specId);
    for (const malformed of [{ ...payload, groups: [] },
      { ...payload, binding: { ...payload.binding, attemptId: "foreign-attempt" } },
      { ...payload, selectionDigest: "f".repeat(64) }]) {
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(malformed));
      const refused = sealAsWorker(request, value.root);
      assert.equal(refused.ok, false);
      assert.match(refused.errors[0].messages.join(" "), /invalid shape|differs from its exact selected request/);
      assert.equal(request.hasSealedSubmission(), false);
      assert.deepEqual(durable(value.flowManager, value.specId), before);
    }
  } finally { removeTmpDir(value.root); }
});
