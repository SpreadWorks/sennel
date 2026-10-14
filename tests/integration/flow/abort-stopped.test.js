import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { Container } from "../../../src/lib/container.js";
import { FlowCommand } from "../../../src/flow/lib/base-command.js";
import { RunAbortCommand } from "../../../src/flow/lib/run-abort.js";
import { FlowCommandExecutionLease } from "../../../src/flow/lib/flow-command-execution-lease.js";
import { ReviewExecutionLease } from "../../../src/flow/lib/review-execution-lease.js";
import { FlowHandoffAuthorityLease } from "../../../src/lib/flow-handoff-authority-lease.js";
import { RepositoryFlowOperationLock } from "../../../src/lib/repository-maintenance-lock.js";
import { ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { AbortHistoryStore } from "../../../src/flow/lib/abort-history.js";

function fixture(t, { mode = "direct" } = {}) {
  const root = createTmpDir("abort-stopped-");
  t.after(() => removeTmpDir(root));
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "README.md"), "baseline\n");
  commitAll(root, "test: baseline");
  const specRoot = "flow-artifacts/specs";
  const specId = "802-stopped-abort";
  const manager = new FlowManager({ root, mainRoot: root, specRoot, specId });
  const flow = new CanonicalFlowFixture({ flowManager: manager, specId, runId: "stopped-abort-run",
    request: "Cancel this stopped work", execution: { mode, baseBranch: "main",
      featureBranch: mode !== "direct" ? "feature/stopped-abort" : null } }).create().registerActive();
  const ctx = { root, mainRoot: root, executionRoot: root, flowManager: manager,
    flowState: flow.state(), specId, specLocation: manager.specLocation(specId), reason: "No longer needed" };
  const history = new AbortHistoryStore({ directory: path.join(root, specRoot) });
  const container = new Container();
  for (const [key, value] of Object.entries({ paths: { root }, mainRoot: root,
    flowManager: manager, config: { flow: { specDir: specRoot } }, inWorktree: false })) {
    container.register(key, value);
  }
  return { root, manager, flow, ctx, history, container };
}

function assertUntouched({ manager, ctx, history }, before) {
  assert.deepEqual(fs.readFileSync(ctx.specLocation.flowStateFile), before);
  assert.equal(fs.existsSync(history.file), false);
  assert.equal(manager.loadActiveFlows().some((entry) => entry.specId === ctx.specId), true);
  assert.equal(fs.existsSync(path.join(ctx.mainRoot, ".sennel/recovery/flow-abort", `${ctx.specId}.json`)), false);
}

function signal() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("a command borrows its parent repository operation without releasing its owner", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.ctx.specLocation.flowStateFile);
  const operation = new RepositoryFlowOperationLock({ mainRoot: f.root });
  const token = operation.acquire();
  let executed = 0;
  class NestedCommand extends FlowCommand {
    execute(ctx) {
      executed += 1;
      assert.equal(ctx.repositoryOperationOwnerToken, token);
      assert.equal(FlowCommandExecutionLease.forRun({ mainRoot: f.root, runId: f.ctx.flowState.runId }).length, 1);
      return "finished";
    }
  }
  try {
    await assert.rejects(new NestedCommand().run(f.container, {
      _envelopeType: "run", repositoryOperationOwnerToken: randomUUID(),
    }), { code: "REPOSITORY_FLOW_OPERATION_BUSY" });
    assert.equal(executed, 0);
    assert.equal(FlowCommandExecutionLease.forRun({ mainRoot: f.root, runId: f.ctx.flowState.runId }).length, 0);
    assertUntouched(f, before);
    assert.equal(await new NestedCommand().run(f.container, {
      _envelopeType: "run", repositoryOperationOwnerToken: token,
    }), "finished");
    assert.equal(executed, 1);
    assert.equal(FlowCommandExecutionLease.forRun({ mainRoot: f.root, runId: f.ctx.flowState.runId }).length, 0);
    assertUntouched(f, before);
    assert.throws(() => new RepositoryFlowOperationLock({ mainRoot: f.root }).acquire(), {
      code: "REPOSITORY_FLOW_OPERATION_BUSY",
    });
  } finally {
    operation.release();
  }
});

