import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { describe, it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowArtifactBaseline } from "../../../src/flow/lib/current-flow-state.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state-conflict-error.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { SpecGateRepairService } from "../../../src/flow/services/spec-gate-repair-service.js";
import { SpecGateRepairStep } from "../../../src/flow/steps/spec/spec-gate-repair.js";
import { SpecReviewWorkerService } from "../../../src/flow/services/spec-worker-review-service.js";
import { SpecTriageStep } from "../../../src/flow/steps/spec/spec-triage.js";
import { SpecRepairStep } from "../../../src/flow/steps/spec/spec-repair.js";
import { StepFactory } from "../../../src/flow/engine/step-factory.js";
import { StepPersistenceFailure } from "../../../src/flow/lib/definition-lifecycle-failure.js";
import { CanonicalSpecReview, SpecReviewDelta, mergeSpecReviewDelta } from "../../../src/flow/lib/spec-review-artifacts.js";
import { attachCanonicalCommandResultPublications } from "../../../src/flow/lib/canonical-command-result.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { createSpecGateRepairScenario, prepareSpecGateRepairHandoff,
  completeSpecGateRepairHandoff } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";

const replacement = "Publish a precisely validated artifact.";
const original = "Publish a validated artifact.";
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date("2026-08-04T00:00:00.000Z");

function durableSnapshot(manager, specId) {
  return {
    state: manager.canonicalState(specId).toJSON(),
    catalog: manager.artifactCatalog(specId).toJSON(),
    activities: manager.activityLedger(specId),
    spec: manager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec-gate-repair" }).bytes.toString("utf8"),
  };
}

function terminalActivities(manager, specId) {
  return manager.activityLedger(specId).filter((activity) => (
    activity.nodeId === "spec-gate-repair"
    && ["spec-gate-repair-review-required", "spec-gate-repair-ready-for-gate"]
      .includes(activity.result?.stepResult?.kind)
  ));
}

function artifactCount(snapshot, logicalKey) {
  return snapshot.catalog.artifacts.filter((artifact) => artifact.logicalKey === logicalKey).length;
}

