import assert from "node:assert/strict";
import test from "node:test";
import {
  DraftAwaitUserDecision,
  DraftBranchRoute,
  DraftExecutionSettlement,
  DraftLoopRoute,
  DraftNextRoute,
  DraftStepErrorDecision,
  settleDraftStepResult,
} from "../../src/flow/definition.js";
import * as results from "../../src/flow/engine/step-result.js";

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
    new results.DraftStepErrorResult("draft-gate", new Error("provider failed")),
  );
  assert.equal(failed instanceof DraftStepErrorDecision, true);
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
