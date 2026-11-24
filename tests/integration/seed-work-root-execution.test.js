import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestTemporaryRoot } from "../test-temporary-root.js";
import { SeedWorkRoot } from "../support/builders/seed-work-root.js";
import { ProcessExecutionControlFailure } from "../../src/lib/process-execution-values.js";
import { PromptBatchExecutionIncompleteFailure } from "../../src/lib/prompt-batching.js";
import { ConcurrentBatchError } from "../../src/docs/lib/concurrency.js";

function fixture(t) {
  const owner = TestTemporaryRoot.createOnRepository();
  // These tests inject errors without launching a child, so teardown can remove
  // their retained evidence after asserting the normal cleanup policy.
  t.after(() => rmSync(owner.path, { recursive: true, force: true }));
  const seed = join(owner.path, "seed");
  mkdirSync(seed);
  writeFileSync(join(seed, "evidence.txt"), "fixture evidence\n");
  return { owner, work: new SeedWorkRoot(seed, { temporaryRoot: owner }) };
}

test("nested prompt control failure preserves fixture evidence through both cleanup owners", async (t) => {
  const { owner, work } = fixture(t);
  const control = new ProcessExecutionControlFailure("stop-unconfirmed", "Child exit remains unknown");
  const failure = new ConcurrentBatchError([{ index: 0, error: new PromptBatchExecutionIncompleteFailure("Prompt did not complete", {}, control) }]);
  await assert.rejects(work.use(async () => { throw failure; }), (error) => error === failure);
  work.cleanup(); // The real quality suite also has an owning after hook.
  new TestTemporaryRoot(owner.path, { owned: true }).remove(); // Read back the borrower marker.
  assert.equal(owner.retained, true);
  assert.equal(readFileSync(join(work.root, "evidence.txt"), "utf8"), "fixture evidence\n");
});

test("ordinary provider failure removes its fixture without retaining the runner root", async (t) => {
  const { owner, work } = fixture(t);
  const failure = new PromptBatchExecutionIncompleteFailure("Provider returned invalid output", {}, new Error("invalid output"));
  await assert.rejects(work.use(async () => { throw failure; }), (error) => error === failure);
  assert.equal(existsSync(work.root), false);
  assert.equal(owner.retained, false);
});

test("successful execution returns its result and removes its fixture", async (t) => {
  const { owner, work } = fixture(t);
  assert.equal(await work.use(async (root) => readFileSync(join(root, "evidence.txt"), "utf8")), "fixture evidence\n");
  assert.equal(existsSync(work.root), false);
  assert.equal(owner.retained, false);
});
