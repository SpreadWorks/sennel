import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { RunAbortCommand } from "../../../src/flow/lib/run-abort.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetExpectation } from "../../../src/lib/flow-target-guard.js";
import {
  WorktreeFlowBindingStore,
  WorktreeFlowIdentity,
} from "../../../src/lib/worktree-flow-binding.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const SENNEL = path.resolve("src/sennel.js");

function installLoggingConfig(repositoryRoot) {
  fs.mkdirSync(path.join(repositoryRoot, ".sennel"), { recursive: true });
  fs.writeFileSync(path.join(repositoryRoot, ".sennel", "config.json"), `${JSON.stringify({
    lang: "en",
    type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
    logs: { enabled: true },
  }, null, 2)}\n`);
}

function installRetiredSpecReviewCatalogEntry(manager, specId) {
  const location = manager.specLocation(specId);
  const artifactDirectory = path.join(location.directory, "steps", "spec-review");
  const artifactFile = path.join(artifactDirectory, "result.json");
  const bytes = Buffer.from("{}\n", "utf8");
  fs.mkdirSync(artifactDirectory, { recursive: true });
  fs.writeFileSync(artifactFile, bytes);
  const catalog = JSON.parse(fs.readFileSync(location.catalogFile, "utf8"));
  const activityId = catalog.artifacts.find((entry) => entry.logicalKey === "flow.state")?.activityId;
  catalog.artifacts.push({
    logicalKey: "spec.review",
    kind: "spec-review",
    relativePath: "steps/spec-review/result.json",
    hash: crypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    mediaType: "application/json",
    authority: "canonical-flow-artifacts",
    cardinality: "singleton",
    memberId: null,
    publicationStep: "spec-review",
    retention: "permanent",
    activityId,
    migrationMaterialization: false,
  });
  fs.writeFileSync(location.catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
}

let root;

afterEach(() => {
  if (root) removeTmpDir(root);
  root = null;
});

test("abort removes only the selected worktree, branch, spec directory, and active entry", async () => {
  root = createTmpDir("flow-abort-target-");
  initGitRepo(root);
  const specRoot = "flow-artifacts/specs";
  fs.writeFileSync(path.join(root, "README.md"), "baseline\n");
  fs.writeFileSync(path.join(root, ".gitignore"), `${specRoot}/\n`);
  commitAll(root, "test: baseline");

  const specId = "485-abort-target";
  const otherSpecId = "486-other-flow";
  const worktreePath = path.join(root, ".sennel", "worktree", "feature-485-abort-target");
  execFileSync("git", ["worktree", "add", "-q", "-b", `feature/${specId}`, worktreePath, "main"], { cwd: root });
  const excludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: worktreePath,
    encoding: "utf8",
  }).trim();
  fs.appendFileSync(excludePath, "/.sennel/flow-identity.json\n");

  const manager = new FlowManager({
    root,
    mainRoot: root,
    inWorktree: false,
    specRoot,
  });
  const flow = new CanonicalFlowFixture({
    flowManager: manager,
    specId,
    runId: "run-485-abort-target",
    execution: {
      mode: "worktree",
      baseBranch: "main",
      featureBranch: `feature/${specId}`,
    },
  }).create().registerActive();
  const state = flow.state();
  const identity = new WorktreeFlowIdentity({
    runId: state.runId,
    issue: null,
    specId,
    worktreePath,
  });
  new WorktreeFlowBindingStore({ worktreePath }).save(identity);

  new CanonicalFlowFixture({
    flowManager: manager,
    specId: otherSpecId,
    runId: "run-486-other-flow",
    execution: { mode: "direct" },
  }).create().registerActive();
  fs.writeFileSync(path.join(root, "unrelated.txt"), "keep me\n");

  const selected = manager.loadReadOnly(specId);
  const result = await new RunAbortCommand().execute({
    root,
    mainRoot: root,
    flowManager: manager,
    flowState: selected,
    specLocation: manager.specLocation(specId),
    force: false,
  });

  assert.equal(result.status, "aborted");
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(fs.existsSync(manager.specLocation(specId).directory), false);
  assert.equal(fs.existsSync(manager.specLocation(otherSpecId).flowStateFile), true);
  assert.equal(fs.readFileSync(path.join(root, "unrelated.txt"), "utf8"), "keep me\n");
  assert.deepEqual(manager.loadActiveFlows(), [{ mode: "direct", specId: otherSpecId }]);
});

