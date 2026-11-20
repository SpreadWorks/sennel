import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RealDirectoryAuthority, RealDirectoryNameSnapshot } from "../../../src/lib/real-directory-authority.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

class NameForestFixture {
  constructor(t) {
    this.root = createTmpDir("directory-name-forest-");
    t.after(() => removeTmpDir(this.root));
    for (const [directory, name] of [["a", "one"], ["b", "two"]]) {
      fs.mkdirSync(path.join(this.root, directory));
      fs.writeFileSync(path.join(this.root, directory, name), name);
    }
    this.authorities = ["a", "b"].map(name => new RealDirectoryAuthority(path.join(this.root, name)));
  }
  read() { return RealDirectoryAuthority.observeNames(this.authorities); }
}

test("a directory-name forest returns exact immutable names and reads actual changes on its next call", t => {
  const fixture = new NameForestFixture(t);
  const first = fixture.read();
  assert.equal(Object.isFrozen(first), true);
  for (const [index, snapshot] of first.entries()) {
    assert.ok(snapshot instanceof RealDirectoryNameSnapshot);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.names), true);
    assert.equal(snapshot.directory, fixture.authorities[index].directory);
  }
  assert.deepEqual(first.map(value => value.names), [["one"], ["two"]]);
  fs.unlinkSync(path.join(fixture.root, "b/two"));
  fs.writeFileSync(path.join(fixture.root, "b/new"), "fresh");
  assert.deepEqual(fixture.read().map(value => value.names), [["one"], ["new"]]);
  assert.deepEqual(first[1].names, ["two"]);
  assert.equal(fs.readFileSync(path.join(fixture.root, "a/one"), "utf8"), "one");
  assert.equal(fs.readFileSync(path.join(fixture.root, "b/new"), "utf8"), "fresh");
});

test("a directory-name forest refuses an earlier parent replaced during its final listing without partial names", t => {
  const fixture = new NameForestFixture(t);
  const first = path.join(fixture.root, "a"), last = path.join(fixture.root, "b");
  const retained = path.join(fixture.root, "retained-a");
  const readdir = fs.readdirSync;
  let changed = false, result;
  const observer = t.mock.method(fs, "readdirSync", function (directory, ...options) {
    const names = Reflect.apply(readdir, this, [directory, ...options]);
    if (directory === last && !changed) {
      fs.renameSync(first, retained);
      fs.mkdirSync(first);
      fs.writeFileSync(path.join(first, "foreign"), "preserved");
      changed = true;
    }
    return names;
  });
  try { assert.throws(() => { result = fixture.read(); }, error => RealDirectoryAuthority.isAuthorityFailure(error)); }
  finally { observer.mock.restore(); }
  assert.equal(changed, true);
  assert.equal(result, undefined);
  assert.equal(fs.readFileSync(path.join(first, "foreign"), "utf8"), "preserved");
  assert.equal(fs.readFileSync(path.join(retained, "one"), "utf8"), "one");
  assert.equal(fs.readFileSync(path.join(last, "two"), "utf8"), "two");
});