test("a direct running command refuses abort, then released execution permits JSONL cleanup", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.ctx.specLocation.flowStateFile);
  const entered = signal();
  const finish = signal();
  class WaitingCommand extends FlowCommand {
    async execute() { entered.resolve(); await finish.promise; return "finished"; }
  }
  const running = new WaitingCommand().run(f.container, { _envelopeType: "run", _envelopeKey: "gate" });
  try {
    await entered.promise;
    for (const force of [false, true]) {
      const refused = await new RunAbortCommand().execute({ ...f.ctx, force });
      assert.equal(refused.ok, false);
      assert.equal(refused.errors[0].code, "ABORT_EXECUTION_BUSY");
      assertUntouched(f, before);
    }
  } finally { finish.resolve(); }
  assert.equal(await running, "finished");
  assert.equal(FlowCommandExecutionLease.forRun({ mainRoot: f.root, runId: f.ctx.flowState.runId }).length, 0);
  const result = await new RunAbortCommand().execute(f.ctx);
  assert.equal(result.status, "aborted");
  assert.equal(result.log, "flow-artifacts/specs/abort-log.jsonl");
  assert.equal(fs.existsSync(f.ctx.specLocation.directory), false);
  assert.equal(fs.existsSync(path.dirname(f.ctx.specLocation.directory)), false);
  assert.deepEqual(f.manager.loadActiveFlows(), []);
  const records = new AbortHistoryStore({ directory: path.dirname(f.history.file) }).read();
  assert.deepEqual(records.map((record) => record.event), ["abort-requested", "abort-completed"]);
  assert.equal(records[0].operationId, records[1].operationId);
  assert.equal(records[0].reason, "No longer needed");
  assert.equal(records[1].runId, f.ctx.flowState.runId);
  assert.equal(fs.existsSync(path.join(f.root, ".sennel/recovery/flow-abort", `${f.ctx.specId}.json`)), false);
});

test("command failure releases its execution marker", async (t) => {
  const f = fixture(t);
  class FailingCommand extends FlowCommand { execute() { throw new Error("external execution failed"); } }
  await assert.rejects(new FailingCommand().run(f.container, { _envelopeType: "run" }), /external execution failed/);
  assert.deepEqual(FlowCommandExecutionLease.forRun({ mainRoot: f.root, runId: f.ctx.flowState.runId }), []);
  assert.equal((await new RunAbortCommand().execute(f.ctx)).status, "aborted");
});

test("the abort operation boundary prevents a new direct command from starting", async (t) => {
  const f = fixture(t);
  const operation = new RepositoryFlowOperationLock({ mainRoot: f.root });
  let calls = 0;
  class CountingCommand extends FlowCommand { execute() { calls += 1; return "started"; } }
  operation.acquire();
  try {
    await assert.rejects(new CountingCommand().run(f.container, { _envelopeType: "run" }),
      (error) => error.code === "REPOSITORY_FLOW_OPERATION_BUSY");
    assert.equal(calls, 0);
    assert.deepEqual(FlowCommandExecutionLease.forRun({ mainRoot: f.root, runId: f.ctx.flowState.runId }), []);
  } finally { operation.release(); }
});