async function reviewAndChangeSpec({ root, specId, flowManager, flow }) {
  flow.activate("spec-review");
  const initial = flowManager.readCurrentSpecReviewInput({ specId, consumerNodeId: "spec-review" });
  const reviewed = mergeSpecReviewDelta({ review: initial.review,
    delta: new SpecReviewDelta({ version: 2, stage: "spec-review",
      identity: initial.review.identity.toJSON(), baseReviewDigest: initial.review.digest,
      operations: [], findings: [{ findingId: "review-improvement", kind: "improvement",
        title: "Clarify the validation target", target: "R1",
        body: "The requirement can name its validation target more precisely.",
        improvement: "Add the precise validation target.",
        whyNonBlocking: "The original requirement remains executable.",
      }] }),
  });
  const reviewResult = attachCanonicalCommandResultPublications(
    { result: "reviewed Spec improvement", artifacts: { phase: "spec" } },
    [{ logicalKey: "spec.review", parameters: { revision: String(initial.revision).padStart(3, "0") },
      payload: reviewed.toJSON() }],
  );
  flowManager.updateStepStatus({ stepId: "spec-review", requestedStatus: "done" },
    { specId, canonicalCommandResult: reviewResult });
  assert.ok(flowManager.readLatestSpecReview({ specId, consumerNodeId: "spec-gate-repair" })
    .review.audit.some((entry) => entry.stage === "spec-review"));

  const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager };
  const coordinator = new WorkerArtifactHandoffCoordinator({ now });
  const request = (stepId) => coordinator.createRequest({ ctx, state: flowManager.load(specId),
    invocation: { id: `dispatch-${stepId}`, target: { digest: "b".repeat(64) },
      action: { digest: "a".repeat(64), nextAction: { step: stepId } } } });
  const complete = async (handoff, StepClass) => {
    sealWorkerArtifactHandoff({ requestPath: handoff.requestPath,
      invocationId: handoff.dispatchInvocationId, now });
    const service = await SpecReviewWorkerService.prepare({ ctx, request: handoff,
      Connector: SpecEntryConnector, handoffCoordinator: coordinator });
    return new StepFactory().provide(SpecReviewWorkerService, service).create(StepClass).execute();
  };

  flow.activate("spec-triage");
  const triageRequest = request("spec-triage");
  const triageReview = new CanonicalSpecReview(
    triageRequest.inputs.find((entry) => entry.name === "review.json").document);
  fs.writeFileSync(triageRequest.payloadPath("review.delta.json"), workerArtifactJson({
    version: 2, stage: "spec-triage", identity: triageReview.identity.toJSON(),
    baseReviewDigest: triageReview.digest, operations: [],
    findings: [{ findingId: "review-improvement", disposition: "apply",
      evidence: "The improvement is authorized for this requirement.",
      allowedTargets: [{ target: { entity: "requirement", id: "R1", field: "desc" },
        operationKinds: ["edit-text-field"] }] }],
  }));
  assert.equal((await complete(triageRequest, SpecTriageStep)).kind, "spec-triage-completed");

  flow.activate("spec-repair");
  const repairRequest = request("spec-repair");
  const repairReview = new CanonicalSpecReview(
    repairRequest.inputs.find((entry) => entry.name === "review.json").document);
  fs.writeFileSync(repairRequest.payloadPath("review.delta.json"), workerArtifactJson({
    version: 2, stage: "spec-repair", identity: repairReview.identity.toJSON(),
    baseReviewDigest: repairReview.digest, findings: [],
    operations: [{ findingIds: ["review-improvement"], kind: "edit-text-field",
      target: { entity: "requirement", id: "R1", field: "desc" },
      expectedDigest: hash(original),
      edits: [{ startByte: 0, endByte: Buffer.byteLength(original, "utf8"), replacement }],
      reason: "Apply the reviewed improvement before Spec Gate.",
    }],
  }));
  assert.equal((await complete(repairRequest, SpecRepairStep)).kind, "spec-repair-changed");
  assert.equal(JSON.parse(flowManager.readArtifact({ specId, logicalKey: "spec.record",
    consumerNodeId: "spec-gate" }).bytes.toString("utf8")).requirements[0].desc, replacement);
}

