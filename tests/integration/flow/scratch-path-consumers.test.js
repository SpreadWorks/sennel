import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTmpDir, removeTmpDir, writeJson } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { FinalizeMergeTransaction } from "../../../src/flow/lib/finalize-merge-transaction.js";
import { buildRepairStateManifest, captureRepairBaseline } from "../../../src/flow/lib/repair-state-identity.js";
import { finalRegressionWorktreeFingerprint } from "../../../src/flow/lib/test-artifacts.js";
import { runDetachedAutoRescue } from "../../../src/flow/lib/run-finalize-cleanup.js";
import { AutoRescueCleanupStore, autoRescueIdentity } from "../../../src/flow/lib/finalize-cleanup-journal.js";
import { installPlugin, readProjectConfig } from "../../../src/lib/plugin-registry.js";
import { commitFinalizeCompletion } from "../../../src/flow/lib/run-finalize.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";

function fixture(t) {
  const root = createTmpDir("scratch-consumers-");
  t.after(() => removeTmpDir(root));
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "source.txt"), "baseline\n");
  commitAll(root, "test: scratch consumer baseline");
  return root;
}

function git(root, args) {
  const result = runGit(["-C", root, ...args]);
  assert.equal(result.ok, true, result.stderr || result.stdout);
  return result.stdout.trim();
}

function observeDirectories(operation) {
  const original = fs.mkdtempSync;
  const directories = [];
  fs.mkdtempSync = (...args) => {
    const directory = original(...args);
    directories.push(directory);
    return directory;
  };
  try { return { result: operation(), directories }; }
  finally { fs.mkdtempSync = original; }
}

test("isolated merge consumes Flow scratch and replays after branch promotion", (t) => {
  const root = fixture(t);
  git(root, ["switch", "-c", "feature/scratch"]);
  fs.writeFileSync(path.join(root, "source.txt"), "feature\n");
  commitAll(root, "test: feature for scratch merge");
  const options = { featureRoot: root, mainRoot: root, repositoryRoot: root,
    specId: "scratch-merge", runId: "run-merge", baseBranch: "main", featureBranch: "feature/scratch",
    commitMessage: "test: squash scratch consumer\n\nsennel-outbox: scratch-merge",
    idempotencyKey: "scratch-merge", promoteFeatureWorktreeToBase: true };
  const observed = observeDirectories(() => new FinalizeMergeTransaction(options).execute());
  assert.equal(observed.result.strategy, "squash");
  assert.equal(git(root, ["branch", "--show-current"]), "main");
  assert.equal(fs.readFileSync(path.join(root, "source.txt"), "utf8"), "feature\n");
  assert.equal(observed.directories.length, 1);
  assert.equal(path.dirname(observed.directories[0]), path.join(root, ".tmp", "flows", "scratch-merge", "run-merge"));
  assert.equal(fs.existsSync(observed.directories[0]), false);
  const repeated = new FinalizeMergeTransaction(options).execute();
  assert.equal(repeated.resumed, true);
  assert.equal(repeated.mergeCommit, observed.result.mergeCommit);
});

test("repair Git output stays in its selected Flow and does not alter repair identity", (t) => {
  const root = fixture(t);
  const specPath = "specs/scratch-repair/001/spec.json";
  fs.mkdirSync(path.dirname(path.join(root, specPath)), { recursive: true });
  fs.writeFileSync(path.join(root, specPath), "{}\n");
  commitAll(root, "test: repair input");
  const baseline = captureRepairBaseline({ root, baseRef: "main", runId: "run-repair" });
  const state = { specId: "scratch-repair", runId: "run-repair", baseBranch: "main", repairBaseline: baseline.toJSON() };
  const capture = () => buildRepairStateManifest({ root, specPath, state });
  const observed = observeDirectories(capture);
  assert.equal(path.dirname(observed.directories[0]), path.join(root, ".tmp", "flows", "scratch-repair", "run-repair"));
  assert.equal(observed.directories.every((directory) => !fs.existsSync(directory)), true);
  assert.equal(capture().hash, observed.result.hash);
  fs.writeFileSync(path.join(root, "source.txt"), "changed\n");
  assert.notEqual(capture().hash, observed.result.hash);
});

test("completion Git index uses selected Flow scratch and commits only durable artifacts", (t) => {
  const root = fixture(t);
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  new CanonicalFlowFixture({ flowManager: manager, specId: "scratch-index", runId: "run-index" }).create();
  manager.addNote("Completion evidence", { specId: "scratch-index" });
  const options = { root, repositoryRoot: root, specRoot: "specs", specId: "scratch-index",
    runId: "run-index", idempotencyKey: "scratch-index-completion" };
  const observed = observeDirectories(() => commitFinalizeCompletion(options));
  assert.equal(observed.result.status, "done");
  assert.equal(observed.directories.length, 1);
  assert.equal(path.dirname(observed.directories[0]), path.join(root, ".tmp", "flows", "scratch-index", "run-index"));
  assert.equal(fs.existsSync(observed.directories[0]), false);
  const committed = git(root, ["show", "--pretty=format:", "--name-only", "HEAD"]).split("\n");
  assert.equal(committed.includes("specs/scratch-index/001/flow.json"), true);
  assert.equal(committed.some((file) => file.startsWith(".tmp/")), false);
  const head = git(root, ["rev-parse", "HEAD"]);
  assert.equal(commitFinalizeCompletion(options).resumed, true);
  assert.equal(git(root, ["rev-parse", "HEAD"]), head);
});

