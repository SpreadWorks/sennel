import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import {
  AuthoritativeSpecRecord, FlowArtifactCatalog, FlowArtifactCatalogStore, FlowVersionAuthorityScope,
  FlowVersionLocation, VersionTreeSnapshot, FlowVersionSemanticValidator, FlowVersionMigrationOutputBuilder,
  FlowVersionMigrationOutput, FlowVersionMigrationOutputSet, FlowVersionMigrationClassifier,
} from "../../../src/lib/flow-version.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t, { create = true } = {}) {
  const root = createTmpDir("remaining-authority-");
  t.after(() => removeTmpDir(root));
  const location = new FlowVersionLocation({ repositoryRoot: root,
    authorityScope: FlowVersionAuthorityScope.canonical(), specId: "authority-handoff", version: 1 });
  if (create) location.repositoryAuthority.descendant(location.directory, { create: true });
  return { root, location };
}

function emptyCatalog(location) {
  const store = new FlowArtifactCatalogStore({ location });
  store.initialize(new FlowArtifactCatalog({ artifacts: [] }));
  return store;
}

test("issue snapshot publication preserves catalog ownership and reads back exact bytes", (t) => {
  const { location } = fixture(t);
  const store = emptyCatalog(location);
  store.writeIssueSnapshot("# First issue");
  assert.equal(store.readIssueSnapshot(), "# First issue\n");
  assert.equal(store.require().resolve("issue.md").logicalKey, "issue.snapshot");
});

test("issue snapshot refuses Version replacement after its journal publication without overwriting foreign bytes", (t) => {
  const { root, location } = fixture(t);
  const store = emptyCatalog(location);
  const catalogBefore = fs.readFileSync(location.catalogFile);
  const backup = path.join(root, "original-version");
  const journal = location.resolve(".runtime/catalog-transaction.json");
  const write = AtomicFile.prototype.write;
  let replaced = false;
  t.mock.method(AtomicFile.prototype, "write", function (...args) {
    const result = write.apply(this, args);
    if (!replaced && this.filePath === journal) {
      fs.renameSync(location.directory, backup);
      fs.mkdirSync(location.directory);
      fs.writeFileSync(location.issueSnapshotFile, "foreign issue\n");
      replaced = true;
    }
    return result;
  });
  let failure;
  try { store.writeIssueSnapshot("our issue"); } catch (error) { failure = error; }
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(location.issueSnapshotFile, "utf8"), "foreign issue\n");
  assert.deepEqual(fs.readdirSync(location.directory), ["issue.md"]);
  assert.deepEqual(fs.readFileSync(path.join(backup, "artifact-catalog.json")), catalogBefore);
  assert.equal(fs.existsSync(path.join(backup, ".runtime/catalog-transaction.json")), true);
  assert.ok(failure instanceof Error);
});

function restoreFixture(t) {
  const { root, location } = fixture(t);
  const directory = location.resolve("artifacts/migration");
  location.repositoryAuthority.descendant(directory, { create: true });
  const snapshot = new VersionTreeSnapshot(location);
  const file = path.join(directory, "extra.bin");
  fs.writeFileSync(file, "transaction extra");
  return { root, location, directory, snapshot, file };
}

test("Version restore removes introduced files while retaining baseline directories", (t) => {
  const { location, directory, snapshot, file } = restoreFixture(t);
  snapshot.restore();
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.deepEqual(new VersionTreeSnapshot(location).toJSON(), snapshot.toJSON());
});

for (const scope of ["Version", "nested parent", "file"]) {
  test(`Version restore refuses ${scope} replacement after ownership readback and preserves foreign bytes`, (t) => {
    const { root, location, directory, snapshot, file } = restoreFixture(t);
    const backup = path.join(root, "original-target");
    const target = scope === "Version" ? location.directory : scope === "nested parent" ? directory : file;
    const open = fs.openSync;
    const close = fs.closeSync;
    const reads = new Set();
    let completed = 0;
    let replaced = false;
    t.mock.method(fs, "openSync", (name, ...args) => {
      const descriptor = open(name, ...args);
      if (name === file && args[0] === "r") reads.add(descriptor);
      return descriptor;
    });
    t.mock.method(fs, "closeSync", (descriptor) => {
      const observed = reads.delete(descriptor);
      const result = close(descriptor);
      // The target's first read captures it; its second confirms link ownership.
      if (observed && ++completed === 2) {
        fs.renameSync(target, backup);
        if (scope !== "file") fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "foreign bytes");
        replaced = true;
      }
      return result;
    });
    let failure;
    try { snapshot.restore(); } catch (error) { failure = error; }
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(file, "utf8"), "foreign bytes");
    const oldFile = scope === "file" ? backup : path.join(backup, path.relative(target, file));
    assert.equal(fs.readFileSync(oldFile, "utf8"), "transaction extra");
    assert.ok(failure instanceof Error);
  });
}

// Exercise the generic migration extension through its public classifier and
// producer APIs. This validator owns only this fixture's format; it does not
// pretend to validate or materialize the production Current Flow schema.
class FixtureValidator extends FlowVersionSemanticValidator {
  validateState(state) {
    assert.equal(state.schemaRevision, 1);
    assert.equal(state.version, 1);
    assert.equal(state.specId, "authority-handoff");
    return structuredClone(state);
  }
  validateMaterialized({ location, spec }) {
    const state = this.validateState(JSON.parse(fs.readFileSync(location.flowStateFile, "utf8")));
    assert.equal(state.specId, spec.specId.toString());
    assert.deepEqual(JSON.parse(fs.readFileSync(location.specFile, "utf8")), spec.toJSON());
  }
}

