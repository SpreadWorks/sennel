import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RealDirectoryAuthority, RealDirectoryTreeEntry, RealDirectoryTreeSnapshot,
  RealDirectoryTreeLimitError } from "../../../src/lib/real-directory-authority.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

class TreeObservationFixture {
  constructor(t) {
    this.root = createTmpDir("directory-tree-observation-");
    t.after(() => removeTmpDir(this.root));
    for (const name of ["a/deeper", "b", "transient"]) fs.mkdirSync(path.join(this.root, name), { recursive: true });
    for (const [name, text] of [["a/one", "one"], ["a/deeper/two", "two"], ["b/three", "three"], ["transient/ignored", "unentered"]]) {
      fs.writeFileSync(path.join(this.root, name), text);
    }
    this.authority = new RealDirectoryAuthority(this.root);
  }
  read(options = {}) { return this.authority.observeTreeEntries({ pruneDirectories: ["transient"], ...options }); }
  names(snapshot) { return snapshot.entries.map(entry => entry.relativePath.split(path.sep).join("/")).sort(); }
}

test("a complete directory observation returns immutable names and kinds without entering its pruned subtree", t => {
  const fixture = new TreeObservationFixture(t);
  const read = fs.readdirSync;
  const observer = t.mock.method(fs, "readdirSync", function (directory, ...options) {
    assert.notEqual(directory, path.join(fixture.root, "transient"));
    return Reflect.apply(read, this, [directory, ...options]);
  });
  let snapshot;
  try { snapshot = fixture.read(); }
  finally { observer.mock.restore(); }
  assert.ok(snapshot instanceof RealDirectoryTreeSnapshot);
  assert.equal(snapshot.directory, fixture.root);
  assert.equal(Object.isFrozen(snapshot.entries), true);
  assert.deepEqual(fixture.names(snapshot), ["a", "a/deeper", "a/deeper/two", "a/one", "b", "b/three", "transient"]);
  for (const entry of snapshot.entries) {
    assert.ok(entry instanceof RealDirectoryTreeEntry);
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(entry.isSymbolicLink(), false);
    assert.equal(entry.isFile(), entry.relativePath === path.join("a", "one")
      || entry.relativePath === path.join("a", "deeper", "two") || entry.relativePath === path.join("b", "three"));
    assert.equal(entry.isDirectory(), !entry.isFile());
    assert.equal(entry.linkCount, entry.isFile() ? 1 : null);
  }
  assert.equal(fs.readFileSync(path.join(fixture.root, "transient/ignored"), "utf8"), "unentered");
});

test("entry limits refuse without a partial snapshot and later calls capture actual directory replacement", t => {
  const fixture = new TreeObservationFixture(t);
  let result;
  assert.throws(() => { result = fixture.read({ maxEntries: 6 }); }, error =>
    error instanceof RealDirectoryTreeLimitError && error.maximum === 6 && error.code === "REAL_DIRECTORY_TREE_LIMIT");
  assert.equal(result, undefined);
  const first = fixture.read({ maxEntries: 7 });
  fs.renameSync(path.join(fixture.root, "a"), path.join(fixture.root, "retained-a"));
  fs.mkdirSync(path.join(fixture.root, "a"));
  fs.writeFileSync(path.join(fixture.root, "a", "new"), "fresh");
  const next = fixture.read();
  assert.ok(fixture.names(first).includes("a/one"));
  assert.ok(!fixture.names(next).includes("a/one"));
  assert.ok(fixture.names(next).includes("a/new"));
  assert.ok(fixture.names(next).includes("retained-a/one"));
  assert.equal(fs.readFileSync(path.join(fixture.root, "a/new"), "utf8"), "fresh");
  assert.equal(fs.readFileSync(path.join(fixture.root, "retained-a/one"), "utf8"), "one");
});

test("a parent changed during a later directory read refuses the complete observation and preserves both trees", t => {
  const fixture = new TreeObservationFixture(t);
  const retained = path.join(fixture.root, "retained-original");
  const read = fs.readdirSync;
  let first = null, changed = false, published;
  const observer = t.mock.method(fs, "readdirSync", function (directory, ...options) {
    const entries = Reflect.apply(read, this, [directory, ...options]);
    if (directory === path.join(fixture.root, "a") || directory === path.join(fixture.root, "b")) {
      if (first === null) first = directory;
      else if (directory !== first && !changed) {
        fs.renameSync(first, retained);
        fs.mkdirSync(first);
        fs.writeFileSync(path.join(first, "foreign"), "preserved");
        changed = true;
      }
    }
    return entries;
  });
  try {
    assert.throws(() => { published = fixture.read(); }, error => RealDirectoryAuthority.isAuthorityFailure(error));
  } finally { observer.mock.restore(); }
  assert.equal(changed, true);
  assert.equal(published, undefined);
  assert.equal(fs.readFileSync(path.join(first, "foreign"), "utf8"), "preserved");
  assert.equal(fs.existsSync(retained), true);
  assert.ok(fs.readdirSync(retained).length > 0);
});
