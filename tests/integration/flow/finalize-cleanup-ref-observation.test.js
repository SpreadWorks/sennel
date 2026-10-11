import assert from "node:assert/strict";
import fs from "node:fs";
import { before, after, test } from "node:test";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { deleteFeatureBranchForCleanup, validateTeardown } from "../../../src/flow/lib/run-finalize-cleanup.js";

const featureBranch = "feature/cleanup";
const ref = `refs/heads/${featureBranch}`;
const ioFailure = Object.freeze({ ok: false, status: 128, stdout: "", stderr: "ref database IO failure", signal: null });
let seed;
let expectedSha;

function git(root, args) {
  const result = runGit(["-C", root, ...args]);
  assert.equal(result.ok, true, result.stderr);
  return result.stdout.trim();
}

before(() => {
  seed = createTmpDir("sennel-cleanup-ref-seed-");
  initGitRepo(seed);
  commitAll(seed, "test: cleanup ref seed");
  expectedSha = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["branch", featureBranch]);
});
after(() => removeTmpDir(seed));

function fixture(t) {
  const root = createTmpDir("sennel-cleanup-ref-case-");
  t.after(() => removeTmpDir(root));
  fs.cpSync(seed, root, { recursive: true });
  return root;
}

function removeFeature(root, runner = runGit, sha = expectedSha) {
  return deleteFeatureBranchForCleanup({ mainRepoPath: root, featureBranch, expectedSha: sha, runGit: runner });
}

function featureOid(root) { return git(root, ["for-each-ref", "--format=%(objectname)", ref]); }

test("cleanup deletes the exact expected ref and repeated deletion proves true absence", (t) => {
  const root = fixture(t);
  assert.equal(featureOid(root), expectedSha);
  assert.equal(removeFeature(root).ok, true);
  assert.equal(featureOid(root), "");
  assert.equal(removeFeature(root).ok, true);
  assert.equal(validateTeardown({ mainRepoPath: root, featureBranch }).ok, true);
});

test("a ref query failure before deletion refuses and preserves the feature ref", (t) => {
  const root = fixture(t);
  const result = removeFeature(root, (args) => args.includes("for-each-ref") ? ioFailure : runGit(args));
  assert.equal(result.ok, false);
  assert.equal(result.env.errors[0].code, "BRANCH_DELETE_FAILED");
  assert.match(result.env.errors[0].messages.join("\n"), /ref database IO failure/);
  assert.equal(featureOid(root), expectedSha);
});

test("failed deletion and unknown readback cannot certify deletion", (t) => {
  const root = fixture(t);
  let failedDeletion = false;
  const result = removeFeature(root, (args) => {
    if (args.includes("update-ref")) { failedDeletion = true; return ioFailure; }
    if (failedDeletion && (args.includes("for-each-ref") || args.includes("rev-parse") && args.includes(ref))) return ioFailure;
    return runGit(args);
  });
  assert.equal(failedDeletion, true);
  assert.equal(result.ok, false);
  assert.equal(result.env.errors[0].code, "BRANCH_DELETE_FAILED");
  assert.match(result.env.errors[0].messages.join("\n"), /ref database IO failure/);
  assert.equal(featureOid(root), expectedSha);
});

test("successful deletion with a lost response is reconciled only by proven absence", (t) => {
  const root = fixture(t);
  let responseLost = false;
  const result = removeFeature(root, (args) => {
    const actual = runGit(args);
    if (args.includes("update-ref")) {
      assert.equal(actual.ok, true, actual.stderr);
      responseLost = true;
      return ioFailure;
    }
    return actual;
  });
  assert.equal(responseLost, true);
  assert.equal(result.ok, true);
  assert.equal(featureOid(root), "");
});

test("a competing ref change remains intact when expected-OID deletion fails", (t) => {
  const root = fixture(t);
  commitAll(root, "test: concurrent feature ref change");
  const changedSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-ref", ref, changedSha, expectedSha]);
  const result = removeFeature(root);
  assert.equal(result.ok, false);
  assert.equal(result.env.errors[0].code, "BRANCH_DELETE_FAILED");
  assert.equal(featureOid(root), changedSha);
});

test("a ref recreated after deletion is retained and cannot masquerade as response loss", (t) => {
  const root = fixture(t);
  commitAll(root, "test: recreated feature ref target");
  const recreatedSha = git(root, ["rev-parse", "HEAD"]);
  const result = removeFeature(root, (args) => {
    const actual = runGit(args);
    if (args.includes("update-ref")) {
      assert.equal(actual.ok, true, actual.stderr);
      git(root, ["update-ref", ref, recreatedSha]);
      return ioFailure;
    }
    return actual;
  });
  assert.equal(result.ok, false);
  assert.equal(result.env.errors[0].code, "BRANCH_DELETE_FAILED");
  assert.equal(featureOid(root), recreatedSha);
});

test("registered worktree ownership prevents feature ref deletion", (t) => {
  const root = fixture(t);
  git(root, ["checkout", featureBranch]);
  const result = removeFeature(root);
  assert.equal(result.ok, false);
  assert.equal(result.env.errors[0].code, "BRANCH_DELETE_FAILED");
  assert.equal(featureOid(root), expectedSha);
});

test("teardown validation retains ref IO failure as a failed probe", (t) => {
  const root = fixture(t);
  git(root, ["update-ref", "-d", ref, expectedSha]);
  const result = validateTeardown({ mainRepoPath: root, featureBranch,
    runGit: (args) => args.includes("for-each-ref") ? ioFailure : runGit(args) });
  assert.equal(result.ok, false);
  assert.equal(result.probeFailed, true);
  assert.match(result.reasons.join("\n"), /ref database IO failure/);
  assert.equal(featureOid(root), "");
});
