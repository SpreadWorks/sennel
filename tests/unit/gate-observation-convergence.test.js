import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ArtifactGateRepairLineage,
  ArtifactGateRepairObservationResult,
  GateEvidenceIdentity,
  GateObservation,
  GateObservationCycleReader,
  GateObservationFingerprint,
  GateObservationOccurrence,
  GateObservationRepair,
  GateRepairMutationLineageEntry,
  GateRepairObservationRequest,
  GateRepairReport,
  PlanGateRepairOutcome,
  SourceGateRepairLineage,
  SourceGateRepairObservationResult,
} from "../../src/flow/lib/gate-observation-convergence.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);

function evidence(sequence, fingerprint = DIGEST_A) {
  const attempt = { id: `gate-attempt-${sequence}`, sequence };
  return new GateEvidenceIdentity({
    sourceAttempt: attempt,
    resultLogicalKey: "task.gate",
    publicationActivityId: `activity-gate-${sequence}`,
    catalogFingerprint: fingerprint,
    transitionLineage: {
      sourceAttempt: attempt,
      canonicalAttempt: attempt,
      sourceFingerprint: fingerprint,
      canonicalFingerprint: fingerprint,
    },
  });
}

function observation(overrides = {}) {
  return new GateObservation({
    phase: "task-impl",
    scope: "task",
    taskId: "T-7",
    authority: { kind: "Requirement", id: "REQ-7" },
    failureMode: "spec-impl-mismatch",
    file: "src\\feature.js",
    locator: "export   class  Feature",
    rootCause: "Returned  value   violates Contract A",
    observed: "provider wording",
    title: "provider title",
    ...overrides,
  });
}

function occurrence(sequence, overrides = {}) {
  return new GateObservationOccurrence({
    evidence: evidence(sequence, sequence === 1 ? DIGEST_A : DIGEST_B),
    observation: observation(overrides),
  });
}

function artifactReport(fingerprint, {
  beforeEvidenceDigest = DIGEST_A,
  outputEvidenceDigest = DIGEST_B,
  deltaIds = [DIGEST_D],
  resultDeltaIds = deltaIds,
  recurrenceCount = 0,
  priorStrategy = null,
  strategy = "change the producer contract",
  priorInsufficiency = null,
} = {}) {
  return new GateRepairReport({
    beforeEvidenceDigest,
    outputEvidenceDigest,
    summary: "Repaired the blocking observation",
    requests: [new GateRepairObservationRequest({ fingerprint, recurrenceCount, priorStrategy })],
    lineage: new ArtifactGateRepairLineage({ deltaIds }),
    results: [new ArtifactGateRepairObservationResult({
      fingerprint,
      strategy,
      summary: "Updated the authoritative artifact",
      priorInsufficiency,
      deltaIds: resultDeltaIds,
    })],
  });
}

function repair(sourceOccurrence, report, overrides = {}) {
  return new GateObservationRepair({
    repairId: "repair-1",
    sourceEvidence: sourceOccurrence.evidence,
    targetAttempt: { id: "repair-attempt-1", sequence: 1 },
    publicationActivityId: "activity-repair-request-1",
    recordFingerprint: DIGEST_C,
    handoffRevision: DIGEST_E,
    requests: report.requests,
    ...overrides,
  });
}

function outcome(repairRecord, report, overrides = {}) {
  return new PlanGateRepairOutcome({
    repairId: repairRecord.repairId,
    repairRecordFingerprint: repairRecord.recordFingerprint,
    sourceEvidence: repairRecord.sourceEvidence,
    sourceAttempt: repairRecord.sourceEvidence.sourceAttempt,
    targetAttempt: repairRecord.targetAttempt,
    publicationActivityId: "activity-repair-outcome-1",
    handoffRevision: repairRecord.handoffRevision,
    disposition: "applied",
    report,
    ...overrides,
  });
}

describe("Gate observation semantic identity", () => {
  it("uses authoritative root cause fields while preserving case and normalizing whitespace and slashes", () => {
    const original = observation();
    const presentationOnly = observation({
      title: "a different title",
      observed: "different provider prose",
      file: "src/feature.js",
      locator: " export class Feature ",
      rootCause: " Returned value violates Contract A ",
      fingerprint: DIGEST_C,
    });
    assert.equal(original.fingerprint.toString(), presentationOnly.fingerprint.toString());
    assert.notEqual(
      original.fingerprint.toString(),
      observation({ rootCause: "Returned value violates contract a" }).fingerprint.toString(),
    );
    assert.notEqual(presentationOnly.fingerprint.toString(), DIGEST_C);
  });

  it("uses observed as the cause only when rootCause is absent", () => {
    const first = observation({ rootCause: null, observed: "Observed   failure" });
    const same = observation({ rootCause: null, observed: " Observed failure " });
    const changed = observation({ rootCause: null, observed: "observed failure" });
    assert.equal(first.fingerprint.toString(), same.fingerprint.toString());
    assert.notEqual(first.fingerprint.toString(), changed.fingerprint.toString());
    assert.throws(() => observation({ rootCause: null, observed: null }), /rootCause or observed/);
  });

  it("never trusts a provider-supplied fingerprint", () => {
    const value = observation().toJSON();
    value.fingerprint = DIGEST_C;
    assert.equal(
      GateObservationFingerprint.fromObservation(value).toString(),
      observation().fingerprint.toString(),
    );
    assert.notEqual(GateObservationFingerprint.fromObservation(value).toString(), DIGEST_C);
  });
});

