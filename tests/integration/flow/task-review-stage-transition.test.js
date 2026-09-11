import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TaskNoChangeContinuationFacts,
  TaskReviewStageBinding,
  TaskReviewStageCompletionPlan,
  TaskReviewStageFacts,
  resolveTaskReviewStageCompletion,
  resolveTaskReviewStageTransition,
  selectTaskNoChangeContinuation,
} from "../../../src/flow/definition.js";
import { taskReviewStagePlanFromJSON } from "../../../src/flow/lib/task-review-stage-transition.js";

const DIGEST = "a".repeat(64);
const REVIEW_DIGEST = "b".repeat(64);

function binding(stage) {
  return new TaskReviewStageBinding({
    runId: "run-1", specId: "3182-review-funnel", taskId: "T-1", stage,
    attemptId: `attempt-${stage}`, attemptSequence: 3,
    sourceFingerprint: DIGEST, artifactDigest: REVIEW_DIGEST,
    catalogFingerprint: "c".repeat(64),
  });
}

function continuation(verdict = "PASS", triage = null) {
  return selectTaskNoChangeContinuation(new TaskNoChangeContinuationFacts({
    source: { fingerprint: DIGEST, allowList: [], reasons: ["The Task has no source paths."] },
    review: { verdict, canonical: true, artifactDigest: REVIEW_DIGEST, sourceFingerprint: DIGEST },
    triage,
    acceptance: { handoffId: "acceptance-1", reviewArtifactDigest: REVIEW_DIGEST, sourceFingerprint: DIGEST },
  }));
}

