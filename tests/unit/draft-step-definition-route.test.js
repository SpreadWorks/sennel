import assert from "node:assert/strict";
import test from "node:test";
import {
  DraftAwaitUserDecision,
  DraftBranchRoute,
  DraftLoopRoute,
  DraftNextRoute,
  DraftStepErrorDecision,
  resolveDraftStepRoute,
} from "../../src/flow/definition.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../../src/flow/engine/step-output.js";

test("Definition routes every successful Draft Step output through the selected Connector", () => {
  const cases = [
    ["draft", "COMPLETED", DraftNextRoute, "draft-questions-review", "DraftReviewConnector"],
    ["draft-questions-review", "COMPLETED", DraftNextRoute, "draft-refine", "DraftRefineConnector"],
    ["draft-questions-review", "BRANCH_REQUIRED", DraftBranchRoute, "draft-questions-triage", "DraftTriageConnector"],
    ["draft-questions-triage", "COMPLETED", DraftNextRoute, "draft-questions-repair", "DraftRepairConnector"],
    ["draft-questions-repair", "COMPLETED", DraftNextRoute, "draft-refine", "DraftRefineConnector"],
    ["draft-questions-repair", "LOOP_REQUIRED", DraftLoopRoute, "draft-questions-review", "DraftReviewConnector"],
    ["draft-refine", "COMPLETED", DraftNextRoute, "draft-coverage-review", "DraftReviewConnector"],
    ["draft-refine", "LOOP_REQUIRED", DraftLoopRoute, "draft-refine", "DraftRefineConnector"],
    ["draft-gate-repair", "COMPLETED", DraftNextRoute, "draft-coverage-review", "DraftReviewConnector"],
    ["draft-coverage-review", "COMPLETED", DraftNextRoute, "draft-gate", "DraftCompletionConnector"],
    ["draft-coverage-review", "BRANCH_REQUIRED", DraftBranchRoute, "draft-coverage-triage", "DraftTriageConnector"],
    ["draft-coverage-triage", "COMPLETED", DraftNextRoute, "draft-coverage-repair", "DraftRepairConnector"],
    ["draft-coverage-repair", "COMPLETED", DraftNextRoute, "draft-gate", "DraftCompletionConnector"],
    ["draft-coverage-repair", "LOOP_REQUIRED", DraftLoopRoute, "draft-coverage-review", "DraftReviewConnector"],
    ["draft-gate", "COMPLETED", DraftNextRoute, "spec", "DraftSpecConnector"],
    ["draft-gate", "LOOP_REQUIRED", DraftLoopRoute, "draft-gate-repair", "PlanGateRepairConnector"],
  ];
  for (const [stepId, outputType, Route, targetStepId, connectorName] of cases) {
    const selected = resolveDraftStepRoute(stepId, new StepOutput(STEP_OUTPUT_TYPE[outputType]));
    assert.equal(selected instanceof Route, true, `${stepId} ${outputType}`);
    assert.equal(selected.sourceStepId, stepId);
    assert.equal(selected.targetStepId, targetStepId);
    assert.equal(selected.connector.name, connectorName);
  }
});

test("Definition keeps user input and Error at the current Draft Step", () => {
  const awaiting = resolveDraftStepRoute("draft-refine", new StepOutput(STEP_OUTPUT_TYPE.USER_INPUT_REQUIRED));
  assert.equal(awaiting instanceof DraftAwaitUserDecision, true);
  assert.equal(awaiting.stepId, "draft-refine");

  const error = new Error("provider failed");
  const failed = resolveDraftStepRoute("draft-gate", new StepOutput(error));
  assert.equal(failed instanceof DraftStepErrorDecision, true);
  assert.equal(failed.stepId, "draft-gate");
  assert.equal(failed.error.message, "provider failed");
});

test("Definition rejects an output that a Draft Step cannot produce", () => {
  assert.throws(() => resolveDraftStepRoute("draft", new StepOutput(STEP_OUTPUT_TYPE.LOOP_REQUIRED)), TypeError);
  assert.throws(() => resolveDraftStepRoute("draft-gate", new StepOutput(STEP_OUTPUT_TYPE.BRANCH_REQUIRED)), TypeError);
  assert.throws(() => resolveDraftStepRoute("draft-coverage-review", new StepOutput(STEP_OUTPUT_TYPE.USER_INPUT_REQUIRED)), TypeError);
  assert.throws(() => resolveDraftStepRoute("spec", new StepOutput(STEP_OUTPUT_TYPE.COMPLETED)), TypeError);
});
