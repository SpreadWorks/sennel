import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  FinalizeMergeTransaction,
  FinalizeMergeTransactionError,
} from "../../../src/flow/lib/finalize-merge-transaction.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { checkoutNewBranch, commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { FinalizeFlowArtifactRegistry } from "../../../src/flow/lib/repair-state-identity.js";
import { FlowCommandExecutionLease } from "../../../src/flow/lib/flow-command-execution-lease.js";

function git(root, args) {
  const result = runGit(["-C", root, ...args]);
  assert.equal(result.ok, true, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createFixture(root, { conflict = false, withBaseWorktree = true } = {}) {
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "shared.txt"), "base\n");
  fs.writeFileSync(path.join(root, "feature.txt"), "baseline\n");
  commitAll(root, "test: baseline");
  checkoutNewBranch(root, "feature/finalize-merge");
  fs.writeFileSync(path.join(root, conflict ? "shared.txt" : "feature.txt"), conflict ? "feature\n" : "feature change\n");
  commitAll(root, "feat: feature change");

  if (!withBaseWorktree) return { baseWorktree: null };
  const baseWorktree = path.join(root, "..", `${path.basename(root)}-base`);
  git(root, ["worktree", "add", "--quiet", baseWorktree, "main"]);
  if (conflict) {
    fs.writeFileSync(path.join(baseWorktree, "shared.txt"), "base change\n");
    commitAll(baseWorktree, "test: conflicting base change");
  }
  return { baseWorktree };
}

function transaction(root, options = {}) {
  return new FinalizeMergeTransaction({
    featureRoot: root,
    mainRoot: root,
    baseBranch: "main",
    featureBranch: "feature/finalize-merge",
    commitMessage: "feat: isolated integration\n\nsennel-outbox: test-finalize-merge",
    idempotencyKey: "test-finalize-merge",
    ...options,
  });
}

