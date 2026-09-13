import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalGateRevision } from "../../src/flow/lib/canonical-gate-artifacts.js";
import {
  CanonicalGateObservationCycle,
  GateObservationConvergenceStatus,
  GateObservationRecurrenceHandoff,
} from "../../src/flow/lib/canonical-gate-observation-cycle.js";
import {
  ArtifactGateRepairLineage,
  ArtifactGateRepairObservationResult,
  GateEvidenceIdentity,
  GateObservationCycleReader,
  GateObservationOccurrence,
  GateObservationRepair,
  GateRepairReport,
  PlanGateRepairOutcome,
} from "../../src/flow/lib/gate-observation-convergence.js";
import { PlanGateRepairObservation, PlanGateRepairRecord } from "../../src/flow/lib/plan-gate-repair.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);

function descriptor({ logicalKey, relativePath, hash = DIGEST_A, activityId }) {
  return { logicalKey, relativePath, hash, activityId };
}

function manager({ artifacts = [], reads = new Map(), activities = [] } = {}) {
  return {
    artifactCatalog() { return { artifacts }; },
    activityLedger() { return activities; },
    readArtifact({ logicalKey, parameters = {}, optional = false }) {
      const key = `${logicalKey}:${parameters.repairId ?? ""}`;
      const value = reads.get(key) ?? null;
      if (value === null && !optional) throw new Error(`missing ${key}`);
      return value;
    },
  };
}

function sourceObservation() {
  return {
    kind: "violation",
    failureMode: "guardrail-violation",
    requirementRef: "R-1",
    where: { file: "src/example.js", locator: "handler" },
    observed: "The invariant is not preserved.",
    severity: "blocking",
    refs: ["R-1"],
  };
}

function repairFixture() {
  const sourceAttempt = { id: "gate-attempt-1", sequence: 1 };
  const source = { issueLogId: "gate-source-1", observations: [sourceObservation()] };
  const gateFacts = {
    currentAttempt: sourceAttempt,
    catalogPublication: { producerActivityId: "gate-publication", fingerprint: DIGEST_A },
    lineage: {
      sourceAttempt,
      canonicalAttempt: sourceAttempt,
      sourceFingerprint: DIGEST_A,
      canonicalFingerprint: DIGEST_A,
      sourceRevisionFingerprint: null,
      canonicalRevisionFingerprint: null,
    },
  };
  const connector = {
    phase: "draft",
    sourceGateStepId: "draft-gate",
    sourceAttempt,
    resultLogicalKey: "draft.gate",
    resultArtifactId: "steps/draft-gate/result.json",
    catalogFingerprint: DIGEST_A,
    targetStepId: "draft-refine",
    resetStepIds: ["draft-refine", "draft-coverage-review", "draft-coverage-triage", "draft-coverage-repair", "draft-gate"],
    taskLifecycle: null,
  };
  const evidenceIdentity = new GateEvidenceIdentity({
    sourceAttempt,
    resultLogicalKey: connector.resultLogicalKey,
    publicationActivityId: gateFacts.catalogPublication.producerActivityId,
    catalogFingerprint: gateFacts.catalogPublication.fingerprint,
    transitionLineage: gateFacts.lineage,
  });
  const observation = new PlanGateRepairObservation({
    ...sourceObservation(), phase: "draft", scope: "flow", taskId: null,
  });
  const cycleReadModel = new GateObservationCycleReader({
    occurrences: [new GateObservationOccurrence({
      evidence: evidenceIdentity,
      observation: observation.canonical,
      blocking: true,
    })],
  }).read();
  const record = PlanGateRepairRecord.create({
    state: { runId: "run-1", specId: "spec-1", issue: 1 },
    issueLogEntry: source,
    gateFacts,
    connector,
    cycleReadModel,
    requestedAt: "2026-09-14T00:00:00.000Z",
  });
  const targetAttempt = { id: "repair-attempt-2", sequence: 2 };
  const repairActivity = {
    id: "plan-repair-activity",
    nodeId: "draft-refine",
    attemptId: targetAttempt.id,
    sequence: targetAttempt.sequence,
    confirmationOrder: 3,
    transition: { operation: "plan_gate_repair", attempt: { ...targetAttempt, nodeId: "draft-refine" } },
    references: { repairs: [record.activityReference()] },
  };
  const fingerprint = record.observationFingerprints[0];
  const report = new GateRepairReport({
    beforeEvidenceDigest: DIGEST_B,
    outputEvidenceDigest: DIGEST_C,
    summary: "Repaired the draft artifact.",
    requests: [{ fingerprint, recurrenceCount: 0, priorStrategy: null }],
    results: [new ArtifactGateRepairObservationResult({
      fingerprint,
      strategy: "revise invariant section",
      summary: "Added the missing invariant.",
      deltaIds: [DIGEST_D],
    })],
    lineage: new ArtifactGateRepairLineage({ deltaIds: [DIGEST_D] }),
  });
  const outcome = new PlanGateRepairOutcome({
    repairId: record.idempotencyKey,
    repairRecordFingerprint: record.idempotencyKey.slice("plan-gate-repair-".length),
    sourceEvidence: record.evidenceIdentity,
    sourceAttempt,
    targetAttempt,
    publicationActivityId: "outcome-publication",
    handoffRevision: DIGEST_E,
    disposition: "applied",
    report,
  });
  const issueLog = { entries: [source, { ...record.issueLogEntry(), issueLogId: record.idempotencyKey }] };
  return { record, targetAttempt, repairActivity, outcome, issueLog };
}

