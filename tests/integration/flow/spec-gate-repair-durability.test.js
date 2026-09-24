import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { validWorkerHandoffSpec } from "../../support/infrastructure/worker-artifact.js";
import { completeSpecGateRepairHandoff } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { SpecGateEvaluationBinding } from "../../../src/flow/engine/connectors/spec/spec-step-binding.js";
import { SpecGateService } from "../../../src/flow/services/spec-gate-service.js";
import { SpecGateStep } from "../../../src/flow/steps/spec/spec-gate.js";
import { SpecGateRepairService } from "../../../src/flow/services/spec-gate-repair-service.js";
import { SpecGateIssuePublication } from "../../../src/flow/lib/gate-issue-publication.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { WorkerArtifactHandoffCoordinator } from "../../../src/flow/lib/worker-artifact-handoff.js";

const now = () => new Date("2026-08-04T00:00:00.000Z");

async function gateRepairFixture() {
  const root = createTmpDir("spec-gate-repair-durability-");
  try {
    const specId = "500-spec-gate-repair-durability";
    const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager, specId, runId: "run-spec-gate-repair-durability",
      request: "Repair the bounded Spec Gate finding.", specRecord: validWorkerHandoffSpec(),
    }).create().registerActive();
    flow.addTask({ id: "T1", title: "Publish guarded Spec", goal: "Exercise the repair route.",
      origin: "plan", added_round: 0, status: "pending" });
    flow.activate("spec-gate");
    const binding = new SpecGateEvaluationBinding({ flowManager, specId });
    const observations = [{
      kind: "violation", failureMode: "guardrail-violation", requirementRef: "R1",
      where: { file: "spec.json", locator: "requirements[R1].desc" },
      observed: "The requirement description needs a precise validation target.",
      severity: "blocking", refs: ["R1"],
    }];
    const commandResult = new CanonicalGatePromotion({
      state: flowManager.canonicalState(specId), phase: "spec", nodeId: "spec-gate",
    }).promote({ result: "fail", artifacts: {
      phase: "spec", failureKind: "ai_semantic_fail", failureCode: "GATE_REJECTED",
      nextAction: { diagnosis: { observations } },
    } });
    const issuePublication = new SpecGateIssuePublication({
      binding, entry: { step: "spec-gate", phase: "spec", observations,
        reason: "The requirement needs a bounded correction.",
        trigger: "gate post hook (auto)", timestamp: binding.assertCurrent().attempt.startedAt },
    });
    const gate = await new SpecGateStep(new SpecGateService({
      flowManager, binding, commandResult, issuePublication,
    })).execute();
    assert.equal(gate.kind, "spec-gate-repair-required");
    assert.equal(flowManager.canonicalState(specId).current?.at(-1), "spec-gate-repair");
    const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager };
    const invocation = { id: "dispatch-spec-gate-repair", target: { digest: "b".repeat(64) },
      action: { digest: "a".repeat(64), nextAction: { step: "spec-gate-repair" } } };
    const coordinator = new WorkerArtifactHandoffCoordinator({ now });
    return { root, specId, flowManager, ctx, invocation, coordinator };
  } catch (error) {
    removeTmpDir(root);
    throw error;
  }
}

function requestFor(value) {
  return value.coordinator.createRequest({
    ctx: value.ctx, state: value.flowManager.load(value.specId), invocation: value.invocation,
  });
}

function currentProgress(manager, specId, request, phase, generation = "0") {
  return JSON.parse(manager.readArtifact({
    specId, logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
    parameters: { attemptId: manager.canonicalState(specId).attempt.id, generation, phase },
  }).bytes.toString("utf8"));
}

describe("Spec Gate repair durable handoff", () => {
  it("publishes a bounded correction, review route and exact receipt through the Step", async () => {
    const value = await gateRepairFixture();
    try {
      const original = value.flowManager.readArtifact({
        specId: value.specId, logicalKey: "spec.record", consumerNodeId: "spec-gate-repair",
      });
      const prior = JSON.parse(original.bytes.toString("utf8")).requirements[0].desc;
      const { request, service, result, range } = await completeSpecGateRepairHandoff({
        ctx: value.ctx, invocation: value.invocation, coordinator: value.coordinator,
        replacement: "Publish a precisely validated artifact.",
      });
      assert.equal(range.path, "requirements[R1].desc");
      assert.equal(prior, "Publish a validated artifact.");
      assert.equal(result.kind, "spec-gate-repair-review-required");
      const restored = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      const state = restored.canonicalState(value.specId);
      assert.equal(state.nextAction().nodeId, "spec-review");
      const published = restored.readArtifact({
        specId: value.specId, logicalKey: "spec.record", consumerNodeId: "spec-review",
      });
      assert.equal(JSON.parse(published.bytes.toString("utf8")).requirements[0].desc,
        "Publish a precisely validated artifact.");
      const audit = JSON.parse(restored.readArtifact({ specId: value.specId,
        logicalKey: "spec.gate.repair.audit", consumerNodeId: "spec-gate",
        parameters: { attemptId: service.binding.attempt.id },
      }).bytes.toString("utf8"));
      assert.equal(audit.acceptedGroups.length, 1);
      assert.equal(audit.reviewFacts.requiresReview, true);
      const receipt = restored.activityLedger(value.specId).findLast((entry) => (
        entry.nodeId === "spec-gate-repair" && entry.result?.stepResult?.kind === result.kind
      ))?.result?.draftSettlementReceipt;
      assert.equal(receipt?.id, service.workerOutcome.receipt.id);
      assert.equal(restored.activityLedger(value.specId).filter((entry) => (
        entry.nodeId === "spec-gate-repair" && entry.result?.stepResult?.kind === result.kind
      )).length, 1);
    } finally { removeTmpDir(value.root); }
  });

  it("retains a claimed provider call budget after a manager restart", async () => {
    const value = await gateRepairFixture();
    try {
      const request = requestFor(value);
      SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request, prompt: JSON.stringify(request.toPromptReference()) });
      const claimed = currentProgress(value.flowManager, value.specId, request, "claimed");
      assert.equal(claimed.phase, "claimed");
      assert.equal(claimed.budget.providerCallCount, 1);
      const restored = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      assert.deepEqual(currentProgress(restored, value.specId, request, "claimed"), claimed);
      assert.equal(restored.canonicalState(value.specId).current?.at(-1), "spec-gate-repair");
      assert.equal(restored.draftStepExecutionState({ binding: {
        runId: restored.canonicalState(value.specId).runId,
        specId: value.specId, stepId: "spec-gate-repair",
        attempt: restored.canonicalState(value.specId).attempt,
      } }).lifecycle.phase, "claimed");
      const restartedCtx = { ...value.ctx, flowManager: restored };
      const nextRequest = new WorkerArtifactHandoffCoordinator({ now }).createRequest({
        ctx: restartedCtx, state: restored.load(value.specId),
        invocation: { ...value.invocation, id: "dispatch-spec-gate-repair-after-crash" },
      });
      SpecGateRepairService.reserveWorkerCall({ ctx: restartedCtx, request: nextRequest, prompt: JSON.stringify(nextRequest.toPromptReference()) });
      const resumed = currentProgress(restored, value.specId, nextRequest, "claimed", "1");
      assert.equal(resumed.budget.providerCallCount, 2);
      assert.deepEqual(currentProgress(restored, value.specId, request, "claimed"), claimed);
    } finally { removeTmpDir(value.root); }
  });
});