describe("Definition-owned Task Review stage transition", () => {
  it("routes canonical review results and consumes only the Review semantic budget", () => {
    const passed = resolveTaskReviewStageTransition(new TaskReviewStageFacts({
      binding: binding("review"), taskRound: 1, reviewResultCount: 1,
      verdict: "PASS", mustFixCount: 0,
    }));
    assert.equal(passed.operation, "review-to-gate");
    assert.equal(passed.targetStepId, "T-1-gate");
    assert.equal(passed.reviewBudgetConsumed, 1);
    assert.deepEqual(passed.effects.map(({ stepId, status }) => [stepId, status]), [
      ["T-1-review", "done"], ["T-1-triage", "skipped"], ["T-1-repair", "skipped"],
    ]);

    const rejected = resolveTaskReviewStageTransition(new TaskReviewStageFacts({
      binding: binding("review"), taskRound: 1, reviewResultCount: 1,
      verdict: "REJECTED", mustFixCount: 1,
    }));
    assert.equal(rejected.operation, "review-to-triage");
    assert.equal(rejected.targetStepId, "T-1-triage");
    assert.equal(rejected.reviewBudgetConsumed, 1);
  });

  it("requires Definition-selected continuation evidence for no-change completion", () => {
    assert.throws(() => new TaskReviewStageFacts({
      binding: binding("review"), taskRound: 1, reviewResultCount: 1,
      verdict: "PASS", mustFixCount: 0, sourceNoChange: true,
      noChangeContinuation: { eligible: true },
    }), /Definition selection/);
    assert.throws(() => continuation("PASS", {
      disposition: "all-reject", artifactDigest: "d".repeat(64),
      reviewArtifactDigest: REVIEW_DIGEST, sourceFingerprint: DIGEST,
    }), /must not invent triage/);

    const plan = resolveTaskReviewStageTransition(new TaskReviewStageFacts({
      binding: binding("review"), taskRound: 1, reviewResultCount: 1,
      verdict: "ADVISORY", mustFixCount: 0, sourceNoChange: true,
      noChangeContinuation: continuation("ADVISORY"),
    }));
    assert.equal(plan.operation, "review-no-change-complete");
    assert.equal(plan.targetStepId, null);
    assert.deepEqual(plan.effects.map(({ stepId, status }) => [stepId, status]), [
      ["T-1-review", "done"], ["T-1-triage", "skipped"],
      ["T-1-repair", "skipped"], ["T-1-gate", "skipped"],
    ]);
    assert.equal(taskReviewStagePlanFromJSON(plan.toJSON()).matches(plan), true);

    const rejectedReviewDigest = "d".repeat(64);
    const allReject = selectTaskNoChangeContinuation(new TaskNoChangeContinuationFacts({
      source: { fingerprint: DIGEST, allowList: [], reasons: ["All findings are already satisfied."] },
      review: { verdict: "REJECTED", canonical: true, artifactDigest: rejectedReviewDigest, sourceFingerprint: DIGEST },
      triage: { disposition: "all-reject", artifactDigest: REVIEW_DIGEST, reviewArtifactDigest: rejectedReviewDigest, sourceFingerprint: DIGEST },
      acceptance: { handoffId: "acceptance-triage", reviewArtifactDigest: rejectedReviewDigest, sourceFingerprint: DIGEST },
    }));
    const triagePlan = resolveTaskReviewStageTransition(new TaskReviewStageFacts({
      binding: binding("triage"), taskRound: 1, reviewResultCount: 1,
      verdict: "REJECTED", mustFixCount: 1, sourceNoChange: true,
      triageDisposition: "all-reject", sameReviewBinding: true,
      reason: "All findings are already satisfied.", noChangeContinuation: allReject,
    }));
    assert.equal(triagePlan.operation, "triage-no-change-complete");
    assert.equal(triagePlan.targetStepId, null);
  });

  it("bounds repair review episodes and carries the fourth repair to Gate", () => {
    const third = resolveTaskReviewStageTransition(new TaskReviewStageFacts({
      binding: binding("repair"), taskRound: 1, reviewResultCount: 3,
      verdict: "REJECTED", mustFixCount: 1, triageDisposition: "apply",
      repairChanged: true, sameReviewBinding: true,
    }));
    assert.equal(third.operation, "repair-to-review");
    assert.equal(third.targetStepId, "T-1-review");
    assert.equal(third.reviewBudgetConsumed, 0);

    assert.throws(() => resolveTaskReviewStageTransition(new TaskReviewStageFacts({
      binding: binding("repair"), taskRound: 1, reviewResultCount: 4,
      verdict: "REJECTED", mustFixCount: 1, triageDisposition: "apply",
      repairChanged: true, sameReviewBinding: true,
    })), /Acceptance handoff/);
    const fourth = resolveTaskReviewStageTransition(new TaskReviewStageFacts({
      binding: binding("repair"), taskRound: 1, reviewResultCount: 4,
      verdict: "REJECTED", mustFixCount: 1, triageDisposition: "apply",
      repairChanged: true, sameReviewBinding: true, acceptanceCarryForwardReady: true,
    }));
    assert.equal(fourth.operation, "repair-unreviewed-to-gate");
    assert.equal(fourth.acceptanceUnreviewed, true);
    assert.equal(fourth.targetStepId, "T-1-gate");
  });

  it("binds Task repair quality recovery to the same selected Review funnel transition", () => {
    for (const [reviewResultCount, acceptanceCarryForwardReady, expectedStep] of [
      [3, false, "T-1-review"],
      [4, true, "T-1-gate"],
    ]) {
      const completion = resolveTaskReviewStageCompletion({
        facts: new TaskReviewStageFacts({
          binding: binding("repair"), taskRound: 1, reviewResultCount,
          verdict: "REJECTED", mustFixCount: 1, triageDisposition: "apply",
          repairChanged: true, sameReviewBinding: true, acceptanceCarryForwardReady,
        }),
        sourceQualityIssueCount: 1,
      });
      assert.ok(completion instanceof TaskReviewStageCompletionPlan);
      assert.equal(completion.transition.targetStepId, expectedStep);
      assert.equal(completion.qualityRecovery.recoveryStep, expectedStep);
      assert.equal(completion.qualityRecovery.taskReviewStagePlan, completion.transition);
    }
  });

  it("allows one no-change correction round and then stops deterministically", () => {
    const common = {
      binding: binding("triage"), reviewResultCount: 1,
      verdict: "REJECTED", mustFixCount: 1, sourceNoChange: true,
      triageDisposition: "apply", sameReviewBinding: true, reason: "The finding requires source work.",
    };
    const first = resolveTaskReviewStageTransition(new TaskReviewStageFacts({ ...common, taskRound: 1 }));
    assert.equal(first.operation, "triage-no-change-correction");
    assert.equal(first.targetStepId, "T-1-impl");
    assert.deepEqual(first.effects.map((effect) => effect.status), Array(5).fill("invalidated"));

    const second = resolveTaskReviewStageTransition(new TaskReviewStageFacts({ ...common, taskRound: 2 }));
    assert.equal(second.operation, "task-rounds-exhausted");
    assert.equal(second.targetStepId, null);
    assert.equal(second.effects.length, 0);
    assert.match(second.terminalReason, /two-round/);
  });
});
