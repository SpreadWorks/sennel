import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CanonicalCommandAttemptArtifactHistory, CanonicalCommandAttemptArtifactRecord, CanonicalCommandArtifactObservation,
  attachCanonicalCommandResultArtifact, attachCanonicalCommandResultPublications,
} from "../../src/flow/lib/canonical-command-result.js";
import { CanonicalDraftReviewObservation, canonicalReviewEvidencePublications } from "../../src/flow/lib/canonical-review-artifacts.js";
import { canonicalStepSettlementPublicationIdentity, commandResultPayload } from "../../src/flow/lib/canonical-step-settlement-publication.js";
import { DRAFT_REVIEW_ROUTES } from "../../src/flow/lib/draft-review-routes.js";
import { DraftReviewArtifactDocument } from "../../src/flow/lib/draft-review-artifacts.js";
import { ReviewEvidence, ReviewDisposition, ReviewProvenance } from "../../src/flow/lib/review-convergence.js";
import { ReviewWorkUnitOutputReceipt, ReviewWorkUnitTarget, digest, stableJson } from "../../src/flow/lib/review-work-unit-values.js";
import { DraftStepSettlementPublication } from "../../src/flow/definition.js";

const state = Object.freeze({ runId: "run-retained", specId: "spec-retained" });
const capturedAt = "2026-10-13T01:00:00.000Z";

function fixture(route = DRAFT_REVIEW_ROUTES[0], bucket = null) {
  const finding = { title: "Record a source", target: "GLOBAL", rationale: "The source is missing.",
    evidence: "Review source.", classification: bucket };
  const body = new DraftReviewArtifactDocument({ phase: route.retryPhase, sourceDraft: "draft.json",
    sourceDraftRevision: { version: 1, ...state, sourceStepId: "draft", digest: "a".repeat(64),
      byteLength: 80, finalizedAt: capturedAt }, generatedAt: capturedAt,
    ...(bucket === "blocking" ? { blockingFindings: [finding] } : {}),
    ...(bucket === "advisory" ? { advisoryFindings: [finding] } : {}),
    ...(bucket === "repair_target" ? { repairTargets: [finding] } : {}),
  }).toJSON();
  const severity = bucket === "blocking" ? "blocking" : "advisory";
  const findingId = `${route.retryPhase}-${severity}-001`;
  const canonicalFinding = { findingId, severity, summary: finding.title,
    fingerprint: digest(stableJson(finding)), evidenceRefs: [`${route.reviewArtifact}#${findingId}`] };
  const target = new ReviewWorkUnitTarget({ treeSha: "b".repeat(40), targetStateDigest: "c".repeat(64) });
  const evidence = new ReviewEvidence({ phase: route.retryPhase, taskId: null, ...target.toJSON(),
    provenance: new ReviewProvenance({ provider: "sennel-review",
      invocationId: digest(`${stableJson(body)}\n`), capturedAt }),
    disposition: new ReviewDisposition({ value: body.verdict,
      blockingFindings: bucket === "blocking" ? [canonicalFinding] : [],
      advisoryFindings: bucket !== null && bucket !== "blocking" ? [canonicalFinding] : [] }),
  });
  const outputReceipt = new ReviewWorkUnitOutputReceipt({ digest: "d".repeat(64), byteLength: 123,
    mediaType: "application/json" });
  const payload = { ...body, workerOutput: outputReceipt.toJSON(), canonicalEvidence: evidence.toJSON(),
    canonicalTarget: target.toJSON() };
  const result = { result: "ok", changed: [], artifacts: { phase: route.retryPhase, verdict: body.verdict,
    blockingCount: body.blockingFindings.length, nonBlockingCount: body.advisoryFindings.length + body.repairTargets.length } };
  attachCanonicalCommandResultArtifact(result, { logicalKey: route.reviewLogicalKey, payload });
  attachCanonicalCommandResultPublications(result, canonicalReviewEvidencePublications({ evidence, nodeId: route.reviewStepId }));
  const saved = { attempt: 2, ...commandResultPayload(result, route.reviewStepId, route.reviewLogicalKey) };
  const history = new CanonicalCommandAttemptArtifactHistory({ logicalKey: route.reviewLogicalKey, attempts: [saved] });
  return { payload, body, target, evidence, outputReceipt, result, route, saved, record: history.currentRecord };
}

