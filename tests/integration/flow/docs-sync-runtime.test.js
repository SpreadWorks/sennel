import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import RunSyncCommand from "../../../src/flow/lib/run-sync.js";
import RunFinalizeSyncCommand from "../../../src/flow/lib/run-finalize-sync.js";
import { runCmd } from "../../../src/lib/process.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-runtime.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { captureFlowProcessExecutionBinding } from "../../../src/flow/lib/process-runtime-admission.js";

const chapter = ["# Runtime documentation", "", "## Description", "Generated child documentation.", "", "## Details",
  ...Array.from({ length: 15 }, (_, index) => `Verified detail ${index}.`), ""].join("\n");
const config = { type: "base", lang: "en", docs: { languages: ["en"], defaultLanguage: "en" },
  chapters: [{ chapter: "overview.md", desc: "Runtime documentation" }], scan: { include: ["input.txt"], exclude: [] } };

function fixture(t) {
  const root = createTestDirectory("docs-sync-runtime-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const templates = path.join(root, ".sennel/templates/en/docs");
  fs.mkdirSync(templates, { recursive: true });
  fs.writeFileSync(path.join(root, ".sennel/config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(root, "input.txt"), "live target input\n");
  fs.writeFileSync(path.join(templates, "overview.md"), chapter);
  fs.writeFileSync(path.join(templates, "README.md"), '# Documentation\n\n<!-- {{data("base.docs.chapters", {labels: "Chapter|Description"})}} -->\n<!-- {{/data}} -->\n');
  // This test owns only process-local environment; the genuine child bootstrap
  // must supply its own proof without a host preload or worktree selection.
  for (const key of ["SENNEL_WORK_ROOT", "SENNEL_SOURCE_ROOT", "NODE_OPTIONS"]) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    delete process.env[key];
  }
  return root;
}

function assertArtifacts(root) {
  assert.equal(fs.readFileSync(path.join(root, "docs/overview.md"), "utf8"), chapter);
  const analysis = JSON.parse(fs.readFileSync(path.join(root, ".sennel/output/analysis.json"), "utf8"));
  assert.equal(typeof analysis.analyzedAt, "string");
  assert.match(fs.readFileSync(path.join(root, "README.md"), "utf8"), /\[Runtime documentation\]\(docs\/overview\.md\)/);
}

function flowContext(mainRoot, { worktree = false } = {}) {
  const flowManager = new FlowManager({ root: mainRoot, mainRoot, inWorktree: false });
  const selected = new CanonicalFlowFixture({ flowManager,
    specId: "docs-managed-spec", runId: "docs-managed-run",
    execution: worktree ? { mode: "worktree", baseBranch: "main", featureBranch: "feature/docs-sync" }
      : { mode: "direct" },
  }).create();
  const flowState = selected.state();
  const root = flowManager.resolveWorktreePaths(flowState).worktreePath ?? mainRoot;
  if (worktree) fs.mkdirSync(root, { recursive: true });
  return { root, mainRoot, repositoryRoot: mainRoot, executionRoot: root,
    specId: flowState.specId, flowState, flowManager };
}

for (const dryRun of [false, true]) {
  test(`sync genuinely builds and reviews generated artifacts before ${dryRun ? "dry-run return" : "Git commit"}`, async (t) => {
    const root = fixture(t);
    const calls = [];
    const command = new RunSyncCommand({
      runCommand(command, args, options) {
        calls.push(args.at(-1));
        const result = runCmd(command, args, options);
        assert.equal(result.ok, true, result.stderr + result.stdout);
        return result;
      },
      git(args, options) {
        assert.equal(options.cwd, root);
        assertArtifacts(root);
        calls.push(args[0]);
        return { ok: true, stdout: args[0] === "diff" ? "docs/overview.md\nREADME.md\n" : "", stderr: "" };
      },
    });
    const result = await command.execute({ root, dryRun });
    assert.equal(result.result, dryRun ? "dry-run" : "ok");
    assert.deepEqual(result.changed, dryRun ? [] : ["docs/overview.md", "README.md"]);
    assert.match(result.artifacts.reviewResult, /PASSED/);
    assert.deepEqual(calls, dryRun ? ["build", "review"] : ["build", "review", "add", "diff", "commit"]);
    assertArtifacts(root);
  });
}

test("sync stops before Git and reports the actual review's invalid generated chapter", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, ".sennel/templates/en/docs/overview.md"), "# Too short\n");
  const command = new RunSyncCommand({ git() { assert.fail("review failure must prevent Git writes"); } });
  await assert.rejects(command.execute({ root }), (error) => {
    assert.match(error.message, /docs review failed/);
    assert.match(error.message, /too short/);
    assert.doesNotMatch(error.message, /RUNTIME_UNPROVEN/);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(root, "docs/overview.md"), "utf8"), "# Too short\n");
});

