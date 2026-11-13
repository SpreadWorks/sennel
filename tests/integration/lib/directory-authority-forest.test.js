import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("directory-forest-");
  t.after(() => removeTmpDir(root));
  const parent = path.join(root, "parent");
  for (const name of ["a", "b"]) fs.mkdirSync(path.join(parent, name), { recursive: true });
  const authority = new RealDirectoryAuthority(parent);
  return { root, parent, leaves: ["a", "b"].map((name) => authority.descendant(path.join(parent, name))) };
}

test("complete directory observation retains every identity and rechecks replacements on the next call", (t) => {
  const { root, parent, leaves } = fixture(t);
  const identities = leaves.map((leaf) => leaf.identity);
  RealDirectoryAuthority.assertAllStable(leaves.values());
  assert.deepEqual(leaves.map((leaf) => leaf.identity), identities);
  fs.renameSync(path.join(parent, "b"), path.join(root, "old-b"));
  fs.mkdirSync(path.join(parent, "b"));
  fs.writeFileSync(path.join(parent, "b", "foreign"), "preserved");
  assert.throws(() => RealDirectoryAuthority.assertAllStable(leaves), {
    code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID",
  });
  assert.equal(fs.readFileSync(path.join(parent, "b", "foreign"), "utf8"), "preserved");
  assert.equal(fs.statSync(path.join(root, "old-b")).ino, Number(identities[1].ino));
});

test("complete directory observation detects an ancestor replaced while observing its final descendant", (t) => {
  const { root, parent, leaves } = fixture(t);
  const original = fs.lstatSync;
  let replaced = false;
  t.mock.method(fs, "lstatSync", (target, options) => {
    const result = original(target, options);
    if (!replaced && target === leaves[1].directory) {
      replaced = true;
      fs.renameSync(parent, path.join(root, "saved"));
      fs.mkdirSync(parent);
      fs.writeFileSync(path.join(parent, "foreign"), "preserved");
    }
    return result;
  });
  assert.throws(() => RealDirectoryAuthority.assertAllStable(leaves), {
    code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID",
  });
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(path.join(parent, "foreign"), "utf8"), "preserved");
  assert.equal(fs.statSync(path.join(root, "saved", "b")).ino, Number(leaves[1].identity.ino));
});

test("shared native paths cannot hide conflicting retained generations", (t) => {
  const { root, parent, leaves } = fixture(t);
  fs.renameSync(path.join(parent, "a"), path.join(root, "old-a"));
  fs.mkdirSync(path.join(parent, "a"));
  const current = new RealDirectoryAuthority(path.join(parent, "a"));
  assert.throws(() => RealDirectoryAuthority.assertAllStable([current, leaves[0]]), {
    code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID",
  });
  assert.equal(fs.statSync(path.join(root, "old-a")).ino, Number(leaves[0].identity.ino));
  assert.equal(current.assertStable(), path.join(parent, "a"));
});

test("child observations retain fresh identities without caching an earlier namespace generation", (t) => {
  const { root, parent, leaves } = fixture(t);
  const authority = leaves[0].parentAuthority;
  const before = authority.observeChildren(["a", "b"]);
  assert.deepEqual(before.map((child) => child.directory), leaves.map((child) => child.directory));
  fs.renameSync(path.join(parent, "a"), path.join(root, "old-a"));
  fs.mkdirSync(path.join(parent, "a"));
  const after = authority.observeChildren(["a", "b"]);
  assert.notDeepEqual(after[0].identity, before[0].identity);
  assert.deepEqual(after[1].identity, before[1].identity);
  assert.throws(() => before[0].assertStable(), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  assert.equal(after[0].assertStable(), path.join(parent, "a"));
});

test("child capture detects its retained parent replaced while capturing the final child", (t) => {
  const { root, parent, leaves } = fixture(t);
  const original = fs.lstatSync;
  let replaced = false;
  t.mock.method(fs, "lstatSync", (target, options) => {
    const result = original(target, options);
    if (!replaced && target === path.join(parent, "b")) {
      replaced = true;
      fs.renameSync(parent, path.join(root, "saved"));
      fs.mkdirSync(parent);
      fs.writeFileSync(path.join(parent, "foreign"), "preserved");
    }
    return result;
  });
  assert.throws(() => leaves[0].parentAuthority.observeChildren(["a", "b"]), {
    code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID",
  });
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(path.join(parent, "foreign"), "utf8"), "preserved");
  assert.equal(fs.statSync(path.join(root, "saved", "b")).ino, Number(leaves[1].identity.ino));
});
