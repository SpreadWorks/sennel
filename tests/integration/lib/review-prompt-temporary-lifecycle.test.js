import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ReviewTextPromptPlan } from "../../../src/flow/lib/review-text-prompt-plan.js";
import { TestTemporaryRoot } from "../../test-temporary-root.js";
import { PromptFixedContextTooLargeFailure } from "../../../src/lib/prompt-batching.js";

const source = "HEAD complete review input\n日本語 😀\n".repeat(500) + "TAIL complete review input";
const environmentNames = ["TMPDIR", "TMP", "TEMP", "SENNEL_TEST_TEMP_ROOT", "GIT_CEILING_DIRECTORIES"];
const environment = () => environmentNames.map((name) => process.env[name]);

test("file-backed review plan releases its owned child before the activated test root", () => {
  const previous = environment();
  const owner = TestTemporaryRoot.createOnRepository();
  const release = owner.activate();
  let plan;
  let directory;
  try {
    plan = ReviewTextPromptPlan.create({ request: source, maxChars: 6_000, projectRoot: owner.path });
    assert.ok(plan.fileInput);
    directory = plan.fileInput.directory;
    assert.equal(fs.readFileSync(plan.fileInput.filePath, "utf8"), source);
    plan.fileInput.assertUnchanged();
  } finally {
    try {
      plan?.dispose();
      assert.equal(fs.existsSync(directory), false);
      assert.equal(fs.existsSync(owner.path), true, "child release must happen while its pinned parent still exists");
    } finally {
      release();
    }
  }
  assert.equal(fs.existsSync(owner.path), false);
  assert.deepEqual(environment(), previous);
});

test("review plan construction failure still releases its activated test root and environment", () => {
  const previous = environment();
  const owner = TestTemporaryRoot.createOnRepository();
  const release = owner.activate();
  let plan;
  try {
    assert.throws(() => {
      plan = ReviewTextPromptPlan.create({ request: source, maxChars: 32, projectRoot: owner.path });
    }, PromptFixedContextTooLargeFailure);
    assert.equal(plan, undefined);
  } finally {
    try { plan?.dispose(); }
    finally { release(); }
  }
  assert.equal(fs.existsSync(owner.path), false);
  assert.deepEqual(environment(), previous);
});

test("parent-first review fixture teardown remains an ownership refusal", () => {
  const previous = environment();
  const owner = TestTemporaryRoot.createOnRepository();
  const release = owner.activate();
  let plan;
  try {
    plan = ReviewTextPromptPlan.create({ request: source, maxChars: 6_000, projectRoot: owner.path });
    assert.ok(plan.fileInput);
    release();
    assert.throws(() => plan.dispose(), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
    assert.equal(fs.existsSync(owner.path), false);
  } finally {
    if (fs.existsSync(owner.path)) {
      try { plan?.dispose(); }
      finally { release(); }
    }
  }
  assert.deepEqual(environment(), previous);
});
