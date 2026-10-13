import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { FLOW_ARTIFACT_CONTRACTS, FlowArtifactActivityEvidenceDocument,
  FlowArtifactSpecReviewActivityEvidenceDocument } from "../../src/lib/flow-artifact-contract.js";
import { CanonicalSpecReview, SpecReviewDelta, mergeSpecReviewDelta } from "../../src/flow/lib/spec-review-artifacts.js";
import { ActivityReviewPublication } from "../../src/flow/lib/current-flow-state.js";

const observedAt = "2026-10-13T03:00:00.000Z";
const finding = { kind: "blocking", findingId: "F-retained", title: "Preserve the source", target: "goal",
  body: "The result needs a measurable source.", issue: "The source is missing.",
  requiredChange: "Record the source.", whyBlocking: "The expected result needs a source." };
const content = FLOW_ARTIFACT_CONTRACTS.require("activity.evidence").contentContract;
function fixture() {
  const initial = new CanonicalSpecReview({ version: 2, identity: { specId: "spec-history", revision: 1,
    digest: "a".repeat(64), byteLength: 100 }, generation: 0, findings: [], audit: [] });
  const review = mergeSpecReviewDelta({ review: initial, delta: new SpecReviewDelta({ version: 2,
    stage: "spec-review", identity: initial.identity.toJSON(), baseReviewDigest: initial.digest,
    findings: [finding], operations: [] }) });
  const audit = review.audit.at(-1);
  const fact = new ActivityReviewPublication({ generation: review.generation, identity: review.identity.toJSON(),
    reviewDigest: review.digest, relation: audit.relation, stage: audit.stage, outcome: audit.outcome });
  const activity = { id: "review-publication-retained", nodeId: "spec-review", nodeKey: "spec-review",
    timing: { finishedAt: observedAt }, reviewPublication: fact };
  const document = FlowArtifactSpecReviewActivityEvidenceDocument.forActivity({ activity, review,
    sourcePath: "revisions/001/review.json", observedAt });
  return { initial, review, fact, activity, document };
}

test("Activity evidence keeps note observations and canonical Spec Review records as separate nominal values", () => {
  const { document, activity, review } = fixture();
  const bytes = Buffer.from(JSON.stringify(document.toJSON()));
  const retained = content.parse(bytes);
  assert.ok(retained instanceof FlowArtifactSpecReviewActivityEvidenceDocument);
  assert.ok(retained.review instanceof CanonicalSpecReview);
  assert.deepEqual(retained.toJSON(), document.toJSON());
  assert.equal(retained.assertActivity(activity), retained);
  assert.deepEqual(retained.review.toJSON(), review.toJSON());
  const { review: removed, ...note } = document.toJSON();
  const observation = content.parse(Buffer.from(JSON.stringify(note)));
  assert.ok(observation instanceof FlowArtifactActivityEvidenceDocument);
  assert.equal(observation instanceof FlowArtifactSpecReviewActivityEvidenceDocument, false);
  assert.deepEqual(observation.toJSON(), note);
  assert.deepEqual(Object.keys(observation.toJSON()).sort(), ["activityId", "note", "observedAt", "owner", "schemaRevision", "source"]);
});

test("retained Review bytes preserve the earlier findings after a normal replacement with no findings", () => {
  const { review, document } = fixture();
  const bytes = Buffer.from(JSON.stringify(document.toJSON()));
  const next = mergeSpecReviewDelta({ review, delta: new SpecReviewDelta({ version: 2, stage: "spec-review",
    identity: review.identity.toJSON(), baseReviewDigest: review.digest, findings: [], operations: [] }) });
  assert.deepEqual(next.findings.findings, []);
  const retained = content.parse(bytes);
  assert.deepEqual(retained.review.findings.findings, [finding]);
  assert.equal(retained.review.generation, 1);
  assert.equal(retained.review.digest, review.digest);
  assert.deepEqual(content.assertPublication(bytes, bytes).toJSON(), document.toJSON());
  const altered = document.toJSON();
  altered.note = "Changed retained observation.";
  assert.throws(() => content.assertPublication(bytes, Buffer.from(JSON.stringify(altered))), /cannot replace existing bytes/);
});

