import assert from "node:assert/strict";
import { initGitRepo } from "../support/infrastructure/git-repo.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";
import { StoredFlowPersistenceSnapshot } from "../support/assertions/canonical-persistence.js";
import { SpecsMigrationRevisionFive, CanonicalRevisionRootTransaction, inspectFlowMigrationRequirements } from "../../src/lib/specs-migration.js";
import { resolveMigrationSpecRoot } from "../../src/lib/migration-spec-root.js";
import { FlowArtifactCatalog, FlowArtifactDescriptor, FlowVersionAuthorityScope, FlowVersionLocation } from "../../src/lib/flow-version.js";
import { CurrentFlowState, CurrentFlowVersionStore } from "../../src/flow/lib/current-flow-state.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { buildCurrentFlowDefinition } from "../../src/flow/definition.js";
import { readRetryBaseline, retryEvidenceRouteForNode } from "../../src/flow/lib/retry-recovery.js";
import { captureExecutionObservations } from "../../src/lib/flow-execution-observation.js";

const roots = [];
const definition = buildCurrentFlowDefinition();
const createdId = "portable-state-created";
const sourceId = "source-checkpoint-implement-direct";
const logger = () => ({ lines: [], errors: [], log(value) { this.lines.push(value); }, error(value) { this.errors.push(value); } });
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function project(fixture, specId) {
  const root = createTmpDir("sennel-portable-specs-");
  roots.push(root);
  initGitRepo(root);
  fs.cpSync(path.resolve("tests/fixtures", fixture, "specs"), path.join(root, "specs"), { recursive: true });
  writeJson(root, ".sennel/config.json", { flow: { specDir: "specs" } });
  const location = new FlowVersionLocation({ repositoryRoot: root, authorityScope: FlowVersionAuthorityScope.canonical(), specRoot: "specs", specId, version: 1 });
  return { root, specId, location };
}

function runner(root, options = {}) {
  return new SpecsMigrationRevisionFive(root, { logger: logger(), ...options });
}

function refreshDescriptor(location, relativePath) {
  const previous = FlowArtifactCatalog.fromSerialized(JSON.parse(fs.readFileSync(location.catalogFile, "utf8")));
  const bytes = fs.readFileSync(location.resolve(relativePath));
  fs.writeFileSync(location.catalogFile, `${JSON.stringify(new FlowArtifactCatalog({ artifacts: previous.artifacts.map((entry) => (
    entry.relativePath === relativePath ? new FlowArtifactDescriptor({ ...entry.toJSON(), hash: hash(bytes), size: bytes.length }) : entry
  )) }).toJSON(), null, 2)}\n`);
}

afterEach(() => { while (roots.length > 0) removeTmpDir(roots.pop()); });

