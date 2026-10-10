import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FinalizationWorktreeScenario, FinalizationWorktreeDurabilityObserver,
  FinalizationWorktreeSourceObserver, finalizationCleanupJournalPhases }
  from "../../support/infrastructure/finalization-worktree-scenario.js";
import { WorktreeFlowBindingStore, WorktreeFlowIdentity } from "../../../src/lib/worktree-flow-binding.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import RunFinalizeCleanupCommand from "../../../src/flow/lib/run-finalize-cleanup.js";
import RunReportShowCommand, { CanonicalLatestReport, POINTER_REL_PATH } from "../../../src/flow/lib/run-report-show.js";
import { dispatchContainer } from "../../support/infrastructure/flow-dispatch-scenario.js";

async function atCleanup(t) {
  const flow = await FinalizationWorktreeScenario.prepare(t);
  const source = flow.report();
  const producer = flow.manager.activityLedger(flow.specId).find((activity) => activity.id === source.descriptor.activityId);
  assert.equal(producer.nodeId, "report");
  assert.equal(producer.result.stepResult.kind, "report-generated");
  assert.equal(flow.binding.runId, flow.state().runId);
  assert.equal(flow.binding.specId, flow.specId);
  assert.equal(flow.binding.worktreePath, flow.worktreePath);
  for (const stepId of ["finalize-commit", "finalize-merge"]) {
    assert.equal(flow.current(), stepId);
    await flow.claimFrontier(stepId);
    const result = await flow.runRegistered(stepId);
    assert.notEqual(result.ok, false, JSON.stringify(result));
    flow.reload();
    assert.equal(flow.outbox(stepId).status, "done");
  }
  assert.equal(flow.docsCalls.length, 0, "merge must not start sync in the managed worktree");
  flow.acquireMainAuthority();
  flow.reload();
  assert.equal(flow.manager.specLocation(flow.specId).repositoryRoot, flow.mainRoot);
  assert.deepEqual(flow.report().bytes, source.bytes, "the actual main authority must consume the real worktree report publication");
  await flow.claimFrontier("finalize-sync");
  const sync = await flow.runRegistered("finalize-sync");
  assert.notEqual(sync.ok, false, JSON.stringify(sync));
  flow.reload();
  assert.equal(flow.outbox("finalize-sync").status, "done");
  assert.equal(flow.current(), "finalize-cleanup");
  await flow.claimFrontier("finalize-cleanup");
  assert.equal(flow.docsCalls.length, 1);
  assert.equal(flow.docsCalls[0].cwd, flow.mainRoot, "docs effects belong to the actual main checkout");
  return { flow, source };
}

function assertCheckpointReality(flow, phase, featureSha) {
  const index = finalizationCleanupJournalPhases.indexOf(phase);
  const journal = flow.journal();
  assert.equal(journal.phase, phase);
  assert.equal(journal.runId, flow.state().runId);
  assert.equal(journal.specId, flow.specId);
  assert.equal(journal.worktreePath, flow.worktreePath);
  assert.equal(journal.featureSha, featureSha);
  assert.equal(fs.existsSync(flow.worktreePath), index === 0);
  const listed = flow.git(["worktree", "list", "--porcelain"]);
  assert.equal(listed.split("\n").includes(`worktree ${flow.worktreePath}`), index === 0);
  assert.equal(flow.git(["branch", "--list", flow.state().execution.featureBranch]) !== "", index < 2);
  const pointerPath = path.join(flow.mainRoot, POINTER_REL_PATH);
  assert.equal(fs.existsSync(pointerPath), index >= 4);
  if (index >= 4) assert.equal(fs.readFileSync(pointerPath, "utf8").trim(), flow.specId);
  assert.equal(flow.outbox("finalize-cleanup").status, index === 5 ? "done" : "pending");
  assert.equal(flow.state().lifecycle.state, index === 5 ? "finalized" : "active");
}

