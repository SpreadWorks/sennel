import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { FlowArtifactCatalogStore, VersionTreeSnapshot } from "../../../src/lib/flow-version.js";
import { CanonicalFlowArtifactWrite } from "../../../src/flow/lib/current-flow-state.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function taskAdmission(t) {
  const directory = createTmpDir("sennel-retained-task-workspace-");
  t.after(() => removeTmpDir(directory));
  const manager = makeFlowManager(directory);
  const specId = "001-retained-task-workspace";
  const fixture = new CanonicalFlowFixture({ flowManager: manager, specId,
    runId: "retained-task-workspace-run",
    specRecord: { requirements: [{ id: "R-1", desc: "Retain admitted Task workspace authority", task_ids: ["T-1"] }] },
  }).create();
  const location = manager.specLocation(specId);
  const taskLocation = location.taskArtifactLocation("T-1");
  const task = { id: "T-1", title: "Retain Task workspace authority",
    goal: "Publish the admitted Task with its own directories", parent: null,
    origin: "plan", added_round: 0, status: "pending" };
  return { directory, manager, specId, fixture, location, taskLocation, task };
}

test("Task admission persists its Task and all five empty workspace directories", (t) => {
  const value = taskAdmission(t);
  value.fixture.addTask(value.task);
  const reloaded = makeFlowManager(value.directory);
  assert.equal(reloaded.loadReadOnly(value.specId).tasks.find((task) => task.id === "T-1").title, value.task.title);
  assert.equal(JSON.parse(fs.readFileSync(value.location.specFile, "utf8")).tasks[0].id, "T-1");
  for (const directory of [value.taskLocation.implDirectory, value.taskLocation.reviewDirectory,
    value.taskLocation.triageDirectory, value.taskLocation.repairDirectory, value.taskLocation.gateDirectory]) {
    assert.deepEqual(fs.readdirSync(directory), []);
  }
});

test("an authority refusal during rollback remains blocked after a fresh catalog read", (t) => {
  const value = taskAdmission(t);
  const catalog = new FlowArtifactCatalogStore({ location: value.location }).require();
  const snapshot = catalog.artifacts.find((artifact) => artifact.logicalKey === "spec.snapshot");
  assert.ok(snapshot);
  const originalDirectory = path.dirname(value.location.resolve(snapshot.relativePath));
  const backup = path.join(value.directory, "original-spec-snapshot");
  const write = CanonicalFlowArtifactWrite.prototype.write;
  const entries = RealDirectoryAuthority.prototype.entries;
  const injected = new Error("ordinary write failure before rollback");
  let rollingBack = false;
  let replaced = false;
  t.mock.method(CanonicalFlowArtifactWrite.prototype, "write", function (...args) {
    if (this.artifact.logicalKey === "spec.snapshot") {
      rollingBack = true;
      throw injected;
    }
    return write.apply(this, args);
  });
  t.mock.method(RealDirectoryAuthority.prototype, "entries", function (...args) {
    const result = entries.apply(this, args);
    if (rollingBack && !replaced && this.directory === originalDirectory) {
      fs.renameSync(originalDirectory, backup);
      fs.mkdirSync(originalDirectory);
      fs.writeFileSync(path.join(originalDirectory, "foreign.txt"), "foreign snapshot owner\n");
      replaced = true;
    }
    return result;
  });
  assert.throws(() => value.fixture.addTask(value.task), (error) =>
    error instanceof AggregateError && error.errors.includes(injected));
  assert.equal(replaced, true);
  const journal = value.location.resolve(".runtime/catalog-transaction.json");
  const bytes = fs.readFileSync(journal);
  assert.equal(JSON.parse(bytes).rollbackBlocked, true);
  assert.throws(() => new FlowArtifactCatalogStore({
    location: makeFlowManager(value.directory).specLocation(value.specId),
  }).require(), /rollback is blocked by a rejected directory authority/);
  assert.deepEqual(fs.readdirSync(originalDirectory), ["foreign.txt"]);
  assert.equal(fs.readFileSync(path.join(originalDirectory, "foreign.txt"), "utf8"), "foreign snapshot owner\n");
  assert.deepEqual(fs.readFileSync(journal), bytes);
});

