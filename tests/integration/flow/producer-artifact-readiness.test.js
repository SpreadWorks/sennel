import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MissingProducerArtifactRecoveryAdmission,
  ProducerArtifactReadiness,
  producerArtifactReadiness,
  producerArtifactReadinessesForProducer,
} from "../../../src/flow/lib/producer-artifact-readiness.js";

function state({ sequence, current = null, attempt = null } = {}) {
  return {
    current,
    attempt,
    findNode: (nodeId) => nodeId === "spec-review" ? { id: nodeId, attemptSequence: sequence } : null,
  };
}

function typedTaskStageSnapshot({ producerRole, consumerRole }) {
  const taskId = "task-17";
  const producerNodeId = `${taskId}-${producerRole}`;
  const attemptId = `${producerRole}-attempt-1`;
  const readiness = producerArtifactReadiness({ producerNodeId, consumerNodeId: `${taskId}-${consumerRole}` });
  return {
    readiness,
    snapshot: {
      state: {
        current: null,
        attempt: null,
        tasks: [{ id: taskId, steps: [
          { id: `${taskId}-review` }, { id: `${taskId}-triage` }, { id: `${taskId}-repair` }, { id: `${taskId}-gate` },
        ] }],
        findNode: (nodeId) => nodeId === producerNodeId ? { id: nodeId, attemptSequence: 1 } : null,
      },
      catalog: { artifacts: [{
        logicalKey: `task.${producerRole}`,
        relativePath: `steps/impl/${taskId}/${producerRole}/result.json`,
        hash: "a".repeat(64),
        activityId: `${producerRole}-stage-completed`,
      }] },
      activities: [
        {
          id: `${producerRole}-started`, nodeId: producerNodeId, attemptId, sequence: 1,
          transition: { operation: "start_attempt", attempt: { id: attemptId, nodeId: producerNodeId, sequence: 1 } },
        },
        {
          id: `${producerRole}-stage-completed`, nodeId: producerNodeId, attemptId, sequence: 1,
          transition: {
            operation: "advance_task_review_stage",
            taskReviewStagePlan: { facts: { binding: {
              taskId, stage: producerRole, attemptId, attemptSequence: 1, artifactDigest: "a".repeat(64),
            } } },
          },
          result: { outcome: "passed" },
        },
      ],
    },
  };
}

