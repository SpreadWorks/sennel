import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, describe, it, test } from "node:test";
import { copyFixture } from "../acceptance/lib/pipeline.js";
import { runStubAcceptance } from "../acceptance/stub-pipeline.js";
import { testTemporaryRoot } from "../test-environment.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";
import { SeedCleanupScope, SeedWorkRoot } from "../support/builders/seed-work-root.js";
import { TaskReviewScenario } from "../support/builders/task-review-scenario.js";
import { CanonicalScenarioSeed } from "../support/assertions/canonical-persistence.js";
import { createSpecGateRepairScenario, seedSpecGateRepairScenario } from "../support/infrastructure/spec-gate-repair-scenario.js";

class TinySeed {
  constructor(t) {
    this.root = createTmpDir("sennel-owner-lifecycle-seed-");
    t.after(() => removeTmpDir(this.root));
    this.sibling = createTmpDir("sennel-owner-lifecycle-sibling-");
    t.after(() => removeTmpDir(this.sibling));
    fs.mkdirSync(path.join(this.root, ".sennel"));
    fs.writeFileSync(path.join(this.root, ".sennel", "config.json"), '{"type":"base"}');
    fs.writeFileSync(path.join(this.root, "source.txt"), "immutable seed\n");
    fs.writeFileSync(path.join(this.sibling, "sentinel.txt"), "unrelated sibling\n");
  }

  assertUnchanged() {
    assert.equal(fs.readFileSync(path.join(this.root, "source.txt"), "utf8"), "immutable seed\n");
    assert.equal(fs.readFileSync(path.join(this.root, ".sennel", "config.json"), "utf8"), '{"type":"base"}');
    assert.equal(fs.readFileSync(path.join(this.sibling, "sentinel.txt"), "utf8"), "unrelated sibling\n");
  }
}

function allocations(prefix) {
  return fs.readdirSync(testTemporaryRoot().path).filter((name) => name.startsWith(prefix)).sort();
}

test("acceptance fixture returns an owner that reclaims its complete allocation", (t) => {
  const seed = new TinySeed(t);
  const beforeCopy = allocations("sennel-acceptance-");
  const owner = copyFixture(seed.root, { agent: null });
  t.after(() => owner.cleanup());
  assert.ok(owner instanceof SeedWorkRoot);
  const allocatedParent = path.dirname(owner.root); // Observe only; the owner performs deletion.
  assert.ok(fs.existsSync(path.join(owner.root, "docs")));
  assert.equal(fs.readFileSync(path.join(owner.root, "source.txt"), "utf8"), "immutable seed\n");
  owner.cleanup();
  assert.equal(fs.existsSync(allocatedParent), false);
  assert.deepEqual(allocations("sennel-acceptance-"), beforeCopy);
  seed.assertUnchanged();
});

test("acceptance fixture cleans a post-copy configuration failure without replacing its error", (t) => {
  const seed = new TinySeed(t);
  const beforeCopy = allocations("sennel-acceptance-");
  const failure = new Error("configuration getter failed after real copy");
  const overrides = {};
  Object.defineProperty(overrides, "type", { enumerable: true, get() { throw failure; } });
  assert.throws(() => copyFixture(seed.root, overrides), (error) => error === failure);
  assert.deepEqual(allocations("sennel-acceptance-"), beforeCopy);
  seed.assertUnchanged();
});

for (const boundary of ["success", "provider", "pipeline", "quality"]) {
  test(`stub acceptance reclaims its owner after ${boundary}`, async (t) => {
    const seed = new TinySeed(t);
    const beforeCopy = allocations("sennel-acceptance-");
    const failure = new Error(`${boundary} failed after real copy`);
    let observedRoot;
    const operation = runStubAcceptance({
      getAcceptanceFixtureDir: () => seed.root,
      createProvider() {
        if (boundary === "provider") throw failure;
        return {};
      },
      async runPipeline(root) {
        observedRoot = root;
        assert.equal(fs.readFileSync(path.join(root, "source.txt"), "utf8"), "immutable seed\n");
        if (boundary === "pipeline") throw failure;
        return { steps: [{ name: "fixture-readback", status: "done" }] };
      },
      verifyQuality() {
        if (boundary === "quality") throw failure;
        return "pass";
      },
    });
    if (boundary === "success") {
      assert.deepEqual(await operation, { steps: [{ name: "fixture-readback", status: "done" }], quality: "pass" });
    } else await assert.rejects(operation, (error) => error === failure);
    if (observedRoot) assert.equal(fs.existsSync(path.dirname(observedRoot)), false);
    assert.deepEqual(allocations("sennel-acceptance-"), beforeCopy);
    seed.assertUnchanged();
  });
}

