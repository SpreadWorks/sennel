import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { FileIdentity } from "../../../src/lib/file-identity.js";
import { resolveCurrentReviewTreeSha } from "../../../src/flow/lib/review-evidence-store.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

let tmp = null;

afterEach(() => {
  if (tmp) removeTmpDir(tmp);
  tmp = null;
});

function git(...args) {
  return execFileSync("git", args, { cwd: tmp, encoding: "utf8" }).trim();
}

describe("resolveCurrentReviewTreeSha", () => {
  it("uses the committed tree for a clean worktree and includes tracked changes", () => {
    tmp = createTmpDir("review-evidence-tree-");
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");
    fs.writeFileSync(path.join(tmp, "subject.js"), "export const value = 1;\n");
    git("add", "subject.js");
    git("commit", "-q", "-m", "baseline");

    assert.equal(resolveCurrentReviewTreeSha(tmp), git("rev-parse", "HEAD^{tree}"));

    fs.writeFileSync(path.join(tmp, "subject.js"), "export const value = 2;\n");
    const unstaged = resolveCurrentReviewTreeSha(tmp);
    assert.notEqual(unstaged, git("rev-parse", "HEAD^{tree}"));

    git("add", "subject.js");
    assert.equal(resolveCurrentReviewTreeSha(tmp), unstaged);
  });

  it("excludes tracked flow artifacts while retaining source changes", () => {
    tmp = createTmpDir("review-evidence-tree-");
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");
    fs.mkdirSync(path.join(tmp, "specs", "demo", "review-history"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".sennel", "output"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "subject.js"), "export const value = 1;\n");
    fs.writeFileSync(path.join(tmp, "specs", "demo", "flow.json"), "{\"metrics\":[]}\n");
    fs.writeFileSync(path.join(tmp, "specs", "demo", "review-history", "test-attempt-001.json"), "{}\n");
    fs.writeFileSync(path.join(tmp, ".sennel", "output", "analysis.json"), "{}\n");
    git("add", ".");
    git("commit", "-q", "-m", "baseline");

    const specPath = "specs/demo/spec.json";
    const baseline = resolveCurrentReviewTreeSha(tmp, specPath);
    fs.writeFileSync(path.join(tmp, "specs", "demo", "flow.json"), "{\"metrics\":[1]}\n");
    fs.writeFileSync(path.join(tmp, "specs", "demo", "review-history", "test-attempt-001.json"), "{\"attempt\":1}\n");
    fs.writeFileSync(path.join(tmp, ".sennel", "output", "analysis.json"), "{\"entries\":[]}\n");
    assert.equal(resolveCurrentReviewTreeSha(tmp, specPath), baseline);

    fs.writeFileSync(path.join(tmp, "subject.js"), "export const value = 2;\n");
    assert.notEqual(resolveCurrentReviewTreeSha(tmp, specPath), baseline);
  });

  it("preserves index bytes and generation after a same-byte source replacement", () => {
    tmp = createTmpDir("review-evidence-tree-");
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");
    git("config", "diff.autoRefreshIndex", "true");
    const subject = path.join(tmp, "subject.js");
    const bytes = Buffer.from("export const value = 1;\n");
    fs.writeFileSync(subject, bytes);
    git("add", "subject.js");
    git("commit", "-q", "-m", "baseline");
    const expectedTree = git("rev-parse", "HEAD^{tree}");

    const replacement = path.join(tmp, "replacement.js");
    fs.writeFileSync(replacement, bytes);
    fs.renameSync(replacement, subject);
    fs.utimesSync(subject, 1_000_000_000, 1_000_000_000);
    const index = path.join(tmp, ".git", "index");
    const indexBytes = fs.readFileSync(index);
    const indexGeneration = FileIdentity.capture(fs.statSync(index, { bigint: true }));

    assert.equal(resolveCurrentReviewTreeSha(tmp), expectedTree);
    assert.deepEqual(fs.readFileSync(subject), bytes);
    assert.deepEqual(fs.readFileSync(index), indexBytes);
    assert.deepEqual(FileIdentity.capture(fs.statSync(index, { bigint: true })), indexGeneration);
  });

});
