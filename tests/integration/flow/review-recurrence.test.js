import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CanonicalAcceptanceArtifactStore } from "../../../src/flow/lib/canonical-acceptance-artifacts.js";
import { ReviewFindingCycle } from "../../../src/flow/lib/finding-disposition-policy.js";
import {
  CanonicalImplementationRepairRecord,
  ImplementationReviewRepairRecurrence,
  ImplementationReviewRecurrenceStatus,
  TaskReviewConvergenceEvidence,
  TaskReviewRecurrenceContract,
} from "../../../src/flow/lib/review-recurrence.js";
import {
  TaskExecutionBudget,
  TaskMutationLineage,
} from "../../../src/flow/lib/task-mutation-lineage.js";
import { SourceMutationManifest } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { assertTaskReviewRecurrenceExplanation } from "../../../src/flow/lib/run-review.js";

const RUN_ID = "run-review-recurrence";
const SPEC_ID = "spec-review-recurrence";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const FINGERPRINT_ONE = "1".repeat(64);
const FINGERPRINT_TWO = "2".repeat(64);
const FINGERPRINT_THREE = "3".repeat(64);

function implementationRepairRecord() {
  return new CanonicalImplementationRepairRecord({
    version: 1,
    appliedFindingKeys: ["flow-finding"],
    summary: "The preceding implementation repair changed the shared branch.",
    sourceMutationManifest: new SourceMutationManifest({
      attempt: { id: "impl-repair-attempt-1", nodeId: "impl-repair", sequence: 1 },
      baselineDigest: DIGEST_A,
      mutations: [{
        mutationId: SourceMutationManifest.mutationId({
          id: "impl-repair-attempt-1", nodeId: "impl-repair", sequence: 1,
        }, "src/one.js"),
        path: "src/one.js",
        changeKind: "content",
        beforeDigest: DIGEST_B,
        afterDigest: DIGEST_C,
      }],
    }).toJSON(),
  }).toJSON();
}

function finding({ fingerprint, findingKey = "same-key", file = "src/one.js", priorRepairInsufficiency = null, repairStrategy = null }) {
  return {
    findingId: fingerprint,
    findingKey,
    fingerprint,
    failureMode: "required_behavior",
    file,
    requirementId: "R-1",
    issue: `Issue at ${file}`,
    suggestion: `Repair ${file}`,
    rationale: "The requirement is mandatory.",
    disposition: "must-fix",
    ...(priorRepairInsufficiency === null ? {} : { priorRepairInsufficiency, repairStrategy }),
  };
}

function review({
  taskId,
  findings = [],
  runId = RUN_ID,
  lineageFingerprint = null,
  verdict = findings.length > 0 ? "REJECTED" : "PASS",
}) {
  return {
    version: 1,
    phase: "impl",
    runId,
    planRewindAt: null,
    taskId,
    verdict,
    blockingFindings: findings,
    nonBlockingImprovements: [],
    canonicalTaskSource: lineageFingerprint === null ? null : {
      reviewRepairComplete: true,
      reviewRepairLineageFingerprint: lineageFingerprint,
    },
  };
}

function historyBytes(logicalKey, attempts) {
  return Buffer.from(JSON.stringify({
    attempts: attempts.map(({ attempt, payload }) => ({
      attempt,
      artifact: { logicalKey, payload },
    })),
  }));
}

function taskLineage({ taskId, sequence, round, reviewStart = 0, role = "review-repair", path = "src/one.js" }) {
  const attempt = {
    id: `${taskId}-${role}-${sequence}`,
    nodeId: `${taskId}-${role === "implementation" ? "impl" : "review"}`,
    sequence,
  };
  const manifest = new SourceMutationManifest({
    attempt,
    baselineDigest: DIGEST_A,
    mutations: [{
      mutationId: SourceMutationManifest.mutationId(attempt, path),
      path,
      changeKind: "content",
      beforeDigest: DIGEST_B,
      afterDigest: DIGEST_C,
    }],
  });
  return new TaskMutationLineage({
    runId: RUN_ID,
    specId: SPEC_ID,
    taskId,
    role,
    attempt,
    budget: new TaskExecutionBudget({
      round,
      reviewAttemptSequenceAtStart: reviewStart,
      gateAttemptSequenceAtStart: 0,
    }),
    sourceFingerprint: manifest.digest,
    manifest: manifest.toJSON(),
  });
}

