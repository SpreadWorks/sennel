import assert from "node:assert/strict";
import test from "node:test";
import { FlowExecutionError } from "../../src/flow/engine/flow-execution-error.js";
import {
  STEP_RESULT_REGISTRY,
  DraftCreatedResult,
  DraftGatePassedResult,
  SpecCreatedResult,
  SpecReviewPassedResult,
  StepErrorResult,
  STEP_RESULT_TYPE,
  StepResult,
  rehydrateStepResult,
  stepResultDigest,
} from "../../src/flow/engine/step-result.js";
import { Step } from "../../src/flow/engine/step.js";

test("StepResult is abstract and every concrete Result has one unique fixed contract", () => {
  const expected = [
    ["DraftCreatedResult", "draft", "draft-created", "completed"],
    ["BranchPreparedResult", "branch", "branch-prepared", "completed"],
    ["BranchNotRequiredResult", "branch", "branch-not-required", "completed"],
    ["PrepareSpecReadyResult", "prepare-spec", "prepare-spec-ready", "completed"],
    ["SpecCreatedResult", "spec", "spec-created", "completed"],
    ["SpecGateRepairReadyForGateResult", "spec-gate-repair", "spec-gate-repair-ready-for-gate", "completed"],
    ["SpecGateRepairReviewRequiredResult", "spec-gate-repair", "spec-gate-repair-review-required", "completed"],
    ["SpecGateRepairContextRequiredResult", "spec-gate-repair", "spec-gate-repair-context-required", "loop-required"],
    ["SpecGateRepairDraftReturnRequiredResult", "spec-gate-repair", "spec-gate-repair-draft-return-required", "loop-required"],
    ["SpecGateRepairNoProgressResult", "spec-gate-repair", "spec-gate-repair-no-progress", "error"],
    ["SpecTriageCompletedResult", "spec-triage", "spec-triage-completed", "completed"],
    ["SpecRepairChangedResult", "spec-repair", "spec-repair-changed", "completed"],
    ["SpecRepairUnchangedResult", "spec-repair", "spec-repair-unchanged", "completed"],
    ["SpecGatePassedResult", "spec-gate", "spec-gate-passed", "completed"],
    ["SpecGateRepairRequiredResult", "spec-gate", "spec-gate-repair-required", "loop-required"],
    ["SpecGateRetryRequiredResult", "spec-gate", "spec-gate-retry-required", "loop-required"],
    ["SpecGateDeferredResult", "spec-gate", "spec-gate-deferred", "completed"],
    ["SpecGateAwaitingDecisionResult", "spec-gate", "spec-gate-awaiting-decision", "user-input-required"],
    ["SpecGateRecoveredResult", "spec-gate", "spec-gate-recovered", "loop-required"],
    ["TaskSpecGatePassedResult", "spec-gate", "task-spec-gate-passed", "completed"],
    ["TaskSpecGateRepairRequiredResult", "spec-gate", "task-spec-gate-repair-required", "loop-required"],
    ["TaskSpecGateRetryRequiredResult", "spec-gate", "task-spec-gate-retry-required", "loop-required"],
    ["TaskSpecGateDeferredResult", "spec-gate", "task-spec-gate-deferred", "completed"],
    ["TaskSpecGateAwaitingDecisionResult", "spec-gate", "task-spec-gate-awaiting-decision", "user-input-required"],
    ["TaskSpecGateRecoveredResult", "spec-gate", "task-spec-gate-recovered", "loop-required"],
    ["SpecGateBlockedResult", "spec-gate", "spec-gate-blocked", "error"],
    ["TaskSpecGateBlockedResult", "spec-gate", "task-spec-gate-blocked", "error"],
    ["SpecReviewExecutionRequiredResult", "spec-review", "spec-review-execution-required", "loop-required"],
    ["SpecReviewPassedResult", "spec-review", "spec-review-passed", "completed"],
    ["SpecReviewAdvisoryResult", "spec-review", "spec-review-advisory", "completed"],
    ["SpecReviewRejectedResult", "spec-review", "spec-review-rejected", "completed"],
    ["DraftQuestionsReviewExecutionRequiredResult", "draft-questions-review", "draft-questions-review-execution-required", "loop-required"],
    ["DraftQuestionsReviewPassedResult", "draft-questions-review", "draft-questions-review-passed", "completed"],
    ["DraftQuestionsReviewFindingsResult", "draft-questions-review", "draft-questions-review-findings", "branch-required"],
    ["DraftQuestionsTriageCompletedResult", "draft-questions-triage", "draft-questions-triage-completed", "completed"],
    ["DraftQuestionsRepairChangedResult", "draft-questions-repair", "draft-questions-repair-changed", "loop-required"],
    ["DraftQuestionsRepairUnchangedResult", "draft-questions-repair", "draft-questions-repair-unchanged", "completed"],
    ["DraftRefineWorkerRequiredResult", "draft-refine", "draft-refine-worker-required", "loop-required"],
    ["DraftRefineAwaitingAnswerResult", "draft-refine", "draft-refine-awaiting-answer", "user-input-required"],
    ["DraftRefineCompletedResult", "draft-refine", "draft-refine-completed", "completed"],
    ["DraftCoverageReviewExecutionRequiredResult", "draft-coverage-review", "draft-coverage-review-execution-required", "loop-required"],
    ["DraftCoverageReviewPassedResult", "draft-coverage-review", "draft-coverage-review-passed", "completed"],
    ["DraftCoverageReviewFindingsResult", "draft-coverage-review", "draft-coverage-review-findings", "branch-required"],
    ["DraftCoverageTriageCompletedResult", "draft-coverage-triage", "draft-coverage-triage-completed", "completed"],
    ["DraftCoverageRepairChangedResult", "draft-coverage-repair", "draft-coverage-repair-changed", "loop-required"],
    ["DraftCoverageRepairUnchangedResult", "draft-coverage-repair", "draft-coverage-repair-unchanged", "completed"],
    ["DraftGatePassedResult", "draft-gate", "draft-gate-passed", "completed"],
    ["DraftGateCarryForwardResult", "draft-gate", "draft-gate-carry-forward", "completed"],
    ["DraftGateRepairRequiredResult", "draft-gate", "draft-gate-repair-required", "loop-required"],
    ["DraftGateRepairWorkerRequiredResult", "draft-gate-repair", "draft-gate-repair-worker-required", "loop-required"],
    ["DraftGateRepairAppliedResult", "draft-gate-repair", "draft-gate-repair-applied", "completed"],
    ["DraftGateRepairCarryForwardResult", "draft-gate-repair", "draft-gate-repair-carry-forward", "completed"],
    ["ApprovalAwaitingUserResult", "approval", "approval-awaiting-user", "user-input-required"],
    ["ApprovalConfirmedWithTestsResult", "approval", "approval-confirmed-with-tests", "completed"],
    ["ApprovalConfirmedWithoutTestsResult", "approval", "approval-confirmed-without-tests", "completed"],
    ["TestGenerateCandidateSavedResult", "test-generate", "test-generate-candidate-saved", "completed"],
    ["TestGenerateStructuralRejectedResult", "test-generate", "test-generate-structural-rejected", "branch-required"],
    ["TestRepairProgressSavedResult", "test-repair", "test-repair-progress-saved", "loop-required"],
    ["TestRepairCandidateSavedResult", "test-repair", "test-repair-candidate-saved", "completed"],
    ["TestRepairStructuralRejectedResult", "test-repair", "test-repair-structural-rejected", "branch-required"],
    ["TestReviewExecutionRequiredResult", "test-review", "test-review-execution-required", "loop-required"],
    ["TestReviewPassedResult", "test-review", "test-review-passed", "completed"],
    ["TestReviewAdvisoryResult", "test-review", "test-review-advisory", "completed"],
    ["TestReviewRejectedResult", "test-review", "test-review-rejected", "branch-required"],
    ["TestGateCompatibleResult", "test-gate", "test-gate-compatible", "completed"],
    ["TestGateIncompatibleResult", "test-gate", "test-gate-incompatible", "branch-required"],
    ["TestGenerateToolingUnavailableResult", "test-generate", "test-generate-tooling-unavailable", "loop-required"],
    ["TestReviewToolingUnavailableResult", "test-review", "test-review-tooling-unavailable", "loop-required"],
    ["TestRepairToolingUnavailableResult", "test-repair", "test-repair-tooling-unavailable", "loop-required"],
    ["TestGateToolingUnavailableResult", "test-gate", "test-gate-tooling-unavailable", "loop-required"],
    ["TestGenerateExternalBlockedResult", "test-generate", "test-generate-external-blocked", "error"],
    ["TestReviewExternalBlockedResult", "test-review", "test-review-external-blocked", "error"],
    ["TestRepairExternalBlockedResult", "test-repair", "test-repair-external-blocked", "error"],
    ["ImplementWorkerRequiredResult", "implement", "implement-worker-required", "loop-required"],
    ["ImplementAppliedResult", "implement", "implement-applied", "completed"],
    ["ImplementExistingCompletionResult", "implement", "implement-existing-completion", "completed"],
    ["ImplementQualityIssueResult", "implement", "implement-quality-issue", "completed"],
    ["TaskImplementationWorkerRequiredResult", "task-impl", "task-impl-worker-required", "loop-required"],
    ["TaskImplementationAppliedResult", "task-impl", "task-impl-applied", "completed"],
    ["TaskImplementationNoChangeResult", "task-impl", "task-impl-no-change", "completed"],
    ["TaskImplementationQualityIssueResult", "task-impl", "task-impl-quality-issue", "completed"],
    ["TaskReviewExecutionRequiredResult", "task-review", "task-review-execution-required", "loop-required"],
    ["TaskReviewFindingsResult", "task-review", "task-review-findings", "branch-required"],
    ["TaskReviewGateRequiredResult", "task-review", "task-review-gate-required", "completed"],
    ["TaskReviewNoChangeCompletedResult", "task-review", "task-review-no-change-completed", "completed"],
    ["TaskReviewUnavailableResult", "task-review", "task-review-unavailable", "completed"],
    ["TaskTriageFilterRequiredResult", "task-triage", "task-triage-filter-required", "user-input-required"],
    ["TaskTriageRepairRequiredResult", "task-triage", "task-triage-repair-required", "branch-required"],
    ["TaskTriageGateRequiredResult", "task-triage", "task-triage-gate-required", "completed"],
    ["TaskTriageNoChangeCompletedResult", "task-triage", "task-triage-no-change-completed", "completed"],
    ["TaskTriageCorrectionRequiredResult", "task-triage", "task-triage-correction-required", "loop-required"],
    ["TaskTriageUnreviewedGateResult", "task-triage", "task-triage-unreviewed-gate", "branch-required"],
    ["TaskRepairWorkerRequiredResult", "task-repair", "task-repair-worker-required", "loop-required"],
    ["TaskRepairReviewRequiredResult", "task-repair", "task-repair-review-required", "loop-required"],
    ["TaskRepairUnreviewedGateResult", "task-repair", "task-repair-unreviewed-gate", "branch-required"],
    ["TaskGateExecutionRequiredResult", "task-gate", "task-gate-execution-required", "loop-required"],
    ["TaskGatePassedResult", "task-gate", "task-gate-passed", "completed"],
    ["TaskGateRepairRequiredResult", "task-gate", "task-gate-repair-required", "loop-required"],
    ["TaskGateRetryRequiredResult", "task-gate", "task-gate-retry-required", "loop-required"],
    ["TaskGateDeferredResult", "task-gate", "task-gate-deferred", "branch-required"],
    ["TaskGateAwaitingDecisionResult", "task-gate", "task-gate-awaiting-decision", "user-input-required"],
    ["TestExecutionRequiredResult", "test-execute", "test-execute-execution-required", "loop-required"],
    ["TestExecutionObservedResult", "test-execute", "test-execute-observed", "completed"],
    ["TestEvidenceAcceptedResult", "test-result-review", "test-result-review-evidence-accepted", "completed"],
    ["TestEvidenceRejectedResult", "test-result-review", "test-result-review-evidence-rejected", "loop-required"],
    ["ImplReviewExecutionRequiredResult", "impl-review", "impl-review-execution-required", "loop-required"],
    ["ImplReviewPassedResult", "impl-review", "impl-review-passed", "completed"],
    ["ImplReviewAdvisoryResult", "impl-review", "impl-review-advisory", "completed"],
    ["ImplReviewRejectedResult", "impl-review", "impl-review-rejected", "branch-required"],
    ["ImplReviewToolingResult", "impl-review", "impl-review-tooling", "user-input-required"],
    ["ImplTriageWorkerRequiredResult", "impl-triage", "impl-triage-worker-required", "loop-required"],
    ["ImplTriageRepairRequiredResult", "impl-triage", "impl-triage-repair-required", "branch-required"],
    ["ImplTriageGateRequiredResult", "impl-triage", "impl-triage-gate-required", "completed"],
    ["ImplRepairWorkerRequiredResult", "impl-repair", "impl-repair-worker-required", "loop-required"],
    ["ImplRepairAppliedResult", "impl-repair", "impl-repair-applied", "loop-required"],
    ["ImplRepairQualityIssueResult", "impl-repair", "impl-repair-quality-issue", "loop-required"],
    ["ImplGateExecutionRequiredResult", "impl-gate", "impl-gate-execution-required", "loop-required"],
    ["ImplGatePassedResult", "impl-gate", "impl-gate-passed", "completed"],
    ["ImplGateEvidenceRefreshResult", "impl-gate", "impl-gate-evidence-refresh", "loop-required"],
    ["ImplGateSemanticFailureResult", "impl-gate", "impl-gate-semantic-failure", "branch-required"],
    ["ImplGateAwaitingDecisionResult", "impl-gate", "impl-gate-awaiting-decision", "user-input-required"],
    ...[
      "draft", "branch", "prepare-spec", "spec", "spec-gate-repair", "spec-triage", "spec-repair", "spec-gate", "spec-review", "draft-questions-review", "draft-questions-triage", "draft-questions-repair", "draft-refine",
      "draft-coverage-review", "draft-coverage-triage", "draft-coverage-repair", "draft-gate", "draft-gate-repair", "approval", "test-generate", "test-repair", "test-review", "test-gate",
      "implement", "task-impl", "task-review", "task-triage", "task-repair", "task-gate", "test-execute", "test-result-review", "impl-review", "impl-triage", "impl-repair", "impl-gate",
    ].map((stepId) => ["StepErrorResult", stepId, `${stepId}-error`, "error"]),
  ];
  assert.throws(() => new StepResult(), /abstract/);
  assert.deepEqual(STEP_RESULT_REGISTRY.map(({ ResultClass, stepId, kind, type }) => (
    [ResultClass.name, stepId, kind, type]
  )), expected);
  assert.equal(new Set(STEP_RESULT_REGISTRY.map(({ kind }) => kind)).size, STEP_RESULT_REGISTRY.length);
  for (const { ResultClass, stepId, kind, type, operands } of STEP_RESULT_REGISTRY) {
    if (ResultClass === StepErrorResult) continue;
    if (operands !== undefined) continue;
    const result = type === "error" ? new ResultClass(new Error("test")) : new ResultClass();
    assert.equal(result.stepId, stepId);
    assert.equal(result.kind, kind);
    assert.equal(result.type, type);
    assert.equal(rehydrateStepResult(stepId, result.toJSON()) instanceof ResultClass, true, kind);
  }
});