describe("ProducerArtifactReadiness", () => {
  it("uses primary attempt results rather than optional catalog readers", () => {
    assert.equal(
      producerArtifactReadiness({ producerNodeId: "implement", consumerNodeId: "test-execute" }),
      null,
      "file.map is not a required producer readiness edge",
    );
    assert.equal(
      producerArtifactReadiness({ producerNodeId: "implement", consumerNodeId: "impl-review" }),
      null,
      "optional implementation map availability remains owned by review's domain check",
    );
    assert.ok(
      producerArtifactReadiness({ producerNodeId: "scenario-validity", consumerNodeId: "test-review" })
        instanceof ProducerArtifactReadiness,
      "scenario validity's retained primary result remains required by test review",
    );
    assert.equal(
      producerArtifactReadiness({ producerNodeId: "scenario-validity", consumerNodeId: "acceptance-review" }),
      null,
      "optional nonblocking handoffs cannot become an unconditional readiness edge",
    );
    assert.ok(
      producerArtifactReadiness({ producerNodeId: "acceptance-decision", consumerNodeId: "final-regression" })
        instanceof ProducerArtifactReadiness,
      "an explicit acceptance decision retains its cataloged primary result",
    );
    assert.ok(
      producerArtifactReadiness({ producerNodeId: "task-17-review", consumerNodeId: "task-17-gate" })
        instanceof ProducerArtifactReadiness,
      "dynamic task primary results preserve their task identity",
    );
    assert.ok(
      producerArtifactReadiness({ producerNodeId: "task-17-gate", consumerNodeId: "task-17-impl" })
        instanceof ProducerArtifactReadiness,
      "dynamic task gate results preserve their replacement implementation identity",
    );
    assert.deepEqual(
      producerArtifactReadinessesForProducer({ producerNodeId: "spec-review" })
        .map((readiness) => `${readiness.producerNodeId}->${readiness.consumerNodeId}`),
      ["spec-review->spec-triage"],
    );
  });

  it("uses Task stage confirmations only for typed Task review stages", () => {
    const draftReadiness = producerArtifactReadiness({
      producerNodeId: "draft-questions-review",
      consumerNodeId: "draft-questions-triage",
    });
    const draftHandoff = draftReadiness.handoffs[0];
    const draftAttempt = "draft-review-attempt-1";
    draftReadiness.assert({
      state: {
        current: null,
        attempt: null,
        tasks: [],
        findNode: (nodeId) => nodeId === "draft-questions-review"
          ? { id: nodeId, attemptSequence: 1 }
          : null,
      },
      catalog: { artifacts: [{
        logicalKey: draftHandoff.logicalKey,
        relativePath: draftHandoff.relativePath,
        activityId: "draft-review-confirmed",
      }] },
      activities: [
        {
          id: "draft-review-started",
          nodeId: "draft-questions-review",
          attemptId: draftAttempt,
          sequence: 1,
          transition: { operation: "start_attempt", attempt: { id: draftAttempt, nodeId: "draft-questions-review", sequence: 1 } },
        },
        {
          id: "draft-review-confirmed",
          nodeId: "draft-questions-review",
          attemptId: draftAttempt,
          sequence: 1,
          transition: { operation: "confirm_attempt" },
          result: { outcome: "passed" },
        },
      ],
    });

    const reviewToGate = typedTaskStageSnapshot({ producerRole: "review", consumerRole: "gate" });
    reviewToGate.readiness.assert(reviewToGate.snapshot);
    reviewToGate.snapshot.activities[1].transition.taskReviewStagePlan.facts.binding.stage = "triage";
    assert.throws(
      () => reviewToGate.readiness.assert(reviewToGate.snapshot),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
    );
    reviewToGate.snapshot.activities[1].transition.taskReviewStagePlan.facts.binding.stage = "review";
    reviewToGate.snapshot.activities[1].attemptId = "foreign-attempt";
    assert.throws(
      () => reviewToGate.readiness.assert(reviewToGate.snapshot),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
    );
    reviewToGate.snapshot.activities[1].attemptId = "review-attempt-1";
    reviewToGate.snapshot.activities[1].result.outcome = "failed";
    assert.throws(
      () => reviewToGate.readiness.assert(reviewToGate.snapshot),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
    );
  });

  it("requires cataloged spec.review and its matching confirmed spec-review Activity before spec-triage", () => {
    const readiness = producerArtifactReadiness({
      producerNodeId: "spec-review",
      consumerNodeId: "spec-triage",
    });
    assert.ok(readiness instanceof ProducerArtifactReadiness);
    assert.throws(
      () => readiness.assert({ state: state({ sequence: 2 }), catalog: { artifacts: [] }, activities: [] }),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
    );
    const catalog = {
      artifacts: [{
        logicalKey: "spec.review",
        relativePath: "revisions/001/review.json",
        activityId: "confirmed-spec-review",
      }],
    };
    assert.throws(
      () => readiness.assert({
        state: state({ sequence: 2 }),
        catalog,
        activities: [
          {
            id: "started-spec-review",
            nodeId: "spec-review",
            attemptId: "spec-review-attempt-2",
            sequence: 2,
            transition: {
              operation: "start_attempt",
              attempt: { id: "spec-review-attempt-2", nodeId: "spec-review", sequence: 2 },
            },
          },
          {
            id: "confirmed-spec-review",
            nodeId: "spec-review",
            attemptId: "spec-review-attempt-2",
            sequence: 2,
            transition: { operation: "fail_attempt" },
            result: { outcome: "failed" },
          },
        ],
      }),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
    );
    readiness.assert({
      state: state({ sequence: 2 }),
      catalog,
      activities: [
        {
          id: "started-spec-review",
          nodeId: "spec-review",
          attemptId: "spec-review-attempt-2",
          sequence: 2,
          transition: {
            operation: "start_attempt",
            attempt: { id: "spec-review-attempt-2", nodeId: "spec-review", sequence: 2 },
          },
        },
        {
          id: "confirmed-spec-review",
          nodeId: "spec-review",
          attemptId: "spec-review-attempt-2",
          sequence: 2,
          transition: { operation: "confirm_attempt" },
          result: { outcome: "passed" },
        },
      ],
    });
  });

  it("admits a deferred integration failure only through its exact adjacent settlement Activity", () => {
    const readiness = producerArtifactReadiness({ producerNodeId: "impl-gate", consumerNodeId: "retro" });
    const integrationState = {
      current: null,
      attempt: null,
      findNode: (nodeId) => nodeId === "impl-gate"
        ? { id: nodeId, status: "done", attemptSequence: 6 }
        : null,
    };
    const deferredFailure = {
      id: "failed-integration-5",
      nodeId: "impl-gate",
      attemptId: "integration-attempt-5",
      sequence: 5,
      transition: { operation: "fail_attempt" },
      result: { outcome: "failed" },
    };
    const settlement = {
      id: "deferred-integration-6",
      nodeId: "impl-gate",
      attemptId: "integration-attempt-5",
      sequence: 5,
      transition: {
        operation: "defer_failed_gate",
        attempt: { id: "integration-settlement-6", nodeId: "impl-gate", sequence: 6 },
      },
      result: { outcome: "passed" },
    };
    const catalog = {
      artifacts: [{
        logicalKey: "impl.gate",
        relativePath: "steps/impl/gate/result.json",
        activityId: deferredFailure.id,
      }],
    };
    readiness.assert({ state: integrationState, catalog, activities: [deferredFailure, settlement] });
    assert.throws(
      () => readiness.assert({ state: integrationState, catalog, activities: [deferredFailure] }),
      /producer Attempt introduction|confirmed producer Activity/,
    );
    assert.throws(
      () => readiness.assert({
        state: integrationState,
        catalog,
        activities: [
          deferredFailure,
          { ...settlement, transition: { ...settlement.transition, attempt: {
            ...settlement.transition.attempt,
            nodeId: "retro",
          } } },
        ],
      }),
      /producer Attempt introduction|confirmed producer Activity/,
    );
    const olderFailure = {
      ...deferredFailure,
      id: "failed-integration-4",
      attemptId: "integration-attempt-4",
      sequence: 4,
    };
    assert.throws(
      () => readiness.assert({
        state: integrationState,
        catalog: { artifacts: [{ ...catalog.artifacts[0], activityId: olderFailure.id }] },
        activities: [olderFailure, deferredFailure, settlement],
      }),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
    );
  });

  it("rejects a retained prior-attempt result when the current producer Attempt is artifactless", () => {
    const readiness = producerArtifactReadiness({ producerNodeId: "spec-review", consumerNodeId: "spec-triage" });
    assert.throws(
      () => readiness.assert({
        state: state({
          sequence: 2,
          current: ["spec-review"],
          attempt: { id: "spec-review-attempt-2", nodeId: "spec-review" },
        }),
        catalog: { artifacts: [{
          logicalKey: "spec.review",
          relativePath: "revisions/001/review.json",
          activityId: "published-attempt-1",
        }] },
        activities: [{
          id: "published-attempt-1",
          nodeId: "spec-review",
          attemptId: "spec-review-attempt-1",
          sequence: 1,
          transition: { operation: "publish_artifacts" },
        }],
      }),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
    );
  });

  it("rejects a terminal descriptor Activity with the wrong Attempt id at the same sequence", () => {
    const readiness = producerArtifactReadiness({ producerNodeId: "spec-review", consumerNodeId: "spec-triage" });
    assert.throws(
      () => readiness.assert({
        state: state({ sequence: 2 }),
        catalog: { artifacts: [{
          logicalKey: "spec.review",
          relativePath: "revisions/001/review.json",
          activityId: "confirmed-spec-review",
        }] },
        activities: [
          {
            id: "started-spec-review",
            nodeId: "spec-review",
            attemptId: "spec-review-attempt-2",
            sequence: 2,
            transition: {
              operation: "start_attempt",
              attempt: { id: "spec-review-attempt-2", nodeId: "spec-review", sequence: 2 },
            },
          },
          {
            id: "confirmed-spec-review",
            nodeId: "spec-review",
            attemptId: "wrong-attempt-id",
            sequence: 2,
            transition: { operation: "confirm_attempt" },
            result: { outcome: "passed" },
          },
        ],
      }),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
    );
  });

  it("rejects historical recovery after the producer result appears", () => {
    const readiness = producerArtifactReadiness({ producerNodeId: "spec-review", consumerNodeId: "spec-triage" });
    const historical = {
      runId: "historical-run",
      current: ["spec-triage"],
      attempt: { id: "triage-attempt-1", sequence: 1, nodeId: "spec-triage", failure: null },
      findNode: (nodeId) => ({
        id: nodeId,
        status: nodeId === "spec-review" ? "failed" : "in_progress",
        attemptSequence: 2,
      }),
    };
    const admission = new MissingProducerArtifactRecoveryAdmission({
      runId: "historical-run",
      consumerAttempt: historical.attempt,
      producerAttempt: {
        id: "spec-review-attempt-2",
        sequence: 2,
        nodeId: "spec-review",
        failure: { code: "REVIEW_EXECUTION_FAILED" },
      },
      readiness,
    });
    assert.throws(
      () => admission.assert({
        state: historical,
        catalog: { artifacts: [{
          logicalKey: "spec.review",
          relativePath: "revisions/001/review.json",
          activityId: "published-spec-review-attempt-2",
        }] },
        activities: [
          {
            id: "started-spec-review-attempt-2",
            nodeId: "spec-review",
            attemptId: "spec-review-attempt-2",
            sequence: 2,
            transition: {
              operation: "start_attempt",
              attempt: { id: "spec-review-attempt-2", nodeId: "spec-review", sequence: 2 },
            },
          },
          {
            id: "published-spec-review-attempt-2",
            nodeId: "spec-review",
            attemptId: "spec-review-attempt-2",
            sequence: 2,
            transition: { operation: "publish_artifacts" },
          },
        ],
      }),
      (error) => error?.code === "CANONICAL_MISSING_PRODUCER_ARTIFACT_RECOVERY_STALE",
    );
  });

  it("rejects recovery when the supplied producer Attempt is not the immutable failure record", () => {
    const readiness = producerArtifactReadiness({ producerNodeId: "spec-review", consumerNodeId: "spec-triage" });
    const historical = {
      runId: "historical-run",
      current: ["spec-triage"],
      attempt: { id: "triage-attempt-1", sequence: 1, nodeId: "spec-triage", failure: null },
      findNode: (nodeId) => ({
        id: nodeId,
        status: nodeId === "spec-review" ? "failed" : "in_progress",
        attemptSequence: 2,
      }),
    };
    const admission = new MissingProducerArtifactRecoveryAdmission({
      runId: "historical-run",
      consumerAttempt: historical.attempt,
      producerAttempt: {
        id: "wrong-spec-review-attempt",
        sequence: 2,
        nodeId: "spec-review",
        failure: { code: "REVIEW_EXECUTION_FAILED" },
      },
      readiness,
    });
    assert.throws(
      () => admission.assert({
        state: historical,
        catalog: { artifacts: [] },
        activities: [
          {
            id: "failed-spec-review-attempt-2",
            nodeId: "spec-review",
            attemptId: "spec-review-attempt-2",
            sequence: 2,
            transition: { operation: "fail_attempt" },
            failure: { code: "REVIEW_EXECUTION_FAILED" },
          },
          {
            id: "recorded-spec-review-attempt-2",
            nodeId: "spec-review",
            attemptId: "spec-review-attempt-2",
            sequence: 2,
            transition: { operation: "record_failure" },
          },
        ],
      }),
      (error) => error?.code === "CANONICAL_MISSING_PRODUCER_ARTIFACT_RECOVERY_STALE",
    );
  });
});