for (const route of DRAFT_REVIEW_ROUTES) {
  for (const bucket of [null, "blocking", "advisory", "repair_target"]) {
    test(`retained ${route.retryPhase} ${bucket ?? "PASS"} preserves nominal values and publication digest`, () => {
      const value = fixture(route, bucket);
      const observed = new CanonicalDraftReviewObservation({ payload: value.payload, state, route });
      assert.ok(observed.document instanceof DraftReviewArtifactDocument);
      assert.deepEqual(observed.document.toJSON(), value.body);
      assert.deepEqual(observed.evidence.toJSON(), value.evidence.toJSON());
      assert.ok(observed.outputReceipt.equals(value.outputReceipt));
      assert.equal(observed.assertTarget(value.target), observed);
      const intent = { artifactWrites: [], artifactRemovals: [], artifactBaselines: [], testSourceBaseline: null,
        command: { attemptHistory: { logicalKey: route.reviewLogicalKey, parameters: {},
          payload: value.record.publicationPayload() }, publications: canonicalReviewEvidencePublications({
          evidence: value.evidence, nodeId: route.reviewStepId }).map((publication) => publication.toJSON()) },
        gatePublication: null, draftCompletionApplication: null, lifecycleResult: null,
        references: null, specRecord: null, planGateRepairOutcome: null };
      assert.equal(observed.settlementPublication(value.record).digest, new DraftStepSettlementPublication(intent).digest);
      const changed = structuredClone(value.saved);
      changed.result.changed = ["different saved command result"];
      const different = new CanonicalCommandAttemptArtifactHistory({ logicalKey: route.reviewLogicalKey, attempts: [changed] });
      assert.notEqual(observed.settlementPublication(different.currentRecord).digest, observed.settlementPublication(value.record).digest);
    });
  }
}

test("exact retained Attempt keeps its position and full entry without substituting the current payload", () => {
  const first = fixture();
  const last = fixture(DRAFT_REVIEW_ROUTES[0], "advisory");
  last.saved.attempt = 5;
  const history = new CanonicalCommandAttemptArtifactHistory({ logicalKey: first.route.reviewLogicalKey,
    attempts: [first.saved, last.saved] });
  const retained = history.atAttempt(2);
  assert.ok(retained instanceof CanonicalCommandAttemptArtifactRecord);
  assert.equal(retained.index, 0);
  assert.equal(retained.nodeId, first.route.reviewStepId);
  assert.deepEqual(retained.result, first.saved.result);
  assert.deepEqual(retained.toJSON(), first.saved);
  assert.equal(retained.payload.verdict, "PASS");
  assert.equal(history.current.payload.verdict, "ADVISORY");
  assert.equal(history.currentRecord.index, 1);
  assert.deepEqual(history.current, { attempt: 5, payload: last.payload });
  assert.deepEqual(history.attempts, [{ attempt: 2, payload: first.payload }, { attempt: 5, payload: last.payload }]);
  assert.equal(history.atAttempt(3), null);
  assert.throws(() => history.atAttempt(0), TypeError);
  const bare = new CanonicalCommandAttemptArtifactHistory({ logicalKey: first.route.reviewLogicalKey,
    attempts: [{ attempt: 1, artifact: first.saved.artifact }] });
  assert.deepEqual(bare.current.payload, first.payload);
  assert.throws(() => new CanonicalDraftReviewObservation({ payload: first.payload, state,
    route: first.route }).settlementPublication(bare.currentRecord), TypeError);
});

test("catalog-owned command observations preserve their public own fields and exact latest producer requirement", () => {
  const value = fixture();
  const bytes = Buffer.from(JSON.stringify({ attempts: [value.saved] }));
  const input = { logicalKey: value.route.reviewLogicalKey, bytes, history: true,
    producerActivityId: "publication-observed", attemptId: "review-attempt-2", sequence: 2 };
  const observed = CanonicalCommandArtifactObservation.fromBytes(input);
  assert.deepEqual(Object.keys(observed), ["artifact", "producerActivityId", "attemptId", "sequence"]);
  assert.deepEqual(JSON.parse(JSON.stringify(observed)), { artifact: value.saved.artifact,
    producerActivityId: input.producerActivityId, attemptId: input.attemptId, sequence: 2 });
  assert.deepEqual(observed.payload, value.payload);
  assert.equal(observed.sourceAttempt, 2);
  assert.throws(() => CanonicalCommandArtifactObservation.fromBytes({ ...input, sequence: 1 }),
    /differs from its exact producer Attempt/);
});

