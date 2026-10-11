import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, mock, test } from "node:test";
import { FinalizationPhaseScenario, finalizationLeaves } from "../../support/finalization-phase-scenario.js";
import RunReportShowCommand, { CanonicalLatestReport, POINTER_REL_PATH } from "../../../src/flow/lib/run-report-show.js";
import { dispatchContainer } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import RunFinalizeCommitCommand from "../../../src/flow/lib/run-finalize-commit.js";
import RunFinalizeMergeCommand from "../../../src/flow/lib/run-finalize-merge.js";
import { outboxCommitMarker } from "../../../src/flow/lib/run-finalize.js";
import { RepositoryFlowOperationLock } from "../../../src/lib/repository-maintenance-lock.js";
import { FinalizeCommitPathSet } from "../../../src/flow/lib/finalize-commit-paths.js";
import { registerFinalizationRecoveryContracts } from "./finalization-phase-recovery.contract.js";
import { registerFinalizationCleanupContracts } from "./finalization-phase-cleanup.contract.js";
import { registerFinalizationWorktreeContracts } from "./finalization-phase-worktree.contract.js";

describe("Finalization phase: genuine Report / canonical reload / external effect / consumer", { concurrency: false }, () => {
  let seed;
  let regressionSeed;
  const cleanups = [];
  before(async () => {
    const scope = { mock, after(fn) { cleanups.push(fn); } };
    regressionSeed = await FinalizationPhaseScenario.seed(scope, { frontier: "final-regression" });
    seed = await FinalizationPhaseScenario.seed(scope, { seedRoot: regressionSeed.root,
      seedSpecId: regressionSeed.specId, frontier: "finalize-commit" });
  });
  after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
  const scenario = (t, options) => FinalizationPhaseScenario.fromSeed(t, seed, options);
  const beforeRegression = (t, options) => FinalizationPhaseScenario.fromSeed(t, regressionSeed, options);
  registerFinalizationRecoveryContracts(scenario);
  registerFinalizationCleanupContracts(scenario);
  registerFinalizationWorktreeContracts();

  test("F01 real commit, squash, main docs and teardown preserve the produced report through last-finalized consumers", async (t) => {
    const flow = scenario(t);
    const source = flow.report();
    const producer = flow.manager.activityLedger(flow.specId).find((entry) => entry.id === source.descriptor.activityId);
    assert.equal(producer.nodeId, "report");
    assert.equal(producer.result.stepResult.kind, "report-generated");
    assert.ok(producer.result.draftSettlementReceipt.id);
    const reportBefore = Buffer.from(source.bytes);
    for (const leaf of finalizationLeaves) {
      await flow.advanceTo(leaf);
      assert.equal(flow.current(), leaf);
      const identity = flow.identity(leaf);
      const result = await flow.runRegistered(leaf);
      assert.notEqual(result.ok, false, JSON.stringify(result));
      flow.reload();
      const outbox = flow.outbox(leaf);
      assert.equal(outbox.status, "done");
      assert.equal(outbox.idempotencyKey, identity.idempotencyKey);
      if (leaf === "finalize-merge") {
        assert.equal(flow.git(["branch", "--show-current"]), "main");
        assert.equal(flow.docsCalls.length, 0, "merge cannot auto-start docs synchronization");
      }
    }
    assert.equal(flow.state().lifecycle.state, "finalized");
    assert.deepEqual(flow.manager.loadActiveFlows(), []);
    assert.equal(fs.readFileSync(path.join(flow.root, POINTER_REL_PATH), "utf8").trim(), flow.specId);
    const latest = CanonicalLatestReport.read({ mainRoot: flow.root, flowManager: flow.manager, specRoot: "specs" });
    assert.equal(latest.specId, flow.specId);
    assert.equal(latest.text(), source.document.text);
    assert.deepEqual(flow.report("finalize-cleanup").bytes, reportBefore);
    assert.equal((await flow.next()).directive.kind, "completed");
    const status = await flow.invokeRegistered("get", "status");
    assert.equal(status.active, false);
    assert.equal(status.specId, flow.specId);
    assert.equal(status.completion.terminal, true);
    assert.equal(status.completion.success, true);
    const show = new RunReportShowCommand();
    show.container = dispatchContainer({ root: flow.root, flowManager: flow.manager, agent: flow.agent });
    show.container.register("flowSpecRoot", "specs");
    let output = "";
    const stdout = t.mock.method(process.stdout, "write", (chunk) => { output += chunk; return true; });
    try { await show.execute(); } finally { stdout.mock.restore(); }
    assert.equal(output, source.document.text);
    const paths = flow.git(["show", "--pretty=format:", "--name-only", "HEAD"]).split("\n").filter(Boolean);
    assert.ok(paths.some((name) => name.startsWith(`specs/${flow.specId}/001/`)));
    const completionPaths = new FinalizeCommitPathSet({ repositoryRoot: flow.root, specRoot: "specs", specId: flow.specId });
    assert.equal(paths.every((name) => name.startsWith(`specs/${flow.specId}/001/`)
      || completionPaths.documentationPaths.some((allowed) => name === allowed || name.startsWith(`${allowed}/`))), true,
    `the actual completion commit must be target-only: ${JSON.stringify(paths)}`);
    assert.equal(paths.some((name) => name.includes("/.runtime/")), false);
    assert.equal(flow.docsCalls.length, 1);
    assert.equal(flow.docsCalls[0].cwd, flow.root);
    flow.assertResults(finalizationLeaves, { expectedKinds: {
      "finalize-commit": "finalize-commit-created", "finalize-merge": "finalize-merge-squashed",
      "finalize-sync": "finalize-sync-built", "finalize-cleanup": "finalize-cleanup-completed",
    } });
  });

  test("F02 implementation commit excludes Spec/docs and preserves unrelated staged index", async (t) => {
    const flow = beforeRegression(t);
    flow.write("docs/overview.md", "pending docs\n");
    flow.write("unrelated.txt", "belongs to a different operation\n");
    flow.git(["add", "unrelated.txt"]);
    const index = flow.git(["diff", "--cached", "--binary", "--", "unrelated.txt"]);
    // Scope inputs exist before the real final-regression and Report producers
    // bind this exact index/tree. No saved evidence is patched after the fact.
    await flow.advanceTo("finalize-commit");
    flow.assertCommitEvidence();
    const committed = await flow.runRegistered("finalize-commit", { message: "feat: finalization scenario" });
    assert.equal(committed.status, "done", JSON.stringify(committed));
    flow.reload();
    const paths = flow.git(["show", "--pretty=format:", "--name-only", "HEAD"]).split("\n").filter(Boolean);
    assert.ok(paths.includes("src/implementation.js"));
    assert.equal(paths.some((name) => name.startsWith("specs/") || name.startsWith("docs/")), false);
    assert.equal(paths.includes("unrelated.txt"), false, "an existing unrelated index entry cannot join the implementation commit");
    assert.equal(flow.git(["diff", "--cached", "--binary", "--", "unrelated.txt"]), index);
    flow.assertResults(["finalize-commit"], { expectedKinds: { "finalize-commit": "finalize-commit-created" } });
  });

  test("F02 legal no-change commit after an existing implementation commit keeps HEAD", async (t) => {
    const flow = beforeRegression(t);
    const paths = new FinalizeCommitPathSet({ repositoryRoot: flow.root, specRoot: "specs", specId: flow.specId });
    flow.git(["add", "-A", "--", ".", ...paths.implementationExclusions]);
    flow.git(["commit", "-m", "feat: implementation already committed"]);
    await flow.advanceTo("finalize-commit");
    flow.assertCommitEvidence();
    const before = flow.git(["rev-parse", "HEAD"]);
    const result = await flow.runRegistered("finalize-commit");
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.equal(flow.git(["rev-parse", "HEAD"]), before);
    flow.reload();
    assert.equal(flow.current(), "finalize-merge");
    flow.assertResults(["finalize-commit"], { expectedKinds: { "finalize-commit": "finalize-commit-unchanged" } });
  });

  test("F02 changed bound Report source refuses before staging or committing", async (t) => {
    const flow = scenario(t);
    const source = flow.report().document.data.binding.sourceArtifacts.find((entry) => entry.path.endsWith("spec.json"));
    assert.ok(source);
    const location = flow.manager.specLocation(flow.specId);
    const protectedFiles = [location.flowStateFile, location.activitiesFile, location.catalogFile];
    const protectedBytes = protectedFiles.map((file) => fs.readFileSync(file));
    fs.appendFileSync(path.join(flow.root, source.path), "\n");
    const gitBefore = flow.gitSnapshot();
    let failed;
    let rejection;
    try { failed = await flow.runRegistered("finalize-commit"); }
    catch (error) { rejection = error; }
    assert.equal(rejection !== undefined || failed?.ok === false, true);
    const messages = rejection ? rejection.message : failed.errors.flatMap((entry) => entry.messages).join("\n");
    assert.match(messages, /(?:artifact content does not match the catalog: spec\.json|REPORT_BINDING_STALE|source.*changed|binding.*stale)/i);
    assert.deepEqual(flow.gitSnapshot(), gitBefore);
    assert.deepEqual(protectedFiles.map((file) => fs.readFileSync(file)), protectedBytes,
      "source admission refusal preserves Attempt, Activity, budget and outbox bytes even when the rejected source cannot be read");
  });

  for (const leaf of finalizationLeaves.slice(1)) {
    test(`F03 unselected ${leaf} rejects without Git, docs or canonical changes`, async (t) => {
      const flow = scenario(t);
      const canonical = flow.snapshot();
      const git = flow.gitSnapshot();
      const failed = await flow.runRegistered(leaf);
      assert.equal(failed.ok, false, `unselected ${leaf} must reject`);
      assert.ok(failed.errors.length);
      flow.reload();
      assert.deepEqual(flow.snapshot(), canonical);
      assert.deepEqual(flow.gitSnapshot(), git);
      assert.equal(flow.docsCalls.length, 0);
    });
  }

  test("F04 unknown dirty input and busy owner reject merge without changing the selected Attempt", async (t) => {
    let lock = null;
    t.after(() => lock?.release());
    const flow = scenario(t);
    await flow.advanceTo("finalize-merge");
    flow.write("unknown-user-change.txt", "retain this user change\n");
    const canonical = flow.snapshot();
    const git = flow.gitSnapshot();
    const dirty = await flow.runRegistered("finalize-merge");
    assert.equal(dirty.ok, false);
    assert.deepEqual(flow.reload().snapshot(), canonical);
    assert.deepEqual(flow.gitSnapshot(), git);
    fs.unlinkSync(path.join(flow.root, "unknown-user-change.txt"));
    lock = new RepositoryFlowOperationLock({ mainRoot: flow.root });
    lock.acquire();
    const beforeLock = flow.snapshot();
    const busy = await flow.runRegistered("finalize-merge");
    assert.equal(busy.ok, false);
    assert.ok(busy.errors.some((entry) => entry.code === "REPOSITORY_FLOW_OPERATION_BUSY"), JSON.stringify(busy));
    assert.deepEqual(flow.reload().snapshot(), beforeLock);
    assert.equal(flow.docsCalls.length, 0);
  });

  test("F05 failed external docs build preserves its actual diagnostics across reload and completes with warnings", async (t) => {
    const flow = scenario(t, { docsMode: "failed" });
    await flow.advanceTo("finalize-sync");
    const identity = flow.identity("finalize-sync");
    const result = await flow.runRegistered("finalize-sync");
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((entry) => entry.code === "FINALIZE_SYNC_FAILED"));
    flow.reload();
    const outbox = flow.outbox("finalize-sync");
    assert.equal(outbox.idempotencyKey, identity.idempotencyKey);
    assert.equal(outbox.status, "failed");
    assert.equal(flow.state().findNode("finalize-sync").status, "skipped");
    const diagnostics = flow.syncFailureDiagnostics();
    assert.ok(diagnostics.length >= 1, "FINALIZATION_SYNC_DIAGNOSTICS_INCOMPLETE: retain the failed docs build observation");
    assert.equal(diagnostics[0].phase, "docs-build");
    assert.equal(diagnostics[0].exitCode, 23);
    assert.equal(diagnostics[0].stdout, "docs build output\n");
    assert.equal(diagnostics[0].stderr, "docs build failed\n");
    assert.equal(flow.current(), "finalize-cleanup");
    const cleanup = await flow.runRegistered("finalize-cleanup");
    assert.notEqual(cleanup.ok, false, JSON.stringify(cleanup));
    assert.equal(cleanup.outcome, "completed_with_warnings");
    flow.reload();
    assert.equal(flow.state().lifecycle.state, "finalized");
    assert.ok(cleanup.finalizeWarnings.some((warning) => warning.message === outbox.failure && warning.code === outbox.latestFailure.code));
    flow.assertResults(["finalize-sync", "finalize-cleanup"], { expectedKinds: {
      "finalize-sync": "finalize-sync-skipped-with-warning", "finalize-cleanup": "finalize-cleanup-completed-with-warning",
    } });
  });

  test("F05 unchanged docs keeps the build observation and routes to cleanup without a docs commit", async (t) => {
    const flow = scenario(t, { docsMode: "unchanged" });
    await flow.advanceTo("finalize-sync");
    const head = flow.git(["rev-parse", "HEAD"]);
    const result = await flow.runRegistered("finalize-sync");
    assert.equal(result.status, "skipped", JSON.stringify(result));
    flow.reload();
    assert.equal(flow.git(["rev-parse", "HEAD"]), head);
    assert.equal(flow.docsCalls.length, 1);
    assert.equal(flow.current(), "finalize-cleanup");
    flow.assertResults(["finalize-sync"], { expectedKinds: { "finalize-sync": "finalize-sync-unchanged" } });
  });

  for (const [leaf, Command] of [["finalize-commit", RunFinalizeCommitCommand], ["finalize-merge", RunFinalizeMergeCommand]]) {
    test(`F06 ${leaf} effect before canonical settlement is resumed by its real marker after manager disposal`, async (t) => {
      const flow = scenario(t);
      await flow.advanceTo(leaf);
      let ctx = flow.context();
      await FLOW_COMMANDS.run[leaf].pre(ctx);
      const identity = flow.identity(leaf);
      const generated = await new Command().execute(ctx);
      assert.equal(generated.status, "done");
      const head = flow.git(["rev-parse", "HEAD"]);
      assert.ok(flow.git(["log", "--format=%B", "HEAD"]).includes(outboxCommitMarker(identity.idempotencyKey)));
      flow.reload();
      assert.equal(flow.outbox(leaf).status, "pending");
      assert.notEqual(flow.state().findNode(leaf).status, "done");
      ctx = flow.context();
      await FLOW_COMMANDS.run[leaf].pre(ctx);
      const resumed = await new Command().execute(ctx);
      assert.equal(resumed.resumed, true);
      assert.equal(flow.git(["rev-parse", "HEAD"]), head);
      await FLOW_COMMANDS.run[leaf].post(ctx, resumed);
      flow.reload();
      assert.equal(flow.outbox(leaf).status, "done");
      const activities = flow.manager.activityLedger(flow.specId).filter((entry) => entry.nodeId === leaf);
      const saved = flow.snapshot();
      await FLOW_COMMANDS.run[leaf].post(flow.context(), resumed);
      flow.reload();
      assert.deepEqual(flow.snapshot(), saved, "exact acknowledged settlement cannot duplicate Activity");
      assert.equal(flow.manager.activityLedger(flow.specId).filter((entry) => entry.nodeId === leaf).length, activities.length);
      flow.assertResults([leaf], { expectedKinds: { [leaf]: leaf === "finalize-commit" ? "finalize-commit-created" : "finalize-merge-squashed" } });
    });
  }

  test("F07 orphan commit refusal retains branch, base, report and current pointer", async (t) => {
    const flow = scenario(t);
    await flow.advanceTo("finalize-sync");
    const sync = await flow.runRegistered("finalize-sync");
    assert.notEqual(sync.ok, false, JSON.stringify(sync));
    flow.reload();
    const feature = flow.state().execution.featureBranch;
    flow.git(["switch", feature]);
    flow.write("orphan.txt", "not included in the accepted squash\n");
    flow.git(["add", "orphan.txt"]);
    flow.git(["commit", "-m", "feat: orphan after squash"]);
    flow.git(["switch", "main"]);
    await flow.advanceTo("finalize-cleanup");
    const base = flow.git(["rev-parse", "main"]);
    const orphan = flow.git(["rev-parse", feature]);
    const sourceActivity = flow.report("finalize-cleanup").descriptor.activityId;
    const failed = await flow.runRegistered("finalize-cleanup");
    assert.equal(failed.ok, false);
    assert.ok(failed.errors.some((entry) => entry.code === "ORPHAN_COMMITS_DETECTED"));
    flow.reload();
    assert.equal(flow.git(["rev-parse", "main"]), base);
    assert.equal(flow.git(["rev-parse", feature]), orphan);
    assert.equal(flow.manager.loadActiveFlows().some((entry) => entry.specId === flow.specId), true);
    assert.equal(flow.state().lifecycle.state, "active");
    assert.equal(fs.existsSync(path.join(flow.root, POINTER_REL_PATH)), false);
    assert.equal(flow.report("finalize-cleanup").descriptor.activityId, sourceActivity);
  });
});