test("finalize sync builds at resolved main root and preserves real child failure diagnostics", async (t) => {
  const root = fixture(t);
  const ctx = flowContext(root, { worktree: true });
  const worktree = ctx.root;
  process.env.SENNEL_WORK_ROOT = worktree;
  process.env.SENNEL_SOURCE_ROOT = worktree;
  const calls = [];
  let completed = false;
  const command = new RunFinalizeSyncCommand({
    hasCommit: () => completed,
    git(args, options) {
      assert.equal(options.cwd, root);
      calls.push(args[0]);
      return { ok: true, status: 0, stdout: args[0] === "diff" ? "docs/overview.md\n" : "", stderr: "" };
    },
  });
  const result = await command.executeEffect(ctx);
  assert.equal(result.status, "done");
  assert.equal(result.diagnostics[0].phase, "docs-build");
  assert.equal(result.diagnostics[0].exitCode, 0);
  assertArtifacts(root);
  assert.equal(fs.existsSync(path.join(worktree, "docs")), false);
  assert.deepEqual(calls, ["diff", "diff"]);

  fs.writeFileSync(path.join(root, ".sennel/config.json"), JSON.stringify({ ...config, type: "missing-runtime-preset" }));
  completed = true;
  assert.deepEqual(await command.executeEffect(ctx), { status: "done", resumed: true });
  assert.deepEqual(calls, ["diff", "diff"]);
  completed = false;
  await assert.rejects(command.executeEffect(ctx), (error) => {
    assert.equal(error.code, "FINALIZE_SYNC_FAILED");
    const [build, status] = error.data.diagnostics;
    assert.equal(build.phase, "docs-build");
    assert.equal(build.exitCode, 1);
    assert.match(build.stderr, /missing-runtime-preset/);
    assert.doesNotMatch(build.stderr, /RUNTIME_UNPROVEN/);
    assert.equal(status.phase, "git-status-after-failure");
    return true;
  });
  assert.deepEqual(calls, ["diff", "diff", "status"]);
});

for (const finalizing of [false, true]) {
  test(`${finalizing ? "finalize sync" : "sync"} awaits real managed documentation children before returning`, async (t) => {
    const root = fixture(t);
    const ctx = { ...flowContext(root), dryRun: true };
    const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root,
      runId: ctx.flowState.runId, specId: ctx.specId,
      binding: captureFlowProcessExecutionBinding(ctx, { commandId: finalizing ? "finalize-sync" : "sync" }) });
    t.after(async () => { if (!runtime.closed) await runtime.close(); });
    const command = finalizing
      ? new RunFinalizeSyncCommand({ hasCommit: () => false,
        git: () => ({ ok: true, status: 0, stdout: "docs/overview.md\n", stderr: "" }) })
      : new RunSyncCommand({ git() { assert.fail("dry run must not call Git"); } });
    const result = await runtime.enter(() => finalizing ? command.executeEffect(ctx) : command.execute(ctx));
    assert.equal(finalizing ? result.status : result.result, finalizing ? "done" : "dry-run");
    assertArtifacts(root);
    const execution = runtime.inspect().executions.find((entry) => entry.executionId === runtime.executionId);
    assert.equal(execution.calls.length, finalizing ? 1 : 2);
    for (const call of execution.calls) {
      const receipt = new ProcessExecutionStopReceipt(call.receipt);
      assert.equal(receipt.stopEvidence.confirmed, true);
      assert.equal(receipt.checkoutIdentity.executionRoot, root);
      assert.equal(receipt.binding.toJSON().runId, ctx.flowState.runId);
      assert.equal(receipt.binding.toJSON().specId, ctx.specId);
      assert.equal(call.outcome.code, 0);
    }
    await runtime.close();
    assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: root }).slot, null);
  });

  test(`${finalizing ? "finalize sync" : "sync"} preserves async process control refusal without Git effects`, async (t) => {
    const root = fixture(t);
    const failure = new ProcessExecutionControlFailure("stop-unconfirmed", "documentation child remains uncontrolled");
    const command = new (finalizing ? RunFinalizeSyncCommand : RunSyncCommand)({
      runCommand: async () => { throw failure; }, hasCommit: () => false,
      git() { assert.fail("control refusal must not continue to Git"); },
    });
    const ctx = finalizing ? flowContext(root) : { root };
    await assert.rejects(finalizing ? command.executeEffect(ctx) : command.execute(ctx), (error) => error === failure);
    assert.equal(fs.existsSync(path.join(root, "docs")), false);
  });
}

test("direct sync creates its own runtime and preserves the preparing Flow while closing both real children", async (t) => {
  const root = fixture(t);
  const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const runId = "direct-docs-sync";
  flowManager.createPreparingFlow(runId, { request: "Build project documentation." });
  const before = flowManager.loadPreparingFlow(runId);
  assert.equal(ProcessExecutionRuntime.current(), null);
  const owner = await ProcessExecutionRuntime.acquire({ mainRoot: root, runId });
  try {
    await assert.rejects(new RunSyncCommand().execute({ root, mainRoot: root, executionRoot: root,
      flowManager, preparingFlowState: before, dryRun: true }), { code: "PROCESS_EXECUTION_BUSY" });
    assert.equal(fs.existsSync(path.join(root, "docs")), false);
    assert.deepEqual(flowManager.loadPreparingFlow(runId), before);
  } finally { await owner.close(); }
  const result = await new RunSyncCommand().execute({ root, mainRoot: root, executionRoot: root,
    flowManager, preparingFlowState: before, dryRun: true });
  assert.equal(result.result, "dry-run");
  assertArtifacts(root);
  assert.equal(ProcessExecutionRuntime.current(), null);
  assert.deepEqual(flowManager.loadPreparingFlow(runId), before);
  const registry = ProcessExecutionRuntime.inspect({ mainRoot: root });
  assert.equal(registry.slot, null);
  assert.equal(registry.executions.length, 2);
  const execution = registry.executions.at(-1);
  assert.equal(execution.status, "closed");
  assert.equal(execution.calls.length, 2);
  for (const call of execution.calls) {
    const receipt = new ProcessExecutionStopReceipt(call.receipt);
    assert.equal(receipt.stopEvidence.confirmed, true);
    assert.equal(receipt.binding.toJSON().runId, runId);
  }
});
