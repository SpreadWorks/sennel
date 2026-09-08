import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { CurrentAttempt } from "../../../src/flow/lib/current-flow-state.js";
import { prepareTaskReviewReconciliation, applyTaskReviewReconciliation, readTaskReviewReconciliations, assertReconciledTaskReviewInput, TaskReviewReconciliationAdmission } from "../../../src/flow/lib/task-review-reconciliation.js";
import { TaskReviewReconciliationRecord } from "../../../src/flow/lib/task-review-reconciliation-record.js";
import { readRetryBaseline, retryEvidenceRouteForNode, captureRetryRecoveryBaseline } from "../../../src/flow/lib/retry-recovery.js";
import { ReviewWorkUnit, ReviewWorkUnitOutput } from "../../../src/flow/lib/review-work-unit.js";
import { SourceMutationBaseline } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { captureCurrentTaskSource } from "../../../src/flow/lib/task-mutation-lineage.js";
import { ReviewExecutionLease } from "../../../src/flow/lib/review-execution-lease.js";
import { ReviewTargetAuthority } from "../../../src/flow/lib/review-target-authority.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunReconcileTaskReviewCommand from "../../../src/flow/lib/run-reconcile-task-review.js";

// Historical input boundary: the old recovery caller omitted the publication
// argument. Like missing-producer-artifact-recovery.test.js, use the Runtime
// APIs to recreate that persisted gap, never edit an actual Flow or its ledger.
function orphan(t) {
  const scenario = new TaskReviewScenario(t);
  scenario.manager._store.runtime.confirmAttempt({ specId: scenario.specId, activityId: "historical-artifactless-review",
    result: { outcome: "passed", summary: "Historical pre-admission result", confirmedAt: "2026-09-07T00:00:00.000Z", artifactRefs: [] } });
  scenario.manager.rewindTo("T-1-impl", { specId: scenario.specId });
  scenario.confirmImplementation("recovered implementation\n", { claimReview: false });
  const state = scenario.state();
  const node = state.findNode("T-1-review");
  assert.equal(node.status, "invalidated");
  const attempt = new CurrentAttempt({ id: "orphaned-review", nodeId: node.id, sequence: node.attemptSequence + 1,
    startedAt: "2026-09-07T01:00:00.000Z", consumption: { semantic: 0, tooling: 0 }, failure: null, blocker: null, incomplete: [],
    operationClaims: [{ operation: "resolve-command-context", resources: state.definition.contractForNode(node).resourceContract.required }] });
  scenario.manager._store.runtime.recover({ specId: scenario.specId, activityId: "historical-recovery-without-baseline", nodeId: node.id, attempt });
  const current = scenario.state();
  const unit = new ReviewWorkUnit({ executionRoot: scenario.root, runId: current.runId, specId: scenario.specId,
    phase: "impl", taskId: scenario.taskId, nodeId: node.id, attemptId: attempt.id,
    target: { treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) }, output: ReviewWorkUnitOutput.forReview({ phase: "impl", taskId: scenario.taskId }) });
  const source = captureCurrentTaskSource({ root: scenario.root, flowManager: scenario.manager, state: current, taskId: scenario.taskId });
  const baseline = SourceMutationBaseline.capture({ root: scenario.root, attempt, ignoredDirectories: [path.relative(scenario.root, unit.directory)] });
  for (const [logicalKey, document] of [["task.source", source], ["task.source-effect-baseline", baseline]]) {
    unit.writeInput({ logicalKey, logicalPath: `${logicalKey}.json`, mediaType: "application/json", bytes: Buffer.from(JSON.stringify(document.toJSON())) });
  }
  unit.finalize();
  scenario.manager.failCurrentAttempt({ specId: scenario.specId, failure: { category: "tooling", retryKind: "tooling", retryable: false,
    code: "TASK_REVIEW_PROTOCOL_INVALID_RESPONSE", message: "complete requires an object, got array after protocol attempt 2/2" } });
  scenario.changeEvidence(1);
  scenario.unit = unit;
  return scenario.reload();
}
function input(s) { return { flowManager: s.manager, specId: s.specId, root: s.root }; }
function baseline(s) { return readRetryBaseline(s.manager, s.state(), retryEvidenceRouteForNode(s.state(), "T-1-review")); }
function apply(s, proposal = prepareTaskReviewReconciliation(input(s)), extra = {}) {
  return applyTaskReviewReconciliation({ ...input(s), expectDigest: proposal.digest,
    yes: true, reason: "Explicitly adopt the inspected current unreviewed input.", ...extra });
}
function context(s) { return { ...s.context(), expectRunId: s.state().runId, expectSpec: s.specId, expectNoIssue: true }; }