function bindTaskReviews(attempts, lineages) {
  return attempts.map((entry) => {
    const lineage = lineages.find((candidate) => candidate.attempt.sequence === entry.attempt);
    return {
      ...entry,
      payload: lineage === undefined
        ? entry.payload
        : review({
          ...entry.payload,
          findings: entry.payload.blockingFindings,
          lineageFingerprint: lineage.fingerprint,
        }),
    };
  });
}

class ReviewRecurrenceFlowManagerFixture {
  constructor({ taskHistories = new Map(), taskLineages = new Map(), implHistory = null, implRepair = null, implTriage = null, activities = [] } = {}) {
    this.taskHistories = taskHistories;
    this.taskLineagesById = taskLineages;
    this.implHistory = implHistory;
    this.implRepair = implRepair;
    this.implTriage = implTriage;
    this.activities = activities;
  }

  artifactCatalog() {
    return {
      artifacts: [...this.taskHistories.keys()].map((taskId) => ({
        logicalKey: "task.review",
        relativePath: `steps/impl/${taskId}/review/result.json`,
      })),
    };
  }

  activityLedger() {
    return this.activities;
  }

  readCatalogArtifact() {
    throw new Error("not used by recurrence projections");
  }

  specLocation() {
    return { specRoot: "specs", specId: SPEC_ID, relativeDirectory: `specs/${SPEC_ID}` };
  }

  readArtifact({ logicalKey, parameters, optional = false }) {
    if (logicalKey === "task.review") {
      return { bytes: this.taskHistories.get(parameters.taskId) };
    }
    if (logicalKey === "impl.repair" && this.implRepair !== null) {
      return { bytes: Buffer.from(JSON.stringify(this.implRepair)), descriptor: { activityId: "repair-1" } };
    }
    if (logicalKey === "impl.triage" && this.implTriage !== null) {
      return { bytes: Buffer.from(JSON.stringify(this.implTriage)), descriptor: { activityId: "triage-2" } };
    }
    if (logicalKey === "impl.review" && this.implHistory !== null) {
      return { bytes: this.implHistory, descriptor: { activityId: "review-3" } };
    }
    if (optional) return null;
    throw new Error(`missing fixture artifact: ${logicalKey}`);
  }

  taskMutationLineages({ taskId }) {
    return this.taskLineagesById.get(taskId) || [];
  }
}

