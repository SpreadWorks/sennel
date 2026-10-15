import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { after, before, describe, mock, test } from "node:test";
import { FinalizationPhaseScenario } from "../../support/finalization-phase-scenario.js";
import { FinalizeCommitPathSet } from "../../../src/flow/lib/finalize-commit-paths.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { FlowOutboxRecoveryReceipt } from "../../../src/flow/lib/flow-outbox.js";
import RunReportShowCommand, { CanonicalLatestReport, POINTER_REL_PATH } from "../../../src/flow/lib/run-report-show.js";
import { dispatchContainer } from "../../support/infrastructure/flow-dispatch-scenario.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";

function canonicalBytes(flow) {
  const location = flow.manager.specLocation(flow.specId);
  return Object.fromEntries(["flow.json", "activities.jsonl", "artifact-catalog.json"]
    .map((file) => [file, fs.readFileSync(location.resolve(file))]));
}

function journal(flow) {
  return JSON.parse(fs.readFileSync(flow.manager.specLocation(flow.specId).artifact("finalize.cleanup.journal"), "utf8"));
}

function assertCanonicalUnchanged(flow, expected) {
  const actual = canonicalBytes(flow);
  assert.deepEqual(Object.keys(actual).filter((key) => !actual[key].equals(expected[key])), [],
    "refusal, projection and completed replay must preserve canonical state and evidence");
}

function refs(flow) {
  return { main: flow.git(["rev-parse", "main"]), feature: flow.git(["rev-parse", flow.state().execution.featureBranch]),
    index: flow.git(["ls-files", "--stage"]), worktrees: flow.git(["worktree", "list", "--porcelain"]) };
}