test("StepResult readback rejects unknown kind, mismatched type, and wrong Step", () => {
  const stored = new DraftGatePassedResult().toJSON();
  assert.throws(() => rehydrateStepResult("draft-gate", { ...stored, kind: "unknown" }), TypeError);
  assert.throws(() => rehydrateStepResult("draft-gate", { ...stored, type: STEP_RESULT_TYPE.LOOP_REQUIRED }), TypeError);
  assert.throws(() => rehydrateStepResult("draft", stored), TypeError);
  assert.equal(
    rehydrateStepResult("spec", new SpecCreatedResult().toJSON()) instanceof SpecCreatedResult,
    true,
  );
  assert.throws(() => rehydrateStepResult("spec-review", new SpecCreatedResult().toJSON()), TypeError);
  assert.equal(rehydrateStepResult("spec-review", new SpecReviewPassedResult().toJSON())
    instanceof SpecReviewPassedResult, true);
  assert.equal(rehydrateStepResult("spec-review", new StepErrorResult("spec-review", new Error("semantic failure")).toJSON())
    instanceof StepErrorResult, true);
});

test("stepResultDigest accepts only a concrete StepResult", () => {
  assert.match(stepResultDigest(new DraftGatePassedResult()), /^[a-f0-9]{64}$/);
  assert.throws(() => stepResultDigest({ toJSON() { return {}; } }), TypeError);
});

