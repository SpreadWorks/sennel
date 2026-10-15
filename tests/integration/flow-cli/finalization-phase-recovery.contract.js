import { offlineExternalGitHubScript } from "../../support/fakes/github.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FinalizationPhaseScenario } from "../../support/finalization-phase-scenario.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import RunFinalizeMergeCommand from "../../../src/flow/lib/run-finalize-merge.js";
import RunFinalizeCommitCommand from "../../../src/flow/lib/run-finalize-commit.js";
import { RuntimeLogBlockWriter } from "../../../src/lib/runtime-log.js";
import { POINTER_REL_PATH } from "../../../src/flow/lib/run-report-show.js";
import { FinalizationWorktreeScenario } from "../../support/infrastructure/finalization-worktree-scenario.js";
import { runGit } from "../../../src/lib/git-helpers.js";

function externalGitHubFixture(flow, controls) {
  const script = path.join(flow.root, ".tmp", "github-provider.mjs");
  const control = path.join(flow.root, ".tmp", "github-control.json");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, offlineExternalGitHubScript({ controlPath: control }));
  fs.writeFileSync(control, JSON.stringify(controls));
  flow.options.config.github = { provider: "offline", repository: { host: "github.com", name: "fixture/repository" },
    providers: { offline: { command: process.execPath, args: [script], maxAttempts: 1 } } };
  return { control, remote: () => JSON.parse(fs.readFileSync(`${script}.remote.json`, "utf8")) };
}