test("TaskReviewScenario actual t.after reclaims normal and failed-readback clones", async (t) => {
  const sibling = new TinySeed(t);
  const seed = TaskReviewScenario.seed(t);
  const beforeCopy = allocations("sennel-task-review-case-");
  let normalRoot;
  await t.test("normal clone uses its canonical producer and registered teardown", (child) => {
    const scenario = TaskReviewScenario.fromSeed(child, seed);
    normalRoot = scenario.root;
    assert.equal(scenario.state().current.at(-1), "T-1-review");
    assert.ok(fs.existsSync(normalRoot));
  });
  assert.equal(fs.existsSync(path.dirname(normalRoot)), false);
  assert.deepEqual(allocations("sennel-task-review-case-"), beforeCopy);
  const failure = new Error("task clone failed after canonical readback");
  let failedRoot;
  await t.test("a setup failure still runs the real registered teardown", (child) => {
    const original = CanonicalScenarioSeed.prototype.assertClone;
    const injected = child.mock.method(CanonicalScenarioSeed.prototype, "assertClone", function (manager) {
      original.call(this, manager);
      failedRoot = manager.specLocation(this.specId).repositoryRoot;
      throw failure;
    });
    try {
      assert.throws(() => TaskReviewScenario.fromSeed(child, seed), (error) => error === failure);
    } finally { injected.mock.restore(); }
  });
  assert.ok(failedRoot, "failure injection follows actual canonical readback");
  assert.equal(fs.existsSync(path.dirname(failedRoot)), false);
  assert.deepEqual(allocations("sennel-task-review-case-"), beforeCopy);
  seed.assertUnchanged();
  sibling.assertUnchanged();
});

test("seeded repair factory reclaims failed setup and returns normal cleanup ownership", async (t) => {
  const sibling = new TinySeed(t);
  const seed = await seedSpecGateRepairScenario(t);
  const beforeCopy = allocations("sennel-spec-repair-case-");
  const failure = new Error("repair clone failed after canonical readback");
  let failedRoot;
  const original = CanonicalScenarioSeed.prototype.assertClone;
  const injected = t.mock.method(CanonicalScenarioSeed.prototype, "assertClone", function (manager) {
    original.call(this, manager);
    failedRoot = manager.specLocation(this.specId).repositoryRoot;
    throw failure;
  });
  try {
    await assert.rejects(createSpecGateRepairScenario({ seed }), (error) => error === failure);
  } finally { injected.mock.restore(); }
  assert.ok(failedRoot, "failure injection follows actual canonical readback");
  assert.equal(fs.existsSync(path.dirname(failedRoot)), false);
  assert.deepEqual(allocations("sennel-spec-repair-case-"), beforeCopy);
  const value = await createSpecGateRepairScenario({ seed });
  t.after(() => value.cleanup());
  assert.equal(value.flowManager.canonicalState(value.specId).current.at(-1), "spec-gate-repair");
  value.cleanup();
  assert.equal(fs.existsSync(path.dirname(value.root)), false);
  assert.deepEqual(allocations("sennel-spec-repair-case-"), beforeCopy);
  seed.assertUnchanged();
  sibling.assertUnchanged();
});

describe("SeedCleanupScope keeps real afterEach allocations independent", { concurrency: false }, () => {
  const seedScope = new SeedCleanupScope(after);
  const clones = new SeedCleanupScope(afterEach);
  let seed;
  let firstRoot;
  let beforeCopy;
  before(() => {
    seed = new TinySeed(seedScope);
    beforeCopy = allocations("sennel-lifecycle-after-each-");
  });
  afterEach(() => {
    assert.deepEqual(allocations("sennel-lifecycle-after-each-"), beforeCopy);
    seed.assertUnchanged();
  });
  it("registers clone ownership before a caught setup failure", () => {
    const owner = new SeedWorkRoot(seed.root, { prefix: "sennel-lifecycle-after-each-" });
    clones.after(() => owner.cleanup());
    firstRoot = owner.root;
    const failure = new Error("later setup failed");
    assert.throws(() => { throw failure; }, (error) => error === failure);
    assert.ok(fs.existsSync(firstRoot));
  });
  it("starts the next case after the prior entire allocation has gone", () => {
    assert.equal(fs.existsSync(path.dirname(firstRoot)), false);
    const owner = new SeedWorkRoot(seed.root, { prefix: "sennel-lifecycle-after-each-" });
    clones.after(() => owner.cleanup());
    assert.notEqual(owner.root, firstRoot);
    assert.equal(fs.readFileSync(path.join(owner.root, "source.txt"), "utf8"), "immutable seed\n");
  });
});