describe("Spec Gate repair terminal durability", () => {
  it("rejects a stale canonical Spec baseline without mutating the active repair", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      const { service } = await prepareSpecGateRepairHandoff({ ctx: value.ctx,
        invocation: value.invocation, coordinator: value.coordinator, replacement });
      const settle = value.flowManager.settleSpecStepResult.bind(value.flowManager);
      let selectedInput = null;
      value.flowManager.settleSpecStepResult = (input) => {
        if (input.specGateRepairSelection) {
          selectedInput = input;
          throw new Error("pause before terminal Store publication");
        }
        return settle(input);
      };
      try {
        await assert.rejects(() => new StepFactory().provide(SpecGateRepairService, service)
          .create(SpecGateRepairStep).execute(), StepPersistenceFailure);
      } finally { value.flowManager.settleSpecStepResult = settle; }
      assert.ok(selectedInput?.specGateRepairSelection);
      const before = durableSnapshot(value.flowManager, value.specId);
      const stale = new CanonicalFlowArtifactBaseline({ logicalKey: "spec.record",
        digest: "0".repeat(64), byteLength: 1 });
      assert.throws(() => settle({ ...selectedInput, artifactBaselines: [stale] }), CurrentFlowStateConflictError);
      assert.deepEqual(durableSnapshot(value.flowManager, value.specId), before);
      await selectedInput.stepResult.persist(service);
      const reloaded = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      assert.equal(terminalActivities(reloaded, value.specId).length, 1);
      const after = durableSnapshot(reloaded, value.specId);
      assert.equal(artifactCount(after, "spec.snapshot"), artifactCount(before, "spec.snapshot") + 1);
      assert.equal(artifactCount(after, "spec.gate.repair.audit"), artifactCount(before, "spec.gate.repair.audit") + 1);
    } finally { removeTmpDir(value.root); }
  });

  it("recovers a lost response after atomic canonical publication and replays one exact terminal receipt", async () => {
    let interrupted = false;
    const value = await createSpecGateRepairScenario();
    try {
      const { service } = await prepareSpecGateRepairHandoff({ ctx: value.ctx,
        invocation: value.invocation, coordinator: value.coordinator, replacement });
      const beforeTerminal = durableSnapshot(value.flowManager, value.specId);
      const settle = value.flowManager.settleSpecStepResult.bind(value.flowManager);
      let selectedInput = null;
      value.flowManager.settleSpecStepResult = (input) => {
        if (input.specGateRepairSelection) selectedInput = input;
        const committed = settle(input);
        if (input.specGateRepairSelection && !interrupted) {
          interrupted = true;
          throw new Error("simulated lost acknowledgement after atomic publication");
        }
        return committed;
      };
      let result;
      try {
        result = await new StepFactory().provide(SpecGateRepairService, service)
          .create(SpecGateRepairStep).execute();
      } finally { value.flowManager.settleSpecStepResult = settle; }
      assert.equal(interrupted, true);
      assert.equal(result.kind, "spec-gate-repair-review-required");
      const restored = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      const beforeReplay = durableSnapshot(restored, value.specId);
      assert.equal(artifactCount(beforeReplay, "spec.snapshot"),
        artifactCount(beforeTerminal, "spec.snapshot") + 1);
      assert.equal(artifactCount(beforeReplay, "spec.gate.repair.audit"),
        artifactCount(beforeTerminal, "spec.gate.repair.audit") + 1);
      const terminal = terminalActivities(restored, value.specId);
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].result.draftSettlementReceipt.id, service.workerOutcome.receipt.id);
      const audit = restored.readArtifact({ specId: value.specId,
        logicalKey: "spec.gate.repair.audit", consumerNodeId: "spec-gate",
        parameters: { attemptId: service.workerOutcome.receipt.binding.attemptId } });
      assert.equal(JSON.parse(audit.bytes.toString("utf8")).acceptedGroups.length, 1);
      assert.equal(JSON.parse(beforeReplay.spec).requirements[0].desc, replacement);
      assert.equal(settle(selectedInput).receipt.id, service.workerOutcome.receipt.id);
      assert.deepEqual(durableSnapshot(restored, value.specId), beforeReplay);
    } finally { removeTmpDir(value.root); }
  });

  it("routes directly back to Gate only when repair restores a genuinely reviewed snapshot", async () => {
    const value = await createSpecGateRepairScenario({ beforeGate: reviewAndChangeSpec });
    try {
      const prior = value.flowManager.readLatestSpecReview({ specId: value.specId,
        consumerNodeId: "spec-gate-repair" });
      assert.ok(prior.review.audit.some((entry) => entry.stage === "spec-review"));
      assert.equal(JSON.parse(prior.snapshotBytes.toString("utf8")).requirements[0].desc, original);
      const { result, service } = await completeSpecGateRepairHandoff({ ctx: value.ctx,
        invocation: value.invocation, coordinator: value.coordinator, replacement: original });
      assert.equal(result.kind, "spec-gate-repair-ready-for-gate");
      const restored = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      assert.equal(restored.canonicalState(value.specId).nextAction().nodeId, "spec-gate");
      const audit = JSON.parse(restored.readArtifact({ specId: value.specId,
        logicalKey: "spec.gate.repair.audit", consumerNodeId: "spec-gate",
        parameters: { attemptId: service.workerOutcome.receipt.binding.attemptId },
      }).bytes.toString("utf8"));
      assert.equal(audit.reviewFacts.reviewInputPreserved, true);
      assert.equal(audit.reviewFacts.requiresReview, false);
      assert.equal(audit.reviewFacts.sourceReviewIdentity.digest, prior.review.identity.digest);
      assert.equal(terminalActivities(restored, value.specId).length, 1);
    } finally { removeTmpDir(value.root); }
  });
});
