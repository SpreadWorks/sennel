import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FlowArtifactCatalog, FlowArtifactDescriptor, ArtifactAuthoritySlot } from "../../../src/lib/flow-version.js";
import { ProcessStopArtifactProof } from "../../../src/lib/process-evidence-artifact-encoding.js";
import { ProcessExecutionEvidenceMigration } from "../../../src/lib/process-execution-evidence-migration.js";
import { executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { PreviousProcessStopFixture } from "../../support/infrastructure/previous-process-stop-fixture.js";

test("captured proof readers enforce catalog bytes independently of equal JSON values", async () => {
  const source = new PreviousProcessStopFixture().receipt;
  const proof = new ProcessStopArtifactProof(ProcessExecutionEvidenceMigration.retainedCompletion(source));
  const bytes = proof.bytes;
  const descriptor = new FlowArtifactDescriptor({
    authoritySlot: ArtifactAuthoritySlot.collectionMember({ kind: "migration-materialization",
      authority: "canonical-flow-artifacts", memberId: "receipt-proof", publicationStep: "system" }),
    relativePath: proof.relativePath, hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length, mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
  });
  const catalog = new FlowArtifactCatalog({ artifacts: [descriptor] });
  const bodies = [Buffer.from(JSON.stringify({ processStop: source }))];
  const encoding = await catalog.processStopEncodingSnapshot("spec.review", bodies, async selected => {
    assert.equal(selected.relativePath, descriptor.relativePath);
    assert.equal(selected.hash, descriptor.hash);
    return Buffer.from(bytes);
  });
  assert.deepEqual(encoding.receipt(source).toArtifactJSON(), source);
  assert.equal(encoding.receipt(source).evidenceDigest, executionValueDigest(source));

  const altered = Buffer.from(bytes);
  assert.equal(altered[altered.length - 1], 10);
  altered[altered.length - 1] = 32;
  assert.equal(altered.length, bytes.length);
  assert.deepEqual(JSON.parse(altered.toString("utf8")), JSON.parse(bytes.toString("utf8")));
  assert.throws(() => catalog.processStopEncodingFromCaptured("spec.review", bodies, () => altered),
    /artifact content does not match the catalog/);
  await assert.rejects(catalog.processStopEncodingSnapshot("spec.review", bodies, async () => altered),
    /artifact content does not match the catalog/);
});
