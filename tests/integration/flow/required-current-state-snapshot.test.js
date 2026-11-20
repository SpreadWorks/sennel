import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowRuntime } from "../../../src/flow/lib/canonical-flow-runtime.js";
import { CurrentFlowStateStore } from "../../../src/flow/lib/current-flow-state.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state-conflict-error.js";
import { buildCurrentFlowDefinition } from "../../../src/flow/definition.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function project(t, specId, create = true) {
  const root = createTmpDir("required-current-state-snapshot-");
  t.after(() => removeTmpDir(root));
  const definition = buildCurrentFlowDefinition();
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  if (create) new CanonicalFlowFixture({ flowManager: manager, specId,
    runId: `run-${specId}`, request: "Keep captured reads separate from later write authority.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
  }).create();
  const runtime = new CanonicalFlowRuntime({ repositoryRoot: root, executionRoot: root, definition });
  return { root, manager, runtime, definition, specId, location: runtime.location(specId) };
}

function persistence(location) {
  return [location.flowStateFile, location.activitiesFile, location.catalogFile, location.specFile]
    .map(file => fs.readFileSync(file));
}

test("required snapshots retain strict missing-state failure while default snapshots remain nullable", (t) => {
  const { runtime, specId, location } = project(t, "001-required-absent", false);
  assert.equal(runtime.loadSnapshot(specId), null);
  let originalFailure = null;
  try { runtime.load(specId); } catch (error) { originalFailure = error; }
  assert.ok(originalFailure instanceof Error, "the existing strict load refuses an absent Version");
  assert.throws(() => runtime.loadSnapshot(specId, { required: true }), error => {
    assert.equal(error.constructor, originalFailure.constructor);
    assert.equal(error.code, originalFailure.code);
    assert.equal(error.message, originalFailure.message);
    return true;
  });
  assert.equal(fs.existsSync(location.directory), false, "reads cannot create an absent Version");
});

test("a captured committed prefix stays isolated while the next read is fresh and stale revision cannot write", (t) => {
  const { manager, runtime, definition, specId, location, root } = project(t, "001-required-prefix");
  const captured = runtime.loadSnapshot(specId, { required: true });
  const state = captured.state.toJSON();
  const prefix = captured.activities.map(activity => activity.toJSON());
  assert.equal(prefix.length, captured.state.confirmationOrder);
  assert.deepEqual(runtime.loadSnapshot(specId).state.toJSON(), state);
  manager.addNote("a later independently committed note", { specId });
  const current = runtime.loadSnapshot(specId, { required: true });
  assert.equal(current.state.confirmationOrder, captured.state.confirmationOrder + 1);
  assert.deepEqual(current.activities.slice(0, -1).map(activity => activity.toJSON()), prefix);
  assert.equal(current.activities.at(-1).note.text, "a later independently committed note");
  assert.deepEqual(captured.state.toJSON(), state);
  assert.deepEqual(captured.activities.map(activity => activity.toJSON()), prefix);
  assert.equal(captured.activities.some(activity => activity.note !== null), false);
  const before = persistence(location);
  const writer = new CurrentFlowStateStore({ directory: location.directory, repositoryRoot: root,
    definition, runtimeLockLocation: location.runtimeLock("runtime.lock.current-flow-state") });
  // The genuine original creation Activity is historical data, not a new write grant.
  assert.throws(() => writer.apply({ activity: captured.activities[0], expectedRevision: captured.revision }),
    error => error instanceof CurrentFlowStateConflictError
      && error.code === "CURRENT_FLOW_STATE_CONFLICT"
      && error.message === "flow state changed before update");
  assert.deepEqual(persistence(location), before, "stale capture cannot append, replace state, or publish a catalog");
});

test("required and nullable snapshots both retain canonical Spec revision authority checks", (t) => {
  const { runtime, specId, location } = project(t, "001-required-spec-authority");
  runtime.loadSnapshot(specId, { required: true });
  const before = persistence(location);
  const orphan = location.resolve("revisions/002");
  fs.mkdirSync(orphan);
  const rejects = error => error.code === "CURRENT_FLOW_STATE_INVARIANT_INVALID"
    && error.message === "canonical Spec revision snapshots and optional reviews do not match the catalog authority";
  assert.throws(() => runtime.load(specId), rejects);
  assert.throws(() => runtime.loadSnapshot(specId, { required: true }), rejects);
  assert.throws(() => runtime.loadSnapshot(specId), rejects);
  assert.deepEqual(persistence(location), before);
  assert.equal(fs.existsSync(orphan), true, "read refusal cannot repair an unadmitted revision directory");
});

test("required and nullable snapshots do not turn corrupt catalog authority into absence", (t) => {
  const { runtime, specId, location } = project(t, "001-required-catalog-authority");
  runtime.loadSnapshot(specId, { required: true });
  const value = JSON.parse(fs.readFileSync(location.catalogFile, "utf8"));
  value.hash = "0".repeat(64);
  fs.writeFileSync(location.catalogFile, `${JSON.stringify(value, null, 2)}\n`);
  const before = persistence(location);
  const rejects = error => error.constructor === Error
    && error.message === "artifact catalog hash does not match its canonical content";
  assert.throws(() => runtime.load(specId), rejects);
  assert.throws(() => runtime.loadSnapshot(specId, { required: true }), rejects);
  assert.throws(() => runtime.loadSnapshot(specId), rejects);
  assert.deepEqual(persistence(location), before);
});
