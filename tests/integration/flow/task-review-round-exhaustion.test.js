import assert from "node:assert/strict";
import { test } from "node:test";

import { container } from "../../../src/lib/container.js";
import { TaskReviewAccounting } from "../../../src/flow/lib/task-review-accounting.js";
import { TaskStageArtifact } from "../../../src/flow/lib/task-review-stage-artifacts.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";

const finding = {
  findingKey: "missing-behavior",
  title: "Required behavior is missing",
  failureMode: "spec_behavior_contradiction",
  file: "README.md",
  requirementId: "R-1",
  issue: "The implementation omits required behavior.",
  suggestion: "Implement the required behavior.",
  disposition: "must-fix",
  rationale: "The mapped requirement requires this behavior.",
};

function triageEffect() {
  return {
    version: 1,
    stepId: "task-triage",
    completionStatus: "done",
    issues: [],
    overview: null,
    triage: {
      version: 1,
      dispositions: [{
        findingKey: finding.findingKey,
        disposition: "apply",
        basis: "repair-required",
        rationale: "The requirement confirms this missing behavior.",
      }],
    },
    repair: null,
    noChangeReason: null,
  };
}

function completeTriage(scenario) {
  return scenario.completeHandoff(scenario.stageHandoff("triage"), triageEffect());
}

test("Task rejected no-change correction stops after the second bounded round", async (t) => {
  const scenario = new TaskReviewScenario(t, { noChange: true });
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());

  await scenario.publishReview([finding]);
  assert.equal(completeTriage(scenario).completed, true);
  scenario.reload();
  assert.equal(scenario.state().current?.at(-1), "T-1-impl");
  assert.equal(scenario.state().findNode("T-1-review").status, "invalidated");

  scenario.confirmNoChangeImplementation();
  await scenario.publishReview([finding]);
  assert.equal(completeTriage(scenario).completed, true);
  scenario.reload();

  const stopped = scenario.state();
  assert.equal(stopped.current?.at(-1), "T-1-triage");
  assert.equal(stopped.attempt.failure.code, "TASK_ROUNDS_EXHAUSTED");
  assert.equal(stopped.attempt.failure.retryable, false);
  assert.equal(stopped.failureDisposition().operation, "blocked");
  assert.equal(stopped.nextAction().operation, "blocked");
  const review = new TaskStageArtifact({
    flowManager: scenario.manager,
    state: stopped,
    taskId: scenario.taskId,
    role: "review",
  });
  const budget = scenario.manager.taskMutationLineages({
    specId: scenario.specId,
    taskId: scenario.taskId,
  }).at(-1).budget;
  assert.equal(new TaskReviewAccounting({ taskId: scenario.taskId, budget, history: review.history }).completedReviewCount, 1);

  const beforeReload = scenario.snapshot();
  scenario.reload();
  assert.equal(scenario.snapshot(), beforeReload);
  assert.equal(scenario.state().nextAction().operation, "blocked");
});
