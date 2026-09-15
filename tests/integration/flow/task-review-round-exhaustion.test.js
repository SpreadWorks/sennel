import assert from "node:assert/strict";
import { test } from "node:test";

import { container } from "../../../src/lib/container.js";
import { TaskReviewAccounting } from "../../../src/flow/lib/task-review-accounting.js";
import { TaskStageArtifact } from "../../../src/flow/lib/task-review-stage-artifacts.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { ReviewFindingCycle } from "../../../src/flow/lib/finding-disposition-policy.js";
import { TaskReviewConvergenceEvidence } from "../../../src/flow/lib/review-recurrence.js";

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

test("Task rejected no-change correction reaches Gate after the second bounded round", async (t) => {
  const scenario = new TaskReviewScenario(t, { noChange: true });
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());

  await scenario.publishReview([finding]);
  const firstFilter = await scenario.filter([]);
  assert.equal(firstFilter.ok, true, JSON.stringify(firstFilter));
  scenario.reload();
  assert.equal(scenario.state().current?.at(-1), "T-1-impl");
  assert.equal(scenario.state().findNode("T-1-review").status, "invalidated");

  scenario.confirmNoChangeImplementation();
  await scenario.publishReview([finding]);
  const secondFilter = await scenario.filter([]);
  assert.equal(secondFilter.ok, true, JSON.stringify(secondFilter));
  scenario.reload();

  const stopped = scenario.state();
  assert.equal(stopped.current?.at(-1), "T-1-gate");
  assert.equal(stopped.attempt.failure, null);
  assert.equal(stopped.nextAction().nodeId, "T-1-gate");
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
  const handoff = new TaskReviewConvergenceEvidence({
    flowManager: scenario.manager,
    state: stopped,
    cycle: ReviewFindingCycle.fromActivityLedger({ runId: stopped.runId, activities: scenario.manager.activityLedger(scenario.specId) }),
  }).handoffs().find((entry) => entry.taskId === scenario.taskId && entry.implementationNoChange === true);
  assert.ok(handoff);
  assert.equal(handoff.toJSON().hostFilter.repairFindingIds.length, 1);

  const beforeReload = scenario.snapshot();
  scenario.reload();
  assert.equal(scenario.snapshot(), beforeReload);
  assert.equal(scenario.state().nextAction().nodeId, "T-1-gate");
});
