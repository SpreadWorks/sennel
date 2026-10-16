import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { buildCurrentFlowDefinition } from "../../src/flow/definition.js";
import { CurrentFlowState } from "../../src/flow/lib/current-flow-state.js";
import { ActiveFlowRegistry } from "../../src/lib/active-flow-registry.js";
import { FlowTargetIdentity, FlowTargetIdentityAuthority } from "../../src/lib/flow-target-identity-authority.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { assertMigrationFlowAuthority, MigrationFlowAuthorityPreflight, MigrationFlowAuthoritySnapshot } from "../../src/lib/migration-flow-authority.js";
import { OfflineMigrationDirectorySnapshot } from "../../src/lib/offline-migration-transaction.js";
import { WorktreeFlowBindingStore, WorktreeFlowIdentity } from "../../src/lib/worktree-flow-binding.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";
import { SeedWorkRoot } from "../support/builders/seed-work-root.js";
import { StoredFlowPersistenceSnapshot } from "../support/assertions/canonical-persistence.js";
import { SpecsMigrationRevisionOne, inspectFlowMigrationRequirements } from "../../src/lib/specs-migration.js";

const roots = [];
const SPEC_ID = "001-selected";
const definition = buildCurrentFlowDefinition();

function project() {
  const root = createTmpDir("sennel-migration-authority-");
  roots.push(root);
  return root;
}

function state(options = {}) {
  return CurrentFlowState.create({
    definition, specId: SPEC_ID, flowId: "selected-flow", flowVersionId: "selected-version", runId: "selected-run", ...options,
  });
}

function assertAuthority(root, states = [state()]) {
  return assertMigrationFlowAuthority({ root, specRoot: "specs", specId: SPEC_ID, states });
}

function registry(root, current) {
  new FlowTargetIdentityAuthority({ mainRoot: root }).addActive(current, current.execution.mode);
  new ActiveFlowRegistry({ mainRoot: root }).add(current.specId, current.execution.mode);
}

function authoritySnapshot(root) {
  return OfflineMigrationDirectorySnapshot.capture(root, path.join(root, ".sennel"));
}

function configuredHistoricalProject(claimRoot) {
  const copy = new SeedWorkRoot(path.resolve("tests/fixtures/legacy-activity-v1/project"), {
    prefix: "sennel-migration-authority-root-",
  });
  roots.push(copy.root);
  const specRoot = "plans/specs";
  const specId = "001-legacy-activity";
  fs.mkdirSync(path.join(copy.root, "plans"));
  fs.renameSync(path.join(copy.root, "specs"), path.join(copy.root, specRoot));
  writeJson(copy.root, ".sennel/config.json", { flow: { specDir: specRoot } });
  const current = JSON.parse(fs.readFileSync(path.join(copy.root, specRoot, specId, "001/flow.json"), "utf8"));
  new FlowTargetIdentityAuthority({ mainRoot: copy.root, specRoot: claimRoot }).addActive(current, current.execution.mode);
  new ActiveFlowRegistry({ mainRoot: copy.root }).add(specId, current.execution.mode);
  return { root: copy.root, specRoot, specId, current };
}

function migrateHistorical(project, dryRun) {
  const messages = [];
  const logger = { log: (message) => messages.push(message), error: (message) => messages.push(message) };
  return { ...new SpecsMigrationRevisionOne(project.root, {
    specId: project.specId, targetRevision: 2, dryRun, logger,
  }).run(), messages };
}

afterEach(() => {
  while (roots.length) removeTmpDir(roots.pop());
});

