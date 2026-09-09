import assert from "node:assert/strict";
import crypto from "node:crypto";
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

const RUN_ID = "run-review-recurrence";
const SPEC_ID = "spec-review-recurrence";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const FINGERPRINT_ONE = "1".repeat(64);
const FINGERPRINT_TWO = "2".repeat(64);
const FINGERPRINT_THREE = "3".repeat(64);
const FINGERPRINT_FOUR = "4".repeat(64);

function implementationRepairRecord() {
  const attempt = { id: "impl-repair-attempt-1", nodeId: "impl-repair", sequence: 1 };
  const mutationId = SourceMutationManifest.mutationId(attempt, "src/one.js");
  return new CanonicalImplementationRepairRecord({
    version: 1,
    appliedFindingKeys: ["flow-finding"],
    findingMutations: [{ findingKey: "flow-finding", mutationIds: [mutationId] }],
    summary: "The preceding implementation repair changed the shared branch.",
    sourceMutationManifest: new SourceMutationManifest({
      attempt,
      baselineDigest: DIGEST_A,
      mutations: [{
        mutationId,
        path: "src/one.js",
        changeKind: "content",
        beforeKind: "file", beforeMode: 0o644, beforeDigest: DIGEST_B,
        afterKind: "file", afterMode: 0o644, afterDigest: DIGEST_C,
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

function taskLineage({ taskId, sequence, round, reviewStart = 0, role = "implementation", path = "src/one.js" }) {
  const attempt = {
    id: `${taskId}-${role}-${sequence}`,
    nodeId: `${taskId}-${role === "implementation" ? "impl" : "repair"}`,
    sequence,
  };
  const manifest = new SourceMutationManifest({
    attempt,
    baselineDigest: DIGEST_A,
    mutations: [{
      mutationId: SourceMutationManifest.mutationId(attempt, path),
      path,
      changeKind: "content",
      beforeKind: "file", beforeMode: 0o644, beforeDigest: DIGEST_B,
      afterKind: "file", afterMode: 0o644, afterDigest: DIGEST_C,
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


class ReviewRecurrenceFlowManagerFixture {
  constructor({ taskStages = new Map(), taskLineages = new Map(), implHistory = null, implRepair = null, implTriage = null, activities = [] } = {}) {
    this.taskStages = taskStages;
    this.taskLineagesById = taskLineages;
    this.implHistory = implHistory;
    this.implRepair = implRepair;
    this.implTriage = implTriage;
    this.activities = activities;
  }

  artifactCatalog() {
    return {
      artifacts: [...this.taskStages.entries()].flatMap(([taskId, stages]) => (
        ["review", "triage", "repair"].flatMap((role) => stages[role] === undefined ? [] : [{
          logicalKey: `task.${role}`,
          relativePath: `steps/impl/${taskId}/${role}/result.json`,
          activityId: `${taskId}-${role}-activity`,
          hash: "f".repeat(64),
        }])
      )),
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
    if (logicalKey.startsWith("task.")) {
      const role = logicalKey.slice(5);
      const stage = this.taskStages.get(parameters?.taskId)?.[role] ?? null;
      if (stage !== null) {
        return { bytes: stage, descriptor: { activityId: `${parameters.taskId}-${role}-activity` } };
      }
      if (optional) return null;
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
  it("derives recurrence and the fourth-review Acceptance handoff from triage and repair publications", () => {
    const taskId = "T-1";
    const stable = (value) => Array.isArray(value)
      ? `[${value.map(stable).join(",")}]`
      : value !== null && typeof value === "object"
        ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
        : JSON.stringify(value);
    const digest = (value) => crypto.createHash("sha256").update(stable(value)).digest("hex");
    const reference = (logicalKey, payload, sequence = 1) => ({
      logicalKey, digest: "e".repeat(64), payloadDigest: digest(payload), activityId: `${taskId}-${logicalKey.slice(5)}-activity`, attemptId: `${logicalKey}-attempt-${sequence}`, sequence,
    });
    const reviewPayload = review({ taskId, findings: [finding({ fingerprint: FINGERPRINT_ONE })] });
    const reviewReference = reference("task.review", reviewPayload, 1);
    const binding = {
      runId: RUN_ID, specId: SPEC_ID, flowVersion: 1, taskId, taskRound: 1, reviewOrdinal: 4,
      specDigest: DIGEST_A, contextDigest: DIGEST_B, sourceFingerprint: DIGEST_C, review: reviewReference, triage: null,
    };
    const triagePayload = {
      version: 1, taskId, binding, attempt: { id: "triage-attempt", nodeId: "T-1-triage", sequence: 1 },
      handoffDigest: DIGEST_A, reviewFindings: reviewPayload.blockingFindings,
      dispositions: [{ findingKey: "same-key", disposition: "apply", basis: "repair-required", rationale: "The finding requires a source correction." }],
      unreviewedAfterRepair: false,
    };
    const triageReference = reference("task.triage", triagePayload, 1);
    const repairPayload = {
      version: 1, taskId, binding: { ...binding, triage: triageReference },
      attempt: { id: "repair-attempt", nodeId: "T-1-repair", sequence: 1 }, handoffDigest: DIGEST_B,
      reviewFindings: reviewPayload.blockingFindings,
      repair: { version: 1, appliedFindingKeys: ["same-key"], summary: "Repair the required source behavior.", findingMutations: [{ findingKey: "same-key", mutationIds: [DIGEST_C] }] },
      sourceMutationManifest: { digest: DIGEST_C, mutations: [{ path: "src/one.js", beforeDigest: DIGEST_A, afterDigest: DIGEST_B, changeKind: "content" }] },
      unreviewedAfterRepair: true,
    };
    const manager = new ReviewRecurrenceFlowManagerFixture({
      taskStages: new Map([[taskId, {
        review: historyBytes("task.review", [{ attempt: 1, payload: reviewPayload }]),
        triage: historyBytes("task.triage", [{ attempt: 1, payload: triagePayload }]),
        repair: historyBytes("task.repair", [{ attempt: 1, payload: repairPayload }]),
      }]]),
      taskLineages: new Map([[taskId, [taskLineage({ taskId, sequence: 1, round: 1, role: "implementation" })]]]),
      activities: ["review", "triage", "repair"].map((role) => ({ id: `${taskId}-${role}-activity`, attemptId: `${role}-attempt`, nodeId: `${taskId}-${role}`, sequence: 1, transition: { taskReviewStagePlan: null } })),
    });
    const convergence = new TaskReviewConvergenceEvidence({ flowManager: manager, state: { runId: RUN_ID, specId: SPEC_ID }, cycle: ReviewFindingCycle.fromActivityLedger({ runId: RUN_ID }) });
    const recurrence = convergence.recurrenceHistory(taskId);
    assert.equal(recurrence.entries.length, 1);
    assert.equal(recurrence.entries[0].previous[0].repair.summary, "Repair the required source behavior.");
    assert.doesNotThrow(() => new TaskReviewRecurrenceContract({ history: recurrence }).validate([finding({ fingerprint: FINGERPRINT_ONE })]));
    const handoff = convergence.handoffs().map((entry) => entry.toJSON());
    assert.equal(handoff.length, 1);
    assert.deepEqual(handoff[0].dispositions, triagePayload.dispositions);
    assert.deepEqual(handoff[0].findings, reviewPayload.blockingFindings);
    assert.deepEqual(handoff[0].sourceMutationManifest, repairPayload.sourceMutationManifest);
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
          { findingKey: "flow-finding", disposition: "apply", basis: "repair-required", rationale: "This recurring finding remains mandatory." },
          { findingKey: "not-repaired", disposition: "apply", basis: "repair-required", rationale: "This finding is now selected for repair." },
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
            beforeKind: "file", beforeMode: 0o644, beforeDigest: DIGEST_B,
            afterKind: "file", afterMode: 0o644, afterDigest: DIGEST_C,
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
