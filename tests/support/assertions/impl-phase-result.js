import assert from "node:assert/strict";
import { STEP_RESULT_REGISTRY, STEP_RESULT_TYPE, StepResult, rehydrateStepResult, stepResultDigest } from "../../../src/flow/engine/step-result.js";
import * as definition from "../../../src/flow/definition.js";
import { StepConnector } from "../../../src/flow/engine/step-connector.js";
import { futurePhaseManifests } from "../structure/phase-manifest.js";

/** Expected semantic contracts from the board's frozen leaf designs.
 * These values inspect the single production registry; they never register or
 * implement a Result, select a route or provide substitute production output.
 */
export class ImplPhaseResultContract {
  constructor(stepId, className, kind, type, sourceBoard) {
    if ([stepId, className, kind, sourceBoard].some((value) => typeof value !== "string" || !value)
      || !Object.values(STEP_RESULT_TYPE).includes(type)) throw new TypeError("invalid implementation Result contract");
    Object.assign(this, { stepId, className, kind, type, sourceBoard });
    Object.freeze(this);
  }

  registration() {
    const entries = STEP_RESULT_REGISTRY.filter((entry) => entry.kind === this.kind);
    assert.equal(entries.length, 1,
      `IMPL_PHASE_RESULT_CONTRACT_MISSING: ${this.stepId} requires exactly one ${this.kind} in STEP_RESULT_REGISTRY (board ${this.sourceBoard})`);
    const entry = entries[0];
    assert.equal(entry.stepId, this.stepId);
    assert.equal(entry.type, this.type);
    assert.equal(entry.ResultClass.name, this.className);
    assert.ok(StepResult.prototype.isPrototypeOf(entry.ResultClass.prototype));
    return entry;
  }

  assertResult(result) {
    const entry = this.registration();
    assert.ok(result instanceof StepResult, "readback must expose a concrete StepResult");
    assert.equal(result.constructor, entry.ResultClass);
    assert.equal(result.stepId, this.stepId);
    assert.equal(result.kind, this.kind);
    assert.equal(result.type, this.type);
    const stored = result.toJSON();
    const restored = rehydrateStepResult(this.stepId, stored);
    assert.equal(restored.constructor, entry.ResultClass);
    assert.deepEqual(restored.toJSON(), stored);
    for (const field of ["target", "effects", "connector", "ctx", "manager", "payload"]) {
      assert.equal(Object.hasOwn(stored, field), false, `Result must not store ${field}`);
    }
    const anotherType = this.type === "completed" ? "loop-required" : "completed";
    assert.throws(() => rehydrateStepResult(this.stepId, { ...stored, type: anotherType }), TypeError);
    assert.throws(() => rehydrateStepResult(this.stepId, { ...stored, kind: "unknown-implementation-result" }), TypeError);
    return restored;
  }
}

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
  assert.equal(typeof definition[name], "function", `IMPL_PHASE_SETTLEMENT_API_MISSING: ${name}`);
  const stored = result.toJSON();
  const restored = rehydrateStepResult(result.stepId, stored);
  const digest = stepResultDigest(restored);
  const selected = definition[name](result.stepId, restored);
  assert.ok(selected instanceof definition.StepSettlement);
  assert.equal(selected.sourceStepId, result.stepId);
  assert.equal(selected.resultKind, result.kind);
  assert.equal(selected.resultType, result.type);
  assert.equal(Object.hasOwn(selected, "facts"), false, "Result-only selection must not retain arbitrary facts");
  const repeated = definition[name](result.stepId, rehydrateStepResult(result.stepId, stored));
  assert.equal(repeated.constructor, selected.constructor);
  assert.deepEqual(repeated.toJSON(), selected.toJSON());
  assert.equal(stepResultDigest(restored), digest, "settlement selection cannot mutate its persisted Result");
  if (selected.kind === "target-connection") {
    assert.ok(selected instanceof definition.StepRoute);
    assert.ok(selected.connector.prototype instanceof StepConnector);
    assert.equal(repeated.connector, selected.connector, "restored Result must select the exact same Connector class");
  } else {
    assert.ok(["execution", "await", "failure"].includes(selected.kind));
    assert.equal("connector" in selected, false);
    assert.equal("targetStepId" in selected, false);
  }
  return selected;
}
