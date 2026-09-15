import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  const sourceGatePayload = {
    result: "fail",
    artifacts: {
      phase: "draft",
      gateTransitionAttemptId: sourceAttempt.id,
      gateTransitionAttemptSequence: sourceAttempt.sequence,
      gateTransitionLineage: DIGEST_E,
    },
  };
  const sourceHistory = { attempts: [{
    attempt: sourceAttempt.sequence,
    artifact: { logicalKey: "draft.gate", payload: sourceGatePayload },
  }] };
  const sourceCatalogFingerprint = crypto.createHash("sha256")
    .update(`${JSON.stringify(sourceHistory, null, 2)}\n`)
    .digest("hex");
  const source = { issueLogId: "gate-source-1", observations: [sourceObservation()] };
  const gateFacts = {
    currentAttempt: sourceAttempt,
    catalogPublication: { producerActivityId: "gate-publication", fingerprint: sourceCatalogFingerprint },
    lineage: {
      sourceAttempt,
      canonicalAttempt: sourceAttempt,
      sourceFingerprint: sourceCatalogFingerprint,
      canonicalFingerprint: sourceCatalogFingerprint,
      sourceRevisionFingerprint: DIGEST_E,
      canonicalRevisionFingerprint: DIGEST_E,
    },
  };
  const connector = {
    phase: "draft",
    sourceGateStepId: "draft-gate",
    sourceAttempt,
    resultLogicalKey: "draft.gate",
    resultArtifactId: "steps/draft-gate/result.json",
    catalogFingerprint: sourceCatalogFingerprint,
    targetStepId: "draft-gate-repair",
    resetStepIds: ["draft-gate-repair", "draft-coverage-review", "draft-coverage-triage", "draft-coverage-repair", "draft-gate"],
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
    nodeId: "draft-gate-repair",
    attemptId: targetAttempt.id,
    sequence: targetAttempt.sequence,
    confirmationOrder: 3,
    transition: { operation: "plan_gate_repair", attempt: { ...targetAttempt, nodeId: "draft-gate-repair" } },
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
  return { record, targetAttempt, repairActivity, outcome, issueLog, sourceAttempt, sourceGatePayload };
}

function noProgressOutcome(fixture) {
  const fingerprint = fixture.record.observationFingerprints[0];
  const report = new GateRepairReport({
    beforeEvidenceDigest: DIGEST_B,
    outputEvidenceDigest: DIGEST_B,
    summary: "The repair could not change the draft artifact.",
    requests: [{ fingerprint, recurrenceCount: 0, priorStrategy: null }],
    results: [new ArtifactGateRepairObservationResult({
      fingerprint,
      strategy: "inspect the artifact",
      summary: "No canonical change was available.",
      deltaIds: [],
    })],
    lineage: new ArtifactGateRepairLineage({ deltaIds: [] }),
  });
  return new PlanGateRepairOutcome({
    repairId: fixture.record.idempotencyKey,
    repairRecordFingerprint: fixture.record.fingerprint,
    sourceEvidence: fixture.record.evidenceIdentity,
    sourceAttempt: fixture.record.evidenceIdentity.sourceAttempt,
    targetAttempt: fixture.targetAttempt,
    publicationActivityId: "outcome-no-progress",
    handoffRevision: DIGEST_E,
    disposition: "rejected-no-progress",
    report,
  });
}

