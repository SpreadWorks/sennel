import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ReadOnlyInvocationWorkspace } from "../../../src/lib/readonly-invocation-workspace.js";
import { TemporaryPaths } from "../../../src/lib/temporary-paths.js";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { Logger } from "../../../src/lib/log.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function workspace(t) {
  const value = ReadOnlyInvocationWorkspace.create();
  t.after(() => {
    // Tests that deliberately leave unconfirmed work explicitly preserve and
    // inspect that evidence before their test-owned final teardown.
    if (fs.existsSync(value.path)) fs.rmSync(value.path, { recursive: true });
  });
  return value;
}
const confirmation = (value) => ({ generation: value.generation, resourcesReleased: true, normalExit: true });

test("factory mints unique canonical Node temporary children without granting project scratch access", (t) => {
  const root = createTmpDir("workspace-project-");
  t.after(() => removeTmpDir(root));
  const first = workspace(t);
  const second = workspace(t);
  assert.equal(path.dirname(first.path), fs.realpathSync(os.tmpdir()));
  assert.notEqual(first.path, second.path);
  assert.notEqual(first.generation, second.generation);
  assert.throws(() => new ReadOnlyInvocationWorkspace(first.path), TypeError);
  assert.throws(() => new TemporaryPaths(root).validate(first.path), { code: "TEMPORARY_PATH_OUTSIDE_PROJECT" });
  assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
  assert.throws(() => first.validate(path.join(first.path, "..", "outside")), { code: "READONLY_WORKSPACE_OUTSIDE_ROOT" });
});

test("readonly namespace lookup creates no files and common file consumers preserve exact snapshot and diagnostic bytes", async (t) => {
  const value = workspace(t);
  const snapshots = value.snapshots();
  const logs = value.logs();
  assert.deepEqual(fs.readdirSync(value.path), []);
  const file = path.join(snapshots, "binary snapshot.bin");
  const bytes = Buffer.from([0, 255, 42, 10]);
  value.writeFile(file, bytes);
  assert.deepEqual(value.readFile(file), bytes);
  assert.deepEqual(new AtomicFile(file).read(), bytes);
  const diagnostic = path.join(logs, "diagnostic.log");
  value.appendFile(diagnostic, "first\n");
  value.appendFile(diagnostic, "second\n");
  assert.equal(value.readFile(diagnostic).toString(), "first\nsecond\n");
  const logger = new Logger({ logDir: logs, enabled: true, cwd: value.path });
  logger.event("workspace diagnostic");
  await logger.flush();
  const journal = fs.readdirSync(logs).find((name) => name.endsWith(".jsonl"));
  assert.match(new AtomicFile(path.join(logs, journal)).read().toString(), /workspace diagnostic/);
  value.complete(confirmation(value));
  value.cleanup({ generation: value.generation });
  assert.equal(fs.existsSync(value.path), false);
  value.cleanup({ generation: value.generation });
});

test("unconfirmed execution retains reloadable journal until matching resource release and normal exit are confirmed", (t) => {
  const value = workspace(t);
  const execution = value.beginExecution();
  const journal = path.join(value.control(), `execution-${execution.id}.json`);
  const pending = new AtomicFile(journal).read();
  assert.deepEqual(JSON.parse(pending), { generation: value.generation, id: execution.id, settled: false });
  assert.throws(() => value.cleanup({ generation: value.generation }), { code: "READONLY_WORKSPACE_INCOMPLETE" });
  assert.throws(() => value.complete(confirmation(value)), { code: "READONLY_WORKSPACE_EXECUTION_UNCONFIRMED" });
  assert.throws(() => value.settleExecution(execution, { ...confirmation(value), normalExit: false }), { code: "READONLY_WORKSPACE_UNCONFIRMED" });
  assert.throws(() => value.settleExecution(execution, { ...confirmation(value), generation: "another" }), { code: "READONLY_WORKSPACE_GENERATION_MISMATCH" });
  assert.deepEqual(new AtomicFile(journal).read(), pending);
  assert.equal(value.pendingExecutionCount, 1);
  value.settleExecution(execution, confirmation(value));
  assert.equal(JSON.parse(new AtomicFile(journal).read()).settled, true);
  assert.equal(value.pendingExecutionCount, 0);
  value.complete(confirmation(value));
  assert.throws(() => value.cleanup({ generation: "another" }), { code: "READONLY_WORKSPACE_GENERATION_MISMATCH" });
  assert.equal(fs.existsSync(journal), true);
  value.cleanup({ generation: value.generation });
  assert.equal(fs.existsSync(value.path), false);
});

