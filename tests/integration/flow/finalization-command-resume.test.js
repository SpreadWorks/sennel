import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { FlowOutbox, FlowOutboxStore, finalizationOutboxIdentity } from "../../../src/flow/lib/flow-outbox.js";
import RunFinalizeCommitCommand from "../../../src/flow/lib/run-finalize-commit.js";
import RunFinalizeMergeCommand from "../../../src/flow/lib/run-finalize-merge.js";
import RunFinalizeSyncCommand from "../../../src/flow/lib/run-finalize-sync.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import RunReportCommand from "../../../src/flow/lib/run-report.js";
import { outboxCommitMarker } from "../../../src/flow/lib/run-finalize.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { dispatch } from "../../../src/lib/dispatcher.js";
import { container } from "../../../src/lib/container.js";
import { createTmpDir, removeTmpDir, writeFile } from "../../support/builders/tmp-dir.js";
import { checkoutNewBranch, commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { CanonicalFlowFixture, makeContainer, makeFlowManager } from "../../support/infrastructure/flow-setup.js";

function pendingEntry(state, stepId) {
  const outbox = new FlowOutbox();
  return outbox.begin(finalizationOutboxIdentity(state, stepId), "2026-07-17T00:00:00.000Z");
}

function commitCount(root, ref = "HEAD") {
  const result = runGit(["-C", root, "rev-list", "--count", ref]);
  assert.equal(result.ok, true, result.stderr);
  return Number(result.stdout.trim());
}

async function setupFinalizationRepo(root, flowOverrides = {}) {
  initGitRepo(root);
  writeFile(root, "README.md", "baseline\n");
  writeFile(root, "package.json", JSON.stringify({ type: "module", scripts: { test: "node --test fixture.test.js" } }));
  writeFile(root, "fixture.test.js", "import test from 'node:test'; test('fixture regression', () => {});\n");
  commitAll(root, "test: baseline");
  checkoutNewBranch(root, "feature/001-test");
  const flowManager = makeFlowManager(root);
  writeFile(root, "src-change.js", "export const changed = true;\n");
  const fixture = new CanonicalFlowFixture({
    flowManager,
    specId: flowOverrides.specId ?? "001-test",
    runId: flowOverrides.runId ?? "run-test",
    request: flowOverrides.request ?? "finalization fixture",
    issue: flowOverrides.issue ?? null,
    specRecord: { requirements: [{ id: "R1", desc: "Exercise finalization recovery.", task_ids: ["T1"], testable: false }] },
    execution: {
      mode: flowOverrides.worktree === true ? "worktree" : "branch",
      baseBranch: flowOverrides.baseBranch ?? "main",
      featureBranch: flowOverrides.featureBranch ?? "feature/001-test",
    },
  }).create().addTask({ id: "T1", title: "Fixture Task", goal: "Exercise finalization recovery.",
    origin: "plan", added_round: 0, status: "pending" }).registerActive();
  await fixture.activateWithProducers("report");
  return { state: fixture.state(), flowManager };
}

describe("finalization command crash resumption", () => {
  it("passes the pre-hook outbox entry unchanged to report issue comment idempotency", async () => {
    const root = createTmpDir("finalize-outbox-report-dispatch-");
    const externalRoot = createTmpDir("finalize-gh-process-");
    const originalPath = process.env.PATH;
    const originalGhLog = process.env.SENNEL_TEST_GH_LOG;
    try {
      const { state, flowManager } = await setupFinalizationRepo(root, { issue: 414 });
      const entry = new FlowOutboxStore(flowManager, { specId: state.specId }).begin(finalizationOutboxIdentity(state, "report"));
      const binDir = path.join(externalRoot, "bin");
      const ghLog = path.join(externalRoot, "gh.log");
      writeFile(externalRoot, "bin/gh", [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" >> \"$SENNEL_TEST_GH_LOG\"",
        "exit 0",
        "",
      ].join("\n"));
      fs.chmodSync(path.join(binDir, "gh"), 0o755);
      process.env.PATH = `${binDir}:${originalPath}`;
      process.env.SENNEL_TEST_GH_LOG = ghLog;

      let receivedEntry;
      class CapturingRunReportCommand extends RunReportCommand {
        execute(ctx) {
          receivedEntry = ctx.flowOutboxEntry;
          return super.execute(ctx);
        }
      }
      const dispatchContainer = makeContainer(root);
      dispatchContainer.register("paths", { root, agentWorkDir: path.join(root, ".tmp") });
      dispatchContainer.register("mainRoot", root);
      dispatchContainer.register("config", {});
      dispatchContainer.register("inWorktree", false);
      const stdout = [];

      await dispatch({
        container: dispatchContainer,
        entry: {
          args: {},
          command: async () => ({ default: CapturingRunReportCommand }),
          pre(ctx) { ctx.flowOutboxEntry = entry; },
        },
        argv: [],
        envelopeType: "run",
        envelopeKey: "report",
        stdout(text) { stdout.push(text); },
        stderr() {},
        setExitCode() {},
        buildHookCtx: () => ({ root, flowState: state, flowManager }),
      });

      assert.strictEqual(receivedEntry, entry);
      assert.equal(JSON.parse(stdout.join("")).ok, true, stdout.join(""));
      assert.match(fs.readFileSync(ghLog, "utf8"), new RegExp(`sennel:${entry.idempotencyKey}`));
    } finally {
      process.env.PATH = originalPath;
      if (originalGhLog === undefined) delete process.env.SENNEL_TEST_GH_LOG;
      else process.env.SENNEL_TEST_GH_LOG = originalGhLog;
      removeTmpDir(externalRoot);
      removeTmpDir(root);
    }
  });

  it("replays exact report publication without creating a second durable artifact", async () => {
    const root = createTmpDir("finalize-outbox-report-");
    try {
      const { state, flowManager } = await setupFinalizationRepo(root);
      const entry = new FlowOutboxStore(flowManager, { specId: state.specId }).begin(finalizationOutboxIdentity(state, "report"));
      const ctx = { root, flowState: state, flowManager, flowOutboxEntry: entry };
      const reportPath = flowManager.specLocation(state.specId).reportFile;

      const first = await new RunReportCommand().execute(ctx);
      assert.equal(first.result, "ok");
      await FLOW_COMMANDS.run.report.post(ctx, first);
      const firstBytes = fs.readFileSync(reportPath);

      const before = { state: flowManager.canonicalState(state.specId).toJSON(),
        activities: flowManager.activityLedger(state.specId), catalog: flowManager.artifactCatalog(state.specId).toJSON() };
      await FLOW_COMMANDS.run.report.post(ctx, first);
      assert.deepEqual({ state: flowManager.canonicalState(state.specId).toJSON(),
        activities: flowManager.activityLedger(state.specId), catalog: flowManager.artifactCatalog(state.specId).toJSON() }, before);
      assert.deepEqual(fs.readFileSync(reportPath), firstBytes);
    } finally {
      removeTmpDir(root);
    }
  });

  it("does not create a second implementation commit after a pre-post-hook crash", async () => {
    const root = createTmpDir("finalize-outbox-commit-");
    try {
      const { state, flowManager } = await setupFinalizationRepo(root);
      const entry = pendingEntry(state, "finalize-commit");
      const ctx = { root, flowState: state, flowManager, flowOutboxEntry: entry };

      const first = await new RunFinalizeCommitCommand().execute(ctx);
      assert.equal(first.status, "done");
      const afterFirst = commitCount(root);

      const resumed = await new RunFinalizeCommitCommand().execute(ctx);
      assert.equal(resumed.resumed, true);
      assert.equal(commitCount(root), afterFirst);
    } finally {
      removeTmpDir(root);
    }
  });

  it("does not create a second squash merge commit after a pre-post-hook crash", async () => {
    const root = createTmpDir("finalize-outbox-merge-");
    try {
      container.set("config", { commands: { gh: "disable" } });
      const { state, flowManager } = await setupFinalizationRepo(root);
      commitAll(root, "feat: implementation");
      const entry = pendingEntry(state, "finalize-merge");
      const ctx = { root, flowState: state, flowManager, flowOutboxEntry: entry };

      const first = await new RunFinalizeMergeCommand().execute(ctx);
      assert.equal(first.status, "done");
      const afterFirst = commitCount(root, "main");
      assert.equal(runGit(["-C", root, "branch", "--show-current"]).stdout.trim(), "main");

      const resumed = await new RunFinalizeMergeCommand().execute(ctx);
      assert.equal(resumed.resumed, true);
      assert.equal(commitCount(root, "main"), afterFirst);
    } finally {
      container.reset();
      removeTmpDir(root);
    }
  });

  it("skips docs sync when its stable outbox commit is already durable", async () => {
    const root = createTmpDir("finalize-outbox-sync-");
    try {
      const { state, flowManager } = await setupFinalizationRepo(root);
      const entry = pendingEntry(state, "finalize-sync");
      const marker = outboxCommitMarker(entry.idempotencyKey);
      const committed = runGit(["-C", root, "commit", "--allow-empty", "-m", "docs: sync documentation", "-m", marker]);
      assert.equal(committed.ok, true, committed.stderr);
      const before = commitCount(root);

      const result = await new RunFinalizeSyncCommand().execute({
        root,
        flowState: state,
        flowManager,
        flowOutboxEntry: entry,
      });

      assert.deepEqual(result, { status: "done", resumed: true });
      assert.equal(commitCount(root), before);
      assert.equal(fs.existsSync(path.join(root, "docs", ".outbox-sync-probe")), false);
    } finally {
      removeTmpDir(root);
    }
  });

  it("preserves docs build stdout, stderr, and exit code in a structured sync failure", async () => {
    const root = createTmpDir("finalize-sync-diagnostics-");
    try {
      const { state, flowManager } = await setupFinalizationRepo(root);
      const command = new RunFinalizeSyncCommand({
        runCommand: () => ({
          ok: false,
          status: 23,
          stdout: "build output\n",
          stderr: "build error\n",
          signal: null,
          killed: false,
        }),
        hasCommit: () => false,
      });

      await assert.rejects(
        () => command.execute({
          root,
          flowState: state,
          flowManager,
          flowOutboxEntry: pendingEntry(state, "finalize-sync"),
        }),
        (error) => {
          assert.equal(error.code, "FINALIZE_SYNC_FAILED");
          assert.deepEqual(error.data.diagnostics[0], {
            phase: "docs-build",
            exitCode: 23,
            signal: null,
            killed: false,
            errorCode: null,
            stdout: "build output\n",
            stderr: "build error\n",
          });
          assert.equal(error.data.diagnostics[1].phase, "git-status-after-failure");
          return true;
        },
      );
    } finally {
      removeTmpDir(root);
    }
  });

  it("binds docs generation to the main repository when finalize-sync runs from a worktree", async () => {
    const root = createTmpDir("finalize-sync-main-root-");
    try {
      const { state } = await setupFinalizationRepo(root, { worktree: true });
      const worktreeRoot = path.join(root, ".sennel", "worktree", "feature");
      fs.mkdirSync(worktreeRoot, { recursive: true });
      let docsBuildOptions = null;
      const resultFor = ({ ok = true, status = 0, stdout = "", stderr = "" } = {}) => ({
        ok,
        status,
        stdout,
        stderr,
        signal: null,
        killed: false,
        errorCode: null,
      });
      const command = new RunFinalizeSyncCommand({
        hasCommit: () => false,
        runCommand: (_command, _args, options) => {
          docsBuildOptions = options;
          return resultFor();
        },
        git: (args, options) => {
          assert.equal(options.cwd, root);
          if (args[0] === "commit") {
            return resultFor({ ok: false, status: 1, stderr: "nothing to commit" });
          }
          return resultFor();
        },
      });

      const result = await command.execute({
        root: worktreeRoot,
        flowState: state,
        flowManager: {
          resolveWorktreePaths: () => ({ mainRepoPath: root }),
        },
      });

      assert.equal(result.status, "skipped");
      assert.equal(docsBuildOptions.cwd, root);
      assert.equal(docsBuildOptions.env.SENNEL_WORK_ROOT, root);
      assert.equal(docsBuildOptions.env.SENNEL_SOURCE_ROOT, root);
    } finally {
      removeTmpDir(root);
    }
  });
});
