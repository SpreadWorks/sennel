import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync, cpSync } from "node:fs";
import { createTmpDir } from "../support/builders/tmp-dir.js";
import { join } from "node:path";
import { test } from "node:test";
import { SeedWorkRoot } from "../support/builders/seed-work-root.js";

test("immutable seed creates independent work roots with cleanup", (t) => {
  const seed = createTmpDir("sennel-seed-");
  const parent = createTmpDir("sennel-seed-work-parent-");
  let first;
  let second;
  t.after(() => {
    first?.cleanup(); second?.cleanup();
    rmSync(seed, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  });
  writeFileSync(join(seed, "seed.txt"), "seed");
  first = new SeedWorkRoot(seed, { parent });
  second = new SeedWorkRoot(seed, { parent });
  assert.notEqual(first.root, second.root);
  assert.equal(first.seed, seed);
  assert.ok(existsSync(join(first.root, "seed.txt")));
  writeFileSync(join(first.root, "seed.txt"), "case mutation");
  assert.equal(readFileSync(join(second.root, "seed.txt"), "utf8"), "seed");
  assert.equal(readFileSync(join(seed, "seed.txt"), "utf8"), "seed");
  first.cleanup(); second.cleanup();
  assert.equal(existsSync(first.root), false);
  assert.equal(existsSync(second.root), false);
  assert.deepEqual(readdirSync(parent), [], "cleanup reclaims the complete owned allocation");
  rmSync(seed, { recursive: true, force: true });
});

test("a failed seed copy removes its partially populated owned root and preserves the failure", (t) => {
  const seed = createTmpDir("sennel-seed-failure-");
  let ownedRoot;
  t.after(() => {
    if (ownedRoot) rmSync(ownedRoot, { recursive: true, force: true });
    rmSync(seed, { recursive: true, force: true });
  });
  writeFileSync(join(seed, "seed.txt"), "unchanged seed");
  const failure = new Error("copy interrupted");
  assert.throws(() => new SeedWorkRoot(seed, { copy(source, target) {
    assert.equal(source, seed);
    ownedRoot = target;
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "partial.txt"), "partial copy");
    throw failure;
  } }), (error) => error === failure);
  assert.equal(existsSync(ownedRoot), false);
  assert.equal(readFileSync(join(seed, "seed.txt"), "utf8"), "unchanged seed");
});


test("an exclusive seed copy preserves conflicting bytes and unrelated roots before reclaiming its allocation", (t) => {
  const seed = createTmpDir("sennel-seed-exclusive-");
  const parent = createTmpDir("sennel-seed-exclusive-parent-");
  const sibling = createTmpDir("sennel-seed-unrelated-");
  t.after(() => {
    rmSync(seed, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  });
  writeFileSync(join(seed, "seed.txt"), "immutable source");
  writeFileSync(join(sibling, "sentinel.txt"), "unrelated root");
  let refusalObserved = false;
  assert.throws(() => new SeedWorkRoot(seed, { parent, copy(source, target, options) {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "seed.txt"), "existing destination");
    try { cpSync(source, target, options); }
    catch (error) {
      assert.equal(error.code, "ERR_FS_CP_EEXIST");
      assert.equal(readFileSync(join(target, "seed.txt"), "utf8"), "existing destination");
      refusalObserved = true;
      throw error;
    }
    assert.fail("an exclusive copy must refuse the conflicting file");
  } }), (error) => error.code === "ERR_FS_CP_EEXIST");
  assert.equal(refusalObserved, true);
  assert.deepEqual(readdirSync(parent), [], "copy failure reclaims its complete owned allocation");
  assert.equal(readFileSync(join(seed, "seed.txt"), "utf8"), "immutable source");
  assert.equal(readFileSync(join(sibling, "sentinel.txt"), "utf8"), "unrelated root");
});