test("orphan preview is read-only; reconciliation durably grants only one unreviewed Attempt", async t => {
  const s = orphan(t);
  assert.equal(baseline(s), null);
  const original = s.snapshot();
  const before = s.state();
  const oldLedger = s.manager.activityLedger(s.specId);
  const oldManifest = fs.readFileSync(s.unit.manifestPath);
  const proposal = prepareTaskReviewReconciliation(input(s));
  assert.equal(proposal.workUnits.length, 1);
  assert.equal(s.snapshot(), original);
  apply(s, proposal);
  s.reload();
  assert.equal(s.state().current.at(-1), "T-1-review");
  assert.equal(s.state().attempt.sequence, before.attempt.sequence + 1);
  assert.equal(s.state().attempt.failure, null);
  assert.equal(s.state().attempt.consumption.semantic, before.attempt.consumption.semantic);
  assert.equal(s.state().attempt.consumption.tooling, s.state().definition.contractForNode(s.state().findNode("T-1-review")).toolingRetryLimit);
  assert.equal(s.state().findNode("T-1-gate").attemptSequence, 0);
  assert.equal(s.manager.readArtifact({ specId: s.specId, logicalKey: "task.review", parameters: { taskId: s.taskId }, consumerNodeId: "T-1-gate", optional: true }), null);
  assert.deepEqual(s.manager.activityLedger(s.specId).slice(0, oldLedger.length), oldLedger);
  assert.deepEqual(fs.readFileSync(s.unit.manifestPath), oldManifest);
  assert.equal(baseline(s).attemptId, s.state().attempt.id);
  const records = readTaskReviewReconciliations({ flowManager: s.manager, state: s.state(), taskId: s.taskId });
  assert.equal(records.length, 1);
  assert.equal(records[0].previousAttempt.id, before.attempt.id);
  assert.deepEqual(records[0].proposal.workUnits, proposal.workUnits);
  assertReconciledTaskReviewInput({ ...input(s), state: s.state(), taskId: s.taskId });
  const action = await new GetNextActionCommand().execute(s.context());
  assert.equal(action.directive.kind, "execute_step", JSON.stringify(action));
  const applied = s.snapshot();
  assert.throws(() => apply(s, proposal), /does not authorize/);
  assert.equal(s.snapshot(), applied);
  s.fail().reload();
  assert.notEqual(s.state().failureDisposition().operation, "retry");
  assert.throws(() => prepareTaskReviewReconciliation(input(s)), /without a baseline or prior reconciliation/);
});

for (const change of ["source", "index", "head", "canonical"]) {
  test(`stale ${change} rejects reconciliation without publishing any state`, t => {
    const s = orphan(t);
    const preview = prepareTaskReviewReconciliation(input(s));
    if (change === "source") fs.appendFileSync(s.sourcePath, "unapproved edit\n");
    if (change === "index") execFileSync("git", ["add", "README.md"], { cwd: s.root });
    if (change === "head") execFileSync("git", ["commit", "--allow-empty", "-m", "new revision"], { cwd: s.root });
    if (change === "canonical") s.manager.setAutoApprove(true, { specId: s.specId });
    const before = s.snapshot();
    assert.throws(() => apply(s, preview), /stale/);
    assert.equal(s.snapshot(), before);
  });
}