test("fingerprint Git output uses canonical repository scratch from a linked checkout", (t) => {
  const root = fixture(t);
  const checkout = path.join(root, "linked");
  git(root, ["worktree", "add", "--detach", checkout, "HEAD"]);
  t.after(() => runGit(["-C", root, "worktree", "remove", "--force", checkout]));
  const options = { repositoryRoot: root, specId: "scratch-fingerprint", runId: "run-fingerprint" };
  const observed = observeDirectories(() => finalRegressionWorktreeFingerprint(checkout, options));
  assert.equal(path.dirname(observed.directories[0]), path.join(root, ".tmp", "flows", "scratch-fingerprint", "run-fingerprint"));
  assert.equal(fs.existsSync(path.join(checkout, ".tmp")), false);
  assert.equal(finalRegressionWorktreeFingerprint(checkout, options), observed.result);
  const runtime = observeDirectories(() => finalRegressionWorktreeFingerprint(checkout, { repositoryRoot: root }));
  assert.equal(path.dirname(runtime.directories[0]), path.join(root, ".tmp", "runtime", "final-regression-git"));
  assert.equal(runtime.result, observed.result);
});

test("auto-rescue reads its relocated worktree journal and resumes interrupted cleanup", (t) => {
  const root = fixture(t);
  const baseline = git(root, ["rev-parse", "HEAD"]);
  git(root, ["switch", "-c", "feature/rescue-scratch"]);
  fs.writeFileSync(path.join(root, "rescued.txt"), "rescued\n");
  commitAll(root, "test: orphan for scratch recovery");
  git(root, ["switch", "main"]);
  const input = { mainRepoPath: root, baseBranch: "main", baseline,
    featureBranch: "feature/rescue-scratch", specId: "scratch-rescue", runId: "run-rescue",
    range: `${baseline}..feature/rescue-scratch` };
  const interrupted = runDetachedAutoRescue({ ...input, runGitFn: (args) => {
    if (args.includes("worktree") && args.includes("remove")) return { ok: false, stdout: "", stderr: "injected cleanup interruption" };
    return runGit(args);
  } });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.code, "AUTO_RESCUE_CLEANUP_FAILED");
  const journal = new AutoRescueCleanupStore(autoRescueIdentity(input)).load();
  assert.equal(path.dirname(journal.tempWorktreePath), path.join(root, ".tmp", "flows", "scratch-rescue", "run-rescue"));
  assert.equal(fs.existsSync(journal.tempWorktreePath), true);
  assert.equal(git(root, ["show", "main:rescued.txt"]), "rescued");
  const published = git(root, ["rev-parse", "main"]);
  const resumed = runDetachedAutoRescue(input);
  assert.equal(resumed.ok, true);
  const reread = new AutoRescueCleanupStore(autoRescueIdentity(input)).load();
  assert.equal(reread.phase, "completed");
  assert.equal(fs.existsSync(reread.tempWorktreePath), false);
  assert.equal(git(root, ["rev-parse", "main"]), published);
  assert.equal(git(root, ["show", "main:rescued.txt"]), "rescued");
});

test("plugin archive staging is consumed from runtime scratch without moving installed package authority", (t) => {
  const root = createTmpDir("scratch-plugin-consumer-");
  t.after(() => removeTmpDir(root));
  const source = path.join(root, "plugin-source");
  fs.mkdirSync(source);
  initGitRepo(source);
  writeJson(source, "plugin.json", { name: "scratch-plugin", type: "mixed", files: ["plugin.json", "lib/"], contributions: {} });
  fs.mkdirSync(path.join(source, "lib"));
  fs.writeFileSync(path.join(source, "lib", "content.txt"), "archived package input\n");
  commitAll(source, "test: plugin archive input");
  writeJson(root, ".sennel/config.json", { plugin: {
    sources: [{ id: "scratch-source", type: "local", path: source }], packages: [],
  } });
  const observed = observeDirectories(() => installPlugin(root, "scratch-plugin"));
  const archives = observed.directories.filter((directory) => path.basename(directory).startsWith("tmp-plugin-"));
  assert.equal(archives.length, 1);
  assert.equal(path.dirname(archives[0]), path.join(root, ".tmp", "runtime", "plugin-materialization"));
  assert.equal(fs.existsSync(archives[0]), false);
  assert.equal(observed.result.id, "scratch-plugin");
  assert.equal(fs.readFileSync(path.join(root, ".sennel", "plugins", "scratch-plugin", "lib", "content.txt"), "utf8"), "archived package input\n");
  assert.equal(readProjectConfig(root).plugin.packages[0].commit, git(source, ["rev-parse", "HEAD"]));
});
