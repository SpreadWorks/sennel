import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CanonicalScenarioSeed } from "../support/assertions/canonical-persistence.js";
import { SeedWorkRoot, SeedCleanupScope } from "../support/builders/seed-work-root.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";
import { CanonicalFlowFixture, makeFlowManager } from "../support/infrastructure/flow-setup.js";

function source(t) {
  const root = createTmpDir("sennel-canonical-seed-contract-");
  t.after(() => removeTmpDir(root));
  writeFileSync(join(root, "input.txt"), "immutable input\n");
  const manager = makeFlowManager(root);
  const specId = "001-seed-contract";
  new CanonicalFlowFixture({ flowManager: manager, specId }).create().registerActive();
  return { root, manager, specId, git: false };
}

test("a canonical seed keeps independent clone mutations local and detects source-byte changes to its own root", (t) => {
  const seed = CanonicalScenarioSeed.freeze(t, source(t));
  assert(seed instanceof CanonicalScenarioSeed);
  const copy = new SeedWorkRoot(seed.root);
  t.after(() => copy.cleanup());
  seed.assertClone(makeFlowManager(copy.root));
  writeFileSync(join(copy.root, "input.txt"), "case mutation\n");
  seed.assertUnchanged();
  assert.equal(readFileSync(join(seed.root, "input.txt"), "utf8"), "immutable input\n");
  writeFileSync(join(seed.root, "input.txt"), "invalid seed mutation\n");
  try {
    assert.throws(() => seed.assertUnchanged(), /immutable seed source and filesystem contents/);
  } finally { writeFileSync(join(seed.root, "input.txt"), "immutable input\n"); }
});

test("seed ownership reclaims a copied root when constructor readback fails and preserves the source", async (t) => {
  const input = source(t);
  const owner = new SeedCleanupScope((cleanup) => t.after(cleanup));
  const failure = new Error("readback interrupted");
  let copiedRoot;
  class FailedReadbackSeed extends CanonicalScenarioSeed {
    constructor(options) {
      super(options);
      copiedRoot = options.root;
      throw failure;
    }
  }
  assert.throws(() => FailedReadbackSeed.freeze(owner, input), (error) => error === failure);
  assert.equal(existsSync(copiedRoot), true, "the owning scope retains the allocated root until teardown");
  await owner.cleanup();
  assert.equal(existsSync(copiedRoot), false);
  assert.equal(readFileSync(join(input.root, "input.txt"), "utf8"), "immutable input\n");
});