test("a prior Review Attempt owner and a stale worker owner both refuse deletion without reclamation", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.ctx.specLocation.flowStateFile);
  const review = new ReviewExecutionLease({ mainRoot: f.root, runId: f.ctx.flowState.runId,
    nodeId: "spec-review", attemptId: "prior-attempt" });
  review.acquire();
  try {
    assert.equal((await new RunAbortCommand().execute(f.ctx)).errors[0].code, "ABORT_EXECUTION_BUSY");
    assertUntouched(f, before);
  } finally { review.release(); }
  const worker = new FlowHandoffAuthorityLease({ mainRoot: f.root, executionRoot: f.root });
  worker.lock.processLock.processIdentitySource = new ProcessIdentitySource({ platform: "linux", pid: process.pid,
    readBootIdentity: () => "previous-boot", readProcessStartFingerprint: () => "441" });
  worker.acquire();
  const ownerBytes = fs.readFileSync(worker.lock.lockPath);
  try {
    assert.equal((await new RunAbortCommand().execute(f.ctx)).errors[0].code, "ABORT_EXECUTION_BUSY");
    assertUntouched(f, before);
    assert.deepEqual(fs.readFileSync(worker.lock.lockPath), ownerBytes);
  } finally { worker.release(); }
});

test("unknown command ownership and malformed history refuse before journal or deletion", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.ctx.specLocation.flowStateFile);
  const lease = new FlowCommandExecutionLease({ mainRoot: f.root, runId: f.ctx.flowState.runId, specId: f.ctx.specId });
  lease.lock.acquire();
  const owner = fs.readFileSync(lease.lock.lockPath);
  try {
    for (const corrupt of ["invalid-owner\n", "null\n"]) {
      fs.writeFileSync(lease.lock.lockPath, corrupt);
      assert.equal((await new RunAbortCommand().execute(f.ctx)).errors[0].code, "ABORT_EXECUTION_BUSY");
      assertUntouched(f, before);
    }
  } finally { fs.writeFileSync(lease.lock.lockPath, owner); lease.release(); }
  fs.writeFileSync(f.history.file, '{"incomplete":true}');
  const refused = await new RunAbortCommand().execute(f.ctx);
  assert.equal(refused.errors[0].code, "ABORT_FAILED");
  assert.deepEqual(fs.readFileSync(f.ctx.specLocation.flowStateFile), before);
  assert.equal(fs.readFileSync(f.history.file, "utf8"), '{"incomplete":true}');
});

test("an already removed owned checkout can still be aborted without recreating its binding", async (t) => {
  const f = fixture(t, { mode: "worktree" });
  const worktree = f.manager.resolveWorktreePaths(f.ctx.flowState).worktreePath;
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature/stopped-abort", worktree, "main"], { cwd: f.root });
  execFileSync("git", ["worktree", "remove", worktree], { cwd: f.root });
  const result = await new RunAbortCommand().execute(f.ctx);
  assert.equal(result.status, "aborted", JSON.stringify(result));
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(fs.existsSync(f.ctx.specLocation.directory), false);
  assert.deepEqual(f.history.read().map((record) => record.event), ["abort-requested", "abort-completed"]);
  assert.equal(execFileSync("git", ["branch", "--list", "feature/stopped-abort"], { cwd: f.root, encoding: "utf8" }).trim(), "");
});

test("branch abort preserves a valid existing JSONL prefix and unrelated Spec Versions", async (t) => {
  const f = fixture(t, { mode: "branch" });
  const historyRecord = {
    schemaVersion: 1, event: "abort-completed", operationId: "11111111-1111-4111-8111-111111111111",
    runId: "another-run", specId: "803-another-spec", reason: null, recordedAt: "2026-10-14T00:00:00Z",
  };
  const prefix = Buffer.from(`${JSON.stringify(historyRecord)}\n`);
  fs.writeFileSync(f.history.file, prefix);
  const sibling = path.join(path.dirname(f.ctx.specLocation.directory), "002");
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, "keep.txt"), "keep\n");
  commitAll(f.root, "test: protected sibling and history baseline");
  execFileSync("git", ["switch", "-c", "feature/stopped-abort"], { cwd: f.root });
  const result = await new RunAbortCommand().execute(f.ctx);
  assert.equal(result.status, "aborted", JSON.stringify(result));
  assert.deepEqual(fs.readFileSync(f.history.file).subarray(0, prefix.length), prefix);
  assert.equal(fs.readFileSync(path.join(sibling, "keep.txt"), "utf8"), "keep\n");
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: f.root, encoding: "utf8" }).trim(), "main");
});
