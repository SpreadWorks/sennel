import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { FlowExecutionContract } from "../../src/flow/lib/flow-execution-contract.js";
import { readStoredPromptExecutionEpisodeFromView } from "../../src/flow/lib/canonical-prompt-execution.js";
import { SpecsMigrationRevisionSix } from "../../src/lib/specs-migration.js";
import { ProcessEvidenceArtifactMigration, ProcessEvidenceMigrationRefusal } from "../../src/lib/process-evidence-artifact-migration.js";
import { ProcessExecutionRecoveryCall, executionValueDigest } from "../../src/lib/process-execution-values.js";
import { PromptExecutionReservationContinuation } from "../../src/lib/prompt-execution-journal.js";
import { CanonicalProcessEvidenceFixture } from "../support/infrastructure/canonical-process-evidence-fixture.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../test-environment.js";

const seed = new CanonicalProcessEvidenceFixture(new URL("../fixtures/process-evidence-ancestors-v1/", import.meta.url));
const provenance = seed.provenance;
const options = { skip: process.platform === "win32" ? "Immutable Linux producer has POSIX absolute checkout paths; Windows native acceptance is unverified" : false };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function assertRevocationIdentities(oldCalls, currentCalls) {
  assert.equal(currentCalls.length, oldCalls.length);
  for (const [index, wire] of currentCalls.entries()) {
    const restored = new ProcessExecutionRecoveryCall(wire);
    assert.equal(restored.startPermitted, false);
    assert.equal(restored.receipt, null);
    assert.notEqual(restored.revocation, null);
    assert.equal(restored.revocation.schemaVersion, 3);
    assert.equal(restored.revocation.evidenceDigest, executionValueDigest(oldCalls[index].revocation));
  }
}

test("genuine consumed ancestor generations migrate with all original claims, revocation identities and budget", options, t => {
  const root = createTmpDir("process-evidence-ancestors-");
  let completed = false;
  t.after(() => {
    if (completed) removeTmpDir(root);
    else testTemporaryRoot().retainOnUnconfirmedExecution();
  });
  assert.equal(provenance.originalOwnerReleased, true);
  assert.equal(provenance.normalCoordinatorClosed, true);
  assert.equal(provenance.notPhysicalRuntimeOwnershipFixture, true);
  assert.equal(provenance.continuation.history.length, 2);
  assert.ok(provenance.continuation.calls.length > 0);
  seed.materialize(root);
  writeJson(root, ".sennel/config.json", { flow: { specDir: "specs" } });
  const specId = provenance.specId;
  const output = { errors: [], log() {}, error(message) { this.errors.push(message); } };
  assert.equal(new SpecsMigrationRevisionSix(root, { specId, logger: output }).run().complete,
    true, output.errors.join("\n"));
  const contract = FlowExecutionContract.fromJSON(provenance.executionContract);
  const readEpisode = manager => manager.readCanonicalTransitionView({ specId, read: view =>
    readStoredPromptExecutionEpisodeFromView(view, contract, null, { currentAttempt: false }) });
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const episode = readEpisode(manager);
  assert.deepEqual(episode.budget, provenance.savedBudget);
  const wire = episode.scopes.flatMap(scope => scope.batches).find(batch => batch.reservationContinuation !== undefined).reservationContinuation;
  const marker = PromptExecutionReservationContinuation.fromJSON(wire);
  assert.equal(marker.pending, false);
  assert.equal(marker.id, provenance.continuationId, "the published identity includes both original ancestor generations");
  assert.deepEqual(marker.previousClaim, provenance.continuation.previousClaim);
  assert.deepEqual(marker.consumedClaim, provenance.continuation.consumedClaim);
  assert.equal(marker.physicalEvidence.digest, provenance.continuation.physicalEvidence.digest);
  assertRevocationIdentities(provenance.continuation.calls, marker.calls);
  assert.equal(marker.history.length, 2);
  for (const [index, entry] of marker.history.entries()) {
    const old = provenance.continuation.history[index];
    assert.deepEqual(entry.previousClaim, old.previousClaim);
    assert.deepEqual(entry.consumedClaim, old.consumedClaim);
    assert.equal(entry.physicalEvidence.digest, old.physicalEvidence.digest);
    assertRevocationIdentities(old.calls, entry.calls);
  }
  const count = manager.activityLedger(specId).length;
  manager.addNote("Retain all consumed ancestor proof identities", { specId });
  const restarted = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  assert.equal(restarted.activityLedger(specId).length, count + 1);
  assert.deepEqual(readEpisode(restarted).budget, provenance.savedBudget);
  completed = true;
});

test("a later consumed immutable event cannot authorize a stale pending frontier with consumed ancestors", options, () => {
  const entries = seed.processArtifacts();
  const pending = entries.find(entry => entry.descriptor.logicalKey === "prompt.execution.event"
    && entry.json.record.snapshot?.batches.some(batch => batch.reservationContinuation?.history.length === 2
      && batch.reservationContinuation.consumedClaim === null));
  assert.notEqual(pending, undefined, "the previous producer actually saved this pending checkpoint");
  const stale = entries.map(entry => entry.descriptor.logicalKey === "prompt.execution.progress"
    ? entry.withJSON(pending.json) : entry);
  const before = stale.map(entry => hash(entry.bytes));
  assert.throws(() => new ProcessEvidenceArtifactMigration(stale), error => error instanceof ProcessEvidenceMigrationRefusal
    && error.code === "UNSAFE_SOURCE_FORMAT" && error.message.includes("unused previous process reservation"));
  assert.deepEqual(stale.map(entry => hash(entry.bytes)), before);
  assert.ok(new ProcessEvidenceArtifactMigration(seed.processArtifacts()).replacements.length > 0);
});