function lockFeatureRef(t, flow) {
  const lockPath = path.join(flow.root, ".git", "refs", "heads", `${flow.state().execution.featureBranch}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "Another Git operation owns this ref.\n", { flag: "wx" });
  const release = () => { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); };
  t.after(release);
  return release;
}

function orphanAtCleanup(t, seed) {
  const flow = FinalizationPhaseScenario.fromSeed(t, seed);
  const paths = new FinalizeCommitPathSet({ repositoryRoot: flow.root, specRoot: "specs", specId: flow.specId });
  flow.git(["add", "-A", "--", ...paths.completionPaths.filter((entry) => fs.existsSync(path.join(flow.root, entry)))]);
  flow.git(["commit", "-m", "test: checkpoint the produced finalization evidence"]);
  flow.git(["switch", flow.state().execution.featureBranch]);
  flow.write("orphan.txt", "An actual orphan requires a saved destructive authorization.\n");
  flow.git(["add", "orphan.txt"]);
  flow.git(["commit", "-m", "test: orphan after the accepted squash"]);
  flow.git(["switch", "main"]);
  flow.reload();
  return flow;
}

describe("Registered cleanup refusal and audit persistence", { concurrency: false }, () => {
  let seed;
  let commitSeed;
  const cleanups = [];
  before(async () => {
    const scope = { mock, after(fn) { cleanups.push(fn); } };
    commitSeed = await FinalizationPhaseScenario.seed(scope, { frontier: "finalize-commit" });
    seed = await FinalizationPhaseScenario.seed(scope, { frontier: "finalize-cleanup",
      seedRoot: commitSeed.root, seedSpecId: commitSeed.specId });
  });
  after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });

for (const response of ["missing-receipt", "missing-assurance", "foreign-receipt", "lost-operational-response"]) {
test(`dispatcher cleanup authenticates the real Completion before ${response}`, async (t) => {
  const flow = FinalizationPhaseScenario.fromSeed(t, seed);
  const dispatcher = new RunDispatchCommand({ agent: flow.agent, maxDispatches: 4 });
  dispatcher.container = dispatchContainer({ root: flow.root, mainRoot: flow.root,
    config: flow.options.config, flowManager: flow.manager, agent: flow.agent });
  const run = dispatcher.runRegisteredFlowCommand;
  let completed = false;
  let commandCalls = 0;
  // Delegate the complete registered producer unchanged, then lose or corrupt
  // only its returned command envelope at the dispatcher input boundary.
  t.mock.method(dispatcher, "runRegisteredFlowCommand", async function (...args) {
    const envelope = await run.apply(this, args);
    assert.equal(args[2].subcommand, "finalize-cleanup");
    assert.equal(envelope.ok, true, JSON.stringify(envelope.errors));
    assert.equal(envelope.data.status, "done");
    assert.equal(envelope.data.settlementReceipt.settlementKind, "completion");
    commandCalls += 1;
    completed = true;
    const result = structuredClone(envelope);
    if (response === "missing-receipt") delete result.data.settlementReceipt;
    if (response === "missing-assurance") delete result.data.assurance;
    if (response === "foreign-receipt") result.data.settlementReceipt.binding.runId = "different-run";
    if (response === "lost-operational-response") {
      result.ok = false;
      result.errors = [{ level: "fatal", code: "RESPONSE_IO_FAILED", messages: ["The Completion response was interrupted."] }];
    }
    return result;
  });
  const fetch = dispatcher.fetchNextAction;
  t.mock.method(dispatcher, "fetchNextAction", function (...args) {
    assert.equal(completed, false, "cleanup must not reread next-action after a possibly removed execution root");
    return fetch.apply(this, args);
  });
  const result = await dispatcher.execute({ ...flow.context(), expectRunId: flow.state().runId,
    expectSpec: flow.specId, _envelopeType: "run", _envelopeKey: "dispatch" });
  assert.equal(commandCalls, 1);
  if (response === "lost-operational-response") {
    assert.equal(result.dispatch.boundary, "completed");
    assert.equal(result.dispatch.dispatchCount, 1);
  } else {
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "FLOW_DISPATCH_FINALIZE_CLEANUP_UNCONFIRMED");
    assert.equal(result.data.dispatch.boundary, "blocked");
  }
  flow.reload();
  assert.equal(flow.state().lifecycle.state, "finalized", "the physical producer completed before its response was altered");
  assert.equal(flow.manager.activityLedger(flow.specId).filter((activity) => activity.type === "flow_finalized").length, 1);
  assert.equal(flow.outbox("finalize-cleanup").status, "done");
});
}

for (const mode of ["initial-read-io", "applied-delete-readback-io"]) {
test(`registered cleanup ref-query IO recovery: ${mode} keeps the truthful checkpoint through one Completion`, async (t) => {
  const flow = FinalizationPhaseScenario.fromSeed(t, seed);
  const feature = flow.state().execution.featureBranch;
  const ref = `refs/heads/${feature}`;
  const featureSha = flow.git(["rev-parse", ref]);
  const mainSha = flow.git(["rev-parse", "main"]);
  const sourceReport = flow.report("finalize-cleanup");
  const reportBefore = sourceReport.bytes;
  const journalFile = flow.manager.specLocation(flow.specId).artifact("finalize.cleanup.journal");
  const original = childProcess.spawnSync;
  let lostDelete = false;
  let queryFailures = 0;
  let deletionAttempts = 0;
  let realDeletions = 0;
  const observer = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    const deleting = command === "git" && args.includes("update-ref") && args.includes("-d") && args.includes(ref);
    const querying = command === "git" && args.includes(ref)
      && (args.includes("for-each-ref") || args.includes("rev-parse") && args.includes("--verify"));
    const phase = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, "utf8")).phase : null;
    const io = { status: 128, stdout: "", stderr: "Observed transient feature-ref IO failure\n", signal: null };
    if (deleting) {
      deletionAttempts += 1;
      const result = original(command, args, options);
      if (result.status === 0) realDeletions += 1;
      if (mode === "applied-delete-readback-io" && !lostDelete && phase === "worktree-removed") {
        assert.equal(result.status, 0, result.stderr);
        lostDelete = true;
        return io;
      }
      return result;
    }
    if (querying && phase === "worktree-removed" && queryFailures === 0
      && (mode === "initial-read-io" || lostDelete)) {
      queryFailures += 1;
      return io;
    }
    return original(command, args, options);
  });
  t.after(() => { observer.mock.restore(); syncBuiltinESMExports(); });
  syncBuiltinESMExports();

  const failed = await flow.runRegistered("finalize-cleanup");
  flow.reload();
  assert.equal(queryFailures, 1, "the external ref query must fail at the actual persisted teardown boundary");
  assert.equal(lostDelete, mode === "applied-delete-readback-io");
  assert.equal(failed.ok, false);
  assert.equal(failed.errors[0].code, "BRANCH_DELETE_FAILED");
  assert.equal(journal(flow).phase, "worktree-removed", "unknown ref reality cannot certify branch deletion");
  assert.equal(flow.git(["for-each-ref", "--format=%(objectname)", ref]),
    mode === "initial-read-io" ? featureSha : "");
  assert.equal(flow.git(["rev-parse", "main"]), mainSha);
  const failure = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-cleanup" });
  assert.equal(failure.result.kind, "finalize-cleanup-error");
  assert.equal(failure.settlement.kind, "failure");
  const failedOutbox = flow.outbox("finalize-cleanup");
  const failedAttempt = flow.state().attempt.toJSON();
  assert.equal(failedOutbox.status, "failed");
  assert.equal(journal(flow).executionOrigin.identity.attempt.id, failedAttempt.id);
  assert.deepEqual(flow.report("finalize-cleanup").bytes, reportBefore);

  const beforeRecovery = canonicalBytes(flow);
  const gitBeforeRecovery = flow.gitSnapshot();
  const ordinary = await flow.runRegistered("finalize-cleanup");
  assert.equal(ordinary.ok, false, "a failed outbox requires its selected exact recovery");
  flow.reload();
  assertCanonicalUnchanged(flow, beforeRecovery);
  assert.deepEqual(flow.gitSnapshot(), gitBeforeRecovery);
  const planned = await flow.next();
  assert.equal(planned.directive.actionId, "RECOVER_FINALIZE_CLEANUP_OUTBOX");
  flow.reload();
  assertCanonicalUnchanged(flow, beforeRecovery);
  const recovered = await flow.runRegistered("recover-finalization");
  assert.equal(recovered.operation, "exact-outbox-recovery");
  flow.reload();
  assert.equal(flow.state().attempt.sequence, failedAttempt.sequence + 1);
  assert.notEqual(flow.state().attempt.id, failedAttempt.id);
  const pending = flow.outbox("finalize-cleanup");
  assert.equal(pending.status, "pending");
  assert.equal(pending.idempotencyKey, failedOutbox.idempotencyKey);
  assert.equal(pending.attempt, failedOutbox.attempt);
  assert.equal(pending.exactRecoveryReceipt.failure, failedOutbox.failure);
  const recoveryReceipt = pending.exactRecoveryReceipt.toJSON();
  assert.equal(journal(flow).phase, "worktree-removed");
  const reopened = canonicalBytes(flow);
  const twice = await flow.runRegistered("recover-finalization");
  assert.equal(twice.ok, false, "the authorized exact reopen is consumed once");
  flow.reload();
  assertCanonicalUnchanged(flow, reopened);

  const completed = await flow.runRegistered("finalize-cleanup");
  assert.equal(completed.status, "done");
  flow.reload();
  assert.equal(flow.state().lifecycle.state, "finalized");
  assert.equal(flow.state().current, null);
  assert.equal(flow.state().attempt, null);
  assert.equal(flow.outbox("finalize-cleanup").status, "done");
  assert.deepEqual(flow.outbox("finalize-cleanup").exactRecoveryReceipt.toJSON(), recoveryReceipt);
  assert.equal(journal(flow).phase, "completed");
  assert.deepEqual(flow.report("finalize-cleanup").bytes, reportBefore);
  const ledger = flow.manager.activityLedger(flow.specId);
  assert.equal(ledger.filter((activity) => activity.type === "flow_finalized").length, 1);
  assert.equal(ledger.filter((activity) => activity.transition.operation === "reopen_outbox"
    && activity.transition.outbox.id === failedOutbox.idempotencyKey).length, 1);
  const completion = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-cleanup", completed: true });
  assert.equal(completion.result.kind, "finalize-cleanup-completed");
  assert.equal(completion.receipt.settlementKind, "completion");
  assert.equal(flow.git(["rev-list", "--count", `${mainSha}..main`]), "1");
  const beforeReplay = canonicalBytes(flow);
  const completedHead = flow.git(["rev-parse", "main"]);
  const replay = await flow.runRegistered("finalize-cleanup");
  assert.deepEqual(replay, completed);
  flow.reload();
  assertCanonicalUnchanged(flow, beforeReplay);
  assert.equal(flow.git(["rev-parse", "main"]), completedHead);
  const latest = CanonicalLatestReport.read({ mainRoot: flow.root, flowManager: flow.manager, specRoot: "specs" });
  assert.equal(latest.specId, flow.specId);
  assert.equal(latest.text(), sourceReport.document.text);
  assert.equal(latest.relativePath, sourceReport.relativePath);
  assert.equal(latest.path, flow.manager.specLocation(flow.specId).resolve(sourceReport.relativePath));
  assert.deepEqual(flow.report("finalize-cleanup").bytes, reportBefore);
  const show = new RunReportShowCommand();
  show.container = dispatchContainer({ root: flow.root, mainRoot: flow.root,
    config: flow.options.config, flowManager: flow.manager, agent: flow.agent });
  show.container.register("flowSpecRoot", "specs");
  let output = "";
  const stdout = t.mock.method(process.stdout, "write", (chunk) => { output += chunk; return true; });
  try { await show.execute(); } finally { stdout.mock.restore(); }
  assert.equal(output, sourceReport.document.text);
  const status = await flow.invokeRegistered("get", "status");
  assert.equal(status.active, false);
  assert.equal(status.specId, flow.specId);
  assertCanonicalUnchanged(flow, beforeReplay);
  assert.equal(flow.git(["rev-parse", "main"]), completedHead);
  assert.equal(realDeletions, 1, "recovery and replay must not repeat the actual deletion");
  assert.equal(deletionAttempts, 1);
  assert.equal(flow.git(["for-each-ref", "--format=%(objectname)", ref]), "");
});
}

test("registered cleanup required audit save failure preserves the canonical checkpoint before every destructive effect", async (t) => {
  const flow = orphanAtCleanup(t, seed);
  await FLOW_COMMANDS.run["finalize-cleanup"].pre(flow.context());
  flow.reload();
  const refsBefore = refs(flow);
  const reportBefore = flow.report("finalize-cleanup").bytes;
  const failure = Object.assign(new Error("Observed audit Store IO failure"), { code: "AUDIT_STORE_IO" });
  let beforeAudit = null;
  let injected = false;
  flow.reload({ versionStoreFaultInjector({ phase, activity }) {
    if (!injected && phase === "activity-ready-to-append" && activity?.nodeId === "finalize-cleanup"
      && activity.transition.operation === "publish_artifacts") {
      beforeAudit = canonicalBytes(flow);
      injected = true;
      throw failure;
    }
  } });
  const result = await flow.runRegistered("finalize-cleanup", { force: true });
  assert.equal(injected, true, "the registered command must reach the actual required audit publication");
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "ISSUE_LOG_AUDIT_FAILED");
  assert.equal(result.data.causeCode, failure.code);
  assert.equal(result.data.failureKind, "step-persistence");
  flow.reload();
  const after = canonicalBytes(flow);
  // Compare every byte, but keep a failed assertion bounded instead of
  // expanding the entire accumulated Activity journal as a Buffer diff.
  assert.deepEqual(Object.keys(after).filter((key) => !after[key].equals(beforeAudit[key])), [],
    "failed audit persistence cannot publish a replacement semantic Error or outbox failure");
  assert.deepEqual(refs(flow), refsBefore);
  assert.deepEqual(flow.report("finalize-cleanup").bytes, reportBefore);
  assert.equal(flow.state().findNode("finalize-cleanup").status, "in_progress");
  assert.equal(flow.state().attempt.failure, null);
  assert.equal(flow.outbox("finalize-cleanup").status, "pending");
  assert.equal(fs.existsSync(path.join(flow.root, POINTER_REL_PATH)), false);
});

test("registered orphan refusal keeps the exact pending claim usable by an explicit forced cleanup", async (t) => {
  const flow = orphanAtCleanup(t, seed);
  await FLOW_COMMANDS.run["finalize-cleanup"].pre(flow.context());
  flow.reload();
  const before = canonicalBytes(flow);
  const attemptBefore = flow.state().attempt.toJSON();
  const refsBefore = refs(flow);
  const reportBefore = flow.report("finalize-cleanup").bytes;
  const refused = await flow.runRegistered("finalize-cleanup");
  assert.equal(refused.ok, false);
  assert.equal(refused.errors[0].code, "ORPHAN_COMMITS_DETECTED");
  assert.equal(refused.data.failureKind, "step-admission");
  flow.reload();
  const afterRefusal = canonicalBytes(flow);
  assert.deepEqual(Object.keys(afterRefusal).filter((key) => !afterRefusal[key].equals(before[key])), []);
  assert.deepEqual(flow.state().attempt.toJSON(), attemptBefore);
  assert.deepEqual(refs(flow), refsBefore);
  assert.deepEqual(flow.report("finalize-cleanup").bytes, reportBefore);
  assert.equal(flow.outbox("finalize-cleanup").status, "pending");
  assert.equal(fs.existsSync(path.join(flow.root, POINTER_REL_PATH)), false);

  const forced = await flow.runRegistered("finalize-cleanup", { force: true });
  assert.notEqual(forced.ok, false, JSON.stringify(forced));
  assert.equal(forced.outcome, "completed_with_warnings");
  assert.ok(forced.forceAuthorization.auditId);
  flow.reload();
  assert.equal(flow.state().lifecycle.state, "finalized");
  assert.equal(flow.outbox("finalize-cleanup").status, "done");
  assert.equal(flow.manager.readCurrentStepSettlement({ specId: flow.specId,
    stepId: "finalize-cleanup", completed: true }).result.kind, "finalize-cleanup-completed-with-warning");
  const audit = flow.manager.readArtifact({ specId: flow.specId, logicalKey: "issue.log", consumerNodeId: "finalize-cleanup" });
  const forcedEntries = JSON.parse(audit.bytes).entries.filter((entry) => entry.issueLogId === forced.forceAuthorization.auditId);
  assert.equal(forcedEntries.length, 1);
  assert.ok(forcedEntries[0].reason.startsWith("FORCED_ORPHAN_DROP"));
  assert.equal(journal(flow).authorization.auditId, forced.forceAuthorization.auditId);
  assert.deepEqual(flow.report("finalize-cleanup").bytes, reportBefore);
  assert.deepEqual(flow.manager.loadActiveFlows(), []);
});
test("registered partial branch failure resumes only through exact journal recovery without repeating the forced audit", async (t) => {
  const flow = orphanAtCleanup(t, seed);
  const state = flow.state();
  const feature = state.execution.featureBranch;
  const featureSha = flow.git(["rev-parse", feature]);
  const mainSha = flow.git(["rev-parse", "main"]);
  const reportBefore = flow.report("finalize-cleanup").bytes;
  const release = lockFeatureRef(t, flow);
  const failed = await flow.runRegistered("finalize-cleanup", { force: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.errors[0].code, "BRANCH_DELETE_FAILED");
  flow.reload();
  const failure = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-cleanup" });
  assert.equal(failure.result.kind, "finalize-cleanup-error");
  assert.equal(failure.settlement.kind, "failure");
  const failedAttempt = flow.state().attempt.toJSON();
  const failedOutbox = flow.outbox("finalize-cleanup");
  assert.equal(failedOutbox.status, "failed");
  assert.equal(journal(flow).phase, "worktree-removed");
  assert.equal(journal(flow).executionOrigin.identity.attempt.id, failedAttempt.id);
  assert.equal(journal(flow).executionOrigin.expectedBaseSha, mainSha);
  assert.equal(journal(flow).executionOrigin.expectedFeatureSha, featureSha);
  assert.equal(flow.git(["rev-parse", feature]), featureSha);
  assert.equal(flow.git(["rev-parse", "main"]), mainSha);
  const audit = () => JSON.parse(flow.manager.readArtifact({ specId: flow.specId,
    logicalKey: "issue.log", consumerNodeId: "finalize-cleanup" }).bytes).entries
    .filter((entry) => entry.reason.startsWith("FORCED_ORPHAN_DROP"));
  const savedAudit = audit();
  assert.equal(savedAudit.length, 1);
  const beforePlanning = canonicalBytes(flow);
  const planned = await flow.next();
  assert.equal(planned.directive.actionId, "RECOVER_FINALIZE_CLEANUP_OUTBOX");
  const afterPlanning = canonicalBytes(flow);
  assert.deepEqual(Object.keys(afterPlanning).filter((key) => !afterPlanning[key].equals(beforePlanning[key])), []);
  release();
  const recovered = await flow.runRegistered("recover-finalization");
  assert.notEqual(recovered.ok, false, JSON.stringify(recovered));
  flow.reload();
  assert.notEqual(flow.state().attempt.id, failedAttempt.id);
  assert.equal(flow.outbox("finalize-cleanup").status, "pending");
  assert.equal(flow.outbox("finalize-cleanup").idempotencyKey, failedOutbox.idempotencyKey);
  assert.equal(flow.outbox("finalize-cleanup").attempt, failedOutbox.attempt);
  assert.equal(flow.outbox("finalize-cleanup").exactRecoveryReceipt.failure, failedOutbox.failure);
  assert.deepEqual(audit(), savedAudit);
  const completed = await flow.runRegistered("finalize-cleanup", { force: true });
  assert.notEqual(completed.ok, false, JSON.stringify(completed));
  assert.equal(completed.outcome, "completed_with_warnings");
  flow.reload();
  assert.equal(flow.state().lifecycle.state, "finalized");
  assert.equal(flow.outbox("finalize-cleanup").status, "done");
  assert.equal(journal(flow).phase, "completed");
  assert.deepEqual(audit(), savedAudit);
  assert.equal(completed.forceAuthorization.auditId, savedAudit[0].issueLogId);
  assert.equal(flow.git(["branch", "--list", feature]), "");
  assert.equal(flow.git(["rev-list", "--count", `${mainSha}..main`]), "1",
    "the resumed operation creates only the existing final completion metadata commit");
  assert.ok(flow.git(["show", "-s", "--format=%B", "main"]).includes(failedOutbox.idempotencyKey));
  assert.deepEqual(flow.report("finalize-cleanup").bytes, reportBefore);
  const beforeReplay = canonicalBytes(flow);
  const completedHead = flow.git(["rev-parse", "main"]);
  const replay = await flow.runRegistered("finalize-cleanup", { force: true });
  assert.notEqual(replay.ok, false, JSON.stringify(replay));
  assert.deepEqual(replay.settlementReceipt, completed.settlementReceipt);
  assert.deepEqual(replay.forceAuthorization, completed.forceAuthorization);
  assert.deepEqual(replay.report, completed.report);
  flow.reload();
  const afterReplay = canonicalBytes(flow);
  assert.deepEqual(Object.keys(afterReplay).filter((key) => !afterReplay[key].equals(beforeReplay[key])), []);
  assert.equal(flow.git(["rev-parse", "main"]), completedHead);
  assert.deepEqual(audit(), savedAudit);
});
test("actual direct-mode producer completes all four registered finalizers and replays its no-feature Completion", async (t) => {
  const flow = FinalizationPhaseScenario.create(t, { execution: { mode: "direct", baseBranch: "main", featureBranch: null } });
  await flow.advanceTo("finalize-commit");
  const reportBefore = flow.report("finalize-commit").bytes;
  const committed = await flow.runRegistered("finalize-commit");
  assert.notEqual(committed.ok, false, JSON.stringify(committed));
  flow.reload();
  assert.equal(flow.current(), "finalize-merge");
  const merged = await flow.runRegistered("finalize-merge");
  assert.equal(merged.status, "skipped", JSON.stringify(merged));
  assert.equal(merged.strategy, "skip");
  flow.reload();
  assert.equal(flow.current(), "finalize-sync");
  await flow.claimFrontier("finalize-sync");
  assert.equal(flow.ghCalls.length, 0);
  const synced = await flow.runRegistered("finalize-sync");
  assert.notEqual(synced.ok, false, JSON.stringify(synced));
  flow.reload();
  assert.equal(flow.current(), "finalize-cleanup");
  const docsCalls = flow.docsCalls.length;
  const headBefore = flow.git(["rev-parse", "main"]);
  await FLOW_COMMANDS.run["finalize-cleanup"].pre(flow.context());
  flow.reload();
  const pending = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-cleanup" });
  assert.equal(pending.result.execution.expectedFeatureSha, null);
  assert.equal(pending.result.execution.expectedBaseSha, headBefore);
  const completed = await flow.runRegistered("finalize-cleanup");
  assert.notEqual(completed.ok, false, JSON.stringify(completed));
  assert.equal(completed.message, "spec-only mode");
  flow.reload();
  assert.equal(flow.state().lifecycle.state, "finalized");
  assert.equal(flow.state().execution.mode, "direct");
  assert.equal(flow.state().execution.featureBranch, null);
  assert.equal(flow.outbox("finalize-cleanup").status, "done");
  assert.equal(journal(flow).featureBranch, null);
  assert.equal(journal(flow).executionOrigin.expectedFeatureSha, null);
  assert.equal(journal(flow).featureSha, pending.result.execution.expectedBaseSha);
  assert.equal(journal(flow).phase, "completed");
  assert.deepEqual(flow.report("finalize-cleanup").bytes, reportBefore);
  flow.assertResults(["finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup"],
    { expectedKinds: { "finalize-merge": "finalize-merge-policy-skipped", "finalize-cleanup": "finalize-cleanup-completed" } });
  const completedReceipt = flow.manager.readCurrentStepSettlement({ specId: flow.specId,
    stepId: "finalize-cleanup", completed: true }).receipt;
  assert.equal(completedReceipt.settlementKind, "completion");
  assert.equal(completedReceipt.connector, null);
  assert.equal(completedReceipt.targetStepId, null);
  const beforeReplay = canonicalBytes(flow);
  const completedHead = flow.git(["rev-parse", "main"]);
  const replay = await flow.runRegistered("finalize-cleanup");
  assert.notEqual(replay.ok, false, JSON.stringify(replay));
  assert.deepEqual(replay.settlementReceipt, completed.settlementReceipt);
  assert.deepEqual(replay.report, completed.report);
  flow.reload();
  const afterReplay = canonicalBytes(flow);
  assert.deepEqual(Object.keys(afterReplay).filter((key) => !afterReplay[key].equals(beforeReplay[key])), []);
  assert.equal(flow.git(["rev-parse", "main"]), completedHead);
  assert.equal(flow.docsCalls.length, docsCalls);
  assert.equal(flow.ghCalls.length, 0);
});
test("a second registered branch failure retains the consumed exact recovery and refuses another recovery without writes", async (t) => {
  const flow = orphanAtCleanup(t, seed);
  lockFeatureRef(t, flow);
  const refsBefore = refs(flow);
  const reportBefore = flow.report("finalize-cleanup").bytes;
  const first = await flow.runRegistered("finalize-cleanup", { force: true });
  assert.equal(first.ok, false);
  assert.equal(first.errors[0].code, "BRANCH_DELETE_FAILED");
  flow.reload();
  const firstOutbox = flow.outbox("finalize-cleanup");
  const recovered = await flow.runRegistered("recover-finalization");
  assert.notEqual(recovered.ok, false, JSON.stringify(recovered));
  flow.reload();
  const consumed = flow.outbox("finalize-cleanup").exactRecoveryReceipt.toJSON();
  assert.equal(consumed.idempotencyKey, firstOutbox.idempotencyKey);
  assert.equal(consumed.attempt, firstOutbox.attempt);
  assert.equal(consumed.failure, firstOutbox.failure);
  const second = await flow.runRegistered("finalize-cleanup", { force: true });
  assert.equal(second.ok, false);
  assert.equal(second.errors[0].code, "BRANCH_DELETE_FAILED");
  flow.reload();
  const secondOutbox = flow.outbox("finalize-cleanup");
  assert.equal(secondOutbox.status, "failed");
  assert.deepEqual(secondOutbox.exactRecoveryReceipt.toJSON(), consumed);
  const failedReceipt = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-cleanup" });
  assert.equal(failedReceipt.result.kind, "finalize-cleanup-error");
  assert.deepEqual(FlowOutboxRecoveryReceipt.fromStored(failedReceipt.receipt.finalization.candidate.outbox.exactRecoveryReceipt).toJSON(), consumed);
  const beforeRefusal = canonicalBytes(flow);
  const planned = await flow.next();
  assert.equal(planned.directive.code, "FINALIZE_OUTBOX_RECOVERY_EXHAUSTED");
  const refused = await flow.runRegistered("recover-finalization");
  assert.equal(refused.ok, false);
  flow.reload();
  const afterRefusal = canonicalBytes(flow);
  assert.deepEqual(Object.keys(afterRefusal).filter((key) => !afterRefusal[key].equals(beforeRefusal[key])), []);
  assert.deepEqual(refs(flow), refsBefore);
  assert.deepEqual(flow.report("finalize-cleanup").bytes, reportBefore);
  assert.equal(journal(flow).phase, "worktree-removed");
  const audit = JSON.parse(flow.manager.readArtifact({ specId: flow.specId,
    logicalKey: "issue.log", consumerNodeId: "finalize-cleanup" }).bytes).entries;
  assert.equal(audit.filter((entry) => entry.reason.startsWith("FORCED_ORPHAN_DROP")).length, 1);
  assert.equal(flow.manager.activityLedger(flow.specId).filter((entry) => entry.transition.operation === "reopen_outbox"
    && entry.transition.outbox.id === firstOutbox.idempotencyKey).length, 1);
});
test("an exact reopen survives checkpoint Store IO failure and resumes its authorized Attempt without reopening twice", async (t) => {
  const flow = orphanAtCleanup(t, seed);
  const release = lockFeatureRef(t, flow);
  const refsBefore = refs(flow);
  const reportBefore = flow.report("finalize-cleanup").bytes;
  const first = await flow.runRegistered("finalize-cleanup", { force: true });
  assert.equal(first.errors[0].code, "BRANCH_DELETE_FAILED");
  flow.reload();
  const originalAttempt = flow.state().attempt.toJSON();
  const originalOutbox = flow.outbox("finalize-cleanup");
  let injected = false;
  let beforeCheckpoint = null;
  flow.reload({ versionStoreFaultInjector({ phase, activity }) {
    if (!injected && phase === "activity-ready-to-append" && activity?.nodeId === "finalize-cleanup"
      && activity.transition.operation === "record_draft_step_settlement") {
      injected = true;
      beforeCheckpoint = canonicalBytes(flow);
      throw Object.assign(new Error("Observed recovery checkpoint Store IO failure"), { code: "RECOVERY_CHECKPOINT_IO" });
    }
  } });
  const interrupted = await flow.runRegistered("recover-finalization");
  assert.equal(injected, true);
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.errors[0].code, "STEP_RESULT_ERROR_PERSISTENCE_FAILED");
  flow.reload();
  const afterCheckpointFailure = canonicalBytes(flow);
  assert.deepEqual(Object.keys(afterCheckpointFailure).filter((key) => !afterCheckpointFailure[key].equals(beforeCheckpoint[key])), []);
  const resumedAttempt = flow.state().attempt.toJSON();
  assert.notEqual(resumedAttempt.id, originalAttempt.id);
  assert.equal(resumedAttempt.failure, null);
  assert.equal(flow.outbox("finalize-cleanup").status, "pending");
  assert.equal(flow.outbox("finalize-cleanup").idempotencyKey, originalOutbox.idempotencyKey);
  assert.equal(flow.outbox("finalize-cleanup").attempt, originalOutbox.attempt);
  const consumed = flow.outbox("finalize-cleanup").exactRecoveryReceipt.toJSON();
  assert.equal(consumed.failure, originalOutbox.failure);
  assert.equal(flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-cleanup" }), null);
  assert.equal(journal(flow).executionOrigin.identity.attempt.id, originalAttempt.id);
  assert.deepEqual(refs(flow), refsBefore);
  assert.deepEqual(flow.report("finalize-cleanup").bytes, reportBefore);
  const audit = () => JSON.parse(flow.manager.readArtifact({ specId: flow.specId,
    logicalKey: "issue.log", consumerNodeId: "finalize-cleanup" }).bytes).entries
    .filter((entry) => entry.reason.startsWith("FORCED_ORPHAN_DROP"));
  const savedAudit = audit();
  assert.equal(savedAudit.length, 1);
  release();
  const completed = await flow.runRegistered("finalize-cleanup", { force: true });
  assert.notEqual(completed.ok, false, JSON.stringify(completed));
  flow.reload();
  assert.equal(flow.state().lifecycle.state, "finalized");
  assert.equal(flow.outbox("finalize-cleanup").status, "done");
  assert.deepEqual(flow.outbox("finalize-cleanup").exactRecoveryReceipt.toJSON(), consumed);
  const ledger = flow.manager.activityLedger(flow.specId);
  assert.equal(ledger.filter((entry) => entry.transition.operation === "reopen_outbox"
    && entry.transition.outbox.id === originalOutbox.idempotencyKey).length, 1);
  const checkpoint = ledger.filter((entry) => entry.nodeId === "finalize-cleanup"
    && entry.attemptId === resumedAttempt.id && entry.result?.stepResult?.kind === "finalize-cleanup-execution-required");
  assert.equal(checkpoint.length, 1, "the missing checkpoint is created exactly once in the authorized recovered Attempt");
  assert.equal(checkpoint[0].result.stepResult.execution.expectedFeatureSha, journal(flow).featureSha);
  assert.equal(checkpoint[0].result.stepResult.execution.identity.attempt.id, resumedAttempt.id);
  assert.equal(journal(flow).executionOrigin.identity.attempt.id, originalAttempt.id);
  assert.deepEqual(audit(), savedAudit);
  assert.deepEqual(flow.report("finalize-cleanup").bytes, reportBefore);
  assert.equal(flow.git(["rev-list", "--count", `${refsBefore.main}..main`]), "1");
  assert.ok(flow.git(["show", "-s", "--format=%B", "main"]).includes(originalOutbox.idempotencyKey));
  const beforeReplay = canonicalBytes(flow);
  const completedHead = flow.git(["rev-parse", "main"]);
  const replay = await flow.runRegistered("finalize-cleanup", { force: true });
  assert.notEqual(replay.ok, false, JSON.stringify(replay));
  assert.deepEqual(replay.settlementReceipt, completed.settlementReceipt);
  assert.deepEqual(replay.forceAuthorization, completed.forceAuthorization);
  assert.deepEqual(replay.report, completed.report);
  flow.reload();
  const afterReplay = canonicalBytes(flow);
  assert.deepEqual(Object.keys(afterReplay).filter((key) => !afterReplay[key].equals(beforeReplay[key])), []);
  assert.equal(flow.git(["rev-parse", "main"]), completedHead);
  assert.deepEqual(audit(), savedAudit);
});
test("finalized receipt replay keeps its own Report when the global latest pointer selects another Spec", async (t) => {
  const flow = orphanAtCleanup(t, seed);
  const completed = await flow.runRegistered("finalize-cleanup", { force: true });
  assert.notEqual(completed.ok, false, JSON.stringify(completed));
  const originalEnvelope = JSON.parse(flow.registeredExecutions.at(-1).stdout);
  assert.ok(completed.report?.text);
  assert.ok(originalEnvelope.errors.some((entry) => entry.code === "FORCED_ORPHAN_DROP"));
  flow.reload();
  const originalReport = flow.report("finalize-cleanup").bytes;
  const beforeReplay = canonicalBytes(flow);
  const headBefore = flow.git(["rev-parse", "main"]);
  const indexBefore = flow.git(["ls-files", "--stage"]);
  const pointerPath = path.join(flow.root, POINTER_REL_PATH);
  // The repository's latest selection is independent of this authenticated
  // historical receipt. A foreign pointer exercises that boundary without
  // inventing a second canonical producer or report artifact.
  const foreignPointer = Buffer.from("999-another-finalized-flow\n");
  fs.writeFileSync(pointerPath, foreignPointer);
  const replay = await flow.runRegistered("finalize-cleanup", { force: true });
  assert.notEqual(replay.ok, false, JSON.stringify(replay));
  const replayEnvelope = JSON.parse(flow.registeredExecutions.at(-1).stdout);
  assert.deepEqual(replay.report, completed.report);
  assert.deepEqual(replay.settlementReceipt, completed.settlementReceipt);
  assert.deepEqual(replay.forceAuthorization, completed.forceAuthorization);
  assert.equal(replay.assurance, completed.assurance);
  assert.deepEqual(replay.advisorySummary, completed.advisorySummary);
  assert.equal(replay.outcome, completed.outcome);
  assert.deepEqual(replayEnvelope.errors, originalEnvelope.errors);
  flow.reload();
  const afterReplay = canonicalBytes(flow);
  assert.deepEqual(Object.keys(afterReplay).filter((key) => !afterReplay[key].equals(beforeReplay[key])), []);
  assert.deepEqual(fs.readFileSync(pointerPath), foreignPointer);
  assert.deepEqual(flow.report("finalize-cleanup").bytes, originalReport);
  assert.equal(flow.git(["rev-parse", "main"]), headBefore);
  assert.equal(flow.git(["ls-files", "--stage"]), indexBefore);
});
test("ordinary registered retry after a repaired merge conflict refuses before changing canonical state or Git", async (t) => {
  const flow = FinalizationPhaseScenario.fromSeed(t, commitSeed);
  await flow.advanceTo("finalize-merge");
  const feature = flow.state().execution.featureBranch;
  const implementationPath = "src/implementation.js";
  const featureBytes = fs.readFileSync(path.join(flow.root, implementationPath));
  assert.equal(flow.git(["ls-tree", "--name-only", "main", "--", implementationPath]), "",
    "the genuine producer added the accepted implementation only to its feature branch");
  const baseWorktree = path.join(flow.root, ".tmp", "ordinary-retry-base");
  flow.git(["worktree", "add", "--detach", baseWorktree, "main"]);
  t.after(() => {
    if (fs.existsSync(baseWorktree)) flow.git(["worktree", "remove", "--force", baseWorktree]);
  });
  fs.mkdirSync(path.join(baseWorktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(baseWorktree, implementationPath), "// Independent base implementation conflicts with accepted feature bytes.\n");
  flow.git(["-C", baseWorktree, "add", implementationPath]);
  flow.git(["-C", baseWorktree, "commit", "-m", "test: independent base add/add divergence"]);
  const previousBase = flow.git(["rev-parse", "main"]);
  const conflictingBase = flow.git(["-C", baseWorktree, "rev-parse", "HEAD"]);
  flow.git(["update-ref", "refs/heads/main", conflictingBase, previousBase]);
  const failed = await flow.runRegistered("finalize-merge");
  assert.equal(failed.ok, false);
  assert.ok(failed.errors.some((entry) => /conflict/i.test(entry.messages.join("\n"))));
  flow.reload();
  assert.equal(flow.outbox("finalize-merge").status, "failed");
  for (const leaf of ["finalize-sync", "finalize-cleanup"]) assert.equal(flow.state().findNode(leaf).status, "skipped");
  fs.writeFileSync(path.join(baseWorktree, implementationPath), featureBytes);
  flow.git(["-C", baseWorktree, "add", implementationPath]);
  flow.git(["-C", baseWorktree, "commit", "-m", "test: actual base repair before ordinary retry"]);
  flow.git(["update-ref", "refs/heads/main", flow.git(["-C", baseWorktree, "rev-parse", "HEAD"]), conflictingBase]);
  flow.git(["worktree", "remove", baseWorktree]);
  flow.reload();
  const before = canonicalBytes(flow);
  const refsBefore = refs(flow);
  const attemptBefore = flow.state().attempt.toJSON();
  const outboxBefore = flow.outbox("finalize-merge").toJSON();
  assert.equal(outboxBefore.exactRecoveryReceipt, undefined, "no exact recovery allowance has been consumed");
  const failureBefore = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-merge" }).receipt.toJSON();
  const reportBefore = flow.report("finalize-merge").bytes;
  const refused = await flow.runRegistered("finalize-merge");
  assert.equal(refused.ok, false, "ordinary retry cannot bypass the failed outbox's exact recovery");
  flow.reload();
  const afterRefusal = canonicalBytes(flow);
  assert.deepEqual(Object.keys(afterRefusal).filter((key) => !afterRefusal[key].equals(before[key])), [],
    "ordinary failed-outbox refusal cannot reset downstream or publish diagnostics before admission");
  assert.deepEqual(refs(flow), refsBefore, "refusal cannot publish a metadata-only Git commit");
  assert.deepEqual(flow.state().attempt.toJSON(), attemptBefore);
  assert.deepEqual(flow.outbox("finalize-merge").toJSON(), outboxBefore);
  assert.deepEqual(flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-merge" }).receipt.toJSON(), failureBefore);
  assert.deepEqual(flow.report("finalize-merge").bytes, reportBefore);
  for (const leaf of ["finalize-sync", "finalize-cleanup"]) assert.equal(flow.state().findNode(leaf).status, "skipped");
  const planned = await flow.next();
  assert.equal(planned.directive.actionId, "RECOVER_FINALIZE_MERGE_OUTBOX");
  flow.reload();
  const afterPlanning = canonicalBytes(flow);
  assert.deepEqual(Object.keys(afterPlanning).filter((key) => !afterPlanning[key].equals(before[key])), []);
  assert.deepEqual(refs(flow), refsBefore);
  assert.deepEqual(flow.state().attempt.toJSON(), attemptBefore);
  assert.deepEqual(flow.outbox("finalize-merge").toJSON(), outboxBefore);
});
});
