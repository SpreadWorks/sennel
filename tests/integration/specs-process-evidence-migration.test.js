import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { SpecsMigrationRevisionSix, CanonicalRevisionRootTransaction, inspectFlowMigrationRequirements } from "../../src/lib/specs-migration.js";
import { resolveMigrationSpecRoot } from "../../src/lib/migration-spec-root.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { FlowExecutionContract } from "../../src/flow/lib/flow-execution-contract.js";
import { readStoredPromptExecutionEpisodeFromView } from "../../src/flow/lib/canonical-prompt-execution.js";
import { buildCurrentFlowDefinition } from "../../src/flow/definition.js";
import { ProcessExecutionStopReceipt, executionValueDigest } from "../../src/lib/process-execution-values.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";
import { StoredFlowPersistenceSnapshot } from "../support/assertions/canonical-persistence.js";
import { testTemporaryRoot } from "../test-environment.js";
import { initGitRepo } from "../support/infrastructure/git-repo.js";

const fixture = new URL("../fixtures/process-evidence-v1/", import.meta.url);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const source = JSON.parse(fs.readFileSync(new URL("provenance.json", fixture)));
const logger = () => ({ errors: [], log() {}, error(value) { this.errors.push(value); } });
const options = { skip: process.platform === "win32" ? "Immutable POSIX checkout evidence fixture; Windows native acceptance is unverified" : false };

function withFixture(name, body) {
  test(name, options, t => {
    const root = createTmpDir("process-evidence-migration-");
    // The isolated public CLI belongs to this fixture's repository. Without
    // its own Git boundary, normal worktree CLI selection chooses the outer
    // repository's source instead of the candidate being tested.
    initGitRepo(root);
    let completed = false;
    t.after(() => {
      if (completed) removeTmpDir(root);
      else testTemporaryRoot().retainOnUnconfirmedExecution();
    });
    assert.equal(source.originalOwnerReleased, true);
    assert.equal(source.normalCoordinatorExitCode, 0);
    assert.equal(source.notPhysicalRuntimeOwnershipFixture, true);
    for (const record of source.records) {
      const bytes = fs.readFileSync(new URL(record.relativePath, fixture));
      assert.equal(bytes.length, record.bytes);
      assert.equal(hash(bytes), record.sha256);
    }
    // Only canonical data is copied. Old runtime/locks are absent and retained
    // checkout identities stay byte-exact, rather than becoming new authority.
    fs.cpSync(new URL("specs/", fixture), path.join(root, "specs"), { recursive: true });
    writeJson(root, ".sennel/config.json", { flow: { specDir: "specs" } });
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: source.specId });
    const result = body({ root, manager, specId: source.specId, location: manager.specLocation(source.specId) });
    assert.equal(result?.then, undefined, "fixture body must complete synchronously");
    completed = true;
  });
}

function migratedReadback({ root, specId, location }) {
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const state = manager.loadReadOnly(specId);
  assert.equal(state.schemaRevision, source.sourceFlowSchemaRevision);
  const contract = FlowExecutionContract.fromJSON(source.executionContract);
  const episode = manager.readCanonicalTransitionView({ specId, read: view =>
    readStoredPromptExecutionEpisodeFromView(view, contract, null, { currentAttempt: false }) });
  const expected = structuredClone(source.savedSnapshot);
  for (const batch of expected.batches) for (const stop of batch.processStops ?? []) stop.receipt.schemaVersion = 4;
  assert.deepEqual(episode.scopes.map(scope => scope.toJSON()), [expected]);
  assert.deepEqual(episode.budget, source.savedSnapshot.budget);
  for (const batch of episode.scopes[0].batches) for (const stop of batch.processStops ?? []) {
    const old = source.savedSnapshot.batches.flatMap(value => value.processStops ?? []).find(value => value.receipt.callId === stop.receipt.callId);
    assert.equal(new ProcessExecutionStopReceipt(stop.receipt).evidenceDigest, executionValueDigest(old.receipt));
  }
  const migration = JSON.parse(fs.readFileSync(location.resolve("artifacts/migration/process-evidence-v6/receipt.json")));
  assert.equal(migration.processEvidenceRevision, 6);
  assert.ok(migration.evidenceChanges.length >= 2);
  for (const change of migration.evidenceChanges) {
    const original = source.records.find(record => record.relativePath === path.posix.join(location.relativeDirectory, change.relativePath));
    assert.equal(hash(fs.readFileSync(location.resolve(change.sourcePath))), original.sha256);
    assert.equal(hash(fs.readFileSync(location.resolve(change.relativePath))), change.targetHash);
  }
  for (const relativePath of ["flow.json", "activities.jsonl"]) {
    const original = source.records.find(record => record.relativePath === path.posix.join(location.relativeDirectory, relativePath));
    assert.equal(hash(fs.readFileSync(location.resolve(relativePath))), original.sha256);
  }
  assert.equal(inspectFlowMigrationRequirements({ root, specId }).classification, "current");
  const count = manager.activityLedger(specId).length;
  manager.addNote("Process evidence migration verified", { specId });
  assert.equal(new FlowManager({ root, mainRoot: root, inWorktree: false, specId }).activityLedger(specId).length, count + 1);
}

withFixture("authentic old Prompt evidence is refused before mutation, explicitly migrated and consumed with its original budget", value => {
  const before = new StoredFlowPersistenceSnapshot(value.root);
  assert.throws(() => value.manager.loadReadOnly(value.specId), { code: "FLOW_MIGRATION_REQUIRED" });
  assert.deepEqual(inspectFlowMigrationRequirements(value).requiredRevisions, [6]);
  const output = logger();
  assert.equal(new SpecsMigrationRevisionSix(value.root, { specId: value.specId, dryRun: true, logger: output }).run().complete, true, output.errors.join("\n"));
  before.assertUnchanged();
  assert.equal(new SpecsMigrationRevisionSix(value.root, { specId: value.specId, logger: output }).run().complete, true, output.errors.join("\n"));
  migratedReadback(value);
});

withFixture("the public specs revision-six CLI previews without writes and publishes the actual historical Prompt result", value => {
  const execute = extra => spawnSync(process.execPath, [path.resolve("src/sennel.js"), "migrate", "specs", "--to", "6", "--spec", value.specId, ...extra], {
    cwd: value.root, encoding: "utf8", env: { ...process.env, SENNEL_WORK_ROOT: value.root, SENNEL_SOURCE_ROOT: value.root },
  });
  const before = new StoredFlowPersistenceSnapshot(value.root);
  const preview = execute(["--dry-run"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /process-evidence-v6/);
  before.assertUnchanged();
  const applied = execute([]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /migrate specs reached revision 6/);
  migratedReadback(value);
});

withFixture("an interrupted process-evidence root replacement recovers through the existing public migration runner", value => {
  const specRoot = resolveMigrationSpecRoot(value.root).root;
  assert.throws(() => new CanonicalRevisionRootTransaction({ root: value.root, specRoot, specId: value.specId,
    definition: buildCurrentFlowDefinition(), revision: 6,
    faultInjector({ phase }) { if (phase === "source-backed-up") throw new Error("interrupted evidence migration"); },
  }).apply(), /interrupted evidence migration/);
  const output = logger();
  assert.equal(new SpecsMigrationRevisionSix(value.root, { specId: value.specId, logger: output }).run().complete, true, output.errors.join("\n"));
  migratedReadback(value);
});
