import assert from "node:assert/strict";
import { StepResult } from "../../../src/flow/engine/step-result.js";
import { ImplPhaseResultContract } from "./phase-result-contract.js";
export { ImplPhaseResultContract } from "./phase-result-contract.js";
import { futurePhaseManifests } from "../structure/phase-manifest.js";
import { assertPhaseSettlementRoundtrip } from "./phase-settlement.js";

export const implPhaseResultContracts = Object.freeze([
  new ImplPhaseResultContract("implement", "ImplementWorkerRequiredResult", "implement-worker-required", "loop-required", "ede4"),
  new ImplPhaseResultContract("implement", "ImplementAppliedResult", "implement-applied", "completed", "ede4"),
  new ImplPhaseResultContract("implement", "ImplementExistingCompletionResult", "implement-existing-completion", "completed", "ede4"),
  new ImplPhaseResultContract("implement", "ImplementQualityIssueResult", "implement-quality-issue", "completed", "ede4"),
  new ImplPhaseResultContract("implement", "StepErrorResult", "implement-error", "error", "ede4"),
  new ImplPhaseResultContract("task-impl", "TaskImplementationWorkerRequiredResult", "task-impl-worker-required", "loop-required", "fdc7"),
  new ImplPhaseResultContract("task-impl", "TaskImplementationAppliedResult", "task-impl-applied", "completed", "fdc7"),
  new ImplPhaseResultContract("task-impl", "TaskImplementationNoChangeResult", "task-impl-no-change", "completed", "fdc7"),
  new ImplPhaseResultContract("task-impl", "TaskImplementationQualityIssueResult", "task-impl-quality-issue", "completed", "fdc7"),
  new ImplPhaseResultContract("task-impl", "StepErrorResult", "task-impl-error", "error", "fdc7"),
  new ImplPhaseResultContract("task-review", "TaskReviewExecutionRequiredResult", "task-review-execution-required", "loop-required", "9a58"),
  new ImplPhaseResultContract("task-review", "TaskReviewFindingsResult", "task-review-findings", "branch-required", "9a58"),
  new ImplPhaseResultContract("task-review", "TaskReviewGateRequiredResult", "task-review-gate-required", "completed", "9a58"),
  new ImplPhaseResultContract("task-review", "TaskReviewNoChangeCompletedResult", "task-review-no-change-completed", "completed", "9a58"),
  new ImplPhaseResultContract("task-review", "TaskReviewUnavailableResult", "task-review-unavailable", "completed", "9a58"),
  new ImplPhaseResultContract("task-review", "StepErrorResult", "task-review-error", "error", "9a58"),
  new ImplPhaseResultContract("task-triage", "TaskTriageFilterRequiredResult", "task-triage-filter-required", "user-input-required", "28a5"),
  new ImplPhaseResultContract("task-triage", "TaskTriageRepairRequiredResult", "task-triage-repair-required", "branch-required", "28a5"),
  new ImplPhaseResultContract("task-triage", "TaskTriageGateRequiredResult", "task-triage-gate-required", "completed", "28a5"),
  new ImplPhaseResultContract("task-triage", "TaskTriageNoChangeCompletedResult", "task-triage-no-change-completed", "completed", "28a5"),
  new ImplPhaseResultContract("task-triage", "TaskTriageCorrectionRequiredResult", "task-triage-correction-required", "loop-required", "28a5"),
  new ImplPhaseResultContract("task-triage", "TaskTriageUnreviewedGateResult", "task-triage-unreviewed-gate", "branch-required", "28a5"),
  new ImplPhaseResultContract("task-triage", "StepErrorResult", "task-triage-error", "error", "28a5"),
  new ImplPhaseResultContract("task-repair", "TaskRepairWorkerRequiredResult", "task-repair-worker-required", "loop-required", "cbd1"),
  new ImplPhaseResultContract("task-repair", "TaskRepairReviewRequiredResult", "task-repair-review-required", "loop-required", "cbd1"),
  new ImplPhaseResultContract("task-repair", "TaskRepairUnreviewedGateResult", "task-repair-unreviewed-gate", "branch-required", "cbd1"),
  new ImplPhaseResultContract("task-repair", "StepErrorResult", "task-repair-error", "error", "cbd1"),
  new ImplPhaseResultContract("task-gate", "TaskGateExecutionRequiredResult", "task-gate-execution-required", "loop-required", "54d4"),
  new ImplPhaseResultContract("task-gate", "TaskGatePassedResult", "task-gate-passed", "completed", "54d4"),
  new ImplPhaseResultContract("task-gate", "TaskGateRepairRequiredResult", "task-gate-repair-required", "loop-required", "54d4"),
  new ImplPhaseResultContract("task-gate", "TaskGateRetryRequiredResult", "task-gate-retry-required", "loop-required", "54d4"),
  new ImplPhaseResultContract("task-gate", "TaskGateDeferredResult", "task-gate-deferred", "branch-required", "54d4"),
  new ImplPhaseResultContract("task-gate", "TaskGateAwaitingDecisionResult", "task-gate-awaiting-decision", "user-input-required", "54d4"),
  new ImplPhaseResultContract("task-gate", "StepErrorResult", "task-gate-error", "error", "54d4"),
  new ImplPhaseResultContract("test-execute", "TestExecutionRequiredResult", "test-execute-execution-required", "loop-required", "fd3b"),
  new ImplPhaseResultContract("test-execute", "TestExecutionObservedResult", "test-execute-observed", "completed", "fd3b"),
  new ImplPhaseResultContract("test-execute", "StepErrorResult", "test-execute-error", "error", "fd3b"),
  new ImplPhaseResultContract("test-result-review", "TestEvidenceAcceptedResult", "test-result-review-evidence-accepted", "completed", "57ec"),
  new ImplPhaseResultContract("test-result-review", "TestEvidenceRejectedResult", "test-result-review-evidence-rejected", "loop-required", "57ec"),
  new ImplPhaseResultContract("test-result-review", "StepErrorResult", "test-result-review-error", "error", "57ec"),
  new ImplPhaseResultContract("impl-review", "ImplReviewExecutionRequiredResult", "impl-review-execution-required", "loop-required", "6167"),
  new ImplPhaseResultContract("impl-review", "ImplReviewPassedResult", "impl-review-passed", "completed", "6167"),
  new ImplPhaseResultContract("impl-review", "ImplReviewAdvisoryResult", "impl-review-advisory", "completed", "6167"),
  new ImplPhaseResultContract("impl-review", "ImplReviewRejectedResult", "impl-review-rejected", "branch-required", "6167"),
  new ImplPhaseResultContract("impl-review", "ImplReviewToolingResult", "impl-review-tooling", "user-input-required", "6167"),
  new ImplPhaseResultContract("impl-review", "StepErrorResult", "impl-review-error", "error", "6167"),
  new ImplPhaseResultContract("impl-triage", "ImplTriageWorkerRequiredResult", "impl-triage-worker-required", "loop-required", "5f3f"),
  new ImplPhaseResultContract("impl-triage", "ImplTriageRepairRequiredResult", "impl-triage-repair-required", "branch-required", "5f3f"),
  new ImplPhaseResultContract("impl-triage", "ImplTriageGateRequiredResult", "impl-triage-gate-required", "completed", "5f3f"),
  new ImplPhaseResultContract("impl-triage", "StepErrorResult", "impl-triage-error", "error", "5f3f"),
  new ImplPhaseResultContract("impl-repair", "ImplRepairWorkerRequiredResult", "impl-repair-worker-required", "loop-required", "8504"),
  new ImplPhaseResultContract("impl-repair", "ImplRepairAppliedResult", "impl-repair-applied", "loop-required", "8504"),
  new ImplPhaseResultContract("impl-repair", "ImplRepairQualityIssueResult", "impl-repair-quality-issue", "loop-required", "8504"),
  new ImplPhaseResultContract("impl-repair", "StepErrorResult", "impl-repair-error", "error", "8504"),
  new ImplPhaseResultContract("impl-gate", "ImplGateExecutionRequiredResult", "impl-gate-execution-required", "loop-required", "9eec"),
  new ImplPhaseResultContract("impl-gate", "ImplGatePassedResult", "impl-gate-passed", "completed", "9eec"),
  new ImplPhaseResultContract("impl-gate", "ImplGateEvidenceRefreshResult", "impl-gate-evidence-refresh", "loop-required", "9eec"),
  new ImplPhaseResultContract("impl-gate", "ImplGateSemanticFailureResult", "impl-gate-semantic-failure", "branch-required", "9eec"),
  new ImplPhaseResultContract("impl-gate", "ImplGateAwaitingDecisionResult", "impl-gate-awaiting-decision", "user-input-required", "9eec"),
  new ImplPhaseResultContract("impl-gate", "StepErrorResult", "impl-gate-error", "error", "9eec"),
]);

export function assertImplPhaseResult(result) {
  assert.ok(result instanceof StepResult, "production must return a typed StepResult");
  const contract = implPhaseResultContracts.find((entry) => entry.stepId === result.stepId && entry.kind === result.kind);
  assert.ok(contract, `unexpected implementation Result ${result.stepId}/${result.kind}`);
  return contract.assertResult(result);
}

/** The phase API follows the existing Draft/Spec/Prepare/Requirement-test
 * Result-only boundary. Its inputs never contain state, manager or extra facts.
 */
export function assertImplPhaseSettlementRoundtrip(result) {
  const leaf = futurePhaseManifests.find((entry) => entry.id === "03").leaves
    .find((entry) => entry.stepId === result.stepId);
  assert.ok(leaf, "a Result settlement must belong to the fixed implementation phase");
  const name = leaf.scope === "task" ? "settleTaskStepResult" : "settleImplStepResult";
  return assertPhaseSettlementRoundtrip(result, { name, missingCode: "IMPL_PHASE_SETTLEMENT_API_MISSING" });
}