test("an untimed Activity requires an explicit saved writer time and never receives a synthesized Activity timestamp", () => {
  const { activity, review } = fixture();
  const untimed = { ...activity, timing: null, result: { confirmedAt: null } };
  assert.throws(() => FlowArtifactSpecReviewActivityEvidenceDocument.forActivity({ activity: untimed,
    review, sourcePath: "revisions/001/review.json" }), /observedAt must be a non-empty string/);
  const document = FlowArtifactSpecReviewActivityEvidenceDocument.forActivity({ activity: untimed,
    review, sourcePath: "revisions/001/review.json", observedAt });
  assert.equal(document.observedAt, observedAt);
  assert.equal(document.assertActivity(untimed), document);
  assert.equal(untimed.timing, null);
  assert.equal(untimed.result.confirmedAt, null);
  const timed = { ...untimed, result: { confirmedAt: "2026-10-13T03:00:01.000Z" } };
  assert.throws(() => document.assertActivity(timed), /saved publication and observation time/);
});

test("Spec Review evidence rejects unknown meaning, inconsistent source and changed publication identity", () => {
  const { document, activity, fact } = fixture();
  for (const mutate of [
    (value) => { value.futureMeaning = true; },
    (value) => { value.review.futureMeaning = true; },
    (value) => { value.note = "  Normalized observation text.  "; },
    (value) => { value.source.hash = "b".repeat(64); },
    (value) => { value.source.path = "revisions/002/review.json"; },
    (value) => { value.source.pointer = "/findings"; },
    (value) => { value.owner.nodeId = "spec-triage"; },
    (value) => { value.review.audit.at(-1).activityId = "different-publication"; },
  ]) {
    const value = document.toJSON();
    mutate(value);
    assert.throws(() => content.parse(Buffer.from(JSON.stringify(value))), Error);
  }
  for (const changed of [
    { ...activity, id: "different-publication" },
    { ...activity, nodeKey: "different-key" },
    { ...activity, timing: { finishedAt: "2026-10-13T03:00:01.000Z" } },
    { ...activity, reviewPublication: new ActivityReviewPublication({ ...fact.toJSON(), generation: 2 }) },
    { ...activity, reviewPublication: new ActivityReviewPublication({ ...fact.toJSON(), reviewDigest: "b".repeat(64) }) },
    { ...activity, reviewPublication: new ActivityReviewPublication({ ...fact.toJSON(), identity: {
      ...fact.identity.toJSON(), digest: "b".repeat(64) } }) },
    { ...activity, reviewPublication: new ActivityReviewPublication({ ...fact.toJSON(), stage: "spec-triage" }) },
    { ...activity, reviewPublication: new ActivityReviewPublication({ ...fact.toJSON(), outcome: "no-op" }) },
  ]) assert.throws(() => document.assertActivity(changed), Error);
});

test("catalog association checks full-byte addresses only for the new canonical Spec Review observation", () => {
  const { document, activity } = fixture();
  const bytes = Buffer.from(JSON.stringify(document.toJSON()));
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const artifact = FLOW_ARTIFACT_CONTRACTS.activityEvidence({ nodeId: activity.nodeId, digest });
  const descriptor = { activityId: activity.id, relativePath: artifact.relativePath,
    slot: artifact.publication({ mediaType: "application/json", updater: activity.nodeId }).authoritySlot };
  assert.deepEqual(content.assertCatalogAssociation({ bytes, descriptor, activity }).toJSON(), document.toJSON());
  const wrong = FLOW_ARTIFACT_CONTRACTS.activityEvidence({ nodeId: activity.nodeId, digest: "b".repeat(64) });
  assert.throws(() => content.assertCatalogAssociation({ bytes, descriptor: { ...descriptor,
    relativePath: wrong.relativePath }, activity }), /address does not match its exact bytes/);
  const { review: removed, ...note } = document.toJSON();
  assert.deepEqual(content.assertCatalogAssociation({ bytes: Buffer.from(JSON.stringify(note)),
    descriptor: { ...descriptor, relativePath: wrong.relativePath }, activity }).toJSON(), note);
});
