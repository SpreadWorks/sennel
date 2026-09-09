/**
 * tests/integration/flow/finalize-cleanup-robustness.test.js
 *
 * Tests for enhanced finalize-cleanup robustness and authority switch.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import fs from "fs";
import { execFileSync, spawnSync } from "child_process";
import { pathToFileURL } from "node:url";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { FlowAtStepFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { findStepById } from "../../../src/flow/lib/step-tree.js";
import { ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { ProcessLock } from "../../../src/lib/process-lock.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { persistPromptCacheHitMetric } from "../../../src/lib/agent-invocation-metric.js";
import {
  WorktreeFlowBindingStore,
  WorktreeFlowIdentity,
} from "../../../src/lib/worktree-flow-binding.js";
import {
  FlowOutboxStore,
  finalizationOutboxIdentity,
} from "../../../src/flow/lib/flow-outbox.js";

function initGitRepo(root) {
  execFileSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "config", "user.name", "Test User"], { encoding: "utf8" });
  fs.writeFileSync(path.join(root, "README.md"), "# Test Repo\n");
  execFileSync("git", ["-C", root, "add", "README.md"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "initial commit"], { encoding: "utf8" });
}

function acquireLiveCurrentFlowStateLock(root, specId) {
  const location = makeFlowManager(root).specLocation(specId);
  const runtimeDirectory = location.resolve(".runtime");
  const lockDirectory = location.resolve(".runtime/locks");
  const directoryAuthority = new RealDirectoryAuthority(location.directory);
  const runtimeAuthority = new RealDirectoryAuthority(runtimeDirectory, { parentAuthority: directoryAuthority });
  const lockDirectoryAuthority = new RealDirectoryAuthority(lockDirectory, { parentAuthority: runtimeAuthority });
  const lock = new ProcessLock({
    directoryAuthority: lockDirectoryAuthority,
    fileName: "current-flow-state.lock",
    kind: "current-flow-state",
    authority: {
      directory: location.directory,
      runtimeDirectory,
      statePath: location.flowStateFile,
      activityPath: location.activitiesFile,
    },
    processIdentitySource: new ProcessIdentitySource(),
  });
  lock.acquire();
  return lock;
}

function canonicalFlowPath(root, specId) {
  return makeFlowManager(root).specLocation(specId).flowStateFile;
}

function canonicalIssueLogPath(root, specId) {
  return makeFlowManager(root).specLocation(specId).issueLogFile;
}

function saveManagedWorktreeBinding(worktreePath, state) {
  new WorktreeFlowBindingStore({ worktreePath }).save(new WorktreeFlowIdentity({
    runId: state.runId,
    issue: Object.hasOwn(state, "issue") ? state.issue : null,
    specId: state.specId,
    worktreePath,
  }));
}

function setupFinalizeCleanupFlow(root, {
  specId = "001-test",
  runId = "run-test",
  baseBranch = "main",
  featureBranch = "feature/001-test",
  worktree = false,
  targetStep = "finalize-cleanup",
} = {}) {
  const flowManager = makeFlowManager(root);
  return new FlowAtStepFixture({
    flowManager,
    specId,
    runId,
    request: "finalize cleanup fixture",
    execution: {
      mode: worktree ? "worktree" : "branch",
      baseBranch,
      featureBranch,
    },
    targetStep,
  }).create().state();
}

describe("finalize-cleanup robustness", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("merges finalize metadata through catalog reads and rejects stale artifact bytes", async () => {
    const { recordFinalizeCleanupPostCommandMetadata } = await import(
      "../../../src/flow/lib/run-finalize-cleanup.js"
    );
    tmp = createTmpDir("sennel-finalize-metadata-catalog-");
    const state = setupFinalizeCleanupFlow(tmp);
    const flowManager = makeFlowManager(tmp);
    const record = (metric) => recordFinalizeCleanupPostCommandMetadata({
      flowManager,
      specId: state.specId,
      metrics: [metric],
    });

    record({ id: "metric-1" });
    record({ id: "metric-2" });
    const artifact = flowManager.readArtifact({
      specId: state.specId,
      logicalKey: "finalize.cleanup.agent-metrics",
      consumerNodeId: "finalize-cleanup",
    });
    assert.deepEqual(JSON.parse(artifact.bytes.toString("utf8")), {
      version: 1,
      entries: [{ id: "metric-1" }, { id: "metric-2" }],
    });

    fs.appendFileSync(flowManager.specLocation(state.specId).resolve(artifact.relativePath), "\n");
    assert.throws(
      () => record({ id: "metric-3" }),
      /canonical finalize-cleanup finalize\.cleanup\.agent-metrics is invalid|does not match the catalog/,
    );
  });

  it("routes prompt-cache metrics through the finalize sidecar in a worktree Flow", async () => {
    tmp = createTmpDir("sennel-finalize-cache-metric-");
    const state = setupFinalizeCleanupFlow(tmp, { worktree: true });
    const flowManager = makeFlowManager(tmp);

    assert.equal(await persistPromptCacheHitMetric({
      flowManager,
      context: flowManager.resolveCurrentContext(),
      provider: "test-provider",
      profileKey: "flow-finalize",
      responseChars: 24,
    }), true);

    const artifact = flowManager.readArtifact({
      specId: state.specId,
      logicalKey: "finalize.cleanup.agent-metrics",
      consumerNodeId: "finalize-cleanup",
    });
    assert.deepEqual(JSON.parse(artifact.bytes.toString("utf8")), {
      version: 1,
      entries: [{
        phase: "finalize-cleanup",
        kind: "agent-cache",
        provider: "test-provider",
        profileKey: "flow-finalize",
        callCount: 0,
        cachedResponse: true,
        responseChars: 24,
      }],
    });
  });

  it("registry post hooks switch ctx.flowManager to main repo authority", async () => {
    tmp = createTmpDir("sennel-finalize-auth-switch-");
    const mainRoot = path.join(tmp, "main");
    const worktreeRoot = path.join(tmp, "worktree");
    fs.mkdirSync(mainRoot);
    fs.mkdirSync(worktreeRoot);
    initGitRepo(mainRoot);

    const state = setupFinalizeCleanupFlow(mainRoot, {
      worktree: true,
      featureBranch: "feature/test",
      targetStep: "finalize-merge",
    });
    const specId = state.specId;

    const { FlowManager } = await import("../../../src/lib/flow-manager.js");
    const fm = new FlowManager({ root: worktreeRoot, mainRoot: mainRoot, inWorktree: true, specId });
    new FlowOutboxStore(fm, { specId }).begin(finalizationOutboxIdentity(state, "finalize-merge"));
    const preparedState = fm.loadReadOnly(specId);
    const ctx = {
      flowManager: fm,
      flowState: { ...preparedState, worktree: true, featureBranch: "feature/test" },
      root: mainRoot,
      repositoryRoot: mainRoot,
      executionRoot: worktreeRoot,
      mainRoot: mainRoot,
      specId,
    };

    const entry = FLOW_COMMANDS.run["finalize-merge"];
    await entry.post(ctx, { status: "done", strategy: "squash" });

    assert.notEqual(ctx.flowManager, fm, "flowManager should have been switched");
    assert.equal(path.resolve(ctx.flowManager._root), path.resolve(mainRoot), "new flowManager should be rooted in main");
  });

  it("finalize stops before every teardown side effect on same-process writer reentry, then succeeds on retry", async () => {
    const { runTeardown } = await import("../../../src/flow/lib/run-finalize-cleanup.js");
    tmp = createTmpDir("sennel-finalize-sync-required-");
    const mainRoot = path.join(tmp, "main");
    const worktreePath = path.join(tmp, "worktree");
    const specId = "125";
    const spec = `specs/${specId}/spec.json`;
    const featureBranch = `feature/${specId}`;
    initGitRepo(mainRoot);

    const mainState = setupFinalizeCleanupFlow(mainRoot, {
      specId,
      runId: "run-required-sync",
      featureBranch,
      baseBranch: "master",
      worktree: true,
    });
    execFileSync("git", ["-C", mainRoot, "add", path.relative(mainRoot, canonicalFlowPath(mainRoot, specId))]);
    execFileSync("git", ["-C", mainRoot, "commit", "--quiet", "-m", "add flow"]);
    execFileSync("git", ["-C", mainRoot, "worktree", "add", "-b", featureBranch, worktreePath]);
    const fm = new FlowManager({ root: worktreePath, mainRoot, inWorktree: true, specId });
    fm.setStepRuntimeLog("finalize-merge", {
      runId: "worktree-log",
      sequence: 7,
      attempt: 1,
      command: "finalize-merge",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 0,
    }, { specId });

    const registryPath = path.join(mainRoot, ".sennel", ".active-flow");
    const flowState = fm.loadReadOnly(specId);
    const lock = acquireLiveCurrentFlowStateLock(mainRoot, specId);
    const before = {
      mainFlow: fs.readFileSync(canonicalFlowPath(mainRoot, specId)),
      registry: fs.readFileSync(registryPath),
      head: execFileSync("git", ["-C", mainRoot, "rev-parse", "HEAD"], { encoding: "utf8" }),
      branches: execFileSync("git", ["-C", mainRoot, "branch", "--format=%(refname)"], { encoding: "utf8" }),
      worktrees: execFileSync("git", ["-C", mainRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" }),
    };
    const ctx = {
      flowManager: fm,
      flowState,
      root: mainRoot,
      mainRoot,
      repositoryRoot: mainRoot,
      executionRoot: worktreePath,
      force: true,
    };

    await assert.rejects(
      () => runTeardown(ctx, {
        worktreePath,
        mainRepoPath: mainRoot,
        reportRoot: mainRoot,
        specId,
      }),
      (error) => error.code === "CURRENT_FLOW_STATE_LOCK_REENTRANT"
        && error.lockStatus === "reentrant",
    );
    assert.deepEqual(fs.readFileSync(canonicalFlowPath(mainRoot, specId)), before.mainFlow);
    assert.deepEqual(fs.readFileSync(registryPath), before.registry);
    assert.equal(execFileSync("git", ["-C", mainRoot, "rev-parse", "HEAD"], { encoding: "utf8" }), before.head);
    assert.equal(execFileSync("git", ["-C", mainRoot, "branch", "--format=%(refname)"], { encoding: "utf8" }), before.branches);
    assert.equal(execFileSync("git", ["-C", mainRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" }), before.worktrees);

    lock.release();
    const retried = await runTeardown(ctx, {
      worktreePath,
      mainRepoPath: mainRoot,
      reportRoot: mainRoot,
      specId,
    });
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(fs.existsSync(worktreePath), false);
    assert.equal(fs.existsSync(registryPath), true, "active entry is cleared only after the completion commit");
  });

  it("validateTeardown detects remaining branch", async () => {
    const { validateTeardown } = await import("../../../src/flow/lib/run-finalize-cleanup.js");
    tmp = createTmpDir("sennel-validate-teardown-");
    initGitRepo(tmp);
    const featureBranch = "feature/test";
    execFileSync("git", ["-C", tmp, "checkout", "-b", featureBranch], { encoding: "utf8" });

    const result = validateTeardown({
      worktreePath: path.join(tmp, "wt"),
      mainRepoPath: tmp,
      featureBranch,
      specId: "123"
    });

    assert.equal(result.ok, false);
    assert.ok(result.reasons.some(r => r.includes("Feature branch remains")));
  });

  it("auto-rescue updates the base without changing the caller checkout, HEAD, or index", async () => {
    const { runAutoRescue } = await import("../../../src/flow/lib/run-finalize-cleanup.js");
    tmp = createTmpDir("sennel-auto-rescue-isolated-");
    initGitRepo(tmp);
    const baseBranch = execFileSync("git", ["-C", tmp, "branch", "--show-current"], { encoding: "utf8" }).trim();
    const baseline = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const featureBranch = "feature/isolated-rescue";
    execFileSync("git", ["-C", tmp, "checkout", "-qb", featureBranch]);
    fs.writeFileSync(path.join(tmp, "rescued.txt"), "rescued\n");
    execFileSync("git", ["-C", tmp, "add", "rescued.txt"]);
    execFileSync("git", ["-C", tmp, "commit", "-qm", "rescue me"]);
    const before = {
      branch: execFileSync("git", ["-C", tmp, "branch", "--show-current"], { encoding: "utf8" }),
      head: execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }),
      index: fs.readFileSync(path.join(tmp, ".git", "index")),
    };

    const result = runAutoRescue({
      mainRepoPath: tmp,
      baseBranch,
      baseline,
      featureBranch,
      specId: "isolated-rescue",
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(execFileSync("git", ["-C", tmp, "branch", "--show-current"], { encoding: "utf8" }), before.branch);
    assert.equal(execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }), before.head);
    assert.deepEqual(fs.readFileSync(path.join(tmp, ".git", "index")), before.index);
    assert.equal(execFileSync("git", ["-C", tmp, "show", `${baseBranch}:rescued.txt`], { encoding: "utf8" }), "rescued\n");
  });

  it("auto-rescue materializes an updated base checkout and leaves its index clean", async () => {
    const { runAutoRescue } = await import("../../../src/flow/lib/run-finalize-cleanup.js");
    tmp = createTmpDir("sennel-auto-rescue-base-checkout-");
    initGitRepo(tmp);
    const baseBranch = execFileSync("git", ["-C", tmp, "branch", "--show-current"], { encoding: "utf8" }).trim();
    const baseline = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const featureBranch = "feature/materialized-rescue";
    execFileSync("git", ["-C", tmp, "checkout", "-qb", featureBranch]);
    fs.writeFileSync(path.join(tmp, "rescued.txt"), "rescued on base\n");
    execFileSync("git", ["-C", tmp, "add", "rescued.txt"]);
    execFileSync("git", ["-C", tmp, "commit", "-qm", "rescue materialized file"]);
    execFileSync("git", ["-C", tmp, "checkout", "-q", baseBranch]);

    const result = runAutoRescue({
      mainRepoPath: tmp,
      baseBranch,
      baseline,
      featureBranch,
      specId: "materialized-rescue",
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(tmp, "rescued.txt"), "utf8"), "rescued on base\n");
    assert.equal(execFileSync("git", ["-C", tmp, "status", "--porcelain"], { encoding: "utf8" }), "");
  });

  it("public auto-rescue resumes a ref-update crash before dirty preflight", async () => {
    const { runAutoRescue } = await import("../../../src/flow/lib/run-finalize-cleanup.js");
    tmp = createTmpDir("sennel-auto-rescue-ref-crash-");
    initGitRepo(tmp);
    const baseBranch = execFileSync("git", ["-C", tmp, "branch", "--show-current"], { encoding: "utf8" }).trim();
    const baseline = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const featureBranch = "feature/ref-crash-rescue";
    execFileSync("git", ["-C", tmp, "checkout", "-qb", featureBranch]);
    fs.writeFileSync(path.join(tmp, "rescued-after-crash.txt"), "recovered\n");
    execFileSync("git", ["-C", tmp, "add", "rescued-after-crash.txt"]);
    execFileSync("git", ["-C", tmp, "commit", "-qm", "rescue after ref crash"]);
    execFileSync("git", ["-C", tmp, "checkout", "-q", baseBranch]);

    const bin = path.join(tmp, ".git", "crash-bin");
    fs.mkdirSync(bin);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(bin, "git"), [
      "#!/bin/sh",
      `real=${JSON.stringify(realGit)}`,
      'case "$*" in *update-ref*refs/heads/*)',
      '  "$real" "$@" || exit $?',
      '  kill -KILL "$SENNEL_RESCUE_PID"',
      "  sleep 5",
      "  exit 91",
      ";; esac",
      'exec "$real" "$@"',
      "",
    ].join("\n"), { mode: 0o755 });
    const moduleUrl = pathToFileURL(path.resolve("src/flow/lib/run-finalize-cleanup.js")).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { runAutoRescue } = await import(${JSON.stringify(moduleUrl)});
      process.env.SENNEL_RESCUE_PID = String(process.pid);
      runAutoRescue(${JSON.stringify({
        mainRepoPath: tmp,
        baseBranch,
        baseline,
        featureBranch,
        specId: "ref-crash-rescue",
      })});
    `], {
      cwd: tmp,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    assert.notEqual(execFileSync("git", ["-C", tmp, "rev-parse", baseBranch], { encoding: "utf8" }).trim(), baseline);
    assert.notEqual(execFileSync("git", ["-C", tmp, "status", "--porcelain"], { encoding: "utf8" }), "");

    const resumed = runAutoRescue({
      mainRepoPath: tmp,
      baseBranch,
      baseline,
      featureBranch,
      specId: "ref-crash-rescue",
    });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(fs.readFileSync(path.join(tmp, "rescued-after-crash.txt"), "utf8"), "recovered\n");
    assert.equal(execFileSync("git", ["-C", tmp, "status", "--porcelain"], { encoding: "utf8" }), "");
  });

  it("auto-rescue adopts a successful ref CAS reported as a Git failure", async () => {
    const { runAutoRescue } = await import("../../../src/flow/lib/run-finalize-cleanup.js");
    tmp = createTmpDir("sennel-auto-rescue-ref-ambiguous-");
    initGitRepo(tmp);
    const baseBranch = execFileSync("git", ["-C", tmp, "branch", "--show-current"], { encoding: "utf8" }).trim();
    const baseline = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const featureBranch = "feature/ref-ambiguous-rescue";
    execFileSync("git", ["-C", tmp, "checkout", "-qb", featureBranch]);
    fs.writeFileSync(path.join(tmp, "ambiguous-ref.txt"), "adopted\n");
    execFileSync("git", ["-C", tmp, "add", "ambiguous-ref.txt"]);
    execFileSync("git", ["-C", tmp, "commit", "-qm", "ambiguous ref rescue"]);
    execFileSync("git", ["-C", tmp, "checkout", "-q", baseBranch]);
    const bin = path.join(tmp, ".git", "ambiguous-bin");
    fs.mkdirSync(bin);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(bin, "git"), [
      "#!/bin/sh",
      `real=${JSON.stringify(realGit)}`,
      'case "$*" in *update-ref*refs/heads/*)',
      '  "$real" "$@" || exit $?',
      "  echo injected-ambiguous-result >&2",
      "  exit 73",
      ";; esac",
      'exec "$real" "$@"',
      "",
    ].join("\n"), { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    let result;
    try {
      result = runAutoRescue({
        mainRepoPath: tmp,
        baseBranch,
        baseline,
        featureBranch,
        specId: "ref-ambiguous-rescue",
      });
    } finally {
      process.env.PATH = oldPath;
    }
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(tmp, "ambiguous-ref.txt"), "utf8"), "adopted\n");
    assert.equal(execFileSync("git", ["-C", tmp, "status", "--porcelain"], { encoding: "utf8" }), "");
  });

  it("auto-rescue fails closed when conflict-file probing fails", async () => {
    const { runAutoRescue } = await import("../../../src/flow/lib/run-finalize-cleanup.js");
    tmp = createTmpDir("sennel-auto-rescue-conflict-probe-");
    initGitRepo(tmp);
    const baseBranch = execFileSync("git", ["-C", tmp, "branch", "--show-current"], { encoding: "utf8" }).trim();
    const baseline = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const featureBranch = "feature/conflict-probe-rescue";
    execFileSync("git", ["-C", tmp, "checkout", "-qb", featureBranch]);
    fs.writeFileSync(path.join(tmp, "README.md"), "feature version\n");
    execFileSync("git", ["-C", tmp, "commit", "-qam", "feature conflict"]);
    execFileSync("git", ["-C", tmp, "checkout", "-q", baseBranch]);
    fs.writeFileSync(path.join(tmp, "README.md"), "base version\n");
    execFileSync("git", ["-C", tmp, "commit", "-qam", "base conflict"]);
    const baseHead = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const bin = path.join(tmp, ".git", "probe-bin");
    fs.mkdirSync(bin);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(bin, "git"), [
      "#!/bin/sh",
      'case "$*" in *diff*--name-only*--diff-filter=U*) echo injected-conflict-probe >&2; exit 74;; esac',
      `exec ${JSON.stringify(realGit)} "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    try {
      assert.throws(
        () => runAutoRescue({
          mainRepoPath: tmp,
          baseBranch,
          baseline,
          featureBranch,
          specId: "conflict-probe-rescue",
        }),
        (error) => error.code === "AUTO_RESCUE_CONFLICT_PROBE_FAILED",
      );
    } finally {
      process.env.PATH = oldPath;
    }
    assert.equal(execFileSync("git", ["-C", tmp, "rev-parse", baseBranch], { encoding: "utf8" }).trim(), baseHead);
    assert.equal(execFileSync("git", ["-C", tmp, "status", "--porcelain"], { encoding: "utf8" }), "");
  });

  it("auto-rescue exempts only its exact conflict audit from issue-log dirtiness", async () => {
    const { runAutoRescue } = await import("../../../src/flow/lib/run-finalize-cleanup.js");
    tmp = createTmpDir("sennel-auto-rescue-issue-log-allowance-");
    const specId = "issue-log-allowance";
    const featureBranch = "feature/issue-log-allowance";
    const ownedAudit = { reason: "owned conflict", issueLogId: "owned-conflict-audit" };
    const prepareScenario = (root, { userEdit }) => {
      initGitRepo(root);
      fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/\n");
      setupFinalizeCleanupFlow(root, { specId, featureBranch });
      const flowManager = makeFlowManager(root);
      execFileSync("git", ["-C", root, "add", ".gitignore", "specs"]);
      execFileSync("git", ["-C", root, "commit", "-qm", "add issue log"]);
      const baseBranch = execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim();
      const baseline = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      execFileSync("git", ["-C", root, "checkout", "-qb", featureBranch]);
      fs.writeFileSync(path.join(root, "rescued.txt"), "rescue audit allowance\n");
      execFileSync("git", ["-C", root, "add", "rescued.txt"]);
      execFileSync("git", ["-C", root, "commit", "-qm", "add rescued file"]);
      execFileSync("git", ["-C", root, "checkout", "-q", baseBranch]);
      flowManager.appendIssueLog({ specId, entry: ownedAudit, idempotencyKey: ownedAudit.issueLogId });
      if (userEdit) {
        flowManager.appendIssueLog({
          specId,
          entry: { reason: "user edit", issueLogId: "user-edit" },
          idempotencyKey: "user-edit",
        });
      }
      return { baseBranch, baseline, issuePath: canonicalIssueLogPath(root, specId) };
    };

    const blockedScenario = prepareScenario(tmp, { userEdit: true });
    const blocked = runAutoRescue({
      mainRepoPath: tmp,
      ...blockedScenario,
      featureBranch,
      specId,
      allowedIssueLogId: ownedAudit.issueLogId,
      allowFinalizeMetadata: true,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "MAIN_REPO_DIRTY");
    assert.deepEqual(blocked.dirtyFiles, [`specs/${specId}/001/issue-log.json`]);

    const staleCatalogRoot = path.join(tmp, "stale-catalog");
    const staleCatalogScenario = prepareScenario(staleCatalogRoot, { userEdit: false });
    fs.appendFileSync(staleCatalogScenario.issuePath, "\n");
    const staleCatalog = runAutoRescue({
      mainRepoPath: staleCatalogRoot,
      ...staleCatalogScenario,
      featureBranch,
      specId,
      allowedIssueLogId: ownedAudit.issueLogId,
      allowFinalizeMetadata: true,
    });
    assert.equal(staleCatalog.ok, false);
    assert.equal(staleCatalog.code, "MAIN_REPO_DIRTY");
    assert.deepEqual(staleCatalog.dirtyFiles, [
      `specs/${specId}/001/flow.json`,
      `specs/${specId}/001/activities.jsonl`,
      `specs/${specId}/001/artifact-catalog.json`,
      `specs/${specId}/001/issue-log.json`,
    ]);

    const cleanRoot = path.join(tmp, "owned-audit-only");
    const rescuedScenario = prepareScenario(cleanRoot, { userEdit: false });
    const rescued = runAutoRescue({
      mainRepoPath: cleanRoot,
      ...rescuedScenario,
      featureBranch,
      specId,
      allowedIssueLogId: ownedAudit.issueLogId,
      allowFinalizeMetadata: true,
    });
    assert.equal(rescued.ok, true, JSON.stringify(rescued));
    assert.equal(fs.readFileSync(path.join(cleanRoot, "rescued.txt"), "utf8"), "rescue audit allowance\n");
    assert.deepEqual(JSON.parse(fs.readFileSync(rescuedScenario.issuePath, "utf8")).entries, [ownedAudit]);
  });

  it("auto-rescue rejects dirty Flow metadata that fails the canonical Version Store contract", async () => {
    const { runAutoRescue } = await import("../../../src/flow/lib/run-finalize-cleanup.js");
    tmp = createTmpDir("sennel-auto-rescue-invalid-flow-metadata-");
    const specId = "invalid-flow-metadata";
    const featureBranch = "feature/invalid-flow-metadata";
    initGitRepo(tmp);
    fs.writeFileSync(path.join(tmp, ".gitignore"), ".sennel/\n");
    setupFinalizeCleanupFlow(tmp, { specId, featureBranch });
    execFileSync("git", ["-C", tmp, "add", ".gitignore", "specs"]);
    execFileSync("git", ["-C", tmp, "commit", "-qm", "add canonical flow"]);
    const baseBranch = execFileSync("git", ["-C", tmp, "branch", "--show-current"], { encoding: "utf8" }).trim();
    const baseline = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", tmp, "checkout", "-qb", featureBranch]);
    fs.writeFileSync(path.join(tmp, "rescued.txt"), "must not be applied\n");
    execFileSync("git", ["-C", tmp, "add", "rescued.txt"]);
    execFileSync("git", ["-C", tmp, "commit", "-qm", "add rescued file"]);
    execFileSync("git", ["-C", tmp, "checkout", "-q", baseBranch]);

    const flowPath = path.join(tmp, "specs", specId, "001", "flow.json");
    const invalid = JSON.parse(fs.readFileSync(flowPath, "utf8"));
    invalid.legacyField = true;
    fs.writeFileSync(flowPath, `${JSON.stringify(invalid, null, 2)}\n`);

    const result = runAutoRescue({
      mainRepoPath: tmp,
      baseBranch,
      baseline,
      featureBranch,
      specId,
      allowFinalizeMetadata: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "MAIN_REPO_DIRTY");
    assert.deepEqual(result.dirtyFiles, [`specs/${specId}/001/flow.json`]);
    assert.equal(fs.existsSync(path.join(tmp, "rescued.txt")), false);
  });

  it("auto-rescue fails closed when repository status cannot be established", async () => {
    const { runAutoRescue } = await import("../../../src/flow/lib/run-finalize-cleanup.js");
    tmp = createTmpDir("sennel-auto-rescue-status-failure-");

    const result = runAutoRescue({
      mainRepoPath: tmp,
      baseBranch: "main",
      baseline: "1".repeat(40),
      featureBranch: "feature/status-failure",
      specId: "status-failure",
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "MAIN_REPO_STATUS_FAILED");
    assert.match(result.message, /status probe failed/i);
  });

  it("runTeardown fails if worktree remove fails (e.g. dirty)", async () => {
    tmp = createTmpDir("sennel-teardown-fail-");
    const mainRoot = path.join(tmp, "main");
    initGitRepo(mainRoot);

    const featureBranch = "feature/test";
    const specId = "123";
    const worktreePath = path.join(tmp, "wt");

    // Create a real worktree
    execFileSync("git", ["-C", mainRoot, "worktree", "add", "-b", featureBranch, worktreePath], { encoding: "utf8" });

    // Make it dirty
    fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "dirty");

    const { FlowManager } = await import("../../../src/lib/flow-manager.js");
    const fm = new FlowManager({ root: worktreePath, mainRoot: mainRoot, inWorktree: true, specId });
    setupFinalizeCleanupFlow(mainRoot, {
      specId,
      worktree: true,
      featureBranch,
      baseBranch: "master",
    });
    const ctx = {
      flowManager: fm,
      flowState: fm.loadReadOnly(specId),
      root: mainRoot,
      mainRoot,
      repositoryRoot: mainRoot,
      executionRoot: worktreePath,
    };

    const { runTeardown } = await import("../../../src/flow/lib/run-finalize-cleanup.js");

    const result = await runTeardown(ctx, {
      worktreePath,
      mainRepoPath: mainRoot,
      reportRoot: mainRoot,
      specId
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "WORKTREE_DIRTY");

    // Cleanup the worktree for real so we can delete tmp
    execFileSync("git", ["-C", mainRoot, "worktree", "remove", "--force", worktreePath], { encoding: "utf8" });
  });

  it("forced teardown failure compensates only its stable audit id and retains independently appended facts", async () => {
    const { RunFinalizeCleanupCommand } = await import("../../../src/flow/lib/run-finalize-cleanup.js");
    tmp = createTmpDir("sennel-finalize-audit-compensation-");
    initGitRepo(tmp);
    const specId = "126";
    const spec = `specs/${specId}/spec.json`;
    const featureBranch = "feature/126";
    const state = setupFinalizeCleanupFlow(tmp, {
      specId,
      runId: "run-compensation",
      baseBranch: "master",
      featureBranch,
      worktree: false,
    });
    execFileSync("git", ["-C", tmp, "branch", featureBranch]);
    const issuePath = canonicalIssueLogPath(tmp, specId);
    makeFlowManager(tmp).appendIssueLog({
      specId,
      entry: { issueLogId: "existing", reason: "existing" },
      idempotencyKey: "existing",
    });
    makeFlowManager(tmp).appendIssueLog({
      specId,
      entry: { issueLogId: "concurrent-writer", reason: "concurrent" },
      idempotencyKey: "concurrent-writer",
    });
    const marker = path.join(tmp, "concurrent-appended");
    const hook = path.join(tmp, ".git", "hooks", "pre-commit");
    fs.writeFileSync(marker, "ready");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const result = await new RunFinalizeCleanupCommand().execute({
      root: tmp,
      flowState: state,
      flowManager: makeFlowManager(tmp),
      force: true,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const entries = JSON.parse(fs.readFileSync(issuePath, "utf8")).entries;
    assert.equal(entries.some((entry) => entry.issueLogId === "existing"), true);
    assert.equal(entries.some((entry) => entry.issueLogId === "concurrent-writer"), true);
    assert.equal(entries.some((entry) => /FORCED_ORPHAN_DROP/.test(entry.reason || "")), true);
  });

  it("forced teardown fails closed before destructive work when audit append fails", async () => {
    const { RunFinalizeCleanupCommand } = await import("../../../src/flow/lib/run-finalize-cleanup.js");
    tmp = createTmpDir("sennel-finalize-audit-fail-stop-");
    initGitRepo(tmp);
    const specId = "127";
    const spec = `specs/${specId}/spec.json`;
    const featureBranch = "feature/127";
    const state = setupFinalizeCleanupFlow(tmp, {
      specId,
      runId: "run-audit-fail-stop",
      baseBranch: "master",
      featureBranch,
      worktree: false,
    });
    execFileSync("git", ["-C", tmp, "branch", featureBranch]);
    const issuePath = canonicalIssueLogPath(tmp, specId);
    fs.mkdirSync(issuePath);
    const before = {
      flow: fs.readFileSync(canonicalFlowPath(tmp, specId)),
      head: execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }),
      branches: execFileSync("git", ["-C", tmp, "branch", "--format=%(refname)"], { encoding: "utf8" }),
      worktrees: execFileSync("git", ["-C", tmp, "worktree", "list", "--porcelain"], { encoding: "utf8" }),
    };

    const result = await new RunFinalizeCleanupCommand().execute({
      root: tmp,
      flowState: state,
      flowManager: makeFlowManager(tmp),
      force: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "ISSUE_LOG_AUDIT_FAILED");
    assert.deepEqual(fs.readFileSync(canonicalFlowPath(tmp, specId)), before.flow);
    assert.equal(execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }), before.head);
    assert.equal(execFileSync("git", ["-C", tmp, "branch", "--format=%(refname)"], { encoding: "utf8" }), before.branches);
    assert.equal(execFileSync("git", ["-C", tmp, "worktree", "list", "--porcelain"], { encoding: "utf8" }), before.worktrees);
    assert.equal(fs.statSync(issuePath).isDirectory(), true);
  });

});