async function assertMainConsumers(t, flow, source) {
  flow.reload();
  assert.equal(flow.manager.executionRoot(), flow.mainRoot);
  assert.equal(fs.existsSync(flow.worktreePath), false);
  assert.deepEqual(flow.manager.loadActiveFlows(), []);
  const latest = CanonicalLatestReport.read({ mainRoot: flow.mainRoot, flowManager: flow.manager, specRoot: "specs" });
  assert.equal(latest.specId, flow.specId);
  assert.equal(latest.text(), source.document.text);
  assert.equal(latest.path.startsWith(flow.mainRoot + path.sep), true);
  assert.deepEqual(flow.report("finalize-cleanup").bytes, source.bytes);
  const status = await flow.invokeRegistered("get", "status");
  assert.equal(status.active, false);
  assert.equal(status.specId, flow.specId);
  assert.equal(status.completion.terminal, true);
  assert.equal(status.completion.success, true);
  const show = new RunReportShowCommand();
  show.container = dispatchContainer({ root: flow.mainRoot, mainRoot: flow.mainRoot,
    config: flow.options.config, flowManager: flow.manager, agent: flow.agent });
  show.container.register("flowSpecRoot", "specs");
  let output = "";
  const stdout = t.mock.method(process.stdout, "write", (chunk) => { output += chunk; return true; });
  try { await show.execute(); } finally { stdout.mock.restore(); }
  assert.equal(output, source.document.text);
}

