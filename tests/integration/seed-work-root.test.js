import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SeedWorkRoot } from "../support/builders/seed-work-root.js";

test("immutable seed creates independent work roots with cleanup", (t) => {
  const seed = mkdtempSync(join(tmpdir(), "sennel-seed-"));
  let first;
  let second;
  t.after(() => {
    first?.cleanup(); second?.cleanup();
    rmSync(seed, { recursive: true, force: true });
  });
  writeFileSync(join(seed, "seed.txt"), "seed");
  first = new SeedWorkRoot(seed);
  second = new SeedWorkRoot(seed);
  assert.notEqual(first.root, second.root);
  assert.equal(first.seed, seed);
  assert.ok(existsSync(join(first.root, "seed.txt")));
  writeFileSync(join(first.root, "seed.txt"), "case mutation");
  assert.equal(readFileSync(join(second.root, "seed.txt"), "utf8"), "seed");
  assert.equal(readFileSync(join(seed, "seed.txt"), "utf8"), "seed");
  first.cleanup(); second.cleanup();
  assert.equal(existsSync(first.root), false);
  assert.equal(existsSync(second.root), false);
  rmSync(seed, { recursive: true, force: true });
});

test("a failed seed copy removes its partially populated owned root and preserves the failure", (t) => {
  const seed = mkdtempSync(join(tmpdir(), "sennel-seed-failure-"));
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
    writeFileSync(join(target, "partial.txt"), "partial copy");
    throw failure;
  } }), (error) => error === failure);
  assert.equal(existsSync(ownedRoot), false);
  assert.equal(readFileSync(join(seed, "seed.txt"), "utf8"), "unchanged seed");
});
