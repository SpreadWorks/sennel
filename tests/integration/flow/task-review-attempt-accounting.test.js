import assert from "node:assert/strict";
import { test } from "node:test";

import { CanonicalCommandAttemptArtifactHistory } from "../../../src/flow/lib/canonical-command-result.js";
import {
  completedTaskReviewAttemptCount,
  currentTaskReviewAttemptCount,
  taskReviewAttemptNumber,
} from "../../../src/flow/lib/task-review-attempt-accounting.js";
import { TaskExecutionBudget } from "../../../src/flow/lib/task-execution-policy.js";

function history(...attempts) {
  return new CanonicalCommandAttemptArtifactHistory({
    logicalKey: "task.review",
    attempts: attempts.map((attempt) => ({
      attempt,
      artifact: { logicalKey: "task.review", payload: { verdict: "REJECTED" } },
    })),
  });
}

test("tooling retries do not consume Task Review semantic attempts", () => {
  const attempt = { consumption: { semantic: 1, tooling: 7 } };

  assert.equal(currentTaskReviewAttemptCount({ attempt }), 1);
  assert.equal(currentTaskReviewAttemptCount({ attempt, includesCurrentResult: true }), 2);
});

test("cataloged Task Review results are numbered without Attempt sequence gaps", () => {
  const reviewHistory = history(1, 5, 8);
  const budget = new TaskExecutionBudget({
    round: 1,
    reviewAttemptSequenceAtStart: 0,
    gateAttemptSequenceAtStart: 0,
  });

  assert.equal(completedTaskReviewAttemptCount({ history: reviewHistory, budget }), 3);
  assert.equal(taskReviewAttemptNumber({ history: reviewHistory, budget, attemptSequence: 5 }), 2);
  assert.equal(taskReviewAttemptNumber({ history: reviewHistory, budget, attemptSequence: 8 }), 3);
});

test("Task Review numbering starts again at the current Task execution round", () => {
  const reviewHistory = history(1, 5, 8);
  const budget = new TaskExecutionBudget({
    round: 2,
    reviewAttemptSequenceAtStart: 5,
    gateAttemptSequenceAtStart: 0,
  });

  assert.equal(completedTaskReviewAttemptCount({ history: reviewHistory, budget }), 1);
  assert.equal(taskReviewAttemptNumber({ history: reviewHistory, budget, attemptSequence: 8 }), 1);
});