describe("FinalizeMergeTransaction", () => {
  let root;
  let baseWorktree;

  afterEach(() => {
    if (root) {
      const registered = runGit(["-C", root, "worktree", "list", "--porcelain"]);
      if (registered.ok && baseWorktree && fs.existsSync(baseWorktree)) {
        runGit(["-C", root, "worktree", "remove", "--force", baseWorktree]);
      }
      removeTmpDir(root);
    }
    root = null;
    baseWorktree = null;
  });

  it("integrates in an isolated worktree while the base branch is checked out elsewhere", () => {
    root = createTmpDir("sennel-finalize-merge-transaction-");
    ({ baseWorktree } = createFixture(root));
    const beforeFeatureHead = git(root, ["rev-parse", "HEAD"]);

    const result = transaction(root).execute();

    assert.equal(result.strategy, "squash");
    assert.equal(result.mergedFromSha, beforeFeatureHead);
    assert.equal(git(root, ["rev-parse", "HEAD"]), beforeFeatureHead, "feature worktree remains untouched");
    assert.equal(git(baseWorktree, ["branch", "--show-current"]), "main");
    assert.equal(fs.readFileSync(path.join(baseWorktree, "feature.txt"), "utf8"), "feature change\n");
    assert.match(git(baseWorktree, ["log", "-1", "--format=%B"]), /sennel-outbox: test-finalize-merge/);
  });

  it("reports a dirty base worktree without changing the base ref", () => {
    root = createTmpDir("sennel-finalize-merge-target-dirty-");
    ({ baseWorktree } = createFixture(root));
    fs.writeFileSync(path.join(baseWorktree, "local-only.txt"), "do not overwrite\n");
    const before = git(root, ["rev-parse", "main"]);

    assert.throws(
      () => transaction(root).execute(),
      (error) => error instanceof FinalizeMergeTransactionError && error.code === "MERGE_TARGET_DIRTY",
    );

    assert.equal(git(root, ["rev-parse", "main"]), before);
    assert.equal(fs.readFileSync(path.join(baseWorktree, "local-only.txt"), "utf8"), "do not overwrite\n");
  });

  it("keeps a live command marker outside the merged source while preserving its owner", () => {
    root = createTmpDir("sennel-finalize-running-marker-");
    ({ baseWorktree } = createFixture(root));
    fs.mkdirSync(path.join(root, ".sennel"));
    const lease = new FlowCommandExecutionLease({ mainRoot: root, runId: "merge-run", specId: "801-merge" });
    lease.lock.acquire();
    const owner = fs.readFileSync(lease.lock.lockPath);
    try {
      assert.equal(transaction(root).execute().strategy, "squash");
      assert.deepEqual(fs.readFileSync(lease.lock.lockPath), owner);
      assert.equal(git(root, ["ls-tree", "-r", "--name-only", "main"])
        .split("\n").some((file) => FlowCommandExecutionLease.ownsRepositoryPath(file)), false);
    } finally { lease.release(); }
  });

  it("rejects an external dirty feature file without changing the base ref", () => {
    root = createTmpDir("sennel-finalize-merge-feature-dirty-");
    ({ baseWorktree } = createFixture(root));
    fs.writeFileSync(path.join(root, "uncommitted.txt"), "do not merge\n");
    const before = git(root, ["rev-parse", "main"]);

    assert.throws(
      () => transaction(root).execute(),
      (error) => error instanceof FinalizeMergeTransactionError && error.code === "MERGE_FEATURE_DIRTY",
    );

    assert.equal(git(root, ["rev-parse", "main"]), before);
  });

  it("permits only the Flow-owned pending metadata required by the outbox", () => {
    root = createTmpDir("sennel-finalize-merge-flow-metadata-");
    ({ baseWorktree } = createFixture(root));
    fs.mkdirSync(path.join(root, "specs", "001-test"), { recursive: true });
    fs.writeFileSync(path.join(root, "specs", "001-test", "flow.json"), "{\"outbox\":[]}\n");

    const result = transaction(root, {
      allowedFeatureMetadataPaths: ["specs/001-test/flow.json"],
    }).execute();

    assert.equal(result.strategy, "squash");
    assert.equal(fs.readFileSync(path.join(root, "specs", "001-test", "flow.json"), "utf8"), "{\"outbox\":[]}\n");
  });

  it("uses the Flow artifact registry without ignoring unknown files in the spec directory", () => {
    root = createTmpDir("sennel-finalize-merge-artifact-ownership-");
    ({ baseWorktree } = createFixture(root));
    const specPath = "specs/001-test/spec.json";
    fs.mkdirSync(path.join(root, "specs", "001-test"), { recursive: true });
    fs.writeFileSync(path.join(root, "specs", "001-test", "flow.json"), "{\"outbox\":[]}\n");
    fs.mkdirSync(path.join(root, "specs", "001-test", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(root, "specs", "001-test", "tests"), { recursive: true });
    fs.writeFileSync(path.join(root, "specs", "001-test", "tasks", "T-1.md"), "# T-1\n");
    fs.writeFileSync(path.join(root, "specs", "001-test", "tests", "R1.test.js"), "// R1\n");
    fs.writeFileSync(path.join(root, "specs", "001-test", "operator-notes.txt"), "retain me\n");

    assert.throws(
      () => transaction(root, {
        flowArtifactRegistry: new FinalizeFlowArtifactRegistry(specPath),
      }).execute(),
      (error) => (
        error instanceof FinalizeMergeTransactionError
        && error.code === "MERGE_FEATURE_DIRTY"
        && error.data.paths.includes("specs/001-test/operator-notes.txt")
        && !error.data.paths.includes("specs/001-test/flow.json")
        && error.data.paths.includes("specs/001-test/tasks/T-1.md")
        && error.data.paths.includes("specs/001-test/tests/R1.test.js")
      ),
    );
  });

  it("moves a branch-mode caller to the published base only after the isolated merge", () => {
    root = createTmpDir("sennel-finalize-merge-branch-transition-");
    ({ baseWorktree } = createFixture(root, { withBaseWorktree: false }));

    const result = transaction(root, { promoteFeatureWorktreeToBase: true }).execute();

    assert.equal(result.strategy, "squash");
    assert.equal(git(root, ["branch", "--show-current"]), "main");
    assert.equal(fs.readFileSync(path.join(root, "feature.txt"), "utf8"), "feature change\n");
  });

  it("reports only a graph-proven content conflict as a merge conflict", () => {
    root = createTmpDir("sennel-finalize-merge-conflict-");
    ({ baseWorktree } = createFixture(root, { conflict: true }));
    const before = git(root, ["rev-parse", "main"]);

    assert.throws(
      () => transaction(root).execute(),
      (error) => error instanceof FinalizeMergeTransactionError && error.code === "MERGE_CONTENT_CONFLICT",
    );

    assert.equal(git(root, ["rev-parse", "main"]), before);
  });

  it("resumes an already published merge without creating a second commit", () => {
    root = createTmpDir("sennel-finalize-merge-resume-");
    ({ baseWorktree } = createFixture(root));
    const first = transaction(root).execute();
    const commitCount = git(root, ["rev-list", "--count", "main"]);

    const resumed = transaction(root).execute();

    assert.equal(resumed.resumed, true);
    assert.equal(resumed.mergeCommit, first.mergeCommit);
    assert.equal(git(root, ["rev-list", "--count", "main"]), commitCount);
  });
});
