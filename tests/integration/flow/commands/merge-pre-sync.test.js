import { createTmpDir as createTestDirectory } from "../../../support/builders/tmp-dir.js";
/**
 * Tests for spec 211 pre-sync behavior in merge.js (R1, R3, R6):
 *   - Before squash merge, auto-fetch + rebase in the worktree when base has advanced.
 *   - If rebase conflicts, abort and throw with conflictFiles + recoveryHint.
 *   - Do NOT pre-sync on PR route or spec-only mode.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { runPreSync } from "../../../../src/flow/commands/merge.js";
import { runCmd } from "../../../../src/lib/process.js";

function init(dir) {
  runCmd("git", ["init", "-q", "-b", "main", dir]);
  runCmd("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  runCmd("git", ["-C", dir, "config", "user.name", "T"]);
  runCmd("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
}

function commitIn(dir, file, content, msg) {
  fs.writeFileSync(path.join(dir, file), content);
  runCmd("git", ["-C", dir, "add", file]);
  runCmd("git", ["-C", dir, "commit", "-q", "-m", msg]);
}

describe("runPreSync — success path (R1)", () => {
  let upstream, worktree;
  beforeEach(() => {
    upstream = createTestDirectory("ps-up-");
    init(upstream);
    commitIn(upstream, "a.txt", "a", "base");
    worktree = createTestDirectory("ps-wt-");
    runCmd("git", ["clone", "-q", upstream, worktree]);
    runCmd("git", ["-C", worktree, "config", "user.email", "t@example.com"]);
    runCmd("git", ["-C", worktree, "config", "user.name", "T"]);
    runCmd("git", ["-C", worktree, "config", "commit.gpgsign", "false"]);
    runCmd("git", ["-C", worktree, "checkout", "-b", "feature"]);
    commitIn(worktree, "b.txt", "b", "feat change");
    // advance base
    commitIn(upstream, "c.txt", "c", "base advance");
  });
  afterEach(() => {
    fs.rmSync(upstream, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it("returns ok:true and places feature on top of advanced base", () => {
    const result = runPreSync({ worktreePath: worktree, baseBranch: "main", remote: "origin" });
    assert.equal(result.ok, true);
    // After rebase, the commit containing c.txt should be reachable in the worktree.
    const log = runCmd("git", ["-C", worktree, "log", "--oneline"]).stdout;
    assert.ok(log.includes("base advance"), "expected base advance commit to be present");
    assert.ok(log.includes("feat change"), "expected feature commit to be preserved");
  });
});

describe("runPreSync — conflict path (R3)", () => {
  let upstream, worktree;
  beforeEach(() => {
    upstream = createTestDirectory("ps-cu-");
    init(upstream);
    commitIn(upstream, "a.txt", "a", "base");
    worktree = createTestDirectory("ps-cw-");
    runCmd("git", ["clone", "-q", upstream, worktree]);
    runCmd("git", ["-C", worktree, "config", "user.email", "t@example.com"]);
    runCmd("git", ["-C", worktree, "config", "user.name", "T"]);
    runCmd("git", ["-C", worktree, "config", "commit.gpgsign", "false"]);
    runCmd("git", ["-C", worktree, "checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(worktree, "a.txt"), "feature-change");
    runCmd("git", ["-C", worktree, "add", "a.txt"]);
    runCmd("git", ["-C", worktree, "commit", "-q", "-m", "feat"]);
    fs.writeFileSync(path.join(upstream, "a.txt"), "upstream-change");
    runCmd("git", ["-C", upstream, "add", "a.txt"]);
    runCmd("git", ["-C", upstream, "commit", "-q", "-m", "up"]);
  });
  afterEach(() => {
    fs.rmSync(upstream, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it("returns ok:false with conflictFiles and restores the worktree (rebase aborted)", () => {
    const result = runPreSync({ worktreePath: worktree, baseBranch: "main", remote: "origin" });
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.conflictFiles));
    assert.ok(result.conflictFiles.includes("a.txt"));
    assert.ok(typeof result.recoveryHint === "string" && result.recoveryHint.length > 0);
    // worktree should be clean after abort
    const status = runCmd("git", ["-C", worktree, "status", "--short"]).stdout.trim();
    assert.equal(status, "");
  });
});

describe("runPreSync — route exclusions (R6)", () => {
  it("returns skipped when usePr is true (PR route)", () => {
    const result = runPreSync({ worktreePath: "/nonexistent", baseBranch: "main", remote: "origin", usePr: true });
    assert.equal(result.skipped, "pr-route");
  });

  it("returns skipped when featureBranch == baseBranch (spec-only mode)", () => {
    const result = runPreSync({ worktreePath: "/nonexistent", baseBranch: "main", featureBranch: "main", remote: "origin" });
    assert.equal(result.skipped, "spec-only");
  });
});
