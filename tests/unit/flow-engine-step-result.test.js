import assert from "node:assert/strict";
import test from "node:test";
import { FlowExecutionError } from "../../src/flow/engine/flow-execution-error.js";
import {
  DRAFT_STEP_RESULT_REGISTRY,
  DraftCreatedResult,
  DraftGatePassedResult,
  DraftStepErrorResult,
  STEP_RESULT_TYPE,
  StepResult,
  rehydrateStepResult,
  stepResultDigest,
} from "../../src/flow/engine/step-result.js";
import { Step } from "../../src/flow/engine/step.js";

test("StepResult is abstract and every concrete Draft Result has one unique fixed contract", () => {
  const expected = [
    ["DraftCreatedResult", "draft", "draft-created", "completed"],
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
      "draft", "draft-questions-review", "draft-questions-triage", "draft-questions-repair", "draft-refine",
      "draft-coverage-review", "draft-coverage-triage", "draft-coverage-repair", "draft-gate", "draft-gate-repair",
    ].map((stepId) => ["DraftStepErrorResult", stepId, `${stepId}-error`, "error"]),
  ];
  assert.throws(() => new StepResult(), /abstract/);
  assert.deepEqual(DRAFT_STEP_RESULT_REGISTRY.map(({ ResultClass, stepId, kind, type }) => (
    [ResultClass.name, stepId, kind, type]
  )), expected);
  assert.equal(new Set(DRAFT_STEP_RESULT_REGISTRY.map(({ kind }) => kind)).size, DRAFT_STEP_RESULT_REGISTRY.length);
  for (const { ResultClass, stepId, kind, type } of DRAFT_STEP_RESULT_REGISTRY) {
    if (ResultClass === DraftStepErrorResult) continue;
    const result = new ResultClass();
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
});

test("stepResultDigest accepts only a concrete StepResult", () => {
  assert.match(stepResultDigest(new DraftGatePassedResult()), /^[a-f0-9]{64}$/);
  assert.throws(() => stepResultDigest({ toJSON() { return {}; } }), TypeError);
});

test("DraftStepErrorResult preserves generic code/data and Flow error identity on readback", () => {
  const generic = new Error("provider failed");
  generic.code = "PROVIDER_DOWN";
  generic.data = { provider: "test", retryAfter: 5 };
  const restored = rehydrateStepResult(
    "draft-refine",
    new DraftStepErrorResult("draft-refine", generic).toJSON(),
  );
  assert.equal(restored instanceof DraftStepErrorResult, true);
  assert.equal(restored.error.code, "PROVIDER_DOWN");
  assert.deepEqual(restored.error.data, { provider: "test", retryAfter: 5 });

  const mutable = { nested: { retryAfter: 5 } };
  const immutable = new DraftStepErrorResult("draft-refine", Object.assign(new Error("immutable"), {
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
    new DraftStepErrorResult("draft-refine", flow).toJSON(),
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
