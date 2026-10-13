import assert from "node:assert/strict";
import test from "node:test";
import {
  DraftAwaitUserDecision,
  DraftBranchRoute,
  DraftExecutionSettlement,
  DraftLoopRoute,
  DraftNextRoute,
  StepErrorDecision,
  settleDraftStepResult,
  DraftStepErrorRecoveryReceipt,
} from "../../src/flow/definition.js";
import * as results from "../../src/flow/engine/step-result.js";

test("explicit Step Error recovery receipts cover exactly the ten registered Draft Steps", () => {
  const steps = results.STEP_RESULT_REGISTRY.filter((entry) => entry.type === "error"
    && entry.stepId.startsWith("draft")).map((entry) => entry.stepId);
  assert.equal(steps.length, 10);
  for (const stepId of steps) {
    const receipt = new DraftStepErrorRecoveryReceipt({
      binding: { runId: "run-recovery", specId: "001-draft-recovery", stepId,
        attemptId: `failed-${stepId}`, attemptSequence: 2 },
      failedActivityId: `failure-${stepId}`, failureReceiptId: `receipt-${stepId}`,
      reason: "Corrected the cause of this saved Step Error.",
    });
    assert.deepEqual(DraftStepErrorRecoveryReceipt.fromJSON(receipt.toJSON()).toJSON(), receipt.toJSON());
    assert.throws(() => DraftStepErrorRecoveryReceipt.fromJSON({ ...receipt.toJSON(), id: "another-receipt" }),
      /receipt identity is invalid/);
    assert.throws(() => new DraftStepErrorRecoveryReceipt({ ...receipt.toJSON(),
      binding: { ...receipt.binding, stepId: "spec" } }), /exact failure binding/);
    assert.throws(() => new DraftStepErrorRecoveryReceipt({ ...receipt.toJSON(), reason: " " }), /non-empty --reason/);
  }
});

test("Definition maps every target-connection Result through its selected Connector", () => {
  const cases = [
    ["DraftCreatedResult", DraftNextRoute, "draft-questions-review", "DraftReviewConnector"],
    ["DraftQuestionsReviewPassedResult", DraftNextRoute, "draft-refine", "DraftRefineConnector"],
    ["DraftQuestionsReviewFindingsResult", DraftBranchRoute, "draft-questions-triage", "DraftTriageConnector"],
    ["DraftQuestionsTriageCompletedResult", DraftNextRoute, "draft-questions-repair", "DraftRepairConnector"],
    ["DraftQuestionsRepairChangedResult", DraftLoopRoute, "draft-questions-review", "DraftReviewConnector"],
    ["DraftQuestionsRepairUnchangedResult", DraftNextRoute, "draft-refine", "DraftRefineConnector"],
    ["DraftRefineCompletedResult", DraftNextRoute, "draft-coverage-review", "DraftReviewConnector"],
    ["DraftCoverageReviewPassedResult", DraftNextRoute, "draft-gate", "DraftCompletionConnector"],
    ["DraftCoverageReviewFindingsResult", DraftBranchRoute, "draft-coverage-triage", "DraftTriageConnector"],
    ["DraftCoverageTriageCompletedResult", DraftNextRoute, "draft-coverage-repair", "DraftRepairConnector"],
    ["DraftCoverageRepairChangedResult", DraftLoopRoute, "draft-coverage-review", "DraftReviewConnector"],
    ["DraftCoverageRepairUnchangedResult", DraftNextRoute, "draft-gate", "DraftCompletionConnector"],
    ["DraftGateRepairRequiredResult", DraftLoopRoute, "draft-gate-repair", "PlanGateRepairConnector"],
    ["DraftGatePassedResult", DraftNextRoute, "spec", "DraftSpecConnector"],
    ["DraftGateCarryForwardResult", DraftNextRoute, "spec", "DraftSpecConnector"],
    ["DraftGateRepairAppliedResult", DraftNextRoute, "draft-coverage-review", "DraftReviewConnector"],
    ["DraftGateRepairCarryForwardResult", DraftNextRoute, "draft-coverage-review", "DraftReviewConnector"],
  ];
  for (const [name, SettlementClass, targetStepId, connectorName] of cases) {
    const result = new results[name]();
    const selected = settleDraftStepResult(result.stepId, result);
    assert.equal(selected instanceof SettlementClass, true, name);
    assert.equal(selected.targetStepId, targetStepId);
    assert.equal(selected.connector.name, connectorName);
    assert.equal(Object.hasOwn(selected, "application"), false);
  }
});

test("Definition reproduces completion settlements from reloaded Results without external facts", () => {
  for (const ResultClass of [
    results.DraftCoverageReviewPassedResult,
    results.DraftCoverageRepairUnchangedResult,
  ]) {
    const original = new ResultClass();
    const reloaded = results.StepResult.fromStored(original.stepId, JSON.parse(JSON.stringify(original)));
    const expected = settleDraftStepResult(original.stepId, original);
    const reproduced = settleDraftStepResult(reloaded.stepId, reloaded);
    assert.equal(reproduced.constructor, expected.constructor);
    assert.equal(reproduced.connector, expected.connector);
    assert.deepEqual(reproduced.toJSON(), expected.toJSON());
  }
});

test("Definition selects connector-free Execution, Await, and Failure settlements", () => {
  for (const name of [
    "DraftQuestionsReviewExecutionRequiredResult",
    "DraftRefineWorkerRequiredResult",
    "DraftCoverageReviewExecutionRequiredResult",
    "DraftGateRepairWorkerRequiredResult",
  ]) {
    const result = new results[name]();
    const selected = settleDraftStepResult(result.stepId, result);
    assert.equal(selected instanceof DraftExecutionSettlement, true, name);
    assert.equal(Object.hasOwn(selected, "connector"), false);
  }
  const awaiting = settleDraftStepResult("draft-refine", new results.DraftRefineAwaitingAnswerResult());
  assert.equal(awaiting instanceof DraftAwaitUserDecision, true);
  assert.equal(Object.hasOwn(awaiting, "connector"), false);

  const failed = settleDraftStepResult(
    "draft-gate",
    new results.StepErrorResult("draft-gate", new Error("provider failed")),
  );
  assert.equal(failed instanceof StepErrorDecision, true);
  assert.equal(Object.hasOwn(failed, "connector"), false);
});

test("Definition rejects a Result bound to another Step", () => {
  assert.throws(
    () => settleDraftStepResult("draft", new results.DraftGatePassedResult()),
    TypeError,
  );
  assert.throws(
    () => new DraftExecutionSettlement(new results.DraftCreatedResult()),
    /must be selected by Definition/,
  );
});

test("Draft refine route effects skip an unselected Gate repair without creating a Result", () => {
  const result = new results.DraftRefineCompletedResult();
  const selected = settleDraftStepResult(result.stepId, result);
  assert.deepEqual(selected.effects.skipStepIds, ["draft-gate-repair"]);
});