describe("review recurrence projections", () => {
  it("separates Task, target, cycle, and execution round while retaining a fourth-review Acceptance handoff", () => {
    const t1RoundOne = [1, 2, 4].map((sequence) => taskLineage({
      taskId: "T-1",
      sequence,
      round: 1,
    }));
    const t1RoundTwo = taskLineage({
      taskId: "T-1",
      sequence: 5,
      round: 2,
      reviewStart: 4,
      role: "implementation",
    });
    const t1Attempts = bindTaskReviews([
      { attempt: 1, payload: review({ taskId: "T-1", findings: [finding({ fingerprint: FINGERPRINT_ONE })] }) },
      { attempt: 2, payload: review({ taskId: "T-1", findings: [finding({ fingerprint: FINGERPRINT_ONE })] }) },
      { attempt: 3, payload: review({ taskId: "T-1", runId: "old-run", findings: [finding({ fingerprint: FINGERPRINT_ONE })] }) },
      { attempt: 4, payload: review({ taskId: "T-1", findings: [finding({ fingerprint: FINGERPRINT_ONE })] }) },
    ], t1RoundOne);
    t1Attempts.push({ attempt: 5, payload: review({ taskId: "T-1" }) });

    const t2Lineages = [1, 2, 4].map((sequence) => taskLineage({
      taskId: "T-2",
      sequence,
      round: 1,
      path: "src/two.js",
    }));
    const t2Attempts = bindTaskReviews([
      { attempt: 1, payload: review({ taskId: "T-2", findings: [
        finding({ fingerprint: FINGERPRINT_TWO, file: "src/two.js" }),
        finding({ fingerprint: FINGERPRINT_THREE, file: "src/other.js" }),
      ] }) },
      { attempt: 2, payload: review({ taskId: "T-2", findings: [finding({
        fingerprint: FINGERPRINT_TWO,
        file: "src/two.js",
        priorRepairInsufficiency: "The direct branch was repaired but its shared caller remained uncovered.",
        repairStrategy: "Repair the shared caller and verify both branch paths.",
      })] }) },
      { attempt: 3, payload: review({ taskId: "T-2" }) },
      { attempt: 4, payload: review({ taskId: "T-2", findings: [finding({ fingerprint: FINGERPRINT_TWO, file: "src/two.js" })] }) },
    ], t2Lineages);

    const manager = new ReviewRecurrenceFlowManagerFixture({
      taskHistories: new Map([
        ["T-1", historyBytes("task.review", t1Attempts)],
        ["T-2", historyBytes("task.review", t2Attempts)],
      ]),
      taskLineages: new Map([
        ["T-1", [...t1RoundOne, t1RoundTwo]],
        ["T-2", t2Lineages],
      ]),
    });
    const convergence = new TaskReviewConvergenceEvidence({
      flowManager: manager,
      state: { runId: RUN_ID, specId: SPEC_ID },
      cycle: ReviewFindingCycle.fromActivityLedger({ runId: RUN_ID }),
    });

    assert.deepEqual(convergence.recurrenceHistory("T-1").toJSON(), []);
    const taskHistory = convergence.recurrenceHistory("T-2");
    const t2History = taskHistory.toJSON();
    assert.equal(t2History.length, 2, "a different target remains a distinct fingerprint");
    assert.equal(t2History.find((entry) => entry.fingerprint === FINGERPRINT_TWO).recurrenceCount, 3);
    assert.equal(t2History.find((entry) => entry.fingerprint === FINGERPRINT_THREE).recurrenceCount, 1);
    assert.equal(
      t2History.find((entry) => entry.fingerprint === FINGERPRINT_TWO).previous[1].finding.repairStrategy,
      "Repair the shared caller and verify both branch paths.",
      "the next Task Review receives the persisted prior strategy from canonical review history",
    );
    const workerRecurrence = new TaskReviewRecurrenceContract({ history: taskHistory });
    assert.doesNotThrow(() => workerRecurrence.validate([finding({
      fingerprint: FINGERPRINT_TWO,
      file: "src/two.js",
      priorRepairInsufficiency: "The direct branch was repaired but its shared caller remained uncovered.",
      repairStrategy: "Repair the shared caller and verify both branch paths.",
    })]));
    assert.throws(
      () => workerRecurrence.validate([finding({
        fingerprint: FINGERPRINT_TWO,
        findingKey: "wrong-key",
        file: "src/two.js",
        priorRepairInsufficiency: "The direct branch was repaired but its shared caller remained uncovered.",
        repairStrategy: "Repair the shared caller and verify both branch paths.",
      })]),
      /findingKey does not match its exact canonical fingerprint/,
      "the worker-side contract rejects recurrence claims before cache acceptance",
    );
    assert.throws(
      () => workerRecurrence.validate([finding({
        fingerprint: FINGERPRINT_THREE,
        file: "src/other.js",
      })]),
      /requires an exact prior insufficiency and repair strategy/,
      "history known to the Task Review requires both recurrence explanations",
    );
    assert.throws(
      () => workerRecurrence.validate([{
        ...finding({ fingerprint: FINGERPRINT_THREE, file: "src/other.js" }),
        priorRepairInsufficiency: 1,
        repairStrategy: 2,
      }]),
      /priorRepairInsufficiency must be a non-empty string/,
      "the typed recurrence value rejects non-string declarations instead of treating them as absent",
    );

    const handoffs = convergence.handoffs().map((handoff) => handoff.toJSON());
    assert.equal(handoffs.filter((handoff) => handoff.taskId === "T-1").length, 1);
    assert.equal(handoffs.find((handoff) => handoff.taskId === "T-1").unreviewedAfterRepair, true);
    assert.equal(handoffs.find((handoff) => handoff.taskId === "T-1").reviewAttempt, 4);
    const acceptanceStore = new CanonicalAcceptanceArtifactStore({
      state: {
        schemaRevision: 3,
        runId: RUN_ID,
        specId: SPEC_ID,
        flowId: "flow-review-recurrence",
        flowVersionId: "version-review-recurrence",
        request: "Retain fourth Task Review evidence for Acceptance.",
      },
      flowManager: manager,
    });
    assert.deepEqual(
      acceptanceStore.taskReviewHandoffs().map((handoff) => handoff.toJSON()),
      handoffs,
      "Acceptance reads the same all-round fourth-review handoff projection",
    );

    const status = convergence.status();
    assert.deepEqual(status.find((entry) => entry.taskId === "T-1"), {
      taskId: "T-1",
      reviewAttempts: 1,
      recurringFindings: [],
      fourthRepairUnreviewed: true,
      finalVerdict: "PASS",
    });
    assert.deepEqual(status.find((entry) => entry.taskId === "T-2"), {
      taskId: "T-2",
      reviewAttempts: 4,
      recurringFindings: [{
        findingId: FINGERPRINT_TWO,
        fingerprint: FINGERPRINT_TWO,
        recurrenceCount: 2,
      }],
      fourthRepairUnreviewed: true,
      finalVerdict: "REJECTED",
    });
    const recurringArtifact = {
      blockingFindings: [{ fingerprint: FINGERPRINT_TWO, findingKey: "same-key" }],
      nonBlockingImprovements: [],
    };
    assert.throws(
      () => assertTaskReviewRecurrenceExplanation({
        artifact: recurringArtifact,
        flowManager: manager,
        state: { runId: RUN_ID, specId: SPEC_ID },
        taskId: "T-2",
      }),
      /requires an exact prior insufficiency and repair strategy/,
    );
    assert.doesNotThrow(() => assertTaskReviewRecurrenceExplanation({
      artifact: {
        ...recurringArtifact,
        blockingFindings: [{
          ...recurringArtifact.blockingFindings[0],
          priorRepairInsufficiency: "The prior mutation repaired only one branch.",
          repairStrategy: "Cover the shared branch and its caller together.",
        }],
      },
      flowManager: manager,
      state: { runId: RUN_ID, specId: SPEC_ID },
      taskId: "T-2",
    }));
  });

  it("derives flow-level worker context and status only from the exact current-cycle fingerprint", () => {
    const matching = finding({ fingerprint: FINGERPRINT_ONE, findingKey: "flow-finding" });
    const sameKeyDifferentTarget = finding({
      fingerprint: FINGERPRINT_TWO,
      findingKey: "flow-finding",
      file: "src/two.js",
    });
    const notPreviouslyRepaired = finding({
      fingerprint: FINGERPRINT_THREE,
      findingKey: "not-repaired",
      file: "src/three.js",
    });
    const manager = new ReviewRecurrenceFlowManagerFixture({
      implHistory: historyBytes("impl.review", [
        { attempt: 1, payload: review({ taskId: null, runId: "old-run", findings: [matching] }) },
        { attempt: 2, payload: review({ taskId: null, findings: [matching, notPreviouslyRepaired] }) },
        { attempt: 3, payload: review({ taskId: null, findings: [matching, sameKeyDifferentTarget, notPreviouslyRepaired] }) },
      ]),
      implRepair: implementationRepairRecord(),
      implTriage: {
        version: 1,
        dispositions: [
          { findingKey: "flow-finding", disposition: "apply", rationale: "This recurring finding remains mandatory." },
          { findingKey: "not-repaired", disposition: "apply", rationale: "This finding is now selected for repair." },
        ],
      },
      activities: [
        { id: "review-1", nodeId: "impl-review", sequence: 1, confirmationOrder: 1, transition: { operation: "confirm_attempt" } },
        { id: "review-2", nodeId: "impl-review", sequence: 2, confirmationOrder: 2, transition: { operation: "confirm_attempt" } },
        { id: "triage-1", nodeId: "impl-triage", sequence: 1, confirmationOrder: 3, transition: { operation: "triage_implementation_for_repair" }, references: { findings: [{ id: "flow-finding" }, { id: "rejected-finding" }] } },
        { id: "repair-1", nodeId: "impl-repair", attemptId: "impl-repair-attempt-1", sequence: 1, confirmationOrder: 4, transition: { operation: "repair_implementation" }, references: { findings: [{ id: "flow-finding" }] } },
        { id: "review-3", nodeId: "impl-review", sequence: 3, confirmationOrder: 5, transition: { operation: "confirm_attempt" } },
        { id: "triage-2", nodeId: "impl-triage", sequence: 2, confirmationOrder: 6, transition: { operation: "triage_implementation_for_repair" }, references: { findings: [{ id: "flow-finding" }, { id: "not-repaired" }] } },
      ],
    });
    const recurrence = new ImplementationReviewRepairRecurrence({
      flowManager: manager,
      state: { runId: RUN_ID, specId: SPEC_ID },
      cycle: ReviewFindingCycle.fromActivityLedger({ runId: RUN_ID }),
    });

    assert.deepEqual(recurrence.toJSON(), [{
      fingerprint: FINGERPRINT_ONE,
      findingId: FINGERPRINT_ONE,
      findingKey: "flow-finding",
      recurrenceCount: 1,
      stillPresent: true,
      previous: [{
        attempt: 2,
        finding: {
          findingId: FINGERPRINT_ONE,
          findingKey: "flow-finding",
          fingerprint: FINGERPRINT_ONE,
          file: "src/one.js",
          location: null,
          requirementId: "R-1",
          issue: "Issue at src/one.js",
          suggestion: "Repair src/one.js",
          rationale: "The requirement is mandatory.",
        },
        repair: {
          summary: "The preceding implementation repair changed the shared branch.",
          appliedFindingKeys: ["flow-finding"],
          recurrenceResolutions: [],
          activityId: "repair-1",
          attempt: { id: "impl-repair-attempt-1", nodeId: "impl-repair", sequence: 1 },
          sourceFingerprint: implementationRepairRecord().sourceMutationManifest.digest,
          mutations: [{
            path: "src/one.js",
            changeKind: "content",
            beforeDigest: DIGEST_B,
            afterDigest: DIGEST_C,
          }],
        },
      }],
    }]);
    assert.deepEqual(recurrence.status(), {
      recurringFindings: [{
        findingId: FINGERPRINT_ONE,
        fingerprint: FINGERPRINT_ONE,
        recurrenceCount: 1,
      }, {
        findingId: FINGERPRINT_THREE,
        fingerprint: FINGERPRINT_THREE,
        recurrenceCount: 1,
      }],
      finalVerdict: "REJECTED",
    });

    const unboundManager = new ReviewRecurrenceFlowManagerFixture({
      implHistory: manager.implHistory,
      implRepair: manager.implRepair,
      implTriage: manager.implTriage,
      activities: manager.activities.map((activity) => activity.id === "repair-1"
        ? { ...activity, confirmationOrder: 1 }
        : activity),
    });
    assert.throws(() => new ImplementationReviewRepairRecurrence({
      flowManager: unboundManager,
      state: { runId: RUN_ID, specId: SPEC_ID },
      cycle: ReviewFindingCycle.fromActivityLedger({ runId: RUN_ID }),
    }), /not bound to the immediately preceding Review lineage/);
  });

  it("keeps the public status projection valid after a second repair and later transitions", () => {
    const recurring = finding({ fingerprint: FINGERPRINT_ONE, findingKey: "flow-finding" });
    const manager = new ReviewRecurrenceFlowManagerFixture({
      implHistory: historyBytes("impl.review", [
        { attempt: 1, payload: review({ taskId: null, findings: [recurring] }) },
        { attempt: 2, payload: review({ taskId: null, findings: [recurring] }) },
      ]),
      // This is deliberately a repair *after* Review 2.  Status must count
      // the recurrence without treating it as Review 2's predecessor.
      implRepair: implementationRepairRecord(),
      activities: [
        { id: "review-1", nodeId: "impl-review", sequence: 1, confirmationOrder: 1, transition: { operation: "confirm_attempt" } },
        { id: "review-3", nodeId: "impl-review", sequence: 2, confirmationOrder: 2, transition: { operation: "confirm_attempt" } },
        { id: "repair-1", nodeId: "impl-repair", attemptId: "impl-repair-attempt-1", sequence: 1, confirmationOrder: 3, transition: { operation: "repair_implementation" } },
        { id: "impl-gate", nodeId: "impl-gate", sequence: 1, confirmationOrder: 4, transition: { operation: "confirm_attempt" } },
      ],
    });
    const cycle = ReviewFindingCycle.fromActivityLedger({ runId: RUN_ID });
    const status = ImplementationReviewRecurrenceStatus.fromCanonical({
      flowManager: manager,
      state: { runId: RUN_ID, specId: SPEC_ID },
      cycle,
    }).toJSON();
    assert.deepEqual(status, {
      recurringFindings: [{ findingId: FINGERPRINT_ONE, fingerprint: FINGERPRINT_ONE, recurrenceCount: 1 }],
      finalVerdict: "REJECTED",
    });
  });
});