class FixtureOutputBuilder extends FlowVersionMigrationOutputBuilder {
  build({ plan, state, spec }) {
    const artifacts = [...plan.artifacts.filter((entry) => entry.operation.value === "transform"), ...plan.generatedArtifacts];
    return new FlowVersionMigrationOutputSet(artifacts.map((artifact) => {
      let bytes;
      if (artifact.outputKey === "current-flow-state") bytes = Buffer.from(JSON.stringify(state));
      else if (artifact.outputKey === "authoritative-spec-record") bytes = Buffer.from(spec.canonicalText);
      else if (artifact.outputKey === "activity-ledger") bytes = Buffer.alloc(0);
      else throw new Error(`undeclared fixture output: ${artifact.outputKey}`);
      return new FlowVersionMigrationOutput({ ...artifact, bytes });
    }));
  }
}

function migrationFixture(t, { copy = true } = {}) {
  const { root, location } = fixture(t, { create: false });
  const source = path.join(root, "legacy");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "flow.json"), "{}");
  fs.writeFileSync(path.join(source, "spec.json"), "{}");
  if (copy) {
    fs.mkdirSync(path.join(source, "artifacts"));
    fs.writeFileSync(path.join(source, "artifacts/copied.bin"), "source bytes");
  }
  const plan = new FlowVersionMigrationClassifier({ target: location,
    semanticValidator: new FixtureValidator(), outputBuilder: new FixtureOutputBuilder() }).inspect(source).plan();
  const migration = plan.outputFixture({
    state: { schemaRevision: 1, version: 1, specId: location.specId.toString() },
    spec: new AuthoritativeSpecRecord({ id: location.specId.toString(), title: "migration fixture" }),
  });
  return { root, source, location, migration };
}

test("generic migration materializes exact copied and generated outputs through catalog readback", (t) => {
  const { location, migration } = migrationFixture(t);
  const materialized = migration.materialize();
  assert.equal(materialized.location, location);
  assert.equal(fs.readFileSync(location.resolve("artifacts/migration/copied.bin"), "utf8"), "source bytes");
  assert.equal(materialized.catalog.resolve("artifacts/migration/copied.bin").size, Buffer.byteLength("source bytes"));
  assert.equal(new FlowArtifactCatalogStore({ location }).require().hash, materialized.catalog.hash);
});

for (const boundary of ["before parent resolution", "after parent resolution", "generated output"]) {
  test(`generic migration refuses Version replacement ${boundary} without publishing into the foreign tree`, (t) => {
    const { root, location, migration } = migrationFixture(t, { copy: boundary !== "generated output" });
    const backup = path.join(root, "original-version");
    const outputParent = boundary === "generated output" ? location.directory : location.resolve("artifacts/migration");
    const resolve = RealDirectoryAuthority.resolve;
    let replaced = false;
    const replace = () => {
      fs.renameSync(location.directory, backup);
      fs.mkdirSync(location.directory);
      // Preserve the same parent presence for the handoff-after-ensure case.
      if (boundary === "after parent resolution") fs.mkdirSync(outputParent, { recursive: true });
      fs.writeFileSync(path.join(location.directory, "foreign.txt"), "foreign tree");
      replaced = true;
    };
    t.mock.method(RealDirectoryAuthority, "resolve", function (target, options = {}) {
      const selected = !replaced && options.create && path.resolve(target) === outputParent
        && fs.existsSync(location.directory);
      if (selected && boundary === "before parent resolution") replace();
      const authority = resolve.call(this, target, options);
      if (selected && boundary !== "before parent resolution") replace();
      return authority;
    });
    let failure;
    try { migration.materialize(); } catch (error) { failure = error; }
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(path.join(location.directory, "foreign.txt"), "utf8"), "foreign tree");
    assert.equal(fs.existsSync(location.resolve("artifacts/migration/copied.bin")), false);
    assert.equal(fs.existsSync(location.activitiesFile), false);
    assert.equal(fs.existsSync(location.flowStateFile), false);
    assert.equal(fs.existsSync(location.specFile), false);
    if (boundary !== "after parent resolution") assert.deepEqual(fs.readdirSync(location.directory), ["foreign.txt"]);
    assert.ok(failure instanceof Error);
    assert.equal(fs.existsSync(backup), true);
  });
}

test("generic migration retains its Version authority from final output through catalog publication", (t) => {
  const { root, location, migration } = migrationFixture(t);
  const backup = path.join(root, "original-version");
  const write = AtomicFile.prototype.write;
  let replaced = false;
  t.mock.method(AtomicFile.prototype, "write", function (...args) {
    const result = write.apply(this, args);
    // The generated activity ledger is the fixture's final planned output.
    if (!replaced && this.filePath === location.activitiesFile) {
      fs.renameSync(location.directory, backup);
      fs.cpSync(backup, location.directory, { recursive: true });
      fs.mkdirSync(location.resolve(".runtime"));
      fs.writeFileSync(location.resolve(".runtime/foreign-marker"), "foreign Version");
      replaced = true;
    }
    return result;
  });
  let failure;
  try { migration.materialize(); } catch (error) { failure = error; }
  assert.equal(replaced, true);
  assert.equal(fs.existsSync(location.catalogFile), false);
  assert.deepEqual(fs.readdirSync(location.resolve(".runtime")), ["foreign-marker"]);
  assert.equal(fs.readFileSync(location.resolve(".runtime/foreign-marker"), "utf8"), "foreign Version");
  assert.equal(fs.readFileSync(location.resolve("artifacts/migration/copied.bin"), "utf8"), "source bytes");
  assert.equal(fs.existsSync(path.join(backup, "artifact-catalog.json")), false);
  assert.ok(failure instanceof Error);
});