describe("Gate evidence identity", () => {
  it("binds exact Attempt, catalog publication, and current transition lineage", () => {
    const value = evidence(1);
    assert.equal(value.sourceAttempt.id, "gate-attempt-1");
    assert.equal(value.catalogFingerprint, DIGEST_A);
    assert.throws(() => new GateEvidenceIdentity({
      ...value.toJSON(),
      catalogFingerprint: DIGEST_B,
    }), /does not match/);
    assert.throws(() => new GateEvidenceIdentity({
      ...value.toJSON(),
      resultLogicalKey: "provider.gate",
    }), /logical key is invalid/);
    assert.throws(() => GateEvidenceIdentity.fromJSON({ ...value.toJSON(), stale: true }), /unknown fields/);
  });
});

describe("Gate repair report and outcome", () => {
  it("requires exact blocking-fingerprint and parent change coverage", () => {
    const fingerprint = observation().fingerprint;
    assert.throws(() => new GateRepairReport({
      beforeEvidenceDigest: DIGEST_A,
      outputEvidenceDigest: DIGEST_B,
      summary: "Incomplete report",
      requests: [new GateRepairObservationRequest({ fingerprint })],
      lineage: new ArtifactGateRepairLineage({ deltaIds: [DIGEST_D] }),
      results: [],
    }), /non-empty array/);
    assert.throws(() => artifactReport(fingerprint, { resultDeltaIds: [DIGEST_E] }), /parent change union/);
    assert.throws(() => new GateRepairReport({
      beforeEvidenceDigest: DIGEST_A,
      outputEvidenceDigest: DIGEST_B,
      summary: "Duplicate result",
      requests: [new GateRepairObservationRequest({ fingerprint })],
      lineage: new ArtifactGateRepairLineage({ deltaIds: [DIGEST_D] }),
      results: [
        new ArtifactGateRepairObservationResult({ fingerprint, strategy: "one", summary: "one", deltaIds: [DIGEST_D] }),
        new ArtifactGateRepairObservationResult({ fingerprint, strategy: "two", summary: "two", deltaIds: [DIGEST_D] }),
      ],
    }), /exactly one result/);
  });

  it("rejects recurrence without prior insufficiency and a changed strategy", () => {
    const fingerprint = observation().fingerprint;
    assert.throws(() => artifactReport(fingerprint, {
      recurrenceCount: 1,
      priorStrategy: "change the producer contract",
      strategy: "change the producer contract",
      priorInsufficiency: "The prior change missed one branch",
    }), /different strategy/);
    assert.throws(() => artifactReport(fingerprint, {
      recurrenceCount: 1,
      priorStrategy: "first strategy",
      strategy: "second strategy",
    }), /priorInsufficiency/);
    assert.doesNotThrow(() => artifactReport(fingerprint, {
      recurrenceCount: 1,
      priorStrategy: "first strategy",
      strategy: "second strategy",
      priorInsufficiency: "The first strategy did not update the canonical producer",
    }));
  });

  it("rejects applied artifact and source outcomes without authoritative progress", () => {
    const sourceOccurrence = occurrence(1);
    const fingerprint = sourceOccurrence.fingerprint;
    const noArtifactProgress = artifactReport(fingerprint, {
      outputEvidenceDigest: DIGEST_A,
      deltaIds: [],
    });
    const repairRecord = repair(sourceOccurrence, noArtifactProgress);
    assert.throws(() => outcome(repairRecord, noArtifactProgress), /changed evidence digest/);

    const sourceReport = new GateRepairReport({
      beforeEvidenceDigest: DIGEST_A,
      outputEvidenceDigest: DIGEST_B,
      summary: "Claimed source repair",
      requests: [new GateRepairObservationRequest({ fingerprint })],
      lineage: new SourceGateRepairLineage({ currentCheckout: true, mutations: [] }),
      results: [new SourceGateRepairObservationResult({
        fingerprint,
        strategy: "edit source",
        summary: "No source mutation was observed",
        mutationIds: [],
      })],
    });
    assert.throws(() => outcome(repair(sourceOccurrence, sourceReport), sourceReport), /non-empty current-checkout/);
  });

  it("accepts applied current-checkout source lineage and rejected no-progress evidence", () => {
    const sourceOccurrence = occurrence(1);
    const fingerprint = sourceOccurrence.fingerprint;
    const mutation = new GateRepairMutationLineageEntry({ mutationId: DIGEST_D, path: "src\\feature.js" });
    const sourceReport = new GateRepairReport({
      beforeEvidenceDigest: DIGEST_A,
      outputEvidenceDigest: DIGEST_B,
      summary: "Changed source",
      requests: [new GateRepairObservationRequest({ fingerprint })],
      lineage: new SourceGateRepairLineage({ currentCheckout: true, mutations: [mutation] }),
      results: [new SourceGateRepairObservationResult({
        fingerprint, strategy: "edit source", summary: "Changed source", mutationIds: [DIGEST_D],
      })],
    });
    assert.equal(outcome(repair(sourceOccurrence, sourceReport), sourceReport).disposition, "applied");

    const noProgress = artifactReport(fingerprint, { outputEvidenceDigest: DIGEST_A, deltaIds: [] });
    assert.equal(outcome(repair(sourceOccurrence, noProgress), noProgress, {
      disposition: "rejected-no-progress",
    }).disposition, "rejected-no-progress");
  });
});

