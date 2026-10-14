import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
/**
 * Tests for the new git sync helpers added by spec 211:
 *   fetchBranch, rebaseOnto, abortRebase, countCommitsBetween, listUncommittedFiles
 *
 * These helpers back the finalize auto-recovery pipeline (pre-merge sync,
 * empty-diff early stop, dirty-worktree detection).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  fetchBranch,
  rebaseOnto,
  abortRebase,
  countCommitsBetween,
  listUncommittedFiles,
} from "../../../src/lib/git-helpers.js";
import { runCmd } from "../../../src/lib/process.js";

function init(dir) {
  runCmd("git", ["init", "-q", "-b", "main", dir]);
  runCmd("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  runCmd("git", ["-C", dir, "config", "user.name", "T"]);
  runCmd("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
}

function commit(dir, file, content, msg) {
  fs.writeFileSync(path.join(dir, file), content);
  runCmd("git", ["-C", dir, "add", file]);
  runCmd("git", ["-C", dir, "commit", "-q", "-m", msg]);
}

describe("countCommitsBetween", () => {
  let dir;
  beforeEach(() => { dir = createTestDirectory("gsh-count-"); init(dir); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns 0 when head has no commits beyond base", () => {
    commit(dir, "a.txt", "a", "base commit");
    runCmd("git", ["-C", dir, "checkout", "-b", "feature"]);
    assert.equal(countCommitsBetween("main", "feature", { cwd: dir }), 0);
  });

  it("returns n when head is n commits ahead of base", () => {
    commit(dir, "a.txt", "a", "base");
    runCmd("git", ["-C", dir, "checkout", "-b", "feature"]);
    commit(dir, "b.txt", "b", "f1");
    commit(dir, "c.txt", "c", "f2");
    assert.equal(countCommitsBetween("main", "feature", { cwd: dir }), 2);
  });
});

describe("listUncommittedFiles", () => {
  let dir;
  beforeEach(() => { dir = createTestDirectory("gsh-un-"); init(dir); commit(dir, "a.txt", "a", "init"); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns empty array when worktree is clean", () => {
    assert.deepEqual(listUncommittedFiles({ cwd: dir }), []);
  });

  it("returns modified and untracked files", () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a-modified");
    fs.writeFileSync(path.join(dir, "new.txt"), "new");
    const files = listUncommittedFiles({ cwd: dir });
    assert.ok(files.includes("a.txt"));
    assert.ok(files.includes("new.txt"));
  });
});

describe("fetchBranch", () => {
  it("returns ok:false when remote does not exist (no network call attempted beyond git's own resolve)", () => {
    const dir = createTestDirectory("gsh-fetch-");
    init(dir);
    commit(dir, "a.txt", "a", "init");
    try {
      const result = fetchBranch("nonexistent-remote", "main", { cwd: dir });
      assert.equal(result.ok, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rebaseOnto / abortRebase", () => {
  let upstream, clone;
  beforeEach(() => {
    upstream = createTestDirectory("gsh-up-");
    init(upstream);
    commit(upstream, "a.txt", "a", "base");

    clone = createTestDirectory("gsh-clone-");
    runCmd("git", ["clone", "-q", upstream, clone]);
    runCmd("git", ["-C", clone, "config", "user.email", "t@example.com"]);
    runCmd("git", ["-C", clone, "config", "user.name", "T"]);
    runCmd("git", ["-C", clone, "config", "commit.gpgsign", "false"]);
  });
  afterEach(() => {
    fs.rmSync(upstream, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  });

  it("ok: true when rebase succeeds (base advanced, feature independent change)", () => {
    runCmd("git", ["-C", clone, "checkout", "-b", "feature"]);
    commit(clone, "b.txt", "b", "feat change");
    commit(upstream, "c.txt", "c", "base advance");
    runCmd("git", ["-C", clone, "fetch", "-q", "origin", "main"]);
    const result = rebaseOnto("origin/main", { cwd: clone });
    assert.equal(result.ok, true);
  });

  it("ok: false with conflictFiles when rebase conflicts", () => {
    runCmd("git", ["-C", clone, "checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(clone, "a.txt"), "feature-change");
    runCmd("git", ["-C", clone, "add", "a.txt"]);
    runCmd("git", ["-C", clone, "commit", "-q", "-m", "feat"]);
    fs.writeFileSync(path.join(upstream, "a.txt"), "upstream-change");
    runCmd("git", ["-C", upstream, "add", "a.txt"]);
    runCmd("git", ["-C", upstream, "commit", "-q", "-m", "up"]);
    runCmd("git", ["-C", clone, "fetch", "-q", "origin", "main"]);
    const result = rebaseOnto("origin/main", { cwd: clone });
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.conflictFiles));
    assert.ok(result.conflictFiles.includes("a.txt"));
    abortRebase({ cwd: clone });
    const statusAfter = runCmd("git", ["-C", clone, "status", "--short"]).stdout.trim();
    assert.equal(statusAfter, "");
  });
});
