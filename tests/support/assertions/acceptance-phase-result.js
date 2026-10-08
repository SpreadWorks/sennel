import assert from "node:assert/strict";
import { StepResult } from "../../../src/flow/engine/step-result.js";
import { ImplPhaseResultContract } from "./impl-phase-result.js";
import { assertPhaseSettlementRoundtrip } from "./phase-settlement.js";

// Reuse the existing registry/class/serialization contract rather than create a
// second Result registry or a test implementation of phase semantics.
export const acceptancePhaseResultContracts = Object.freeze([
  ["retro", "RetroAggregatedResult", "retro-aggregated", "completed"],
  ["retro", "RetroIncompleteResult", "retro-incomplete", "branch-required"],
  ["retro", "RetroEvidenceRefreshResult", "retro-evidence-refresh", "loop-required"],
  ["acceptance-review", "AcceptanceReviewExecutionRequiredResult", "acceptance-review-execution-required", "loop-required"],
  ["acceptance-review", "AcceptanceReviewPassedResult", "acceptance-review-passed", "completed"],
  ["acceptance-review", "AcceptanceReviewRepairRequiredResult", "acceptance-review-repair-required", "loop-required"],
  ["acceptance-review", "AcceptanceReviewDecisionRequiredResult", "acceptance-review-decision-required", "branch-required"],
  ["acceptance-review", "AcceptanceReviewMechanicallyBlockedResult", "acceptance-review-mechanically-blocked", "branch-required"],
  ["acceptance-decision", "AcceptanceDecisionAwaitingChoiceResult", "acceptance-decision-awaiting-choice", "user-input-required"],
  ["acceptance-decision", "AcceptanceDecisionRiskAcceptedResult", "acceptance-decision-risk-accepted", "completed"],
  ["acceptance-decision", "AcceptanceDecisionAbortedResult", "acceptance-decision-aborted", "completed"],
  ["final-regression", "FinalRegressionExecutionRequiredResult", "final-regression-execution-required", "loop-required"],
  ["final-regression", "FinalRegressionPassedResult", "final-regression-passed", "completed"],
  ["final-regression", "FinalRegressionPolicySkippedResult", "final-regression-policy-skipped", "completed"],
  ["final-regression", "FinalRegressionFailedResult", "final-regression-failed", "branch-required"],
  ["final-regression", "FinalRegressionFailureAcceptedResult", "final-regression-failure-accepted", "completed"],
  ["report", "ReportDeliveryRequiredResult", "report-delivery-required", "loop-required"],
  ["report", "ReportGeneratedResult", "report-generated", "completed"],
  ...["retro", "acceptance-review", "acceptance-decision", "final-regression", "report"]
    .map((id) => [id, "StepErrorResult", `${id}-error`, "error"]),
].map((entry) => new ImplPhaseResultContract(...entry, "d538")));

export function assertAcceptancePhaseResult(result) {
  assert.ok(result instanceof StepResult, "Acceptance publication must retain a concrete StepResult");
  const contract = acceptancePhaseResultContracts.find((entry) => entry.stepId === result.stepId && entry.kind === result.kind);
  assert.ok(contract, `ACCEPTANCE_PHASE_RESULT_UNKNOWN: ${result.stepId}/${result.kind}`);
  return contract.assertResult(result);
}

export function assertAcceptancePhaseSettlementRoundtrip(result) {
  return assertPhaseSettlementRoundtrip(result, { name: "settleAcceptanceStepResult",
    missingCode: "ACCEPTANCE_PHASE_SETTLEMENT_API_MISSING", nonTargetKinds: ["execution", "await", "failure", "park"],
    connectorNames: ["RetroConnector", "AcceptanceRepairConnector", "AcceptanceDecisionConnector",
      "AcceptanceFinalRegressionConnector", "FinalRegressionReportConnector", "ReportFinalizeCommitConnector"] });
}