/** Register inside the existing phase suite so discovery owns one entrypoint. */
export function registerFinalizationWorktreeContracts() {
  test("F00 real managed Prepare producer preserves Task Gate source authority and publishes the report prerequisite", async (t) => {
    const observer = new FinalizationWorktreeSourceObserver(t);
    let flow;
    try { flow = await FinalizationWorktreeScenario.prepare(t); }
    catch (error) {
      if (error.message.includes("canonical Task Gate result source fingerprint is stale")) {
        const publication = observer.captures.findLast((capture) =>
          capture.acquisition.includes("prepareImplementationGatePublication"));
        assert.ok(publication, "diagnosis requires the real Task Gate publication source acquisition");
        const execution = observer.captures.findLast((capture) => capture.root !== publication.root
          && capture.acquisition.includes("executeCanonicalTaskGate")
          && capture.source.runId === publication.source.runId
          && capture.source.taskId === publication.source.taskId
          && JSON.stringify(capture.source.lineageFingerprints) === JSON.stringify(publication.source.lineageFingerprints));
        assert.ok(execution, "diagnosis requires two real source acquisitions for the exact same Task lineage");
        assert.equal(publication.source.fingerprint, execution.source.fingerprint,
          `WORKTREE_REPORT_PRODUCER_SOURCE_AUTHORITY_MISMATCH: ${JSON.stringify({ execution, publication })}`);
      }
      throw error;
    } finally { observer.restore(); }
    assert.equal(flow.current(), "finalize-commit");
    const report = flow.report();
    const producer = flow.manager.activityLedger(flow.specId).find((activity) => activity.id === report.descriptor.activityId);
    assert.equal(producer.nodeId, "report");
    assert.equal(producer.result.stepResult.kind, "report-generated");
    const before = flow.snapshot();
    flow.reload();
    assert.deepEqual(flow.snapshot(), before);
    assert.deepEqual(flow.report().bytes, report.bytes);
  });

  test("F07 managed Prepare worktree completes every real journal phase and all later writers/consumers use main", async (t) => {
    const { flow, source } = await atCleanup(t);
    const featureSha = flow.git(["rev-parse", flow.state().execution.featureBranch]);
    const observer = new FinalizationWorktreeDurabilityObserver(t, flow);
    let result;
    try { result = await flow.runRegistered("finalize-cleanup"); }
    finally { observer.restore(); }
    assert.notEqual(result.ok, false, JSON.stringify(result));
    assert.deepEqual(observer.phases.map((journal) => journal.phase), finalizationCleanupJournalPhases);
    assertCheckpointReality(flow, "completed", featureSha);
    observer.assertMainWriters(flow);
    await assertMainConsumers(t, flow, source);
    flow.assertResults(["finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup"], {
      expectedKinds: { "finalize-sync": "finalize-sync-built", "finalize-cleanup": "finalize-cleanup-completed" },
    });
  });

  test("F06 managed cleanup reconstructs each real saved journal checkpoint after a lost response and never repeats completed effects", async (t) => {
    const { flow, source } = await atCleanup(t);
    const featureSha = flow.git(["rev-parse", flow.state().execution.featureBranch]);
    const mainHead = flow.git(["rev-parse", "HEAD"]);
    const cleanupIdentity = flow.identity("finalize-cleanup");
    // This is the same registered pre/body boundary used by public cleanup.
    // A lost response leaves pending authority; no onError success/failure is
    // manufactured. Each retry reconstructs its context from durable storage.
    await FLOW_COMMANDS.run["finalize-cleanup"].pre(flow.context());
    const savedPhases = [];
    let finalObserver;
    for (const phase of finalizationCleanupJournalPhases) {
      const observer = new FinalizationWorktreeDurabilityObserver(t, flow, { interruptAfter: phase });
      try {
        await assert.rejects(() => new RunFinalizeCleanupCommand().execute(flow.context()),
          (error) => error === observer.interruption);
      } finally { observer.restore(); }
      assert.equal(observer.interrupted, true, `the real journal must reach ${phase}`);
      assert.deepEqual(observer.phases.map((journal) => journal.phase), [phase],
        "resume must advance only the next unconfirmed journal phase");
      savedPhases.push(...observer.phases.map((journal) => journal.phase));
      flow.reload();
      assertCheckpointReality(flow, phase, featureSha);
      assert.equal(flow.outbox("finalize-cleanup").idempotencyKey, cleanupIdentity.idempotencyKey);
      assert.equal(flow.git(["rev-parse", "HEAD"]), mainHead,
        "a lost cleanup response cannot fabricate the later completion commit");
      assert.equal(flow.docsCalls.length, 1, "journal replay must not rerun docs synchronization");
      finalObserver = observer;
    }
    assert.deepEqual(savedPhases, finalizationCleanupJournalPhases);
    finalObserver.assertMainWriters(flow);
    const completionActivities = flow.manager.activityLedger(flow.specId).filter((activity) =>
      activity.nodeId === "finalize-cleanup");
    assert.ok(completionActivities.length > 0,
      "the real cleanup Attempt must own persisted Activities before its exact replay");
    const replay = await flow.runRegistered("finalize-cleanup");
    assert.notEqual(replay.ok, false, JSON.stringify(replay));
    flow.reload();
    assert.equal(flow.journal().phase, "completed");
    assert.equal(fs.existsSync(flow.worktreePath), false);
    assert.deepEqual(flow.manager.activityLedger(flow.specId).filter((activity) =>
      activity.nodeId === "finalize-cleanup"), completionActivities,
    "exact public replay must not append or modify any owning cleanup Activity");
    await assertMainConsumers(t, flow, source);
    flow.assertResults(["finalize-cleanup"], { expectedKinds: { "finalize-cleanup": "finalize-cleanup-completed" } });
  });

  test("F07 a different managed worktree owner is refused before teardown and exact owner restoration permits cleanup", async (t) => {
    const { flow, source } = await atCleanup(t);
    const store = new WorktreeFlowBindingStore({ worktreePath: flow.worktreePath });
    const exact = store.load();
    const other = new WorktreeFlowIdentity({ ...exact.toJSON(), runId: `${exact.runId}-other-owner` });
    const before = flow.snapshot();
    const gitBefore = flow.gitSnapshot();
    store.withLock((ownerToken) => store.replace(exact, other, ownerToken));
    try {
      await t.test("wrong owner preserves canonical state, refs, directory and journal", async () => {
        const denied = await flow.runRegistered("finalize-cleanup");
        assert.equal(denied.ok, false);
        assert.equal(denied.errors[0].code, "WORKTREE_FLOW_BINDING_REMOVE_FAILED");
        assert.equal(fs.existsSync(flow.worktreePath), true);
        assert.equal(store.load().equals(other), true);
        assert.deepEqual(flow.gitSnapshot(), gitBefore);
        assert.deepEqual(flow.reload().snapshot(), before,
          "an ownership refusal must precede outbox/Activity mutation");
        assert.equal(flow.journal(), null, "ownership must be checked before publishing a teardown journal");
      });
    } finally { store.withLock((ownerToken) => store.replace(other, exact, ownerToken)); }
    await t.test("restoring the exact owner enables the actual cleanup command", async (restorationTest) => {
      const restored = await flow.runRegistered("finalize-cleanup");
      assert.notEqual(restored.ok, false, JSON.stringify(restored));
      await assertMainConsumers(restorationTest, flow, source);
      flow.assertResults(["finalize-cleanup"], { expectedKinds: { "finalize-cleanup": "finalize-cleanup-completed" } });
    });
  });
}
