import assert from "node:assert/strict";
import { test } from "node:test";

import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import {
  CanonicalCommandAttemptArtifactHistory,
  CanonicalCommandResultArtifact,
  attachCanonicalCommandResultArtifact,
} from "../../../src/flow/lib/canonical-command-result.js";
import { TaskReviewAccounting } from "../../../src/flow/lib/task-review-accounting.js";
import { TaskExecutionBudget } from "../../../src/flow/lib/task-execution-policy.js";

function reviewHistory(attempts) {
  return new CanonicalCommandAttemptArtifactHistory({
    logicalKey: "task.review",
    attempts: attempts.map((attempt) => ({
      attempt,
      artifact: { logicalKey: "task.review", payload: { verdict: "REJECTED", attempt } },
    })),
  });
}

function taskReviewResult() {
  return attachCanonicalCommandResultArtifact(
    { result: "ok", artifacts: { verdict: "REJECTED" } },
    new CanonicalCommandResultArtifact({
      logicalKey: "task.review",
      payload: { verdict: "REJECTED", blockingFindings: [] },
    }),
  );
}

test("Task Review accounting counts one cataloged result across tooling retry and reload", (t) => {
  const scenario = new TaskReviewScenario(t);
  const before = TaskReviewAccounting.fromCanonicalState({
    flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId,
  });
  assert.equal(before.completedReviewCount, 0);
  assert.equal(before.requireInflightReviewOrdinal(), 1);

  scenario.manager.failCurrentAttempt({ specId: scenario.specId, failure: {
    category: "tooling", retryKind: "tooling", retryable: true,
    code: "REVIEW_PROVIDER_UNAVAILABLE", message: "fixture pre-publication tooling stop",
  } });
  scenario.manager.retryCurrentAttempt({ specId: scenario.specId });
  const retried = TaskReviewAccounting.fromCanonicalState({
    flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId,
  });
  assert.equal(retried.completedReviewCount, 0);
  assert.equal(retried.requireInflightReviewOrdinal(), 1, "tooling retries do not consume a Review result");
  assert.ok(scenario.state().attempt.sequence > 1, "transport lifecycle advanced independently");
  scenario.manager.publishCurrentAttemptResult({ specId: scenario.specId, commandResult: taskReviewResult() });
  scenario.reload();

  const after = TaskReviewAccounting.fromCanonicalState({
    flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId,
  });
  assert.equal(after.completedReviewCount, 1, "the published review remains one semantic result");
  assert.equal(after.inflightReviewOrdinal, null, "a publication cannot be counted again as an inflight Review");
});

test("Task Review accounting bounds a round by its implementation budget, not sequence gaps", () => {
  const history = reviewHistory([2, 5, 9]);
  const secondRound = new TaskExecutionBudget({
    round: 2,
    reviewAttemptSequenceAtStart: 5,
    gateAttemptSequenceAtStart: 0,
  });
  const accounting = new TaskReviewAccounting({
    taskId: "T-1",
    budget: secondRound,
    history,
    activeAttempt: { id: "T-1-review-10", nodeId: "T-1-review", sequence: 10 },
  });
  assert.equal(accounting.completedReviewCount, 1);
  assert.equal(accounting.requireInflightReviewOrdinal(), 2);

  const closedFirstRound = new TaskReviewAccounting({
    taskId: "T-1",
    budget: new TaskExecutionBudget({
      round: 1,
      reviewAttemptSequenceAtStart: 0,
      gateAttemptSequenceAtStart: 0,
    }),
    history,
    roundEndAttemptSequence: 5,
  });
  assert.equal(closedFirstRound.completedReviewCount, 2, "a later round cannot inflate historical handoff accounting");
  assert.equal(closedFirstRound.completedOrdinalForSequence(5), 2);
  assert.equal(closedFirstRound.completedOrdinalForSequence(9), null);
});
