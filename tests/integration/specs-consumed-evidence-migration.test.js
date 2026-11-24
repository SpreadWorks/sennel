import { CanonicalProcessEvidenceFixture } from "../support/infrastructure/canonical-process-evidence-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { FlowExecutionContract } from "../../src/flow/lib/flow-execution-contract.js";
import { readStoredPromptExecutionEpisodeFromView } from "../../src/flow/lib/canonical-prompt-execution.js";
import { SpecsMigrationRevisionSix } from "../../src/lib/specs-migration.js";
import { PromptExecutionReservationContinuation } from "../../src/lib/prompt-execution-journal.js";
import { StoredFlowPersistenceSnapshot } from "../support/assertions/canonical-persistence.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../test-environment.js";

const fixture = new CanonicalProcessEvidenceFixture(new URL("../fixtures/process-evidence-consumed-v1/", import.meta.url));
const provenance = fixture.provenance;

test("authentic consumed reservation history migrates and reloads without changing its claim, proof identity or budget", {
  skip: process.platform === "win32" ? "Immutable Linux producer has POSIX absolute checkout paths; Windows native acceptance is unverified" : false,
}, t => {
  const root = createTmpDir("specs-consumed-evidence-migration-");
  let completed = false;
  t.after(() => {
    if (completed) removeTmpDir(root);
    else testTemporaryRoot().retainOnUnconfirmedExecution();
  });
  assert.equal(provenance.sourceRuntimeRecordVersion, 9);
  assert.equal(provenance.originalOwnerReleased, true);
  assert.equal(provenance.normalCoordinatorClosed, true);
  assert.equal(provenance.notPhysicalRuntimeOwnershipFixture, true);
  assert.notEqual(provenance.continuation.consumedClaim, null);
  assert.equal(provenance.artifactLogicalKeys.includes("execution.source.manifest"), false,
    "a genuine before-launch recovery may have no physical source publication");
  fixture.materialize(root);
  writeJson(root, ".sennel/config.json", { flow: { specDir: "specs" } });
  const specId = provenance.specId;
  const before = new StoredFlowPersistenceSnapshot(root);
  const output = { errors: [], log() {}, error(message) { this.errors.push(message); } };
  assert.equal(new SpecsMigrationRevisionSix(root, { specId, dryRun: true, logger: output }).run().complete,
    true, output.errors.join("\n"));
  before.assertUnchanged();
  assert.equal(new SpecsMigrationRevisionSix(root, { specId, logger: output }).run().complete,
    true, output.errors.join("\n"));
  const contract = FlowExecutionContract.fromJSON(provenance.executionContract);
  const readEpisode = manager => manager.readCanonicalTransitionView({ specId, read: view =>
    readStoredPromptExecutionEpisodeFromView(view, contract, null, { currentAttempt: false }) });
  const fresh = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const episode = readEpisode(fresh);
  assert.deepEqual(episode.budget, provenance.savedBudget);
  const marker = episode.scopes.flatMap(scope => scope.batches).find(batch => batch.reservationContinuation !== undefined).reservationContinuation;
  const restored = PromptExecutionReservationContinuation.fromJSON(marker);
  assert.equal(restored.pending, false);
  assert.equal(restored.id, provenance.continuationId);
  assert.deepEqual(restored.previousClaim, provenance.continuation.previousClaim);
  assert.deepEqual(restored.consumedClaim, provenance.continuation.consumedClaim);
  assert.equal(restored.physicalEvidence.digest, provenance.continuation.physicalEvidence.digest);
  assert.equal(restored.physicalEvidence.schemaVersion, 4);
  assert.equal(restored.physicalEvidence.nonExecution.schemaVersion, 2);
  assert.deepEqual(restored.calls, provenance.continuation.calls);
  assert.deepEqual(restored.history, provenance.continuation.history);
  const count = fresh.activityLedger(specId).length;
  fresh.addNote("Consumed reservation history remains readable after explicit migration", { specId });
  const restarted = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  assert.equal(restarted.activityLedger(specId).length, count + 1);
  assert.deepEqual(readEpisode(restarted).budget, provenance.savedBudget);
  completed = true;
});
