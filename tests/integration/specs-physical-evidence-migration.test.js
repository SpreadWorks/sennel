import { CanonicalProcessEvidenceFixture } from "../support/infrastructure/canonical-process-evidence-fixture.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { FlowExecutionContract } from "../../src/flow/lib/flow-execution-contract.js";
import { readStoredPromptExecutionEpisodeFromView } from "../../src/flow/lib/canonical-prompt-execution.js";
import { SpecsMigrationRevisionSix } from "../../src/lib/specs-migration.js";
import { ProcessExecutionRecoveryEvidenceSummary, ProcessExecutionStopReceipt, executionValueDigest } from "../../src/lib/process-execution-values.js";
import { StoredFlowPersistenceSnapshot } from "../support/assertions/canonical-persistence.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../test-environment.js";

const fixture = new CanonicalProcessEvidenceFixture(new URL("../fixtures/process-evidence-physical-v1/", import.meta.url));
const provenance = fixture.provenance;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("authentic previous physical accounting migrates and reloads with its original completion identity and budget", {
  skip: process.platform === "win32" ? "Immutable Linux producer has POSIX absolute checkout paths; Windows native acceptance is unverified" : false,
}, t => {
  const root = createTmpDir("specs-physical-evidence-migration-");
  let completed = false;
  t.after(() => {
    if (completed) removeTmpDir(root);
    else testTemporaryRoot().retainOnUnconfirmedExecution();
  });
  assert.equal(provenance.sourceRuntimeRecordVersion, 9);
  assert.equal(provenance.originalOwnerReleased, true);
  assert.equal(provenance.normalCoordinatorClosed, true);
  assert.equal(provenance.notPhysicalRuntimeOwnershipFixture, true);
  assert.equal(provenance.originalChildReceipt.observation.kind, "exited");
  assert.equal(provenance.originalChildReceipt.observation.code, 0);
  fixture.materialize(root);
  writeJson(root, ".sennel/config.json", { flow: { specDir: "specs" } });
  const specId = provenance.specId;
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const before = new StoredFlowPersistenceSnapshot(root);
  assert.throws(() => manager.loadReadOnly(specId), { code: "FLOW_MIGRATION_REQUIRED" });
  const output = { errors: [], log() {}, error(message) { this.errors.push(message); } };
  const preview = new SpecsMigrationRevisionSix(root, { specId, dryRun: true, logger: output }).run();
  assert.equal(preview.complete, true, output.errors.join("\n"));
  before.assertUnchanged();
  const applied = new SpecsMigrationRevisionSix(root, { specId, logger: output }).run();
  assert.equal(applied.complete, true, output.errors.join("\n"));

  const fresh = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const contract = FlowExecutionContract.fromJSON(provenance.executionContract);
  const episode = fresh.readCanonicalTransitionView({ specId, read: view =>
    readStoredPromptExecutionEpisodeFromView(view, contract, null, { currentAttempt: false }) });
  assert.deepEqual(episode.budget, provenance.savedBudget);
  assert.deepEqual(episode.scopes, []);
  const document = JSON.parse(fs.readFileSync(path.join(root, provenance.physicalDocumentPath)));
  assert.equal(document.digest, provenance.physicalDocumentDigest, "migration preserves the original physical accounting identity");
  const summary = ProcessExecutionRecoveryEvidenceSummary.fromSaved(document.record.physicalEvidence);
  assert.equal(summary.schemaVersion, 4);
  const receipt = new ProcessExecutionStopReceipt(document.record.calls[0].receipt);
  assert.equal(receipt.schemaVersion, 4);
  assert.equal(receipt.evidenceDigest, executionValueDigest(provenance.originalChildReceipt));
  assert.equal(receipt.checkoutIdentity.matches(summary.checkoutIdentity), true);
  assert.equal(typeof document.record.physicalEvidence.checkoutIdentity.mainDevice, "number", "retained producer tokens are preserved");
  for (const name of ["flow.json", "activities.jsonl"]) {
    const original = provenance.records.find(entry => entry.relativePath.endsWith("/" + name));
    assert.equal(hash(fs.readFileSync(path.join(root, original.relativePath))), original.sha256);
  }
  const count = fresh.activityLedger(specId).length;
  fresh.addNote("Physical accounting remains usable after explicit evidence migration", { specId });
  const restarted = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  assert.equal(restarted.activityLedger(specId).length, count + 1);
  const reloaded = restarted.readCanonicalTransitionView({ specId, read: view =>
    readStoredPromptExecutionEpisodeFromView(view, contract, null, { currentAttempt: false }) });
  assert.deepEqual(reloaded.budget, provenance.savedBudget);
  completed = true;
});