describe("canonical Gate observation cycle", () => {
  it("projects an always-typed recurrence handoff with bounded prior history", () => {
    const empty = new GateObservationRecurrenceHandoff({
      record: null,
      readModel: new GateObservationCycleReader().read(),
    });
    assert.deepEqual(empty.toJSON(), {
      version: 1, phase: null, targetStepId: null, sourceEvidence: null, entries: [],
    });

    const fixture = repairFixture();
    const readModel = new GateObservationCycleReader({
      occurrences: fixture.record.observations.map((observation) => new GateObservationOccurrence({
        evidence: fixture.record.evidenceIdentity,
        observation: observation.canonical,
        blocking: true,
      })),
      repairs: [new GateObservationRepair({
        repairId: fixture.record.idempotencyKey,
        sourceEvidence: fixture.record.evidenceIdentity,
        targetAttempt: fixture.targetAttempt,
        publicationActivityId: fixture.repairActivity.id,
        recordFingerprint: fixture.record.fingerprint,
        handoffRevision: DIGEST_E,
        requests: fixture.record.observationRequests,
      })],
      outcomes: [fixture.outcome],
    }).read();
    const projected = new GateObservationRecurrenceHandoff({
      record: fixture.record,
      readModel,
    }).toJSON();
    assert.equal(projected.entries.length, 1);
    assert.equal(projected.entries[0].occurrenceCount, 1);
    assert.equal(projected.entries[0].repairCount, 1);
    assert.equal(projected.entries[0].previousCycle, null);
  });

  it("returns an empty read model and status when no canonical Gate evidence exists", () => {
    const issue = descriptor({ logicalKey: "issue.log", relativePath: "issue-log.json", activityId: "issue-publication" });
    const flowManager = manager({
      artifacts: [issue],
      reads: new Map([["issue.log:", { descriptor: issue, relativePath: issue.relativePath, bytes: Buffer.from('{"entries":[]}') }]]),
    });
    const state = { schemaRevision: 3, specId: "spec-1", runId: "run-1", issue: 1, current: null, attempt: null };
    const cycle = new CanonicalGateObservationCycle({ flowManager, state }).read();
    const status = GateObservationConvergenceStatus.fromCanonical({ flowManager, state });

    assert.deepEqual(cycle.toJSON(), { occurrenceCount: 0, repairCount: 0, recurrenceCount: 0, cycles: [] });
    assert.equal(status.empty, true);
  });

  it("joins a v2 repair record, its exact Activity, and immutable outcome", () => {
    const fixture = repairFixture();
    const issue = descriptor({ logicalKey: "issue.log", relativePath: "issue-log.json", hash: DIGEST_B, activityId: "issue-publication" });
    const outcomeDescriptor = descriptor({
      logicalKey: "plan.gate.repair.outcome",
      relativePath: `artifacts/plan-gate-repairs/${fixture.record.idempotencyKey}/outcome.json`,
      hash: DIGEST_C,
      activityId: fixture.outcome.publicationActivityId,
    });
    const outcomeActivity = {
      id: fixture.outcome.publicationActivityId,
      nodeId: "draft-refine",
      attemptId: fixture.targetAttempt.id,
      sequence: fixture.targetAttempt.sequence,
      confirmationOrder: 4,
      transition: { operation: "confirm_attempt" },
    };
    const reads = new Map([
      ["issue.log:", { descriptor: issue, relativePath: issue.relativePath, bytes: Buffer.from(JSON.stringify(fixture.issueLog)) }],
      [`plan.gate.repair.outcome:${fixture.record.idempotencyKey}`, {
        descriptor: outcomeDescriptor,
        relativePath: outcomeDescriptor.relativePath,
        bytes: Buffer.from(JSON.stringify(fixture.outcome.toJSON())),
      }],
    ]);
    const flowManager = manager({
      artifacts: [issue, outcomeDescriptor],
      reads,
      activities: [fixture.repairActivity, outcomeActivity],
    });
    const state = { schemaRevision: 3, specId: "spec-1", runId: "run-1", issue: 1, current: ["draft-refine"], attempt: fixture.targetAttempt };

    const status = GateObservationConvergenceStatus.fromCanonical({ flowManager, state });
    assert.equal(status.empty, false);
    assert.deepEqual(status.toJSON(), {
      occurrenceCount: 1,
      repairCount: 1,
      recurrenceCount: 0,
      entries: [{
        phase: "draft",
        taskId: null,
        fingerprint: fixture.record.observationFingerprints[0],
        occurrenceCount: 1,
        repairCount: 1,
        recurrenceCount: 0,
        lastEvidence: fixture.record.evidenceIdentity.toJSON(),
        lastOutcome: fixture.outcome.toJSON(),
        finalDisposition: "applied",
      }],
    });
  });

  it("reconstructs the current failed Gate occurrence only from exact catalog and Activity lineage", () => {
    const attempt = {
      id: "draft-gate-attempt",
      nodeId: "draft-gate",
      sequence: 1,
      failure: { category: "semantic" },
    };
    const state = {
      schemaRevision: 3, specId: "spec-1", runId: "run-1", issue: null,
      current: ["draft-gate"], attempt,
    };
    const resultDescriptor = descriptor({
      logicalKey: "draft.gate",
      relativePath: "steps/draft-gate/result.json",
      hash: DIGEST_A,
      activityId: "gate-publication",
    });
    const payload = {
      result: "fail",
      artifacts: {
        phase: "draft",
        gateTransitionAttemptId: attempt.id,
        gateTransitionAttemptSequence: attempt.sequence,
        gateTransitionLineage: canonicalGateRevision(state, "draft-gate"),
        nextAction: { diagnosis: { observations: [sourceObservation()] } },
      },
    };
    const history = { attempts: [{ attempt: 1, artifact: { logicalKey: "draft.gate", payload } }] };
    const reads = new Map([
      ["draft.gate:", { descriptor: resultDescriptor, relativePath: resultDescriptor.relativePath, bytes: Buffer.from(JSON.stringify(history)) }],
    ]);
    const activities = [{
      id: "gate-publication", nodeId: "draft-gate", attemptId: attempt.id, sequence: 1,
      transition: { operation: "publish_artifacts" },
    }, {
      id: "gate-failed", nodeId: "draft-gate", attemptId: attempt.id, sequence: 1,
      transition: { operation: "fail_attempt" }, failure: { category: "semantic" },
    }];
    const flowManager = manager({ artifacts: [resultDescriptor], reads, activities });

    const status = GateObservationConvergenceStatus.fromCanonical({ flowManager, state }).toJSON();
    assert.equal(status.entries.length, 1);
    assert.equal(status.entries[0].phase, "draft");
    assert.equal(status.entries[0].occurrenceCount, 1);
    assert.equal(status.entries[0].repairCount, 0);
    assert.equal(Object.hasOwn(status.entries[0], "finalDisposition"), false);
  });

  it("fails closed when a repair record is not bound to its exact plan_gate_repair Activity", () => {
    const fixture = repairFixture();
    fixture.repairActivity.references.repairs[0] = { id: "different-repair", label: "gate-source-1" };
    const issue = descriptor({ logicalKey: "issue.log", relativePath: "issue-log.json", activityId: "issue-publication" });
    const flowManager = manager({
      artifacts: [issue],
      reads: new Map([["issue.log:", {
        descriptor: issue,
        relativePath: issue.relativePath,
        bytes: Buffer.from(JSON.stringify(fixture.issueLog)),
      }]]),
      activities: [fixture.repairActivity],
    });
    const state = { schemaRevision: 3, specId: "spec-1", runId: "run-1", issue: 1, current: ["draft-refine"], attempt: fixture.targetAttempt };

    assert.throws(
      () => new CanonicalGateObservationCycle({ flowManager, state }).read(),
      /one exact plan_gate_repair Activity reference/,
    );
  });
});
