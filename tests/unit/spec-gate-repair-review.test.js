import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { initialCanonicalSpecReview, SpecReviewDelta, mergeSpecReviewDelta } from "../../src/flow/lib/spec-review-artifacts.js";
import { SpecGateRepairReviewFacts } from "../../src/flow/lib/spec-gate-repair-review.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const baseRevision = `sha256:${"a".repeat(64)}`;
const sourceSpec = { goal: "Previously reviewed plan", background: "Original" };
const target = { entity: "spec", field: "background" };
const gateIdentity = { sourceArtifact: "gate/result.json", sourceStep: "spec-gate", sourceFindingId: "G1", fingerprint: "c".repeat(64) };
const acceptedGroups = [{ index: 0, findingIdentities: [gateIdentity], operations: [{ kind: "edit-text-field", target }] }];
function reviewSource(findings = []) {
  const bytes = Buffer.from(`${JSON.stringify(sourceSpec, null, 2)}\n`);
  let review = initialCanonicalSpecReview({ specId: "001-review", revision: 1, bytes });
  function apply(stage, entries) {
    review = mergeSpecReviewDelta({ review, delta: new SpecReviewDelta({ version: 2, stage,
      identity: review.identity.toJSON(), baseReviewDigest: review.digest, findings: entries, operations: [] }) });
  }
  apply("spec-review", findings.map(({ disposition, evidence, allowedTargets, ...finding }) => finding));
  if (findings.length) apply("spec-triage", findings.map(({ findingId, disposition, evidence, allowedTargets }) =>
    ({ findingId, disposition, evidence, allowedTargets })));
  return { review, snapshotBytes: bytes, descriptor: { relativePath: "reviews/spec/001.json", hash: review.digest } };
}
function inputs(sourceReview, resultSpec = sourceSpec) {
  return { sourceReview, baseRevision, resultSpec, acceptedGroups,
    resultRevision: { digest: hash(JSON.stringify(resultSpec)), byteLength: Buffer.byteLength(JSON.stringify(resultSpec)) } };
}
function blocking() {
  return { findingId: "F1", kind: "blocking", title: "Missing preservation", issue: "Preservation is unclear",
    target: "background", requiredChange: "Make preservation explicit", whyBlocking: "The plan could delete retained behavior",
    body: "Clarify preservation in the background", disposition: "apply", evidence: "The rule requires preservation",
    allowedTargets: [{ target, operationKinds: ["edit-text-field"] }] };
}

test("exact previously reviewed input can be reused without moving the source finding identity", () => {
  const source = reviewSource();
  const facts = new SpecGateRepairReviewFacts(inputs(source, { background: "Original", goal: sourceSpec.goal }));
  assert.equal(facts.reviewInputPreserved, true);
  assert.equal(facts.requiresReview, false);
  assert.equal(facts.reason, "exact-reviewed-input-preserved");
  assert.deepEqual(facts.sourceReviewIdentity, source.review.identity.toJSON());
  assert.equal(facts.sourceReviewIdentity.revision, 1);
  assert.notEqual(`sha256:${facts.sourceReviewIdentity.digest}`, baseRevision);
});

test("changed input and missing proof require review even when the prior review had no findings", () => {
  for (const source of [null, { ...reviewSource(), snapshotBytes: null }, reviewSource()]) {
    const facts = new SpecGateRepairReviewFacts(inputs(source, { ...sourceSpec, background: "Changed" }));
    assert.equal(facts.requiresReview, true);
    assert.equal(facts.reviewInputPreserved, false);
  }
});

test("accepted edits never resolve blocking review findings and the audit preserves complete identities", () => {
  const source = reviewSource([blocking()]);
  const facts = new SpecGateRepairReviewFacts(inputs(source));
  assert.equal(facts.reviewInputPreserved, true);
  assert.equal(facts.unresolvedBlocking, true);
  assert.equal(facts.requiresReview, true);
  const finding = facts.toJSON().findings[0];
  assert.deepEqual(finding.finding, blocking());
  assert.equal(finding.identity.sourceArtifact, "reviews/spec/001.json");
  assert.equal(finding.identity.sourceStep, "spec-review");
  assert.equal(finding.identity.sourceFindingId, "F1");
  assert.match(finding.identity.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(finding.relatedChanges, [{ groupIndex: 0, operationIndex: 0, target, gateFindingIdentities: [gateIdentity] }]);
});

test("review preservation rejects stale snapshots and tampered durable facts", () => {
  const source = reviewSource();
  assert.throws(() => new SpecGateRepairReviewFacts(inputs({ ...source, snapshotBytes: Buffer.from("{}") })), /original revision identity/);
  const input = inputs(source, { ...sourceSpec, background: "Changed" });
  const facts = new SpecGateRepairReviewFacts(input);
  const saved = JSON.parse(JSON.stringify(facts.toJSON()));
  assert.deepEqual(SpecGateRepairReviewFacts.fromJSON(saved, input).toJSON(), saved);
  assert.throws(() => SpecGateRepairReviewFacts.fromJSON({ ...saved, requiresReview: false }, input), /differ/);
  assert.throws(() => SpecGateRepairReviewFacts.fromJSON({ ...saved, sourceReviewIdentity: { ...saved.sourceReviewIdentity, revision: 2 } }, input), /differ/);
});

test("an initial empty review is not evidence of reviewer execution", () => {
  const bytes = Buffer.from(`${JSON.stringify(sourceSpec, null, 2)}\n`);
  const review = initialCanonicalSpecReview({ specId: "001-review", revision: 1, bytes });
  const source = { review, snapshotBytes: bytes, descriptor: { relativePath: "reviews/spec/seed.json", hash: review.digest } };
  const facts = new SpecGateRepairReviewFacts(inputs(source));
  assert.equal(facts.reviewInputPreserved, false);
  assert.equal(facts.requiresReview, true);
});