describe("explicit portable Specs format migration", () => {
  it("routes the selected public revision-five CLI through read-only preview and explicit apply", () => {
    const { root, location } = project("flow-state-v4", createdId);
    const execute = (extra = []) => spawnSync(process.execPath, [path.resolve("src/sennel.js"), "migrate", "specs",
      "--to", "5", "--spec", createdId, ...extra], { cwd: root, encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root } });
    const snapshot = new StoredFlowPersistenceSnapshot(root);
    const preview = execute(["--dry-run"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /portable-state-v5/);
    snapshot.assertUnchanged();
    const applied = execute();
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /migrate specs reached revision 5/);
    assert.equal(new CurrentFlowVersionStore({ location, definition }).load().schemaRevision, 5);
  });

  it("previews without writes, preserves prior semantic state and reads the migrated result through a new Store", () => {
    const { root, specId, location } = project("flow-state-v4", createdId);
    const original = fs.readFileSync(location.flowStateFile);
    const raw = JSON.parse(original.toString("utf8"));
    const originalActivities = fs.readFileSync(location.activitiesFile);
    assert.equal(hash(original), JSON.parse(fs.readFileSync("tests/fixtures/flow-state-v4/provenance.json", "utf8")).sourceFlowHash);
    assert.throws(() => new CurrentFlowState(raw, { definition }), /unsupported schemaRevision: 4/);
    const snapshot = new StoredFlowPersistenceSnapshot(root);
    assert.equal(inspectFlowMigrationRequirements({ root, specId }).requiredRevisions.includes(5), true);
    assert.equal(runner(root, { dryRun: true }).run().complete, true);
    snapshot.assertUnchanged();
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
    const migration = runner(root);
    assert.equal(migration.run().complete, true, migration.logger.errors.join("\n"));
    const loaded = new CurrentFlowVersionStore({ location, definition }).load();
    assert.deepEqual(loaded.toJSON(), { ...raw, schemaRevision: 5 });
    assert.deepEqual(fs.readFileSync(location.activitiesFile), originalActivities);
    assert.deepEqual(fs.readFileSync(location.resolve("artifacts/migration/portable-state-v5/flow.json")), original);
    const receipt = JSON.parse(fs.readFileSync(location.resolve("artifacts/migration/portable-state-v5/receipt.json"), "utf8"));
    assert.equal(receipt.sourceFlowHash, hash(original));
    assert.equal(receipt.targetFlowHash, hash(fs.readFileSync(location.flowStateFile)));
    assert.equal(inspectFlowMigrationRequirements({ root, specId }).classification, "current");
    fs.mkdirSync(path.join(root, ".tmp", "sennel-migrate-specs"), { recursive: true });
    const complete = new StoredFlowPersistenceSnapshot(root);
    const repeated = runner(root);
    assert.equal(repeated.run().complete, true, repeated.logger.errors.join("\n"));
    complete.assertUnchanged();
  });

  it("keeps completed historical retry evidence inert across reload and the actual current baseline reader", () => {
    const { root, specId, location } = project("source-format-v1/without-source-checkpoint", sourceId);
    const oldState = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
    const oldCatalog = FlowArtifactCatalog.fromSerialized(JSON.parse(fs.readFileSync(location.catalogFile, "utf8")));
    const baseline = oldCatalog.artifacts.find((entry) => entry.logicalKey === "retry.recovery.baseline");
    const oldBytes = fs.readFileSync(location.resolve(baseline.relativePath));
    assert.notEqual(JSON.parse(oldBytes.toString("utf8")).attemptId, oldState.attempt.id);
    const migration = runner(root);
    assert.equal(migration.run().complete, true, migration.logger.errors.join("\n"));
    const state = new CurrentFlowVersionStore({ location, definition }).load();
    assert.equal(state.current.at(-1), "implement");
    assert.equal(state.nextAction().nodeId, "implement");
    assert.deepEqual(state.attempt.toJSON(), oldState.attempt);
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    manager.load(specId);
    assert.equal(retryEvidenceRouteForNode(state, "implement"), null);
    assert.throws(() => readRetryBaseline(manager, state, retryEvidenceRouteForNode(state, "spec-review")),
      /canonical artifact consumer is not authorized: implement\/retry\.recovery\.baseline/);
    assert.deepEqual(fs.readFileSync(location.resolve(baseline.relativePath)), oldBytes);
    assert.deepEqual(FlowArtifactCatalog.fromSerialized(JSON.parse(fs.readFileSync(location.catalogFile, "utf8")))
      .artifacts.find((entry) => entry.relativePath === baseline.relativePath).toJSON(), baseline.toJSON());
  });

  it("retains genuine previous runtime telemetry and reads it through the current observation consumer", async () => {
    const { root, specId, location } = project("flow-telemetry-v4", createdId);
    const provenance = JSON.parse(fs.readFileSync("tests/fixtures/flow-telemetry-v4/provenance.json", "utf8"));
    assert.equal(hash(fs.readFileSync(location.flowStateFile)), provenance.sourceFlowHash);
    const beforeCatalog = FlowArtifactCatalog.fromSerialized(JSON.parse(fs.readFileSync(location.catalogFile, "utf8")));
    const telemetry = beforeCatalog.artifacts.filter((entry) => ["execution.source.manifest", "execution.observation"].includes(entry.logicalKey));
    const before = new Map(telemetry.map((entry) => [entry.relativePath, fs.readFileSync(location.resolve(entry.relativePath))]));
    const oldState = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
    const originalManifestDescriptor = telemetry.find(entry => entry.logicalKey === "execution.source.manifest");
    const originalManifest = JSON.parse(before.get(originalManifestDescriptor.relativePath));
    const originalFacts = telemetry.filter(entry => entry.logicalKey === "execution.observation")
      .map(entry => JSON.parse(before.get(entry.relativePath)));
    const snapshot = new StoredFlowPersistenceSnapshot(root);
    await assert.rejects(captureExecutionObservations({ catalog: beforeCatalog,
      readArtifact: descriptor => descriptor.readBytes(location), expectedBinding: oldState }), /explicit evidence-format migration/);
    assert.equal(runner(root, { dryRun: true }).run().complete, true);
    snapshot.assertUnchanged();
    const migration = runner(root);
    assert.equal(migration.run().complete, true, migration.logger.errors.join("\n"));
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const restored = await manager.readExecutionObservations({ specId });
    assert.deepEqual(restored.manifests.map(entry => entry.toJSON()), [{ ...originalManifest, schemaRevision: 2 }]);
    assert.equal(restored.manifests[0].id, provenance.sourceId);
    assert.notEqual(restored.manifests[0].runtimeSourceId, null);
    assert.equal(restored.manifests[0].runtimeSourceId, originalManifest.runtimeSourceId);
    assert.equal(restored.facts.length, originalFacts.length);
    for (const fact of restored.facts) assert.deepEqual(fact.toJSON(), originalFacts.find(entry => entry.id === fact.id));
    const catalog = manager.artifactCatalog(specId);
    const receipt = JSON.parse(fs.readFileSync(location.resolve("artifacts/migration/portable-state-v5/receipt.json")));
    for (const descriptor of telemetry) {
      const bytes = fs.readFileSync(location.resolve(descriptor.relativePath));
      const current = catalog.artifacts.find(entry => entry.relativePath === descriptor.relativePath);
      if (descriptor.logicalKey === "execution.source.manifest") {
        assert.deepEqual(JSON.parse(bytes), { ...originalManifest, schemaRevision: 2 });
        assert.deepEqual(current.toJSON(), { ...descriptor.toJSON(), hash: hash(bytes), size: bytes.length });
        const change = receipt.evidenceChanges.find(entry => entry.relativePath === descriptor.relativePath);
        assert.ok(change);
        assert.equal(change.sourceHash, descriptor.hash);
        assert.equal(change.targetHash, current.hash);
        assert.deepEqual(fs.readFileSync(location.resolve(change.sourcePath)), before.get(descriptor.relativePath));
      } else {
        assert.deepEqual(bytes, before.get(descriptor.relativePath));
        assert.deepEqual(current.toJSON(), descriptor.toJSON());
      }
    }
  });

  it("refuses authentic v1 physical source authority without changing its original bytes or creating runtime state", () => {
    const { root } = project("source-format-v1/with-source-checkpoint", sourceId);
    const snapshot = new StoredFlowPersistenceSnapshot(root);
    for (const dryRun of [true, false]) {
      const output = logger();
      assert.equal(new SpecsMigrationRevisionFive(root, { dryRun, logger: output }).run().complete, false);
      assert.match(output.errors.join("\n"), /UNSAFE_SOURCE_FORMAT/);
      snapshot.assertUnchanged();
      assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
    }
  });

  it("refuses a previous baseline payload claiming the current Attempt before any migration writes", () => {
    const { root, location } = project("source-format-v1/without-source-checkpoint", sourceId);
    const state = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
    const catalog = FlowArtifactCatalog.fromSerialized(JSON.parse(fs.readFileSync(location.catalogFile, "utf8")));
    const descriptor = catalog.artifacts.find((entry) => entry.logicalKey === "retry.recovery.baseline");
    const file = location.resolve(descriptor.relativePath);
    const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...baseline, attemptId: state.attempt.id, attempt: state.attempt.sequence }));
    refreshDescriptor(location, descriptor.relativePath);
    const snapshot = new StoredFlowPersistenceSnapshot(root);
    const output = logger();
    assert.equal(new SpecsMigrationRevisionFive(root, { logger: output }).run().complete, false);
    assert.match(output.errors.join("\n"), /UNSAFE_SOURCE_FORMAT.*current Attempt retry authority/);
    snapshot.assertUnchanged();
  });

  it("reconstructs a journaled schema migration after source backup through the public runner", () => {
    const { root, specId, location } = project("flow-state-v4", createdId);
    const specRoot = resolveMigrationSpecRoot(root).root;
    assert.throws(() => new CanonicalRevisionRootTransaction({ root, specRoot, specId, definition, revision: 5,
      faultInjector({ phase }) { if (phase === "source-backed-up") throw new Error("interrupted portable migration"); },
    }).apply(), /interrupted portable migration/);
    assert.equal(fs.existsSync(location.directory), false);
    assert.equal(runner(root).run().complete, true);
    assert.equal(new CurrentFlowVersionStore({ location, definition }).load().schemaRevision, 5);
  });
});
