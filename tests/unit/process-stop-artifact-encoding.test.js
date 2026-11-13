import assert from "node:assert/strict";
import { test } from "node:test";
import { PreviousProcessStopFixture } from "../support/infrastructure/previous-process-stop-fixture.js";
import { ProcessExecutionStopReceipt, ProcessStopArtifactEncoding, executionValueDigest } from "../../src/lib/process-execution-values.js";
import { ProcessExecutionEvidenceMigration } from "../../src/lib/process-execution-evidence-migration.js";

const fixture = new PreviousProcessStopFixture();
const original = () => fixture.receipt;
const current = value => ProcessExecutionEvidenceMigration.retainedCompletion(value);

test("explicit artifact proof retains producer bytes and digest while exposing only a current typed receipt", () => {
  const source = original();
  const encoding = new ProcessStopArtifactEncoding([current(source)]);
  const receipt = ProcessExecutionStopReceipt.fromArtifact(source, encoding);
  assert.equal(receipt.schemaVersion, 4);
  assert.equal(receipt.toJSON().schemaVersion, 4);
  assert.deepEqual(receipt.toArtifactJSON(), source);
  assert.equal(receipt.evidenceDigest, executionValueDigest(source));
  assert.equal(ProcessExecutionStopReceipt.fromArtifact(receipt), receipt);
  const reloaded = ProcessStopArtifactEncoding.fromJSON(encoding.toJSON()).receipt(source);
  assert.deepEqual(reloaded.toArtifactJSON(), source);
  assert.deepEqual(reloaded.toJSON(), receipt.toJSON());
});

test("ordinary readers and missing or different artifact proofs refuse previous receipts", () => {
  const source = original();
  assert.throws(() => new ProcessExecutionStopReceipt(source), TypeError);
  assert.throws(() => ProcessExecutionStopReceipt.fromArtifact(source), TypeError);
  assert.throws(() => new ProcessStopArtifactEncoding([source]), TypeError);
  assert.throws(() => ProcessExecutionStopReceipt.fromArtifact(source, new ProcessStopArtifactEncoding([])), TypeError);
  const encoding = new ProcessStopArtifactEncoding([current(source)]);
  for (const altered of [{ ...source, unknown: true }, { ...source, callId: "11111111-1111-4111-8111-111111111111" }]) {
    assert.throws(() => encoding.receipt(altered), TypeError);
  }
  assert.throws(() => ProcessExecutionStopReceipt.fromArtifact(source, {}), TypeError);
});

test("current numeric producer serialization remains current even when an artifact proof is available", () => {
  const source = original(), wire = current(source).toJSON();
  const encoding = new ProcessStopArtifactEncoding([wire]);
  const receipt = ProcessExecutionStopReceipt.fromArtifact(wire, encoding);
  assert.deepEqual(receipt.toArtifactJSON(), wire);
  assert.equal(receipt.toArtifactJSON().schemaVersion, 4);
  assert.equal(receipt.evidenceDigest, executionValueDigest(source));
  const native = new ProcessExecutionStopReceipt({ ...wire, checkoutIdentity: receipt.checkoutIdentity.toJSON() });
  assert.deepEqual(native.toArtifactJSON(), native.toJSON());
  assert.throws(() => new ProcessStopArtifactEncoding([native]), TypeError);
});

test("artifact encoding owns immutable exact proofs and rejects unknown document revisions and fields", () => {
  const source = original(), proof = current(source).toJSON();
  const encoding = new ProcessStopArtifactEncoding([proof, proof]);
  proof.checkoutIdentity.mainInode += 1;
  encoding.toJSON().receipts[0].checkoutIdentity.mainInode += 2;
  assert.deepEqual(encoding.receipt(source).toArtifactJSON(), source);
  assert.equal(encoding.receipts.length, 1);
  assert.equal(Object.isFrozen(encoding.receipts), true);
  assert.throws(() => ProcessStopArtifactEncoding.fromJSON({ ...encoding.toJSON(), version: 2 }), TypeError);
  assert.throws(() => ProcessStopArtifactEncoding.fromJSON({ ...encoding.toJSON(), unknown: true }), TypeError);
});


test("artifact proof matches the same producer receipt after canonical object-key ordering", () => {
  const source = original();
  const receipt = new ProcessStopArtifactEncoding([current(source)]).receipt(fixture.canonicalReceipt);
  assert.deepEqual(receipt.toArtifactJSON(), source);
  assert.equal(receipt.evidenceDigest, executionValueDigest(source));
});


test("one physical call cannot acquire conflicting retained receipt proofs", () => {
  const proof = current(original());
  const conflicting = new ProcessExecutionStopReceipt({ ...proof.toJSON(), outcomeDigest: "b".repeat(64) });
  assert.throws(() => new ProcessStopArtifactEncoding([proof, conflicting]), TypeError);
});
