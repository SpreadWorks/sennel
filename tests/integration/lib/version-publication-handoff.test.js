import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { FlowArtifactCatalog, FlowArtifactCatalogStore, FlowVersionAuthorityScope, FlowVersionLocation } from "../../../src/lib/flow-version.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { CanonicalNextActionScenario, makeFlowManager } from "../../support/infrastructure/flow-setup.js";

function ownedRoot(t, prefix) {
  const root = createTmpDir(prefix);
  t.after(() => removeTmpDir(root));
  return root;
}

function runtimeLog(sequence) {
  return { runId: "run-publication-handoff", sequence, attempt: 1,
    command: "flow run fixture", startedAt: "2026-08-13T00:00:00.000Z",
    endedAt: "2026-08-13T00:00:01.000Z", exitCode: 0 };
}

function canonicalFlow(t) {
  const root = ownedRoot(t, "runtime-metadata-handoff-");
  const manager = makeFlowManager(root);
  new CanonicalNextActionScenario({ flowManager: manager,
    specId: "001-publication-handoff", runId: runtimeLog(1).runId }).create();
  return { root, manager, location: manager.specLocation("001-publication-handoff") };
}

function emptyVersion(t) {
  const root = ownedRoot(t, "catalog-publication-handoff-");
  const location = new FlowVersionLocation({ repositoryRoot: root,
    authorityScope: FlowVersionAuthorityScope.canonical(), specId: "handoff", version: 1 });
  // Production constructs the catalog owner before materializing a new Version.
  const store = new FlowArtifactCatalogStore({ location });
  location.repositoryAuthority.descendant(location.directory, { create: true });
  return { root, location, store, catalog: new FlowArtifactCatalog({ artifacts: [] }) };
}

test("runtime metadata producer persists exact bytes without changing the canonical catalog", (t) => {
  const { manager, location } = canonicalFlow(t);
  const catalogBefore = new AtomicFile(location.catalogFile).read();
  const metadata = { nodeId: "branch", ...runtimeLog(1) };
  const publication = manager.setStepRuntimeLog("branch", runtimeLog(1));
  const file = location.resolve(".runtime/step-metadata/branch.json");
  assert.equal(publication.committed, true);
  assert.deepEqual(new AtomicFile(file).read(), Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));
  assert.deepEqual(new AtomicFile(location.catalogFile).read(), catalogBefore);
});

test("runtime metadata refuses an observed parent replacement without overwriting foreign bytes", (t) => {
  const { root, manager, location } = canonicalFlow(t);
  manager.setStepRuntimeLog("branch", runtimeLog(1));
  const file = location.resolve(".runtime/step-metadata/branch.json");
  const directory = path.dirname(file);
  const original = new AtomicFile(file).read();
  const backup = path.join(root, "original-metadata");
  const foreign = Buffer.from("foreign runtime metadata\n");
  const resolve = RealDirectoryAuthority.resolve;
  let replaced = false;
  t.mock.method(RealDirectoryAuthority, "resolve", function (target, options = {}) {
    const authority = resolve.call(this, target, options);
    if (!replaced && options.create && path.resolve(target) === directory) {
      fs.renameSync(directory, backup);
      fs.mkdirSync(directory);
      fs.writeFileSync(file, foreign);
      replaced = true;
    }
    return authority;
  });
  let failure;
  try { manager.setStepRuntimeLog("branch", runtimeLog(2)); }
  catch (error) { failure = error; }
  assert.equal(replaced, true);
  assert.deepEqual(fs.readFileSync(file), foreign);
  assert.deepEqual(fs.readFileSync(path.join(backup, "branch.json")), original);
  assert.deepEqual(fs.readdirSync(directory), ["branch.json"]);
  assert.ok(failure instanceof Error, "the producer must refuse the changed authority");
});

test("a catalog owner created before its Version supports initial publication and fresh readback", (t) => {
  const { location, store, catalog } = emptyVersion(t);
  assert.equal(fs.existsSync(location.catalogFile), false);
  assert.equal(store.initialize(catalog).hash, catalog.hash);
  const expected = Buffer.from(`${JSON.stringify(catalog.toJSON(), null, 2)}\n`);
  assert.deepEqual(new AtomicFile(location.catalogFile).read(), expected);
  const reloaded = new FlowArtifactCatalogStore({ location });
  assert.equal(reloaded.require().hash, catalog.hash);
  assert.deepEqual(reloaded.require().toJSON(), catalog.toJSON());
});

test("catalog lock admission refuses a replaced Version before creating runtime directories in it", (t) => {
  const { root, location, store, catalog } = emptyVersion(t);
  store.initialize(catalog);
  const original = new AtomicFile(location.catalogFile).read();
  const backup = path.join(root, "original-version");
  const runtimeLock = location.runtimeLock("runtime.lock.artifact-catalog");
  const sentinel = Buffer.from("foreign Version\n");
  const resolve = RealDirectoryAuthority.resolve;
  let replaced = false;
  t.mock.method(RealDirectoryAuthority, "resolve", function (target, options = {}) {
    if (!replaced && options.create && [runtimeLock.runtimeDirectory, runtimeLock.directory].includes(path.resolve(target))) {
      fs.renameSync(location.directory, backup);
      fs.mkdirSync(location.directory);
      fs.writeFileSync(path.join(location.directory, "foreign.txt"), sentinel);
      replaced = true;
    }
    return resolve.call(this, target, options);
  });
  let failure;
  try { store.load(); }
  catch (error) { failure = error; }
  assert.equal(replaced, true);
  assert.ok(failure instanceof Error, "catalog admission must refuse the replaced Version");
  assert.deepEqual(fs.readdirSync(location.directory), ["foreign.txt"]);
  assert.deepEqual(fs.readFileSync(path.join(location.directory, "foreign.txt")), sentinel);
  assert.deepEqual(fs.readFileSync(path.join(backup, "artifact-catalog.json")), original);
});