test("Task admission refuses a replaced task root between sibling workspace creation without foreign mutation", (t) => {
  const value = taskAdmission(t);
  const originalResolve = RealDirectoryAuthority.resolve;
  const backup = path.join(value.directory, "original-task-workspace");
  let replaced = false;
  t.mock.method(RealDirectoryAuthority, "resolve", function (target, options = {}) {
    const authority = originalResolve.call(this, target, options);
    if (!replaced && options.create && path.resolve(target) === value.taskLocation.implDirectory) {
      assert.deepEqual(fs.readdirSync(value.taskLocation.directory), ["impl"]);
      fs.renameSync(value.taskLocation.directory, backup);
      fs.mkdirSync(value.taskLocation.directory);
      fs.writeFileSync(path.join(value.taskLocation.directory, "foreign.txt"), "foreign Task owner\n");
      replaced = true;
    }
    return authority;
  });
  let failure;
  try { value.fixture.addTask(value.task); } catch (error) { failure = error; }
  assert.equal(replaced, true, "replacement follows real impl directory creation");
  assert.ok(failure instanceof Error);
  assert.deepEqual(fs.readdirSync(value.taskLocation.directory), ["foreign.txt"]);
  assert.equal(fs.readFileSync(path.join(value.taskLocation.directory, "foreign.txt"), "utf8"), "foreign Task owner\n");
  assert.deepEqual(fs.readdirSync(backup), ["impl"]);
  const journalPath = value.location.resolve(".runtime/catalog-transaction.json");
  const journalBytes = fs.readFileSync(journalPath);
  assert.equal(JSON.parse(journalBytes).rollbackBlocked, true);
  const sameStore = new FlowArtifactCatalogStore({ location: value.location });
  const freshStore = new FlowArtifactCatalogStore({ location: makeFlowManager(value.directory).specLocation(value.specId) });
  for (const store of [sameStore, sameStore, freshStore]) {
    assert.throws(() => store.require(), /rollback is blocked by a rejected directory authority/);
    assert.deepEqual(fs.readdirSync(value.taskLocation.directory), ["foreign.txt"]);
    assert.equal(fs.readFileSync(path.join(value.taskLocation.directory, "foreign.txt"), "utf8"), "foreign Task owner\n");
    assert.deepEqual(fs.readFileSync(journalPath), journalBytes);
  }
  const stored = JSON.parse(journalBytes);
  for (const invalid of [undefined, null, "false", 1]) {
    const { digest: _digest, ...document } = { ...stored, rollbackBlocked: invalid };
    const encoded = JSON.stringify(document);
    const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(encoded),
      digest: crypto.createHash("sha256").update(encoded).digest("hex") }));
    fs.writeFileSync(journalPath, bytes);
    assert.throws(() => new FlowArtifactCatalogStore({ location: value.location }).require(), /journal integrity/);
    assert.deepEqual(fs.readFileSync(journalPath), bytes);
    assert.deepEqual(fs.readdirSync(value.taskLocation.directory), ["foreign.txt"]);
  }
});