test("StepErrorResult preserves generic code/data and Flow error identity on readback", () => {
  const generic = new Error("provider failed");
  generic.code = "PROVIDER_DOWN";
  generic.data = { provider: "test", retryAfter: 5 };
  const restored = rehydrateStepResult(
    "draft-refine",
    new StepErrorResult("draft-refine", generic).toJSON(),
  );
  assert.equal(restored instanceof StepErrorResult, true);
  assert.equal(restored.error.code, "PROVIDER_DOWN");
  assert.deepEqual(restored.error.data, { provider: "test", retryAfter: 5 });

  const mutable = { nested: { retryAfter: 5 } };
  const immutable = new StepErrorResult("draft-refine", Object.assign(new Error("immutable"), {
    data: mutable,
  }));
  mutable.nested.retryAfter = 10;
  assert.equal(immutable.error.data.nested.retryAfter, 5);
  assert.throws(() => { immutable.error.data.nested.retryAfter = 20; }, TypeError);

  const flow = new FlowExecutionError({
    code: "STEP_TIMEOUT",
    message: "timed out",
    runId: "run-7",
    stepId: "draft-refine",
    attemptId: "attempt-2",
  });
  const restoredFlow = StepResult.fromStored(
    "draft-refine",
    new StepErrorResult("draft-refine", flow).toJSON(),
  );
  assert.equal(restoredFlow.error instanceof FlowExecutionError, true);
  assert.equal(restoredFlow.error.code, "STEP_TIMEOUT");
});

