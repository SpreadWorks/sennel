import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
/**
 * Tests for spec 219 finalize preflight refinement (supersedes spec 211 R2/R4):
 *   - commitStepActive=true: only fail when ahead==0 AND uncommitted==0 (no-commits)
 *   - commitStepActive=false: fail when ahead==0 (no-commits) OR uncommitted>0 (dirty-worktree)
 *   - spec-only mode (feature == base) bypasses all checks
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { runPreflightChecks } from "../../../src/flow/lib/run-finalize.js";
import { runCmd } from "../../../src/lib/process.js";

function init(dir) {
  runCmd("git", ["init", "-q", "-b", "main", dir]);
  runCmd("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  runCmd("git", ["-C", dir, "config", "user.name", "T"]);
  runCmd("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  runCmd("git", ["-C", dir, "add", "."]);
  runCmd("git", ["-C", dir, "commit", "-q", "-m", "init"]);
}

function checkoutFeature(dir) {
  runCmd("git", ["-C", dir, "checkout", "-q", "-b", "feature"]);
}

function addFeatureCommit(dir, file = "b.txt") {
  fs.writeFileSync(path.join(dir, file), "b");
  runCmd("git", ["-C", dir, "add", "."]);
  runCmd("git", ["-C", dir, "commit", "-q", "-m", "feat"]);
}

function dirtyWorktree(dir, file = "a.txt") {
  fs.writeFileSync(path.join(dir, file), "modified");
}

describe("runPreflightChecks — commitStepActive=true (commit step in active steps)", () => {
  let dir;
  beforeEach(() => { dir = createTestDirectory("fin-ca-"); init(dir); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns { ok: true } when ahead==0 and uncommitted>0 (commit step will create first commit)", () => {
    checkoutFeature(dir);
    dirtyWorktree(dir);
    const result = runPreflightChecks({ root: dir, baseBranch: "main", featureBranch: "feature", commitStepActive: true });
    assert.equal(result.ok, true);
  });

  it("returns { ok: true } when ahead>0 and uncommitted>0 (commit step will absorb dirty)", () => {
    checkoutFeature(dir);
    addFeatureCommit(dir);
    dirtyWorktree(dir);
    const result = runPreflightChecks({ root: dir, baseBranch: "main", featureBranch: "feature", commitStepActive: true });
    assert.equal(result.ok, true);
  });

  it("returns { ok: true } when ahead>0 and uncommitted==0 (normal case)", () => {
    checkoutFeature(dir);
    addFeatureCommit(dir);
    const result = runPreflightChecks({ root: dir, baseBranch: "main", featureBranch: "feature", commitStepActive: true });
    assert.equal(result.ok, true);
  });

  it("returns { ok: false, reason: 'no-commits' } when ahead==0 AND uncommitted==0 (truly nothing to do)", () => {
    checkoutFeature(dir);
    const result = runPreflightChecks({ root: dir, baseBranch: "main", featureBranch: "feature", commitStepActive: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-commits");
    assert.equal(result.baseBranch, "main");
    assert.equal(result.featureBranch, "feature");
    assert.equal(result.hasUncommitted, false);
  });
});

describe("runPreflightChecks — commitStepActive=false (commit step NOT in active steps)", () => {
  let dir;
  beforeEach(() => { dir = createTestDirectory("fin-ci-"); init(dir); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns { ok: false, reason: 'dirty-worktree' } when uncommitted>0 (no commit step to absorb)", () => {
    checkoutFeature(dir);
    addFeatureCommit(dir);
    dirtyWorktree(dir);
    const result = runPreflightChecks({ root: dir, baseBranch: "main", featureBranch: "feature", commitStepActive: false });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "dirty-worktree");
    assert.ok(Array.isArray(result.uncommittedFiles));
    assert.ok(result.uncommittedFiles.includes("a.txt"));
  });

  it("returns { ok: false, reason: 'dirty-worktree' } when ahead==0 and uncommitted>0", () => {
    checkoutFeature(dir);
    dirtyWorktree(dir);
    const result = runPreflightChecks({ root: dir, baseBranch: "main", featureBranch: "feature", commitStepActive: false });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "dirty-worktree");
    assert.ok(result.uncommittedFiles.includes("a.txt"));
  });

  it("returns { ok: false, reason: 'no-commits' } when ahead==0 AND uncommitted==0", () => {
    checkoutFeature(dir);
    const result = runPreflightChecks({ root: dir, baseBranch: "main", featureBranch: "feature", commitStepActive: false });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-commits");
    assert.equal(result.hasUncommitted, false);
  });

  it("returns { ok: true } when ahead>0 and uncommitted==0 (normal case)", () => {
    checkoutFeature(dir);
    addFeatureCommit(dir);
    const result = runPreflightChecks({ root: dir, baseBranch: "main", featureBranch: "feature", commitStepActive: false });
    assert.equal(result.ok, true);
  });
});

describe("runPreflightChecks — spec-only mode", () => {
  let dir;
  beforeEach(() => { dir = createTestDirectory("fin-so-"); init(dir); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns { ok: true, skipped: 'spec-only' } when featureBranch == baseBranch (commitStepActive=true)", () => {
    const result = runPreflightChecks({ root: dir, baseBranch: "main", featureBranch: "main", commitStepActive: true });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, "spec-only");
  });

  it("returns { ok: true, skipped: 'spec-only' } when featureBranch == baseBranch (commitStepActive=false)", () => {
    const result = runPreflightChecks({ root: dir, baseBranch: "main", featureBranch: "main", commitStepActive: false });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, "spec-only");
  });
});