describe("migration native identity authority", () => {
  it("compares an explicitly selected Spec root while preserving inferred-root identity checks", () => {
    const current = state();
    const original = FlowTargetIdentity.active(current, current.execution.mode, "specs");
    const custom = FlowTargetIdentity.active(current, current.execution.mode, "plans/specs");
    assert.equal(original.assertState(current), current);
    assert.equal(custom.assertState(current), current);
    assert.equal(custom.assertState(current, { specRoot: "plans/specs" }), current);
    assert.throws(() => original.assertState(current, { specRoot: "plans/specs" }), {
      code: "FLOW_TARGET_RECOVERY_REQUIRED",
    });
  });

  it("rejects a historical migration whose selected configured root differs from its target claim", () => {
    const project = configuredHistoricalProject("specs");
    const before = new StoredFlowPersistenceSnapshot(project.root);
    assert.throws(() => assertMigrationFlowAuthority({ ...project, states: [project.current] }), {
      code: "FLOW_TARGET_RECOVERY_REQUIRED",
    });
    const assessment = inspectFlowMigrationRequirements({ root: project.root, specId: project.specId });
    assert.equal(assessment.classification, "integrity-error");
    assert.equal(assessment.code, "FLOW_TARGET_RECOVERY_REQUIRED");
    assert.equal(new StoredFlowPersistenceSnapshot(project.root).digest, before.digest);
  });

  for (const dryRun of [true, false]) {
    it(`rejects configured-root target mismatch during historical migration ${dryRun ? "preview" : "apply"}`, () => {
      const project = configuredHistoricalProject("specs");
      const before = new StoredFlowPersistenceSnapshot(project.root);
      const result = migrateHistorical(project, dryRun);
      assert.equal(result.complete, false, result.messages.join("\n"));
      assert.match(result.messages.join("\n"), /FLOW_TARGET_RECOVERY_REQUIRED/);
      assert.equal(new StoredFlowPersistenceSnapshot(project.root).digest, before.digest);
    });
  }

  it("migrates a historical source with a matching configured-root target claim", () => {
    const project = configuredHistoricalProject("plans/specs");
    const before = new StoredFlowPersistenceSnapshot(project.root);
    const authority = authoritySnapshot(project.root);
    assert.equal(assertMigrationFlowAuthority({ ...project, states: [project.current] }).identities[0].runId,
      project.current.runId);
    const preview = migrateHistorical(project, true);
    assert.equal(preview.complete, true, preview.messages.join("\n"));
    assert.equal(new StoredFlowPersistenceSnapshot(project.root).digest, before.digest);
    const applied = migrateHistorical(project, false);
    assert.equal(applied.complete, true, applied.messages.join("\n"));
    authority.assertUnchanged();
    const current = JSON.parse(fs.readFileSync(path.join(project.root, project.specRoot, project.specId, "001/flow.json"), "utf8"));
    assert.equal(current.runId, project.current.runId);
    assert.deepEqual(current.lifecycle, project.current.lifecycle);
  });

  it("keeps historical absence of repository authorities read-only", () => {
    const root = project();
    const before = fs.readdirSync(root);
    const result = assertAuthority(root);
    assert.ok(result instanceof MigrationFlowAuthoritySnapshot);
    assert.equal(result.identities[0].runId, "selected-run");
    assert.deepEqual(result.activeEntries, []);
    assert.deepEqual(fs.readdirSync(root), before);
  });

  it("validates current target authority without treating historical Version snapshots as current registry owners", () => {
    const root = project();
    const current = state();
    registry(root, current);
    const before = authoritySnapshot(root);
    const historical = state({ flowVersionId: "historical-version", runId: "historical-run" });
    const result = assertMigrationFlowAuthority({ root, specRoot: "specs", specId: SPEC_ID,
      states: [historical, current], versions: [2, 1], currentState: current });
    assert.equal(result.identities.length, 2);
    assert.equal(result.identities[0].version, 2);
    assert.equal(result.targetIdentities.entries[0].runId, current.runId);
    before.assertUnchanged();
  });

  it("rejects stale target ownership and corrupted active registry without repairing either authority", () => {
    const root = project();
    registry(root, state());
    const before = authoritySnapshot(root);
    assert.throws(() => assertAuthority(root, [state({ issue: 9 })]), { code: "FLOW_TARGET_RECOVERY_REQUIRED" });
    before.assertUnchanged();
    writeJson(root, ".sennel/.active-flow", [{ specId: SPEC_ID, mode: "branch" }]);
    const mismatched = authoritySnapshot(root);
    assert.throws(() => assertAuthority(root), { code: "ACTIVE_FLOW_REGISTRY_MODE_CONFLICT" });
    mismatched.assertUnchanged();
    fs.writeFileSync(path.join(root, ".sennel/.active-flow"), "{broken");
    const corrupted = authoritySnapshot(root);
    assert.throws(() => assertAuthority(root), { code: "ACTIVE_FLOW_REGISTRY_CORRUPT" });
    corrupted.assertUnchanged();
  });

  it("rejects selected one-sided active references without repairing the registry or identity authority", () => {
    for (const present of ["registry", "identity"]) {
      const root = project();
      const current = state();
      if (present === "registry") new ActiveFlowRegistry({ mainRoot: root }).add(SPEC_ID, "direct");
      else new FlowTargetIdentityAuthority({ mainRoot: root }).addActive(current, "direct");
      const before = authoritySnapshot(root);
      assert.throws(() => assertAuthority(root, [current]), { code: "FLOW_TARGET_AUTHORITY_CORRUPT" });
      before.assertUnchanged();
    }
  });

  it("requires canonical Version 001 when selected active references remain, while allowing unindexed historical-only roots", () => {
    const root = project();
    const current = state();
    registry(root, current);
    const historical = state({ flowVersionId: "historical-version", runId: "historical-run" });
    const before = authoritySnapshot(root);
    assert.throws(() => assertMigrationFlowAuthority({ root, specRoot: "specs", specId: SPEC_ID,
      states: [historical], versions: [2], currentState: null }), { code: "FLOW_TARGET_AUTHORITY_CORRUPT" });
    before.assertUnchanged();

    const unindexedRoot = project();
    const result = assertMigrationFlowAuthority({ root: unindexedRoot, specRoot: "specs", specId: SPEC_ID,
      states: [historical], versions: [2], currentState: null });
    assert.equal(result.identities[0].version, 2);
    assert.deepEqual(result.activeEntries, []);
    assert.deepEqual(result.targetIdentities.entries, []);
    assert.deepEqual(fs.readdirSync(unindexedRoot), []);
  });

  it("detects neighbor identity claims while ignoring unrelated malformed Flow data", () => {
    const root = project();
    writeJson(root, "specs/002-other/001/flow.json", state({
      specId: "002-other", flowId: "other-flow", flowVersionId: "other-version",
    }).toJSON());
    assert.throws(() => assertAuthority(root), { code: "RUN_ID_COLLISION" });
    writeJson(root, "specs/002-other/001/flow.json", state({
      specId: "002-other", flowId: "other-flow", runId: "other-run",
    }).toJSON());
    assert.throws(() => assertAuthority(root), { code: "FLOW_VERSION_ID_COLLISION" });
    writeJson(root, "specs/002-other/001/flow.json", state({
      specId: "002-other", runId: "other-run", flowVersionId: "other-version",
    }).toJSON());
    assert.throws(() => assertAuthority(root), { code: "FLOW_ID_CROSS_SPEC_COLLISION" });
    fs.writeFileSync(path.join(root, "specs/002-other/001/flow.json"), "{broken");
    assert.equal(assertAuthority(root).identities.length, 1);
    const sameTuple = state({ flowVersionId: "other-version", runId: "other-run" });
    assert.throws(() => assertAuthority(root, [state(), sameTuple]), { code: "FLOW_VERSION_TUPLE_COLLISION" });
  });

  it("keeps a preflight snapshot local while fresh authority checks observe subsequent neighbor and owner changes", () => {
    const root = project();
    const current = state();
    registry(root, current);
    const preflight = new MigrationFlowAuthorityPreflight({ root, specRoot: "specs" });
    assert.equal(preflight.assert({ specId: SPEC_ID, states: [current] }).identities[0].runId, current.runId);
    writeJson(root, "specs/002-other/001/flow.json", {
      // A foreign directory's identity references matter even when its schema
      // or claimed Spec identity cannot be accepted as migration input.
      specId: SPEC_ID, runId: current.runId,
    });
    assert.equal(preflight.assert({ specId: SPEC_ID, states: [current] }).identities[0].runId, current.runId);
    const before = new StoredFlowPersistenceSnapshot(root);
    assert.throws(() => assertAuthority(root, [current]), { code: "RUN_ID_COLLISION" });
    assert.equal(new StoredFlowPersistenceSnapshot(root).digest, before.digest);
    fs.writeFileSync(path.join(root, "specs/002-other/001/flow.json"), "{broken");
    new ActiveFlowRegistry({ mainRoot: root }).remove(SPEC_ID);
    assert.throws(() => assertAuthority(root, [current]), { code: "FLOW_TARGET_AUTHORITY_CORRUPT" });
  });

  it("uses the persisted worktree binding reader without recovering or publishing a mismatched binding", () => {
    const root = project();
    const current = state({ execution: { mode: "worktree", featureBranch: `feature/${SPEC_ID}` } });
    registry(root, current);
    const worktreePath = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: SPEC_ID })
      .resolveWorktreePaths(current).worktreePath;
    fs.mkdirSync(worktreePath, { recursive: true });
    const store = new WorktreeFlowBindingStore({ worktreePath });
    store.save(new WorktreeFlowIdentity({ runId: "foreign-run", issue: null, specId: SPEC_ID, worktreePath }));
    const before = authoritySnapshot(root);
    const bindingBefore = OfflineMigrationDirectorySnapshot.capture(root, path.join(worktreePath, ".sennel"));
    assert.throws(() => assertAuthority(root, [current]), { code: "WORKTREE_FLOW_BINDING_CORRUPT" });
    before.assertUnchanged();
    bindingBefore.assertUnchanged();
  });
});
