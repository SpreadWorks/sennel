import { CanonicalProcessEvidenceFixture } from "../support/infrastructure/canonical-process-evidence-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecsMigrationRevisionSix } from "../../src/lib/specs-migration.js";
import { StoredFlowPersistenceSnapshot } from "../support/assertions/canonical-persistence.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";

const fixture = new CanonicalProcessEvidenceFixture(new URL("../fixtures/process-evidence-pending-v1/", import.meta.url));
const provenance = fixture.provenance;

test("a genuine current unused reservation refuses both migration preview and apply without changing canonical authority", {
  skip: process.platform === "win32" ? "Immutable Linux producer has POSIX absolute checkout paths; Windows native acceptance is unverified" : false,
}, t => {
  const root = createTmpDir("specs-pending-evidence-migration-");
  t.after(() => removeTmpDir(root));
  assert.equal(provenance.sourceRuntimeRecordVersion, 9);
  assert.equal(provenance.originalOwnerReleased, true);
  assert.equal(provenance.normalCoordinatorClosed, true);
  assert.equal(provenance.notPhysicalRuntimeOwnershipFixture, true);
  assert.equal(provenance.continuation.consumedClaim, null);
  fixture.materialize(root);
  writeJson(root, ".sennel/config.json", { flow: { specDir: "specs" } });
  const before = new StoredFlowPersistenceSnapshot(root);
  for (const dryRun of [true, false]) {
    const output = { errors: [], log() {}, error(message) { this.errors.push(message); } };
    const result = new SpecsMigrationRevisionSix(root, { specId: provenance.specId, dryRun, logger: output }).run();
    assert.equal(result.complete, false);
    assert.match(output.errors.join("\n"), /UNSAFE_SOURCE_FORMAT.*unused previous process reservation/);
    before.assertUnchanged();
  }
});