test("a directory rejected during journal recovery cannot be adopted by the next reader", (t) => {
  const value = taskAdmission(t);
  const catalog = new FlowArtifactCatalogStore({ location: value.location }).require();
  const snapshot = catalog.artifacts.find((artifact) => artifact.logicalKey === "spec.snapshot");
  assert.ok(snapshot);
  const directory = path.dirname(value.location.resolve(snapshot.relativePath));
  const backup = path.join(value.directory, "original-recovery-snapshot");
  const write = CanonicalFlowArtifactWrite.prototype.write;
  const restore = VersionTreeSnapshot.prototype.restore;
  const entries = RealDirectoryAuthority.prototype.entries;
  let interrupted = false;
  t.mock.method(CanonicalFlowArtifactWrite.prototype, "write", function (...args) {
    if (this.artifact.logicalKey === "spec.snapshot") throw new Error("ordinary publication failure");
    return write.apply(this, args);
  });
  t.mock.method(VersionTreeSnapshot.prototype, "restore", function (...args) {
    if (!interrupted) {
      interrupted = true;
      throw new Error("interrupt rollback before its first operation");
    }
    return restore.apply(this, args);
  });
  assert.throws(() => value.fixture.addTask(value.task), AggregateError);
  const journal = value.location.resolve(".runtime/catalog-transaction.json");
  assert.equal(JSON.parse(fs.readFileSync(journal)).rollbackBlocked, false);
  let replaced = false;
  t.mock.method(RealDirectoryAuthority.prototype, "entries", function (...args) {
    const result = entries.apply(this, args);
    if (!replaced && this.directory === directory) {
      fs.renameSync(directory, backup);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "foreign.txt"), "foreign recovery owner\n");
      replaced = true;
    }
    return result;
  });
  assert.throws(() => new FlowArtifactCatalogStore({ location: value.location }).require());
  assert.equal(replaced, true);
  const journalBytes = fs.readFileSync(journal);
  assert.equal(JSON.parse(journalBytes).rollbackBlocked, true);
  assert.throws(() => new FlowArtifactCatalogStore({
    location: makeFlowManager(value.directory).specLocation(value.specId),
  }).require(), /rollback is blocked by a rejected directory authority/);
  assert.deepEqual(fs.readdirSync(directory), ["foreign.txt"]);
  assert.equal(fs.readFileSync(path.join(directory, "foreign.txt"), "utf8"), "foreign recovery owner\n");
  assert.deepEqual(fs.readFileSync(journal), journalBytes);
});

test("a directory recreated after rollback removal remains protected across repeated and fresh recovery", (t) => {
  const value = taskAdmission(t);
  const sameStore = new FlowArtifactCatalogStore({ location: value.location });
  const write = CanonicalFlowArtifactWrite.prototype.write;
  const remove = fs.rmdirSync;
  const injected = new Error("reject Task Spec publication before catalog commit");
  const directory = value.taskLocation.implDirectory;
  let replaced = false;
  t.mock.method(CanonicalFlowArtifactWrite.prototype, "write", function (...args) {
    if (this.artifact.logicalKey === "spec.snapshot") throw injected;
    return write.apply(this, args);
  });
  t.mock.method(fs, "rmdirSync", function (target, ...args) {
    const result = remove.call(this, target, ...args);
    if (!replaced && target === directory) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "foreign.txt"), "foreign rollback owner\n");
      replaced = true;
    }
    return result;
  });
  assert.throws(() => value.fixture.addTask(value.task), (error) =>
    error instanceof AggregateError && error.errors.includes(injected));
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(path.join(directory, "foreign.txt"), "utf8"), "foreign rollback owner\n");
  const journal = value.location.resolve(".runtime/catalog-transaction.json");
  const bytes = fs.readFileSync(journal);
  for (const store of [sameStore, sameStore, new FlowArtifactCatalogStore({
    location: makeFlowManager(value.directory).specLocation(value.specId),
  })]) {
    let failure = null;
    try { store.require(); } catch (error) { failure = error; }
    assert.equal(fs.readFileSync(path.join(directory, "foreign.txt"), "utf8"), "foreign rollback owner\n");
    assert.deepEqual(fs.readdirSync(directory), ["foreign.txt"]);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /rollback is blocked by a rejected directory authority/);
    assert.deepEqual(fs.readFileSync(journal), bytes);
  }
  assert.equal(JSON.parse(bytes).rollbackBlocked, true);
});
