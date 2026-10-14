import { createTmpDir as createTestDirectory } from "../support/builders/tmp-dir.js";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SeedWorkRoot } from "../support/builders/seed-work-root.js";

test("immutable seed creates independent work roots with cleanup", () => {
  const seed = createTestDirectory("sennel-seed-");
  writeFileSync(join(seed, "seed.txt"), "seed");
  const first = new SeedWorkRoot(seed);
  const second = new SeedWorkRoot(seed);
  assert.notEqual(first.root, second.root);
  assert.equal(first.seed, seed);
  assert.ok(existsSync(join(first.root, "seed.txt")));
  first.cleanup(); second.cleanup();
  assert.equal(existsSync(first.root), false);
  assert.equal(existsSync(second.root), false);
  rmSync(seed, { recursive: true, force: true });
});