test("current CLI abort removes an active Flow whose retired Artifact layout is unreadable", () => {
  root = createTmpDir("flow-abort-incompatible-");
  initGitRepo(root);
  const specRoot = "specs";
  installLoggingConfig(root);
  fs.writeFileSync(path.join(root, "README.md"), "baseline\n");
  fs.writeFileSync(path.join(root, ".gitignore"), `${specRoot}/\n`);
  commitAll(root, "test: baseline");

  const specId = "487-abort-incompatible";
  const runId = "run-487-abort-incompatible";
  const featureBranch = `feature/${specId}`;
  const worktreePath = path.join(root, ".sennel", "worktree", featureBranch.replaceAll("/", "-"));
  execFileSync("git", ["worktree", "add", "-q", "-b", featureBranch, worktreePath, "main"], { cwd: root });
  const excludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: worktreePath,
    encoding: "utf8",
  }).trim();
  fs.appendFileSync(excludePath, "/.sennel/flow-identity.json\n");

  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specRoot });
  const flow = new CanonicalFlowFixture({
    flowManager: manager,
    specId,
    runId,
    execution: { mode: "worktree", baseBranch: "main", featureBranch },
  }).create().registerActive();
  new WorktreeFlowBindingStore({ worktreePath }).save(new WorktreeFlowIdentity({
    runId,
    issue: null,
    specId,
    worktreePath,
  }));
  installRetiredSpecReviewCatalogEntry(manager, specId);
  assert.throws(() => manager.loadReadOnly(specId), /artifact path does not match logical contract spec\.review/);

  const mismatch = spawnSync(process.execPath, [
    SENNEL,
    "flow",
    "run",
    "abort",
    "--force",
    "--expect-spec",
    "488-another-flow",
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: root },
  });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stdout, /FLOW_TARGET_NOT_FOUND/);
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(fs.existsSync(manager.specLocation(specId).directory), true);

  const result = spawnSync(process.execPath, [
    SENNEL,
    "flow",
    "run",
    "abort",
    "--force",
    "--expect-spec",
    specId,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: root },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /artifact path does not match logical contract spec\.review/);
  assert.equal(JSON.parse(result.stdout).data.status, "aborted");
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(fs.existsSync(manager.specLocation(specId).directory), false);
  assert.deepEqual(manager.loadActiveFlows(), []);
  assert.equal(execFileSync("git", ["branch", "--list", featureBranch], { cwd: root, encoding: "utf8" }).trim(), "");
});

test("recovery abort supports a direct Flow without branch ownership", async () => {
  root = createTmpDir("flow-abort-direct-");
  initGitRepo(root);
  const specRoot = "flow-artifacts/specs";
  fs.writeFileSync(path.join(root, "README.md"), "baseline\n");
  fs.writeFileSync(path.join(root, ".gitignore"), `${specRoot}/\n`);
  commitAll(root, "test: baseline");

  const specId = "489-abort-direct";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specRoot });
  new CanonicalFlowFixture({
    flowManager: manager,
    specId,
    runId: "run-489-abort-direct",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
  }).create().registerActive();
  installRetiredSpecReviewCatalogEntry(manager, specId);
  const unrelatedFile = path.join(root, "unrelated.txt");
  fs.writeFileSync(unrelatedFile, "keep me\n");
  assert.throws(() => manager.loadReadOnly(specId), /artifact path does not match logical contract spec\.review/);

  const target = manager.resolveFlowRecoveryTarget(new FlowTargetExpectation({ expectSpec: specId }));
  const result = await new RunAbortCommand().execute({
    root,
    mainRoot: root,
    flowManager: manager,
    flowState: target.state,
    specLocation: manager.specLocation(specId),
    force: false,
  });

  assert.equal(result.status, "aborted");
  assert.equal(result.removed.worktree, null);
  assert.equal(result.removed.branch, null);
  assert.equal(fs.existsSync(manager.specLocation(specId).directory), false);
  assert.equal(fs.readFileSync(unrelatedFile, "utf8"), "keep me\n");
  assert.deepEqual(manager.loadActiveFlows(), []);
});

test("recovery abort refuses an invalid execution authority before deleting anything", () => {
  root = createTmpDir("flow-abort-invalid-recovery-");
  initGitRepo(root);
  const specRoot = "flow-artifacts/specs";
  fs.writeFileSync(path.join(root, "README.md"), "baseline\n");
  fs.writeFileSync(path.join(root, ".gitignore"), `${specRoot}/\n`);
  commitAll(root, "test: baseline");

  const specId = "490-abort-invalid-recovery";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specRoot });
  new CanonicalFlowFixture({
    flowManager: manager,
    specId,
    runId: "run-490-abort-invalid-recovery",
    execution: { mode: "direct" },
  }).create().registerActive();

  const location = manager.specLocation(specId);
  const state = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
  state.execution.featureBranch = "feature/490-foreign-branch";
  fs.writeFileSync(location.flowStateFile, `${JSON.stringify(state, null, 2)}\n`);

  assert.throws(
    () => manager.resolveFlowRecoveryTarget(new FlowTargetExpectation({ expectSpec: specId })),
    (error) => error.code === "FLOW_TARGET_RECOVERY_REQUIRED"
      && error.data?.reason === "FLOW_RECOVERY_STATE_INVALID",
  );
  assert.equal(fs.existsSync(location.directory), true);
  assert.deepEqual(manager.loadActiveFlows(), [{ mode: "direct", specId }]);
});