test("cleanup refuses a replaced owned directory and preserves the replacement and original evidence", (t) => {
  const value = workspace(t);
  value.writeFile(path.join(value.snapshots(), "evidence"), "original");
  value.complete(confirmation(value));
  const displaced = `${value.path}-displaced`;
  t.after(() => fs.rmSync(displaced, { recursive: true, force: true }));
  fs.renameSync(value.path, displaced);
  fs.mkdirSync(value.path);
  fs.writeFileSync(path.join(value.path, "sentinel"), "replacement");
  assert.throws(() => value.cleanup({ generation: value.generation }), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  assert.equal(fs.readFileSync(path.join(value.path, "sentinel"), "utf8"), "replacement");
  assert.equal(fs.readFileSync(path.join(displaced, "snapshots", "evidence"), "utf8"), "original");
});

test("cleanup preserves a replacement nested snapshot directory and retained original bytes", (t) => {
  const value = workspace(t);
  const snapshots = value.snapshots();
  value.writeFile(path.join(snapshots, "evidence"), "original");
  value.complete(confirmation(value));
  const displaced = path.join(value.path, "displaced-snapshots");
  fs.renameSync(snapshots, displaced);
  fs.mkdirSync(snapshots);
  fs.writeFileSync(path.join(snapshots, "sentinel"), "replacement");
  assert.throws(() => value.cleanup({ generation: value.generation }), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  assert.equal(fs.readFileSync(path.join(snapshots, "sentinel"), "utf8"), "replacement");
  assert.equal(fs.readFileSync(path.join(displaced, "evidence"), "utf8"), "original");
});

test("settled nested resource cleanup releases its minted directory before completing the workspace", (t) => {
  const value = workspace(t);
  const execution = value.beginExecution();
  const resource = value.create(value.runtime("fixed-input"), "resource-");
  value.writeFile(path.join(resource, "input.bin"), Buffer.from([0, 42, 255]));
  const journal = path.join(value.control(), `execution-${execution.id}.json`);
  assert.throws(() => value.cleanupDirectory(resource, confirmation(value)), { code: "READONLY_WORKSPACE_EXECUTION_UNCONFIRMED" });
  assert.equal(fs.existsSync(resource), true);
  assert.equal(JSON.parse(new AtomicFile(journal).read()).settled, false);
  value.settleExecution(execution, confirmation(value));
  value.cleanupDirectory(resource, confirmation(value));
  assert.equal(fs.existsSync(resource), false);
  assert.equal(JSON.parse(new AtomicFile(journal).read()).settled, true);
  value.complete(confirmation(value));
  value.cleanup({ generation: value.generation });
  assert.equal(fs.existsSync(value.path), false);
});

test("settled resource cleanup refuses a replacement and does not acquire ownership from its path", (t) => {
  const value = workspace(t);
  const resource = value.create(value.runtime("fixed-input"), "resource-");
  const unminted = value.ensureDirectory(path.join(value.path, "unminted"));
  assert.throws(() => value.cleanupDirectory(unminted, confirmation(value)), { code: "READONLY_WORKSPACE_DIRECTORY_NOT_OWNED" });
  const displaced = `${resource}-displaced`;
  fs.renameSync(resource, displaced);
  fs.mkdirSync(resource);
  fs.writeFileSync(path.join(resource, "sentinel"), "replacement");
  assert.throws(() => value.cleanupDirectory(resource, confirmation(value)), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  assert.equal(fs.readFileSync(path.join(resource, "sentinel"), "utf8"), "replacement");
  assert.equal(fs.existsSync(displaced), true);
});

test("snapshot reading keeps its selected workspace parent identity through physical admission", (t) => {
  const value = workspace(t);
  const snapshots = value.snapshots();
  const file = path.join(snapshots, "evidence");
  value.writeFile(file, "original");
  const displaced = `${snapshots}-displaced`;
  const resolve = RealDirectoryAuthority.resolve;
  let replaced = false;
  t.mock.method(RealDirectoryAuthority, "resolve", function(directory, options) {
    const authority = resolve.call(this, directory, options);
    if (!replaced && directory === snapshots) {
      replaced = true;
      fs.renameSync(snapshots, displaced);
      fs.mkdirSync(snapshots);
      fs.writeFileSync(file, "replacement");
    }
    return authority;
  });
  assert.throws(() => value.readFile(file), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(file, "utf8"), "replacement");
  assert.equal(fs.readFileSync(path.join(displaced, "evidence"), "utf8"), "original");
});

test("diagnostic append keeps its selected workspace parent identity before physical writing", (t) => {
  const value = workspace(t);
  const logs = value.ensureDirectory(value.logs());
  const file = path.join(logs, "diagnostic.log");
  value.appendFile(file, "original");
  const displaced = `${logs}-displaced`;
  const ensure = value.ensureDirectory.bind(value);
  t.mock.method(value, "ensureDirectory", function(directory) {
    const result = ensure(directory);
    fs.renameSync(logs, displaced);
    fs.mkdirSync(logs);
    fs.writeFileSync(file, "replacement");
    return result;
  });
  assert.throws(() => value.appendFile(file, "new"), (error) => error.cause?.code === "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" && error.bytesWritten === 0);
  assert.equal(fs.readFileSync(file, "utf8"), "replacement");
  assert.equal(fs.readFileSync(path.join(displaced, "diagnostic.log"), "utf8"), "original");
});

for (const replaced of ["root", "nested"]) {
  test(`pinned authority handoff refuses ${replaced} replacement before workspace directory creation`, (t) => {
    const value = workspace(t);
    const known = value.ensureDirectory(value.snapshots());
    const victim = replaced === "root" ? value.path : known;
    const displaced = `${victim}-displaced`;
    t.after(() => fs.rmSync(displaced, { recursive: true, force: true }));
    const target = path.join(known, "new-child");
    const resolve = RealDirectoryAuthority.resolve;
    let intercepted = false;
    t.mock.method(RealDirectoryAuthority, "resolve", function(directory, options) {
      if (!intercepted && directory === target && options.create) {
        intercepted = true;
        fs.renameSync(victim, displaced);
        fs.mkdirSync(victim);
        fs.writeFileSync(path.join(victim, "sentinel"), "replacement");
      }
      return resolve.call(this, directory, options);
    });
    assert.throws(() => value.ensureDirectory(target), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
    assert.equal(intercepted, true);
    assert.deepEqual(fs.readdirSync(victim), ["sentinel"]);
    assert.equal(fs.readFileSync(path.join(victim, "sentinel"), "utf8"), "replacement");
  });

  test(`pinned authority handoff refuses foreign bytes after ${replaced} workspace replacement`, (t) => {
    const value = workspace(t);
    const known = value.ensureDirectory(value.snapshots());
    const file = path.join(known, "evidence");
    value.writeFile(file, "original");
    const victim = replaced === "root" ? value.path : known;
    const displaced = `${victim}-displaced`;
    t.after(() => fs.rmSync(displaced, { recursive: true, force: true }));
    const resolve = RealDirectoryAuthority.resolve;
    let intercepted = false;
    t.mock.method(RealDirectoryAuthority, "resolve", function(directory, options) {
      if (!intercepted && directory === known) {
        intercepted = true;
        fs.renameSync(victim, displaced);
        fs.mkdirSync(known, { recursive: true });
        fs.writeFileSync(file, "replacement");
      }
      return resolve.call(this, directory, options);
    });
    assert.throws(() => value.readFile(file), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
    assert.equal(intercepted, true);
    assert.equal(fs.readFileSync(file, "utf8"), "replacement");
    const original = replaced === "root" ? path.join(displaced, "snapshots", "evidence") : path.join(displaced, "evidence");
    assert.equal(fs.readFileSync(original, "utf8"), "original");
  });
}

test("readonly temporary allocation stays outside both selected checkouts", (t) => {
  const root = createTmpDir("workspace-excluded-checkouts-");
  t.after(() => removeTmpDir(root));
  const executionRoot = path.join(root, "checkout");
  const temporaryParent = path.join(executionRoot, "local-tmp");
  fs.mkdirSync(temporaryParent, { recursive: true });
  const value = ReadOnlyInvocationWorkspace.create({ temporaryParent,
    outsideRoots: [executionRoot, root] });
  t.after(() => {
    if (fs.existsSync(value.path)) fs.rmSync(value.path, { recursive: true });
  });
  assert.equal(path.dirname(value.path), path.dirname(fs.realpathSync(root)));
  assert.deepEqual(fs.readdirSync(temporaryParent), []);
  assert.deepEqual(fs.readdirSync(executionRoot), ["local-tmp"]);
  assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
  value.complete(confirmation(value));
  value.cleanup({ generation: value.generation });
  assert.equal(fs.existsSync(value.path), false);
});
