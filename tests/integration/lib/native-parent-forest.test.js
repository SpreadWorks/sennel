import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { NativeAbsolutePath, NativePathResolution } from "../../../src/lib/native-path.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

class ParentForestFixture {
  constructor(t) {
    this.root = createTmpDir("native-parent-forest-");
    t.after(() => removeTmpDir(this.root));
    this.names = ["a/one", "a/deeper/two", "b/three", "資料/space name.bin"];
    for (const name of this.names) {
      const file = path.join(this.root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, name);
    }
    this.authority = new RealDirectoryAuthority(this.root);
  }
  values(names = this.names) { return names.map(name => new NativeAbsolutePath(path.join(this.root, name))); }
  resolve(names = this.names) { return NativeAbsolutePath.resolveAuthorities(this.authority, this.values(names)); }
}

test("native parent forests preserve exact logical paths and absence, then reacquire actual replacements", t => {
  const fixture = new ParentForestFixture(t);
  const names = [...fixture.names, "missing/deeper/file"];
  const result = fixture.resolve(names);
  assert.equal(Object.isFrozen(result), true);
  for (const [index, value] of result.entries()) {
    assert.ok(value instanceof NativePathResolution);
    assert.equal(String(value.logicalPath), names[index]);
    assert.equal(value.directoryAuthority?.directory ?? null,
      index === fixture.names.length ? null : path.dirname(path.join(fixture.root, names[index])));
  }
  assert.equal(fs.existsSync(path.join(fixture.root, "missing")), false);
  const retained = path.join(fixture.root, "retained-a");
  fs.renameSync(path.join(fixture.root, "a"), retained);
  fs.mkdirSync(path.join(fixture.root, "a"));
  fs.writeFileSync(path.join(fixture.root, "a/one"), "fresh");
  const next = fixture.resolve(["a/one"]);
  assert.notEqual(next[0].directoryAuthority.identity.ino, result[0].directoryAuthority.identity.ino);
  assert.equal(fs.readFileSync(path.join(fixture.root, "a/one"), "utf8"), "fresh");
  assert.equal(fs.readFileSync(path.join(retained, "one"), "utf8"), "a/one");
});

test("a native forest refuses an earlier parent replaced while its final target is observed", t => {
  const fixture = new ParentForestFixture(t);
  const first = path.join(fixture.root, "a");
  const last = path.join(fixture.root, "資料/space name.bin");
  const retained = path.join(fixture.root, "retained-original");
  const lstat = fs.lstatSync;
  let replaced = false, result;
  const observer = t.mock.method(fs, "lstatSync", function (target, ...options) {
    const value = Reflect.apply(lstat, this, [target, ...options]);
    if (target === last && !replaced) {
      fs.renameSync(first, retained);
      fs.mkdirSync(first);
      fs.writeFileSync(path.join(first, "foreign"), "preserved");
      replaced = true;
    }
    return value;
  });
  try { assert.throws(() => { result = fixture.resolve(); }, error => RealDirectoryAuthority.isAuthorityFailure(error)); }
  finally { observer.mock.restore(); }
  assert.equal(replaced, true);
  assert.equal(result, undefined);
  assert.equal(fs.readFileSync(path.join(first, "foreign"), "utf8"), "preserved");
  assert.equal(fs.readFileSync(path.join(retained, "one"), "utf8"), "a/one");
  assert.equal(fs.readFileSync(last, "utf8"), "資料/space name.bin");
});

test("native forests reject outside paths before inspecting their namespace", t => {
  const fixture = new ParentForestFixture(t);
  const outside = new NativeAbsolutePath(fixture.root + "-neighbor/file");
  const lstat = fs.lstatSync;
  const observer = t.mock.method(fs, "lstatSync", function (target, ...options) {
    assert.notEqual(target, outside.value);
    assert.notEqual(target, path.dirname(outside.value));
    return Reflect.apply(lstat, this, [target, ...options]);
  });
  try {
    assert.throws(() => NativeAbsolutePath.resolveAuthorities(fixture.authority, [...fixture.values(), outside]),
      { code: "PORTABLE_PATH_INVALID" });
  } finally { observer.mock.restore(); }
  for (const name of fixture.names) assert.equal(fs.readFileSync(path.join(fixture.root, name), "utf8"), name);
});