export function registerFinalizationRecoveryContracts(scenario) {
  test("F02 manual approval authorizes only the current durable finalization action", async (t) => {
    const flow = scenario(t);
    const policy = await flow.invokeRegistered("set", "auto", {}, ["off"]);
    assert.notEqual(policy.ok, false, JSON.stringify(policy));
    flow.reload();
    assert.equal(flow.state().policy.autoApprove, false);
    const target = { expectRunId: flow.state().runId };
    const head = flow.git(["rev-parse", "HEAD"]);
    const waiting = await flow.runRegistered("dispatch", target);
    assert.notEqual(waiting.ok, false, JSON.stringify(waiting));
    assert.equal(waiting.dispatch.boundary, "approval_required", JSON.stringify(waiting));
    assert.ok(waiting.dispatch.approvalToken);
    assert.equal(flow.git(["rev-parse", "HEAD"]), head);
    flow.reload();
    assert.equal(flow.outbox("finalize-commit"), null);
    const documentationPath = path.join(flow.root, "docs", "overview.md");
    const originalDocumentation = fs.readFileSync(documentationPath);
    // Flow control records (including notes) are deliberately excluded from
    // approval's repository fingerprint. A tracked documentation edit changes
    // real approval input while remaining outside the implementation commit.
    flow.write("docs/overview.md", "User revised documentation before finalization approval.\n");
    flow.reload();
    const before = flow.snapshot();
    const stale = await flow.runRegistered("dispatch", { ...target, approve: waiting.dispatch.approvalToken });
    assert.equal(stale.ok, false);
    assert.ok(stale.errors.some((entry) => entry.code === "FLOW_DISPATCH_APPROVAL_STALE"), JSON.stringify(stale));
    assert.deepEqual(flow.reload().snapshot(), before);
    assert.equal(flow.git(["rev-parse", "HEAD"]), head);
    const fresh = await flow.runRegistered("dispatch", target);
    assert.notEqual(fresh.ok, false, JSON.stringify(fresh));
    assert.equal(fresh.dispatch.boundary, "approval_required");
    assert.notEqual(fresh.dispatch.approvalToken, waiting.dispatch.approvalToken);
    // The changed documentation also invalidates the saved regression's
    // repository binding. Undo this owned edit before accepting execution;
    // approval must match both the current action and genuine tested input.
    fs.writeFileSync(documentationPath, originalDocumentation);
    flow.reload();
    const restored = await flow.runRegistered("dispatch", target);
    assert.notEqual(restored.ok, false, JSON.stringify(restored));
    assert.equal(restored.dispatch.boundary, "approval_required");
    assert.equal(restored.dispatch.approvalToken, waiting.dispatch.approvalToken,
      "restored input has the original exact approval identity; no token generation is fabricated");
    flow.assertCommitEvidence();
    const completed = await flow.runRegistered("dispatch", { ...target, approve: restored.dispatch.approvalToken });
    assert.notEqual(completed.ok, false, JSON.stringify(completed));
    flow.reload();
    assert.equal(completed.dispatch.boundary, "completed", JSON.stringify({
      dispatch: completed.dispatch, directive: completed.nextAction?.directive,
      commitOutbox: flow.outbox("finalize-commit")?.toJSON() ?? null,
      attempt: flow.state().attempt?.toJSON() ?? null,
    }));
    assert.equal(flow.state().lifecycle.state, "finalized");
    assert.equal(flow.outbox("finalize-commit").status, "done");
    flow.assertResults(["finalize-commit"], { expectedKinds: { "finalize-commit": "finalize-commit-created" } });
  });

  for (const leaf of ["finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup"]) {
    test(`F06 ${leaf} publishes its exact Execution Result before effects`, async (t) => {
      let ctx = null;
      t.after(() => ctx?.finalizeSyncOperation?.release());
      const flow = scenario(t);
      await flow.advanceTo(leaf);
      ctx = flow.context();
      await FLOW_COMMANDS.run[leaf].pre(ctx);
      flow.reload();
      assert.equal(flow.state().attempt.nodeId, leaf);
      assert.equal(flow.outbox(leaf).status, "pending");
      assert.equal(flow.docsCalls.length, leaf === "finalize-cleanup" ? 1 : 0);
      flow.assertResults([leaf], { terminal: false });
      const receipt = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: leaf });
      assert.equal(receipt.result.kind, `${leaf}-execution-required`);
      assert.equal(receipt.receipt.settlementKind, "execution");
      assert.equal(receipt.receipt.connector, null);
    });
  }

  test("F03 direct-mode producer selects merge policy skip and saves its actual route without docs side effects", async (t) => {
    const flow = FinalizationPhaseScenario.create(t, { execution: { mode: "direct", baseBranch: "main", featureBranch: null } });
    await flow.advanceTo("finalize-merge");
    flow.reload();
    const head = flow.git(["rev-parse", "HEAD"]);
    const report = flow.report("finalize-merge");
    const result = await flow.runRegistered("finalize-merge");
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.equal(result.strategy, "skip");
    flow.reload();
    assert.equal(flow.git(["rev-parse", "HEAD"]), head);
    assert.equal(flow.current(), "finalize-sync");
    assert.equal(flow.docsCalls.length, 0);
    assert.equal(flow.report("finalize-sync").descriptor.activityId, report.descriptor.activityId);
    flow.assertResults(["finalize-merge"], { expectedKinds: { "finalize-merge": "finalize-merge-policy-skipped" } });
  });

  test("F03 actual local push and keyed PR creation survive response loss and settle PR Await with zero sync/cleanup", async (t) => {
    const flow = scenario(t, { config: { lang: "en", type: "base", commands: { gh: "enable" } } });
    const { control, remote } = externalGitHubFixture(flow, { loseResponse: true });
    flow.createLocalRemote();
    await flow.advanceTo("finalize-merge");
    const identity = flow.identity("finalize-merge");
    const submittedHead = flow.git(["rev-parse", flow.state().execution.featureBranch]);
    const failed = await flow.runRegistered("finalize-merge");
    assert.equal(failed.ok, false);
    assert.ok(failed.errors.some((entry) => entry.code === "GITHUB_WRITE_OUTCOME_UNKNOWN"), JSON.stringify(failed));
    flow.reload();
    assert.equal(remote().prs.length, 1);
    assert.equal(remote().calls.find((request) => request.operation === "pull-request.create").payload.expectedHeadOid, submittedHead);
    assert.equal(remote().prs[0].headOid, submittedHead);
    assert.equal(flow.git(["rev-parse", flow.state().execution.featureBranch]), submittedHead,
      "PR failure must preserve the head already submitted to GitHub");
    assert.equal(flow.outbox("finalize-merge").status, "failed");
    const recovered = await flow.runRegistered("recover-finalization");
    assert.equal(recovered.operation, "exact-outbox-recovery", JSON.stringify(recovered));
    flow.reload();
    fs.writeFileSync(control, JSON.stringify({ loseResponse: false }));
    const replay = await flow.runRegistered("finalize-merge");
    assert.equal(replay.strategy, "pr", JSON.stringify(replay));
    assert.equal(replay.resumed, true);
    assert.equal(replay.prNumber, 717);
    assert.deepEqual(replay.repository, { host: "github.com", name: "fixture/repository" });
    assert.equal(replay.headOid, flow.git(["rev-parse", flow.state().execution.featureBranch]));
    flow.reload();
    assert.equal(remote().prs.length, 1);
    assert.equal(flow.outbox("finalize-merge").idempotencyKey, identity.idempotencyKey);
    assert.equal(flow.outbox("finalize-merge").status, "done");
    const action = await flow.next();
    // PR Await is external merge waiting, not necessarily a user-question UI.
    // Its observable contract is that no post-merge action is authorized.
    const postMergeLeaves = ["finalize-sync", "finalize-cleanup"];
    assert.equal(postMergeLeaves.includes(action.step), false,
      `FINALIZATION_PR_AWAIT_BYPASS: PR Await cannot expose a post-merge step: ${JSON.stringify(action)}`);
    assert.equal(postMergeLeaves.some((stepId) => action.action === `run-${stepId}`
      || action.directive?.nextAction?.includes(`flow run ${stepId}`)), false,
    `FINALIZATION_PR_AWAIT_BYPASS: PR Await cannot authorize sync or teardown: ${JSON.stringify(action)}`);
    const before = flow.snapshot();
    for (const leaf of ["finalize-sync", "finalize-cleanup"]) {
      const denied = await flow.runRegistered(leaf);
      assert.equal(denied.ok, false, `PR Await cannot authorize ${leaf}`);
      assert.deepEqual(flow.reload().snapshot(), before);
    }
    assert.equal(flow.docsCalls.length, 0);
    assert.equal(fs.existsSync(path.join(flow.root, POINTER_REL_PATH)), false);
    assert.equal(flow.git(["branch", "--show-current"]), flow.state().execution.featureBranch);
    flow.assertResults(["finalize-merge"], { expectedKinds: { "finalize-merge": "finalize-merge-pr-opened" } });
    const settled = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-merge", completed: true });
    assert.equal(settled.result.type, "completed");
    assert.equal(settled.receipt.finalization.commandResult.headOid, replay.headOid);
    assert.equal(settled.receipt.finalization.commandResult.prNumber, 717);
    assert.deepEqual(settled.receipt.finalization.commandResult.repository, replay.repository);
    assert.equal(settled.receipt.settlementKind, "await");
    assert.equal(settled.receipt.connector, null);
    assert.equal(settled.receipt.targetStepId, null);
  });

  test("F03 PR provider preflight refusal preserves Git refs without submitting a remote write", async (t) => {
    const flow = scenario(t, { config: { lang: "en", type: "base", commands: { gh: "enable" } } });
    const { remote } = externalGitHubFixture(flow, { authenticationFailure: true });
    await flow.advanceTo("finalize-merge");
    const refs = flow.git(["show-ref"]);
    const failed = await flow.runRegistered("finalize-merge");
    assert.equal(failed.ok, false);
    assert.ok(failed.errors.some((entry) => entry.code === "GITHUB_AUTHENTICATION"), JSON.stringify(failed));
    flow.reload();
    assert.equal(flow.git(["show-ref"]), refs);
    assert.deepEqual(remote().prs, []);
    assert.equal(remote().calls.some((request) => request.operation === "pull-request.create"), false);
    assert.equal(flow.outbox("finalize-merge"), null);
    assert.equal(flow.docsCalls.length, 0);
  });

  test("F03 a foreign PR on the same branch cannot authenticate the current outbox effect", async (t) => {
    const flow = scenario(t, { config: { lang: "en", type: "base", commands: { gh: "enable" } },
      ghProcess(args, _options, active) {
        const repository = { full_name: "fixture/repository", html_url: "https://github.com/fixture/repository" };
        if (args[0] === "--version" || args[0] === "auth") return { status: 0, stdout: "gh fixture", stderr: "" };
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ nameWithOwner: repository.full_name, url: repository.html_url }), stderr: "" };
        assert.equal(args[0], "api");
        if (args[1] === "repos/fixture/repository") return { status: 0, stdout: JSON.stringify(repository), stderr: "" };
        assert.equal(active.outbox("finalize-merge").status, "pending");
        const state = active.state();
        const foreign = { number: 716, body: "<!-- sennel:another-flow-outbox-key -->", title: "Foreign operation", state: "open",
          html_url: "https://github.com/fixture/repository/pull/716", merged_at: null,
          base: { repo: repository, ref: state.execution.baseBranch },
          head: { repo: repository, ref: state.execution.featureBranch, sha: active.git(["rev-parse", state.execution.featureBranch]) } };
        assert.equal(args[1].startsWith("repos/fixture/repository/pulls?"), true);
        return { status: 0, stdout: JSON.stringify([[foreign]]), stderr: "" };
      } });
    flow.createLocalRemote();
    await flow.advanceTo("finalize-merge");
    const base = flow.git(["rev-parse", "main"]);
    const failed = await flow.runRegistered("finalize-merge");
    assert.equal(failed.ok, false, "a PR number is not proof of the exact outbox marker");
    assert.ok(failed.errors.some((entry) => entry.code === "GITHUB_CONFLICT"), JSON.stringify(failed));
    flow.reload();
    assert.notEqual(flow.outbox("finalize-merge").status, "done");
    assert.notEqual(flow.state().findNode("finalize-merge").status, "done");
    assert.equal(flow.git(["rev-parse", "main"]), base);
    assert.equal(flow.docsCalls.length, 0);
    assert.equal(flow.ghCalls.some((args) => args[0] === "api" && args.includes("POST")), false);
  });

  for (const foreign of [false, true]) {
    test(`F05 ${foreign ? "foreign runtime identity refuses skip" : "actual interrupted docs runtime remains read-only until lock-authorized skip"}`, async (t) => {
      let ctx = null;
      t.after(() => ctx?.finalizeSyncOperation?.release());
      const flow = scenario(t);
      await flow.advanceTo("finalize-sync");
      ctx = flow.context();
      const writer = new RuntimeLogBlockWriter({ root: flow.root, flowId: flow.specId,
        runId: foreign ? "another-run" : flow.state().runId, command: "flow run finalize-sync" });
      writer.capture("stderr", "external docs process interrupted before return\n");
      await FLOW_COMMANDS.run["finalize-sync"].pre(ctx);
      const identity = flow.identity("finalize-sync");
      flow.reload();
      const before = flow.snapshot();
      const log = fs.readFileSync(writer.file.filePath);
      const busy = await flow.runRegistered("recover-finalization");
      assert.equal(busy.ok, false);
      assert.deepEqual(flow.reload().snapshot(), before);
      assert.deepEqual(fs.readFileSync(writer.file.filePath), log);
      ctx.finalizeSyncOperation.release();
      const advice = await flow.next();
      assert.deepEqual(flow.reload().snapshot(), before, "next-action cannot turn interrupted evidence into a skip");
      assert.deepEqual(fs.readFileSync(writer.file.filePath), log);
      if (foreign) {
        assert.notEqual(advice.directive.actionId, "RECOVER_INTERRUPTED_FINALIZE_SYNC");
        const denied = await flow.runRegistered("recover-finalization");
        assert.equal(denied.ok, false);
        assert.deepEqual(flow.reload().snapshot(), before);
        assert.equal(flow.outbox("finalize-sync").status, "pending");
      } else {
        assert.equal(advice.directive.actionId, "RECOVER_INTERRUPTED_FINALIZE_SYNC");
        const recovered = await flow.runRegistered("recover-finalization");
        assert.equal(recovered.operation, "interrupted-sync-settlement", JSON.stringify(recovered));
        flow.reload();
        assert.equal(flow.current(), "finalize-cleanup");
        assert.equal(flow.state().findNode("finalize-sync").status, "skipped");
        assert.equal(flow.outbox("finalize-sync").status, "failed");
        assert.equal(flow.outbox("finalize-sync").idempotencyKey, identity.idempotencyKey);
        const issue = flow.manager.readArtifact({ specId: flow.specId, logicalKey: "issue.log", consumerNodeId: "finalize-cleanup" });
        const entry = JSON.parse(issue.bytes).entries.at(-1);
        assert.equal(entry.trigger, "interrupted");
        assert.ok(JSON.stringify(entry).includes(String(writer.metadata.sequence)));
        const settled = flow.snapshot();
        const repeated = await flow.runRegistered("recover-finalization");
        assert.equal(repeated.ok, false);
        assert.deepEqual(flow.reload().snapshot(), settled);
        flow.assertResults(["finalize-sync"], { expectedKinds: { "finalize-sync": "finalize-sync-skipped-with-warning" } });
      }
      assert.equal(flow.docsCalls.length, 0, "runtime settlement cannot fabricate a successful docs build");
    });
  }

  test("F04 feature branch drift refuses before claiming effects or selecting a replacement source", async (t) => {
    const flow = scenario(t);
    await flow.advanceTo("finalize-merge");
    flow.git(["switch", "-c", "independent-operation"]);
    const before = flow.snapshot();
    const git = flow.gitSnapshot();
    const failed = await flow.runRegistered("finalize-merge");
    assert.equal(failed.ok, false);
    assert.ok(failed.errors.some((entry) => /branch|HEAD|checkout/i.test(entry.messages.join("\n"))));
    assert.deepEqual(flow.reload().snapshot(), before);
    assert.deepEqual(flow.gitSnapshot(), git);
    assert.equal(flow.outbox("finalize-merge"), null);
    assert.equal(flow.docsCalls.length, 0);
  });

  test("F05 actual Git diff failure retains successful build and failed diff diagnostics in the same warning provenance", async (t) => {
    const flow = scenario(t);
    await flow.advanceTo("finalize-sync");
    const indexPath = path.join(flow.root, flow.git(["rev-parse", "--git-path", "index"]));
    const index = fs.readFileSync(indexPath);
    t.after(() => { if (fs.existsSync(path.dirname(indexPath))) fs.writeFileSync(indexPath, index); });
    fs.writeFileSync(indexPath, "invalid external Git index\n");
    let failed;
    try { failed = await flow.runRegistered("finalize-sync"); }
    finally { fs.writeFileSync(indexPath, index); }
    assert.equal(failed.ok, false);
    assert.ok(failed.errors.some((entry) => entry.code === "FINALIZE_SYNC_FAILED"));
    flow.reload();
    const outbox = flow.outbox("finalize-sync");
    assert.equal(outbox.status, "failed");
    assert.equal(outbox.latestFailure.code, "FINALIZE_SYNC_FAILED");
    const diagnostic = flow.syncFailureDiagnostics();
    assert.ok(diagnostic.length >= 2, "FINALIZATION_SYNC_DIAGNOSTICS_INCOMPLETE: retain the successful build and failed Git diff observations");
    assert.equal(diagnostic[0].phase, "docs-build");
    assert.equal(diagnostic[0].exitCode, 0);
    assert.equal(diagnostic[1].phase, "git-diff-stat");
    assert.notEqual(diagnostic[1].exitCode, 0);
    assert.ok(diagnostic[1].stderr.includes("index"));
    assert.equal(flow.docsCalls.length, 1);
    assert.equal(flow.current(), "finalize-cleanup");
    flow.assertResults(["finalize-sync"], { expectedKinds: { "finalize-sync": "finalize-sync-skipped-with-warning" } });
  });

  for (const phase of ["before-current-flow-state-temp-write", "activity-appended"]) {
    test(`F06 actual implementation effect survives ${phase} settlement discontinuity without duplicate commit`, async (t) => {
      const flow = scenario(t);
      let ctx = flow.context();
      await FLOW_COMMANDS.run["finalize-commit"].pre(ctx);
      const effect = await new RunFinalizeCommitCommand().execute(ctx);
      assert.equal(effect.status, "done");
      const before = flow.snapshot();
      const head = flow.git(["rev-parse", "HEAD"]);
      let injected = false;
      const fault = new Error(`injected canonical ${phase}`);
      flow.reload({ versionStoreFaultInjector({ phase: boundary }) {
        if (!injected && boundary === phase) { injected = true; throw fault; }
      } });
      ctx = flow.context();
      let failure;
      try { await FLOW_COMMANDS.run["finalize-commit"].post(ctx, effect); }
      catch (error) { failure = error; }
      assert.equal(injected, true, "fault reaches the real canonical publication boundary");
      flow.reload();
      assert.equal(flow.git(["rev-parse", "HEAD"]), head, "canonical write failure cannot pretend Git was rolled back");
      if (phase === "before-current-flow-state-temp-write") {
        assert.equal(failure, fault);
        assert.deepEqual(flow.snapshot(), before);
      } else if (failure === undefined) {
        const receipt = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-commit", completed: true });
        assert.ok(receipt?.receipt, "success after a lost journal acknowledgement requires a real authenticated durable settlement");
        assert.equal(flow.current(), "finalize-merge");
      } else {
        assert.equal(failure, fault);
      }
      if (flow.current() === "finalize-commit") {
        const replay = await flow.runRegistered("finalize-commit");
        assert.equal(replay.resumed, true, JSON.stringify(replay));
        flow.reload();
      }
      assert.equal(flow.current(), "finalize-merge");
      assert.equal(flow.git(["rev-parse", "HEAD"]), head);
      assert.equal(flow.outbox("finalize-commit").status, "done");
      flow.assertResults(["finalize-commit"], { expectedKinds: { "finalize-commit": "finalize-commit-created" } });
    });
  }

  test("F06 successful sync lost acknowledgement replays only the actual durable effect receipt", async (t) => {
    const flow = scenario(t);
    await flow.advanceTo("finalize-sync");
    const identity = flow.identity("finalize-sync");
    const lost = new Error("caller lost the successful docs sync acknowledgement");
    await assert.rejects(async () => {
      const result = await flow.runRegistered("finalize-sync");
      assert.equal(result.status, "done", JSON.stringify(result));
      throw lost;
    }, (error) => error === lost);
    flow.reload();
    assert.equal(flow.outbox("finalize-sync").status, "done");
    assert.equal(flow.outbox("finalize-sync").idempotencyKey, identity.idempotencyKey);
    assert.equal(flow.docsCalls.length, 1);
    const actualDocs = fs.readFileSync(path.join(flow.root, "docs", "overview.md"));
    assert.equal(actualDocs.toString("utf8"), "Generated from the merged implementation.\n");
    const head = flow.git(["rev-parse", "HEAD"]);
    flow.assertResults(["finalize-sync"], { expectedKinds: { "finalize-sync": "finalize-sync-built" } });
    const receipt = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-sync", completed: true });
    assert.ok(receipt?.receipt, "successful docs synchronization must retain its exact durable settlement receipt");
    assert.equal(receipt.result.kind, "finalize-sync-built");
    const before = flow.snapshot();
    const outbox = flow.outbox("finalize-sync").toJSON();
    assert.equal(outbox.result.status, "done");
    assert.equal(outbox.result.diffSummary, "docs/overview.md");
    // Recover the acknowledgement from actual persisted success data. No
    // previous command return, owner or manager crosses this reload boundary.
    await FLOW_COMMANDS.run["finalize-sync"].post(flow.context(), flow.outbox("finalize-sync").result);
    flow.reload();
    assert.equal(flow.docsCalls.length, 1, "acknowledgement replay cannot run docs generation twice");
    assert.equal(flow.git(["rev-parse", "HEAD"]), head);
    assert.deepEqual(fs.readFileSync(path.join(flow.root, "docs", "overview.md")), actualDocs);
    assert.deepEqual(flow.snapshot(), before);
    assert.deepEqual(flow.outbox("finalize-sync").toJSON(), outbox);
    assert.equal(flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-sync", completed: true }).receipt.id, receipt.receipt.id);
    const refused = await flow.runRegistered("finalize-sync");
    assert.equal(refused.ok, false, "ordinary sync is unselected once its saved receipt exposes cleanup");
    assert.deepEqual(flow.reload().snapshot(), before);
    assert.equal(flow.docsCalls.length, 1);
    assert.equal(flow.git(["rev-parse", "HEAD"]), head);
    assert.deepEqual(fs.readFileSync(path.join(flow.root, "docs", "overview.md")), actualDocs);
    assert.deepEqual(flow.outbox("finalize-sync").toJSON(), outbox);
    flow.assertResults(["finalize-sync"], { expectedKinds: { "finalize-sync": "finalize-sync-built" } });
  });

  test("F04 genuine squash conflict stays failed until isolated readiness authorizes exact recovery and resets downstream skips", async (t) => {
    const flow = FinalizationPhaseScenario.create(t, { sourceWorker(request, active) {
      if (request.stepId === "implement") active.write("conflict.txt", "accepted feature behavior\n");
    } });
    await flow.advanceTo("finalize-merge");
    const feature = flow.state().execution.featureBranch;
    const baseWorktree = path.join(flow.root, ".tmp", "base-input");
    flow.git(["worktree", "add", "--detach", baseWorktree, "main"]);
    t.after(() => {
      if (fs.existsSync(baseWorktree)) flow.git(["worktree", "remove", "--force", baseWorktree]);
    });
    fs.writeFileSync(path.join(baseWorktree, "conflict.txt"), "independent base behavior\n");
    flow.git(["-C", baseWorktree, "add", "conflict.txt"]);
    flow.git(["-C", baseWorktree, "commit", "-m", "feat: independent base change"]);
    const beforeBase = flow.git(["rev-parse", "main"]);
    flow.git(["update-ref", "refs/heads/main", flow.git(["-C", baseWorktree, "rev-parse", "HEAD"]), beforeBase]);
    const base = flow.git(["rev-parse", "main"]);
    const mergeAttempt = flow.state().attempt;
    const failed = await flow.runRegistered("finalize-merge");
    assert.equal(failed.ok, false);
    assert.ok(failed.errors.some((entry) => /conflict/i.test(entry.messages.join("\n"))));
    flow.reload();
    assert.equal(flow.git(["rev-parse", "main"]), base);
    assert.equal(flow.git(["branch", "--show-current"]), feature);
    // The preserved finalize lifecycle retains the active merge Attempt on an
    // external conflict; its failed outbox owns the operational failure.
    assert.equal(flow.state().findNode("finalize-merge").status, "in_progress");
    assert.equal(flow.state().attempt.id, mergeAttempt.id);
    assert.equal(flow.state().attempt.sequence, mergeAttempt.sequence);
    assert.equal(flow.state().attempt.nodeId, "finalize-merge");
    for (const leaf of ["finalize-sync", "finalize-cleanup"]) assert.equal(flow.state().findNode(leaf).status, "skipped");
    const identity = flow.identity("finalize-merge");
    assert.equal(flow.outbox("finalize-merge").status, "failed");
    const failure = flow.outbox("finalize-merge").latestFailure;
    const before = flow.snapshot();
    const denied = await flow.runRegistered("recover-finalization");
    assert.equal(denied.ok, false, "unrepaired conflict cannot consume the exact recovery allowance");
    assert.deepEqual(flow.reload().snapshot(), before);
    const failedGit = flow.gitSnapshot();
    for (const leaf of ["finalize-merge", "finalize-sync", "finalize-cleanup"]) {
      const unselected = await flow.runRegistered(leaf);
      assert.equal(unselected.ok, false, `failed merge cannot authorize ${leaf} before exact recovery`);
      assert.deepEqual(flow.reload().snapshot(), before,
        "unselected retry cannot reset skips, append Activity or consume the recovery allowance");
      assert.deepEqual(flow.gitSnapshot(), failedGit);
    }
    assert.equal(flow.docsCalls.length, 0);
    fs.writeFileSync(path.join(baseWorktree, "conflict.txt"), "accepted feature behavior\n");
    flow.git(["-C", baseWorktree, "add", "conflict.txt"]);
    flow.git(["-C", baseWorktree, "commit", "-m", "fix: explicitly resolve finalization conflict"]);
    flow.git(["update-ref", "refs/heads/main", flow.git(["-C", baseWorktree, "rev-parse", "HEAD"]), base]);
    flow.git(["worktree", "remove", baseWorktree]);
    const recovered = await flow.runRegistered("recover-finalization");
    assert.equal(recovered.operation, "exact-outbox-recovery", JSON.stringify(recovered));
    flow.reload();
    assert.equal(flow.outbox("finalize-merge").idempotencyKey, identity.idempotencyKey);
    assert.equal(flow.outbox("finalize-merge").status, "pending");
    assert.deepEqual(flow.outbox("finalize-merge").latestFailure, failure, "reopening retains the actual failure provenance");
    const retry = await flow.runRegistered("finalize-merge");
    assert.equal(retry.status, "done", JSON.stringify(retry));
    flow.reload();
    assert.equal(flow.current(), "finalize-sync");
    assert.equal(flow.state().findNode("finalize-sync").status, "pending");
    assert.equal(flow.state().findNode("finalize-cleanup").status, "pending");
    assert.equal(flow.docsCalls.length, 0);
    flow.assertResults(["finalize-merge"], { expectedKinds: { "finalize-merge": "finalize-merge-squashed" } });
  });

  test("F04 real worktree pre-sync conflict preserves the abort baseline and requires the exact saved remote base before recovery", async (t) => {
    const flow = await FinalizationWorktreeScenario.prepare(t, { sourceWorker(request, active) {
      if (request.stepId === "implement") active.write("pre-sync-conflict.txt", "accepted feature behavior\n");
    } });
    await flow.advanceTo("finalize-merge");
    const featureBefore = flow.git(["rev-parse", "HEAD"]);
    const baseFile = path.join(flow.mainRoot, "pre-sync-conflict.txt");
    fs.writeFileSync(baseFile, "independent remote base behavior\n");
    flow.git(["-C", flow.mainRoot, "add", "pre-sync-conflict.txt"]);
    flow.git(["-C", flow.mainRoot, "commit", "-m", "feat: remote base divergence"]);
    flow.git(["-C", flow.mainRoot, "push", "origin", "main"]);
    const expectedBase = flow.git(["-C", flow.mainRoot, "rev-parse", "main"]);
    const failed = await flow.runRegistered("finalize-merge");
    assert.equal(failed.ok, false);
    assert.ok(failed.errors.some((entry) => entry.code === "MERGE_PRE_SYNC_CONFLICT"));
    flow.reload();
    assert.equal(flow.git(["rev-parse", "HEAD"]), featureBefore, "production rebase abort restores the feature baseline");
    assert.equal(flow.git(["diff", "--name-only", "--diff-filter=U"]), "");
    const failure = flow.outbox("finalize-merge").latestFailure;
    assert.equal(failure.code, "MERGE_PRE_SYNC_CONFLICT");
    assert.equal(failure.recovery.baseRef, "origin/main");
    assert.equal(failure.recovery.baseHead, expectedBase);
    const before = flow.snapshot();
    const advice = await flow.next();
    assert.equal(advice.directive.actionId, "REPAIR_FINALIZE_MERGE_REBASE");
    const rejected = await flow.runRegistered("recover-finalization");
    assert.equal(rejected.ok, false);
    assert.deepEqual(flow.reload().snapshot(), before);
    // Resolve through real Git's normal rebase protocol; never rewrite the
    // saved failure or recovery base to make the consumer accept the retry.
    const rebase = runGit(["rebase", "origin/main"], { cwd: flow.worktreePath });
    assert.equal(rebase.ok, false);
    assert.ok(flow.git(["diff", "--name-only", "--diff-filter=U"]).includes("pre-sync-conflict.txt"));
    fs.writeFileSync(path.join(flow.worktreePath, "pre-sync-conflict.txt"), "accepted feature behavior\n");
    flow.git(["add", "pre-sync-conflict.txt"]);
    flow.git(["-c", "core.editor=true", "rebase", "--continue"]);
    assert.equal(flow.git(["merge-base", "--is-ancestor", expectedBase, "HEAD"]), "");
    flow.acquireMainAuthority();
    flow.reload();
    const recovered = await flow.runRegistered("recover-finalization");
    assert.equal(recovered.operation, "exact-outbox-recovery", JSON.stringify(recovered));
    flow.reload();
    assert.equal(flow.outbox("finalize-merge").status, "pending");
    assert.equal(flow.outbox("finalize-merge").latestFailure.recovery.baseHead, expectedBase);
    const merged = await flow.runRegistered("finalize-merge");
    assert.equal(merged.status, "done", JSON.stringify(merged));
    flow.reload();
    assert.equal(flow.current(), "finalize-sync");
    assert.equal(flow.state().findNode("finalize-sync").status, "pending");
    assert.equal(flow.state().findNode("finalize-cleanup").status, "pending");
    assert.equal(flow.docsCalls.length, 0);
    flow.assertResults(["finalize-merge"], { expectedKinds: { "finalize-merge": "finalize-merge-squashed" } });
  });
}