test("confirmation, preview digest and exact target guards are mandatory", t => {
  const s = orphan(t);
  const proposal = prepareTaskReviewReconciliation(input(s));
  const before = s.snapshot();
  assert.throws(() => apply(s, proposal, { yes: false }), /requires --yes/);
  assert.throws(() => apply(s, proposal, { reason: "short" }), /invalid/);
  const result = new RunReconcileTaskReviewCommand().execute({ ...context(s), expectRunId: "wrong", dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(s.snapshot(), before);
});

test("a live Review lease refuses recovery before canonical changes", t => {
  const s = orphan(t);
  const proposal = prepareTaskReviewReconciliation(input(s));
  const lease = new ReviewExecutionLease({ mainRoot: s.root, runId: s.state().runId, nodeId: "T-1-review", attemptId: s.state().attempt.id });
  lease.acquire();
  try {
    const before = s.snapshot();
    assert.throws(() => apply(s, proposal), { code: "REVIEW_EXECUTION_BUSY" });
    assert.equal(s.snapshot(), before);
  } finally { lease.release(); }
});

test("normal exhausted Review with durable baseline is not an orphan", t => {
  const s = new TaskReviewScenario(t).exhaust();
  const before = s.snapshot();
  assert.throws(() => prepareTaskReviewReconciliation(input(s)), /without a baseline or prior reconciliation/);
  assert.equal(s.snapshot(), before);
});

for (const changed of ["source", "archived-input"]) {
  test(`post-recovery ${changed} change is blocked before worker launch`, async t => {
    const s = orphan(t);
    apply(s);
    s.reload();
    if (changed === "source") fs.appendFileSync(s.sourcePath, "later edit\n");
    else fs.appendFileSync(path.join(s.unit.directory, s.unit.manifestDocument.inputs[0].relativePath), "tampered\n");
    const before = s.snapshot();
    let calls = 0;
    const action = await new GetNextActionCommand().execute(s.context());
    assert.equal(action.directive.kind, "blocked", JSON.stringify(action));
    assert.equal(action.directive.code, "TASK_REVIEW_RECONCILIATION_INPUT_CHANGED");
    const result = await s.review(() => { calls++; throw new Error("must not launch"); }).execute(s.context());
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.equal(s.snapshot(), before);
  });
}

test("readback admits a new Review while preserving the archived old work unit", async t => {
  const s = orphan(t);
  const oldBytes = fs.readFileSync(s.unit.manifestPath);
  apply(s);
  s.reload();
  let calls = 0;
  const result = await s.review(() => { calls++; return { ok: false, status: 1, stdout: "", stderr: "deterministic stop", signal: null, killed: false }; }, {
    resolveTargetStateDigest(ctx, phase) {
      return new ReviewTargetAuthority({ executionRoot: ctx.executionRoot, artifactRoot: ctx.mainRoot, flowState: ctx.flowState, flowManager: ctx.flowManager }).captureTargetStateForPhase(phase).digest;
    },
  }).execute(s.context());
  assert.equal(calls, 1, JSON.stringify(result));
  assert.equal(result.ok, false);
  assert.deepEqual(fs.readFileSync(s.unit.manifestPath), oldBytes);
});

test("publication rechecks changed input under the catalog lock", t => {
  const s = orphan(t);
  const proposal = prepareTaskReviewReconciliation(input(s));
  const currentAttempt = { id: "reconciliation-race", nodeId: "T-1-review", sequence: s.state().attempt.sequence + 1 };
  const record = TaskReviewReconciliationRecord.create({ proposal, currentAttempt, reason: "Explicit adoption before a simulated external edit." });
  const freshBaseline = captureRetryRecoveryBaseline({ flowState: s.manager.loadReadOnly(s.specId), flowManager: s.manager,
    executionRoot: s.root, artifactRoot: s.root, nodeId: currentAttempt.nodeId, attempt: currentAttempt });
  const admission = new TaskReviewReconciliationAdmission({ ...input(s), proposal });
  fs.appendFileSync(s.sourcePath, "edit after decision\n");
  const before = s.snapshot();
  assert.throws(() => s.manager.reconcileTaskReview({ specId: s.specId, record, baseline: freshBaseline, admission }), /changed before publication/);
  assert.equal(s.snapshot(), before);
});
