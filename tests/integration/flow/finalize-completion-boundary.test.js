import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { commitFinalizeCompletion } from "../../../src/flow/lib/run-finalize.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

let root;

afterEach(() => {
  if (root) removeTmpDir(root);
  root = null;
});

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(relativePath, content) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test("completion commit contains only target spec and docs while preserving unrelated staged changes", () => {
  root = createTmpDir("finalize-completion-boundary-");
  initGitRepo(root);
  write("docs/overview.md", "before\n");
  write("AGENTS.md", "before\n");
  write("unrelated.txt", "before\n");
  commitAll(root, "test: baseline");

  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const fixture = new CanonicalFlowFixture({
    flowManager: manager,
    specId: "485-finalize",
    runId: "run-485",
  }).create();
  manager.addNote("Finalize completion evidence", { specId: fixture.specId });
  write("docs/overview.md", "after\n");
  write("specs/485-finalize/001/.runtime/runtime-log.json", "{\"exitCode\":0}\n");
  const derivedViews = [
    "specs/485-finalize/001/.runtime/spec-render/spec.md",
    "specs/485-finalize/001/.runtime/spec-render/review.md",
    "specs/485-finalize/001/.runtime/task-views/T-1.md",
  ];
  for (const view of derivedViews) write(view, "regenerable human view\n");
  write("unrelated.txt", "user staged change\n");
  git(["add", "unrelated.txt"]);

  const result = commitFinalizeCompletion({
    root,
    specRoot: "specs",
    specId: "485-finalize",
    idempotencyKey: "run-485:finalize-cleanup:1",
  });

  assert.equal(result.status, "done");
  const committed = git(["show", "--pretty=format:", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  assert.ok(committed.includes("docs/overview.md"));
  assert.ok(committed.includes("specs/485-finalize/001/flow.json"));
  assert.ok(committed.includes("specs/485-finalize/001/activities.jsonl"));
  assert.ok(committed.includes("specs/485-finalize/001/spec.json"));
  assert.ok(committed.includes("specs/485-finalize/001/artifact-catalog.json"));
  assert.equal(committed.some((entry) => entry.includes("/.runtime/")), false);
  for (const view of derivedViews) {
    assert.equal(committed.includes(view), false);
    assert.equal(git(["ls-files", "--", view]), "");
    assert.equal(fs.existsSync(path.join(root, view)), true);
  }
  assert.equal(committed.every((entry) => entry === "docs/overview.md" || entry.startsWith("specs/485-finalize/001/")), true);
  assert.equal(git(["diff", "--cached", "--name-only"]), "unrelated.txt");
});

test("ignored configured spec root is left untracked while docs still commit", () => {
  root = createTmpDir("finalize-completion-ignored-root-");
  initGitRepo(root);
  write(".gitignore", "flow-artifacts/specs/\n");
  write("docs/overview.md", "before\n");
  commitAll(root, "test: baseline");

  write("docs/overview.md", "after\n");
  const manager = new FlowManager({
    root,
    mainRoot: root,
    inWorktree: false,
    specRoot: "flow-artifacts/specs",
  });
  new CanonicalFlowFixture({
    flowManager: manager,
    specId: "485-ignored",
    runId: "run-485-ignored",
  }).create();

  const result = commitFinalizeCompletion({
    root,
    specRoot: "flow-artifacts/specs",
    specId: "485-ignored",
    idempotencyKey: "run-485-ignored:finalize-cleanup:1",
  });

  assert.equal(result.status, "done");
  assert.equal(git(["show", "--pretty=format:", "--name-only", "HEAD"]), "docs/overview.md");
  assert.equal(git(["ls-files", "flow-artifacts/specs/485-ignored"]), "");
  assert.equal(fs.existsSync(path.join(root, "flow-artifacts/specs/485-ignored/001/flow.json")), true);
});
