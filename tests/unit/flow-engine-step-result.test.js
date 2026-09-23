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
    ["SpecCreatedResult", "spec", "spec-created", "completed"],
    ["SpecPlanGateRepairAppliedResult", "spec", "spec-plan-gate-repair-applied", "completed"],
    ["SpecPlanGateRepairNoProgressResult", "spec", "spec-plan-gate-repair-no-progress", "error"],
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
    ...[
      "draft", "spec", "spec-triage", "spec-repair", "spec-gate", "spec-review", "draft-questions-review", "draft-questions-triage", "draft-questions-repair", "draft-refine",
      "draft-coverage-review", "draft-coverage-triage", "draft-coverage-repair", "draft-gate", "draft-gate-repair",
    ].map((stepId) => ["StepErrorResult", stepId, `${stepId}-error`, "error"]),
  ];
  assert.throws(() => new StepResult(), /abstract/);
  assert.deepEqual(STEP_RESULT_REGISTRY.map(({ ResultClass, stepId, kind, type }) => (
    [ResultClass.name, stepId, kind, type]
  )), expected);
  assert.equal(new Set(STEP_RESULT_REGISTRY.map(({ kind }) => kind)).size, STEP_RESULT_REGISTRY.length);
  for (const { ResultClass, stepId, kind, type } of STEP_RESULT_REGISTRY) {
    if (ResultClass === StepErrorResult) continue;
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