function statusFixture({ outcome = null, nextResult = null, settlement = null, sourceSettlement = null } = {}) {
  const fixture = repairFixture();
  const selectedOutcome = outcome === "no-progress" ? noProgressOutcome(fixture) : (outcome === "applied" ? fixture.outcome : null);
  const issue = descriptor({ logicalKey: "issue.log", relativePath: "issue-log.json", hash: DIGEST_B, activityId: "issue-publication" });
  const artifacts = [issue];
  const reads = new Map([["issue.log:", {
    descriptor: issue,
    relativePath: issue.relativePath,
    bytes: Buffer.from(JSON.stringify(fixture.issueLog)),
  }]]);
  const activities = [{
    id: "gate-publication",
    nodeId: "draft-gate",
    attemptId: fixture.sourceAttempt.id,
    sequence: fixture.sourceAttempt.sequence,
    confirmationOrder: 1,
    transition: { operation: "publish_artifacts" },
  }, fixture.repairActivity];
  if (sourceSettlement !== null) {
    activities.push({
      id: `source-gate-${sourceSettlement}`,
      nodeId: "draft-gate",
      attemptId: fixture.record.evidenceIdentity.sourceAttempt.id,
      sequence: fixture.record.evidenceIdentity.sourceAttempt.sequence,
      transition: sourceSettlement === "deferred"
        ? { operation: "defer_failed_gate" }
        : { operation: "continue_nonblocking", nonblocking: { kind: "decision" } },
    });
  }
  if (selectedOutcome !== null) {
    const outcomeDescriptor = descriptor({
      logicalKey: "plan.gate.repair.outcome",
      relativePath: `artifacts/plan-gate-repairs/${fixture.record.idempotencyKey}/outcome.json`,
      hash: DIGEST_C,
      activityId: selectedOutcome.publicationActivityId,
    });
    artifacts.push(outcomeDescriptor);
    reads.set(`plan.gate.repair.outcome:${fixture.record.idempotencyKey}`, {
      descriptor: outcomeDescriptor,
      relativePath: outcomeDescriptor.relativePath,
      bytes: Buffer.from(JSON.stringify(selectedOutcome.toJSON())),
    });
    activities.push({
      id: selectedOutcome.publicationActivityId,
      nodeId: "draft-gate-repair",
      attemptId: fixture.targetAttempt.id,
      sequence: fixture.targetAttempt.sequence,
      transition: { operation: "confirm_attempt" },
    });
  }
  const nextResults = nextResult === null ? [] : (Array.isArray(nextResult) ? nextResult : [nextResult]);
  const finalAttempt = nextResults.length + 1;
  const resultDescriptor = descriptor({
    logicalKey: "draft.gate",
    relativePath: "steps/draft-gate/result.json",
    hash: nextResults.length === 0 ? fixture.record.evidenceIdentity.catalogFingerprint : DIGEST_D,
    activityId: nextResults.length === 0 ? "gate-publication" : `gate-publication-${finalAttempt}`,
  });
  artifacts.push(resultDescriptor);
  reads.set("draft.gate:", {
    descriptor: resultDescriptor,
    relativePath: resultDescriptor.relativePath,
    bytes: Buffer.from(JSON.stringify({ attempts: [
      { attempt: 1, artifact: { logicalKey: "draft.gate", payload: fixture.sourceGatePayload } },
      ...nextResults.map((result, index) => ({
        attempt: index + 2,
        artifact: { logicalKey: "draft.gate", payload: { result, artifacts: {
          phase: "draft",
          gateTransitionAttemptId: `gate-attempt-${index + 2}`,
          gateTransitionAttemptSequence: index + 2,
        } } },
      })),
    ] })),
  });
  if (nextResults.length > 0) {
    activities.push(...nextResults.map((_result, index) => ({
      id: `gate-publication-${index + 2}`,
      nodeId: "draft-gate",
      attemptId: `gate-attempt-${index + 2}`,
      sequence: index + 2,
      confirmationOrder: index + 5,
      transition: { operation: "publish_artifacts" },
    })));
    if (settlement !== null) {
      activities.push({
        id: `gate-${settlement}`,
        nodeId: "draft-gate",
        attemptId: `gate-attempt-${finalAttempt}`,
        sequence: finalAttempt,
        transition: settlement === "deferred"
          ? { operation: "defer_failed_gate" }
          : { operation: "continue_nonblocking", nonblocking: { kind: "decision" } },
      });
    }
  }
  return {
    flowManager: manager({ artifacts, reads, activities }),
    state: { schemaRevision: 3, specId: "spec-1", runId: "run-1", issue: 1, current: ["draft-gate-repair"], attempt: fixture.targetAttempt },
    activities,
    reads,
  };
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
    const { flowManager, state } = statusFixture({ outcome: "applied" });

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
        sourceAttempt: fixture.record.evidenceIdentity.sourceAttempt.toJSON(),
        repair: {
          disposition: "applied",
          changedEvidence: true,
          targetAttempt: fixture.targetAttempt,
        },
        nextGate: null,
        finalDisposition: "repaired-awaiting-gate",
      }],
    });
  });

  it("classifies only an applied, changed repair followed by its next exact-scope PASS as passed", () => {
    const cases = [
      { name: "unrepaired observation", outcome: null, nextResult: null, expected: "open" },
      { name: "unrepaired deferred observation", outcome: null, nextResult: null, sourceSettlement: "deferred", expected: "deferred" },
      { name: "unrepaired advisory observation", outcome: null, nextResult: null, sourceSettlement: "nonblocking", expected: "nonblocking-advisory" },
      { name: "applied repair awaiting Gate", outcome: "applied", nextResult: null, expected: "repaired-awaiting-gate" },
      { name: "exact-scope PASS", outcome: "applied", nextResult: "pass", expected: "passed" },
      { name: "PASS after a failed retry", outcome: "applied", nextResult: ["fail", "pass"], expected: "passed" },
      { name: "later Gate failure", outcome: "applied", nextResult: "fail", expected: "open" },
      { name: "deferred Gate failure", outcome: "applied", nextResult: "fail", settlement: "deferred", expected: "deferred" },
      { name: "nonblocking advisory", outcome: "applied", nextResult: "fail", settlement: "nonblocking", expected: "nonblocking-advisory" },
      { name: "draft repair with no canonical progress", outcome: "no-progress", nextResult: null, expected: "carried-to-spec" },
    ];
    for (const scenario of cases) {
      const { flowManager, state } = statusFixture(scenario);
      const firstRead = GateObservationConvergenceStatus.fromCanonical({ flowManager, state }).toJSON();
      const entry = firstRead.entries[0];
      assert.equal(entry.finalDisposition, scenario.expected, scenario.name);
      if (scenario.nextResult === "pass") {
        assert.deepEqual(entry.nextGate, {
          result: "pass",
          attempt: {
            id: `gate-attempt-${Array.isArray(scenario.nextResult) ? scenario.nextResult.length + 1 : 2}`,
            sequence: Array.isArray(scenario.nextResult) ? scenario.nextResult.length + 1 : 2,
          },
          publicationActivityId: `gate-publication-${Array.isArray(scenario.nextResult) ? scenario.nextResult.length + 1 : 2}`,
        });
      }
      assert.equal(Object.hasOwn(entry, "lastOutcome"), false, "status omits raw repair outcome");
      assert.equal(Object.hasOwn(entry, "lastEvidence"), false, "status omits raw evidence lineage");
      assert.deepEqual(
        GateObservationConvergenceStatus.fromCanonical({ flowManager, state }).toJSON(),
        firstRead,
        "canonical restart read is deterministic",
      );
    }
  });

  it("rejects a matching Gate PASS that was published before its repair Activity", () => {
    const { flowManager, state, activities } = statusFixture({ outcome: "applied", nextResult: "pass" });
    activities.find((activity) => activity.id === "gate-publication-2").confirmationOrder = 3;
    assert.throws(
      () => GateObservationConvergenceStatus.fromCanonical({ flowManager, state }),
      /not subsequent to its repair Activity/,
    );
  });

  it("rejects a repair whose persisted source Gate identity was altered", () => {
    const cases = [
      {
        name: "Attempt identity",
        mutate({ reads }) {
          const resolved = reads.get("draft.gate:");
          const document = JSON.parse(resolved.bytes.toString("utf8"));
          document.attempts[0].artifact.payload.artifacts.gateTransitionAttemptId = "different-attempt";
          resolved.bytes = Buffer.from(JSON.stringify(document));
        },
        expected: /mismatched Attempt identity/,
      },
      {
        name: "transition lineage",
        mutate({ reads }) {
          const resolved = reads.get("draft.gate:");
          const document = JSON.parse(resolved.bytes.toString("utf8"));
          document.attempts[0].artifact.payload.artifacts.gateTransitionLineage = DIGEST_A;
          resolved.bytes = Buffer.from(JSON.stringify(document));
        },
        expected: /mismatched transition lineage/,
      },
      {
        name: "raw catalog fingerprint",
        mutate({ reads }) {
          const resolved = reads.get("draft.gate:");
          const document = JSON.parse(resolved.bytes.toString("utf8"));
          document.attempts[0].nodeId = "draft-gate";
          resolved.bytes = Buffer.from(JSON.stringify(document));
        },
        expected: /mismatched catalog fingerprint/,
      },
      {
        name: "publication Activity",
        mutate({ activities }) {
          activities.find((activity) => activity.id === "gate-publication").attemptId = "different-attempt";
        },
        expected: /no exact publication Activity/,
      },
    ];
    for (const scenario of cases) {
      const fixture = statusFixture({ outcome: "applied" });
      scenario.mutate(fixture);
      assert.throws(
        () => GateObservationConvergenceStatus.fromCanonical(fixture),
        scenario.expected,
        scenario.name,
      );
    }
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
    assert.equal(status.entries[0].finalDisposition, "open");
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
    const state = { schemaRevision: 3, specId: "spec-1", runId: "run-1", issue: 1, current: ["draft-gate-repair"], attempt: fixture.targetAttempt };

    assert.throws(
      () => new CanonicalGateObservationCycle({ flowManager, state }).read(),
      /one exact plan_gate_repair Activity reference/,
    );
  });
});