test("normal Draft publication refuses incomplete or unknown history intent and a different execution target", () => {
  const value = fixture();
  const observed = new CanonicalDraftReviewObservation({ payload: value.payload, state, route: value.route });
  assert.throws(() => observed.assertTarget(new ReviewWorkUnitTarget({ treeSha: "e".repeat(40),
    targetStateDigest: value.target.targetStateDigest })), TypeError);
  const mutations = [
    (entry) => { delete entry.result; },
    (entry) => { delete entry.outcome; },
    (entry) => { entry.unknownIntent = {}; },
    (entry) => { entry.artifact.unknownMeaning = true; },
    (entry) => { entry.nodeId = "draft-coverage-review"; },
  ];
  for (const mutate of mutations) {
    const saved = structuredClone(value.saved);
    mutate(saved);
    const history = new CanonicalCommandAttemptArtifactHistory({ logicalKey: value.route.reviewLogicalKey,
      attempts: [saved] });
    assert.throws(() => observed.settlementPublication(history.currentRecord), TypeError);
  }
});

test("self-consistent evidence for a different phase or Task cannot certify the saved Draft body", () => {
  const value = fixture();
  for (const changes of [{ phase: "impl" }, { taskId: "different-task" }]) {
    const input = value.evidence.toCanonicalJSON();
    const evidence = new ReviewEvidence({ ...input, ...changes, disposition: value.evidence.disposition });
    assert.deepEqual(ReviewEvidence.fromJSON(evidence.toJSON()).toJSON(), evidence.toJSON());
    assert.throws(() => new CanonicalDraftReviewObservation({ payload: { ...value.payload,
      canonicalEvidence: evidence.toJSON() }, state, route: value.route }), TypeError);
  }
});

const invalidPayloads = [
  ["unknown body field", (value) => { value.unrecognizedMeaning = true; }],
  ["missing body field", (value) => { delete value.generatedAt; }],
  ["normalized body text", (value) => { value.advisoryFindings[0].title = "  Record a source  "; }],
  ["unknown output receipt field", (value) => { value.workerOutput.filename = "file.json"; }],
  ["missing output receipt", (value) => { delete value.workerOutput; }],
  ["different output media type", (value) => { value.workerOutput.mediaType = "text/plain"; }],
  ["unknown target field", (value) => { value.canonicalTarget.phase = "draft-questions"; }],
  ["missing evidence", (value) => { delete value.canonicalEvidence; }],
  ["changed evidence identity", (value) => { value.canonicalEvidence.identity.evidenceDigest = "e".repeat(64); }],
  ["changed target", (value) => { value.canonicalTarget.treeSha = "e".repeat(40); }],
  ["changed verdict", (value) => { value.verdict = "PASS"; }],
  ["changed evidence finding", (value) => { value.advisoryFindings[0].rationale = "Different stored finding."; }],
  ["changed provenance", (value) => { value.generatedAt = "2026-10-13T01:00:01.000Z"; }],
  ["changed source Flow", (value) => { value.sourceDraftRevision.runId = "different-run"; }],
  ["unauthorized source Step", (value) => { value.sourceDraftRevision.sourceStepId = "spec-review"; }],
];
for (const [label, mutate] of invalidPayloads) {
  test(`retained normal Draft Review rejects ${label}`, () => {
    const value = fixture(DRAFT_REVIEW_ROUTES[0], "advisory");
    mutate(value.payload);
    assert.throws(() => new CanonicalDraftReviewObservation({ payload: value.payload, state, route: value.route }), Error);
  });
}

test("publication identity extraction keeps the digest of the immutable base Store input", () => {
  const commandResult = { result: "ok", changed: [], artifacts: { phase: "draft-questions",
    verdict: "PASS", blockingCount: 0, nonBlockingCount: 0 } };
  attachCanonicalCommandResultArtifact(commandResult, { logicalKey: "draft.questions.review",
    payload: { version: 2, marker: "retained saved input" } });
  attachCanonicalCommandResultPublications(commandResult, [{ logicalKey: "review.evidence",
    parameters: { reviewStep: "draft-questions-review", digest: "a".repeat(64) }, payload: { saved: "evidence" } }]);
  const publication = canonicalStepSettlementPublicationIdentity({ binding: { stepId: "draft-questions-review" },
    settlement: null, draftCompletionApplication: null, commandResult, artifactWrites: [], artifactRemovals: [],
    artifactBaselines: [], testSourceBaseline: undefined, gatePublication: null, lifecycleResult: null,
    references: undefined, specRecord: undefined, planGateRepairOutcome: null, preparation: null });
  // Evaluated with the same input by the immutable 3ff0e282 Store method.
  assert.equal(publication.digest, "5cce6155988835ce2a433243baf6eb522e26fc03582864176969cd3217c41623");
});
