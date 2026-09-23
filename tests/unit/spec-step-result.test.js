import assert from "node:assert/strict";
import test from "node:test";

import {
  SpecNextRoute,
  StepErrorDecision,
  settleSpecStepResult,
} from "../../src/flow/definition.js";
import { SpecReviewConnector } from "../../src/flow/engine/connectors/spec/spec-review-connector.js";
import { SpecRepairConnector } from "../../src/flow/engine/connectors/spec/spec-repair-connector.js";
import { SpecGateConnector } from "../../src/flow/engine/connectors/spec/spec-gate-connector.js";
import {
  SpecCreatedResult,
  SpecPlanGateRepairAppliedResult,
  SpecPlanGateRepairNoProgressResult,
  SpecTriageCompletedResult,
  SpecRepairChangedResult,
  SpecRepairUnchangedResult,
  StepErrorResult,
  StepResult,
} from "../../src/flow/engine/step-result.js";
import {
  CanonicalFlowArtifactBaseline,
  CanonicalWorkerSpecPublication,
} from "../../src/flow/lib/current-flow-state.js";
import { SpecWorkerCompletionFacts } from "../../src/flow/lib/spec-step-connection.js";
import {
  ArtifactGateRepairLineage,
  ArtifactGateRepairObservationResult,
  GateEvidenceIdentity,
  GateObservationRepair,
  GateRepairObservationRequest,
  GateRepairReport,
  PlanGateRepairOutcomeDraft,
} from "../../src/flow/lib/gate-observation-convergence.js";
import { specResult } from "../../src/flow/steps/spec/spec.js";

function repairOutcome(disposition) {
  const fingerprint = "a".repeat(64);
  const before = "b".repeat(64);
  const after = disposition === "applied" ? "c".repeat(64) : before;
  const sourceAttempt = { id: "gate-attempt", sequence: 1 };
  const sourceEvidence = new GateEvidenceIdentity({
    sourceAttempt,
    resultLogicalKey: "spec.gate",
    publicationActivityId: "gate-publication",
    catalogFingerprint: "d".repeat(64),
    transitionLineage: {
      sourceAttempt, canonicalAttempt: sourceAttempt,
      sourceFingerprint: "d".repeat(64), canonicalFingerprint: "d".repeat(64),
    },
  });
  const request = new GateRepairObservationRequest({ fingerprint });
  const deltaIds = disposition === "applied" ? [after] : [];
  const report = new GateRepairReport({
    beforeEvidenceDigest: before,
    outputEvidenceDigest: after,
    summary: "Address the Gate observation",
    requests: [request],
    lineage: new ArtifactGateRepairLineage({ deltaIds }),
    results: [new ArtifactGateRepairObservationResult({
      fingerprint, strategy: "Revise the specification",
      summary: "Checked the specification against the observation",
      priorRepairInsufficiency: null, deltaIds,
    })],
  });
  return new PlanGateRepairOutcomeDraft({
    repair: new GateObservationRepair({
      repairId: "repair-spec-gate",
      sourceEvidence,
      targetAttempt: { id: "spec-repair-attempt", sequence: 2 },
      publicationActivityId: "repair-selection",
      recordFingerprint: "e".repeat(64),
      handoffRevision: "f".repeat(64),
      requests: [request],
    }),
    disposition,
    report,
  });
}

test("initial Spec facts produce the semantic Result without I/O", () => {
  const facts = new SpecWorkerCompletionFacts({
    publication: new CanonicalWorkerSpecPublication({ version: 1 }),
    baseline: new CanonicalFlowArtifactBaseline({ logicalKey: "spec.record" }),
  });

  const result = specResult(facts);

  assert.equal(result instanceof SpecCreatedResult, true);
  assert.deepEqual(result.toJSON(), { kind: "spec-created", type: "completed" });
});

test("bound Spec plan Gate repair facts produce distinct applied and no-progress Results", () => {
  for (const [disposition, Result, settlementKind] of [
    ["applied", SpecPlanGateRepairAppliedResult, "target-connection"],
    ["rejected-no-progress", SpecPlanGateRepairNoProgressResult, "failure"],
  ]) {
    const facts = new SpecWorkerCompletionFacts({
      publication: new CanonicalWorkerSpecPublication({ version: 1 }),
      baseline: new CanonicalFlowArtifactBaseline({ logicalKey: "spec.record" }),
      planGateRepairOutcome: repairOutcome(disposition),
    });
    const result = specResult(facts);
    assert.ok(result instanceof Result);
    assert.equal(result.stepId, "spec");
    assert.equal(settleSpecStepResult("spec", result).kind, settlementKind);
    if (disposition === "rejected-no-progress") {
      assert.equal(result.error.code, "FLOW_PLAN_GATE_REPAIR_NO_PROGRESS");
    }
  }
});

test("Definition deterministically selects the Spec Review connection after readback", () => {
  const original = new SpecCreatedResult();
  const restored = StepResult.fromStored("spec", original.toJSON());

  for (const result of [original, restored]) {
    const settlement = settleSpecStepResult("spec", result);
    assert.equal(settlement instanceof SpecNextRoute, true);
    assert.equal(settlement.targetStepId, "spec-review");
    assert.equal(settlement.connector, SpecReviewConnector);
    assert.deepEqual(settlement.toJSON(), {
      kind: "target-connection",
      sourceStepId: "spec",
      targetStepId: "spec-review",
      effects: { skipStepIds: [], resetStepIds: [] },
    });
  }
});

test("Spec Error Results select the shared failure settlement", () => {
  const result = specResult(new Error("initial Spec unavailable"));
  const settlement = settleSpecStepResult(result.stepId, result);

  assert.equal(result instanceof StepErrorResult, true);
  assert.equal(result.stepId, "spec");
  assert.equal(settlement instanceof StepErrorDecision, true);
  assert.equal(settlement.error.message, "initial Spec unavailable");
  assert.equal(Object.hasOwn(settlement, "connector"), false);
});

test("Spec Triage and Repair Results select the next route after readback", () => {
  for (const [result, target, connector] of [
    [new SpecTriageCompletedResult(), "spec-repair", SpecRepairConnector],
    [new SpecRepairChangedResult(), "spec-gate", SpecGateConnector],
    [new SpecRepairUnchangedResult(), "spec-gate", SpecGateConnector],
  ]) {
    const restored = StepResult.fromStored(result.stepId, result.toJSON());
    const settlement = settleSpecStepResult(result.stepId, restored);
    assert.equal(settlement instanceof SpecNextRoute, true);
    assert.equal(settlement.targetStepId, target);
    assert.equal(settlement.connector, connector);
  }
});