describe("Gate observation cycle reader", () => {
  it("joins exact evidence, repair and outcome bindings and calculates cumulative counts", () => {
    const first = occurrence(1);
    const second = occurrence(2, { observed: "new wording after repair" });
    const report = artifactReport(first.fingerprint);
    const repairRecord = repair(first, report);
    const repairOutcome = outcome(repairRecord, report);
    const model = new GateObservationCycleReader({
      occurrences: [second, first],
      repairs: [repairRecord],
      outcomes: [repairOutcome],
    }).read();
    const cycle = model.find(first.fingerprint);
    assert.equal(model.occurrenceCount, 2);
    assert.equal(model.repairCount, 1);
    assert.equal(model.recurrenceCount, 1);
    assert.equal(cycle.occurrenceCount, 2);
    assert.equal(cycle.repairCount, 1);
    assert.equal(cycle.recurrenceCount, 1);
    assert.deepEqual(cycle.occurrences.map((entry) => entry.evidence.sourceAttempt.sequence), [1, 2]);
  });

  it("binds recurrence metadata to the latest exact prior repair outcome", () => {
    const first = occurrence(1);
    const second = occurrence(2);
    const firstReport = artifactReport(first.fingerprint);
    const firstRepair = repair(first, firstReport);
    const firstOutcome = outcome(firstRepair, firstReport);
    const secondReport = artifactReport(second.fingerprint, {
      beforeEvidenceDigest: DIGEST_B,
      outputEvidenceDigest: DIGEST_C,
      deltaIds: [DIGEST_E],
      recurrenceCount: 1,
      priorStrategy: "change the producer contract",
      strategy: "replace the incomplete branch",
      priorInsufficiency: "The first strategy left the alternate branch unchanged",
    });
    const secondRepair = repair(second, secondReport, {
      repairId: "repair-2",
      targetAttempt: { id: "repair-attempt-2", sequence: 2 },
      recordFingerprint: DIGEST_B,
      handoffRevision: DIGEST_C,
    });
    const secondOutcome = outcome(secondRepair, secondReport, {
      publicationActivityId: "activity-repair-outcome-2",
    });
    const model = new GateObservationCycleReader({
      occurrences: [first, second],
      repairs: [firstRepair, secondRepair],
      outcomes: [firstOutcome, secondOutcome],
    }).read();
    assert.equal(model.find(first.fingerprint).repairCount, 2);
    assert.equal(model.recurrenceCount, 1);

    const staleRepair = repair(second, artifactReport(second.fingerprint), {
      repairId: "repair-stale",
      targetAttempt: { id: "repair-attempt-stale", sequence: 3 },
    });
    assert.throws(() => new GateObservationCycleReader({
      occurrences: [first, second], repairs: [staleRepair], outcomes: [],
    }).read(), /recurrence count/);
  });

  it("fails closed for duplicate, stale, mismatched and unbound claims", () => {
    const first = occurrence(1);
    const report = artifactReport(first.fingerprint);
    const repairRecord = repair(first, report);
    assert.throws(() => new GateObservationCycleReader({
      occurrences: [first, first], repairs: [], outcomes: [],
    }).read(), /duplicate occurrence/);
    assert.throws(() => new GateObservationCycleReader({
      occurrences: [occurrence(2)], repairs: [repairRecord], outcomes: [],
    }).read(), /stale or unbound/);
    assert.throws(() => new GateObservationCycleReader({
      occurrences: [first], repairs: [], outcomes: [outcome(repairRecord, report)],
    }).read(), /no canonical repair/);
    assert.throws(() => new GateObservationCycleReader({
      occurrences: [first],
      repairs: [repairRecord],
      outcomes: [outcome(repairRecord, report, { handoffRevision: DIGEST_D })],
    }).read(), /exact repair binding/);
  });

  it("round-trips canonical rows without accepting altered fingerprints", () => {
    const first = occurrence(1);
    const report = artifactReport(first.fingerprint);
    const repairRecord = repair(first, report);
    const repairOutcome = outcome(repairRecord, report);
    const reader = GateObservationCycleReader.fromCanonical({
      observationRows: [first.toJSON()],
      repairRows: [repairRecord.toJSON()],
      outcomeRows: [repairOutcome.toJSON()],
    });
    assert.equal(reader.read().occurrenceCount, 1);
    const altered = first.toJSON();
    altered.fingerprint = DIGEST_C;
    assert.throws(() => GateObservationCycleReader.fromCanonical({ observationRows: [altered] }), /does not match/);
  });
});
