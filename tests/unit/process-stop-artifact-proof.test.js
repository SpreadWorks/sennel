import assert from "node:assert/strict";
import { test } from "node:test";
import { PreviousProcessStopFixture } from "../support/infrastructure/previous-process-stop-fixture.js";
import { ProcessExecutionEvidenceMigration } from "../../src/lib/process-execution-evidence-migration.js";
import { ProcessStopArtifactProof } from "../../src/lib/process-evidence-artifact-encoding.js";
import { FlowArtifactDescriptor, ArtifactAuthoritySlot } from "../../src/lib/flow-version.js";
import { ProcessExecutionStopReceipt, executionValueDigest } from "../../src/lib/process-execution-values.js";

const fixture = new PreviousProcessStopFixture();
const original = () => fixture.receipt;

test("one compact current proof binds the original producer digest without a larger aggregate document", () => {
  const source = original(), current = ProcessExecutionEvidenceMigration.retainedCompletion(source);
  const proof = new ProcessStopArtifactProof(current);
  assert.equal(proof.relativePath, `artifacts/migration/process-evidence-v6/retained-completions/${ProcessStopArtifactProof.referenceDigest(source)}.json`);
  assert.equal(JSON.parse(proof.bytes).schemaVersion, 4);
  assert.equal(proof.evidenceDigest, executionValueDigest(source));
  assert.equal(proof.bytes.length, Buffer.byteLength(JSON.stringify(source)) + 1);
  const reloaded = ProcessStopArtifactProof.fromBytes(proof.bytes, proof.relativePath);
  assert.deepEqual(reloaded.encoding.receipt(source).toArtifactJSON(), source);
  assert.deepEqual(reloaded.receipt.toJSON(), current.toJSON());
});

test("proof discovery inspects only protocol-owned receipt fields and deduplicates repeated producer references", () => {
  const source = original(), digest = ProcessStopArtifactProof.referenceDigest(source);
  const bytes = value => Buffer.from(JSON.stringify(value));
  for (const [key, value] of [
    ["source.handoff.event", { processStopEvidence: source }],
    ["spec.review", { processStop: source }],
    ["activity.evidence", { review: { processStop: source } }],
    ["impl.review", { processStop: source, attempts: [{ artifact: { payload: { processStop: source } } }] }],
  ]) assert.deepEqual(ProcessStopArtifactProof.requiredDigests(key, bytes(value)), [digest]);
  assert.deepEqual(ProcessStopArtifactProof.requiredDigests("impl.review",
    bytes({ attempts: [{ artifact: { payload: { providerResponse: { processStop: source } } } }] })), []);
  assert.deepEqual(ProcessStopArtifactProof.requiredDigests("spec.review",
    bytes({ processStop: ProcessExecutionEvidenceMigration.retainedCompletion(source).toJSON() })), []);
});

test("proof decoding refuses another digest path, unknown receipt schema and a native current receipt", () => {
  const source = original(), current = ProcessExecutionEvidenceMigration.retainedCompletion(source);
  const proof = new ProcessStopArtifactProof(current);
  assert.throws(() => ProcessStopArtifactProof.fromBytes(proof.bytes, ProcessStopArtifactProof.pathFor("a".repeat(64))), TypeError);
  assert.throws(() => ProcessStopArtifactProof.fromBytes(Buffer.from(JSON.stringify({ ...current.toJSON(), schemaVersion: 5 })), proof.relativePath), TypeError);
  assert.throws(() => new ProcessStopArtifactProof(new ProcessExecutionStopReceipt({
    ...current.toJSON(), checkoutIdentity: current.checkoutIdentity.toJSON(),
  })), TypeError);
});


test("proof discovery keeps the same reference after canonical Review key ordering", () => {
  const source = original();
  assert.deepEqual(ProcessStopArtifactProof.requiredDigests("spec.review", Buffer.from(JSON.stringify({ processStop: fixture.canonicalReceipt }))),
    ProcessStopArtifactProof.requiredDigests("spec.review", Buffer.from(JSON.stringify({ processStop: source }))));
});


test("proof descriptors use the catalog's nominal authority and refuse a different publisher", () => {
  const proof = new ProcessStopArtifactProof(ProcessExecutionEvidenceMigration.retainedCompletion(original()));
  const descriptor = publicationStep => new FlowArtifactDescriptor({
    authoritySlot: ArtifactAuthoritySlot.collectionMember({ kind: "migration-materialization",
      authority: "canonical-flow-artifacts", memberId: "receipt-proof", publicationStep }),
    relativePath: proof.relativePath, hash: "a".repeat(64), size: proof.bytes.length,
    mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
  });
  assert.equal(ProcessStopArtifactProof.assertDescriptor(descriptor("system")), true);
  assert.throws(() => ProcessStopArtifactProof.assertDescriptor(descriptor("spec-review")), TypeError);
});