test("Result.persist resolves only after the service returns its durable receipt", async () => {
  const expected = Object.freeze({ id: "receipt-1" });
  const calls = [];
  const result = new DraftCreatedResult();
  const receipt = await result.persist({
    async persistStepResult(candidate) {
      calls.push(candidate);
      return expected;
    },
  });
  assert.equal(receipt, expected);
  assert.deepEqual(calls, [result]);
});

test("Step.execute accepts only a concrete StepResult boundary", async () => {
  class ValidStep extends Step { async _execute() { return new DraftCreatedResult(); } }
  class InvalidStep extends Step { async _execute() { return { kind: "draft-created" }; } }
  assert.equal(await new ValidStep().execute() instanceof DraftCreatedResult, true);
  await assert.rejects(() => new InvalidStep().execute(), /must return a StepResult/);
});

test("Step.execute starts its asynchronous operation immediately and waits for acknowledgement", async (t) => {
  let started = false;
  let acknowledged = false;
  let release;
  const acknowledgement = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  class AcknowledgedStep extends Step {
    async _execute() {
      started = true;
      await acknowledgement;
      acknowledged = true;
      return new DraftCreatedResult();
    }
  }
  const execution = new AcknowledgedStep().execute();
  assert.equal(started, true, "synchronous callers must observe the operation's immediate prefix");
  assert.equal(acknowledged, false, "execution must not complete before its acknowledgement");
  assert.ok(execution instanceof Promise);
  release();
  assert.ok(await execution instanceof DraftCreatedResult);
  assert.equal(acknowledged, true);
});
