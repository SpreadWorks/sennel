import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { TaskLifecycleFixture } from "../../support/infrastructure/flow-setup.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { readTaskReviewRecoveryAuthorization, readTaskReviewUnsealedCheckpoint } from "../../../src/flow/lib/task-review-recovery-checkpoint.js";
import { ReviewTargetAuthority } from "../../../src/flow/lib/review-target-authority.js";
import { ReviewWorkUnit, ReviewWorkUnitOutput } from "../../../src/flow/lib/review-work-unit.js";
import { SourceMutationBaseline, SourceMutationManifest, SourceWorkerEffect } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { captureCurrentTaskSource } from "../../../src/flow/lib/task-mutation-lineage.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../../src/lib/flow-artifact-contract.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import SetRetryCommand from "../../../src/flow/lib/set-retry.js";

function commitRuntimeEvidence(scenario, revision) {
  commitRuntimeEvidenceAt(scenario.root, revision);
}

function commitRuntimeEvidenceAt(root, revision) {
  const file = path.join(root, "runtime-checkpoint-repair.js");
  fs.writeFileSync(file, `export const revision = ${revision};\n`);
  execFileSync("git", ["add", "runtime-checkpoint-repair.js"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", `runtime checkpoint evidence ${revision}`], { cwd: root });
}

function stoppedWorker(onRun = null, { stderr = "deterministic worker stop" } = {}) {
  return (_command, _args, options) => {
    onRun?.(options);
    return { ok: false, status: 1, stdout: "", stderr, signal: null, killed: false };
  };
}

function runtimeBoundReview(scenario, worker) {
  return scenario.review(worker, {
    resolveTargetStateDigest(ctx, phase) {
      return new ReviewTargetAuthority({
        executionRoot: ctx.executionRoot,
        artifactRoot: ctx.mainRoot,
        flowState: ctx.flowState,
        flowManager: ctx.flowManager,
      }).captureTargetStateForPhase(phase).digest;
    },
  });
}

async function produceStoppedSurface(scenario) {
  let directory;
  const result = await runtimeBoundReview(scenario, stoppedWorker((options) => { directory = options.env.SENNEL_REVIEW_OUTPUT_DIR; }))
    .execute(scenario.context());
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(fs.existsSync(directory), "the stopped worker surface is retained until a parent-authorized recovery");
  return { directory, result };
}

function createRetainedTaskReviewUnit({ scenario, attempt, invalidTaskSource = false }) {
  const state = scenario.manager.loadReadOnly(scenario.specId);
  const unit = new ReviewWorkUnit({
    executionRoot: scenario.root,
    runId: state.runId,
    specId: scenario.specId,
    phase: "impl",
    taskId: scenario.taskId,
    nodeId: `${scenario.taskId}-review`,
    attemptId: attempt.id,
    target: { treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) },
    output: ReviewWorkUnitOutput.forReview({ phase: "impl", taskId: scenario.taskId }),
  });
  const taskSource = captureCurrentTaskSource({
    root: scenario.root,
    flowManager: scenario.manager,
    state,
    taskId: scenario.taskId,
  });
  const baseline = SourceMutationBaseline.capture({
    root: scenario.root,
    attempt,
    ignoredDirectories: [path.relative(scenario.root, unit.directory)],
  });
  unit.writeInput({
    logicalKey: "task.source",
    logicalPath: "task-source.json",
    bytes: Buffer.from(invalidTaskSource ? "{}\n" : `${JSON.stringify(taskSource.toJSON(), null, 2)}\n`),
    mediaType: "application/json",
  });
  unit.writeInput({
    logicalKey: "task.source-effect-baseline",
    logicalPath: "task-source-effect-baseline.json",
    bytes: Buffer.from(`${JSON.stringify(baseline.toJSON(), null, 2)}\n`),
    mediaType: "application/json",
  });
  unit.finalize();
  return unit;
}

function retainedTaskReviewDirectory({ scenario, attempt }) {
  return new ReviewWorkUnit({
    executionRoot: scenario.root,
    runId: scenario.state().runId,
    specId: scenario.specId,
    phase: "impl",
    taskId: scenario.taskId,
    nodeId: `${scenario.taskId}-review`,
    attemptId: attempt.id,
    target: { treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) },
    output: ReviewWorkUnitOutput.forReview({ phase: "impl", taskId: scenario.taskId }),
  }).directory;
}

function assertPartialEffectBlocked({ scenario, result, directory }) {
  assert.equal(result.data.failureCode, "TASK_REVIEW_PARTIAL_EFFECT");
  assert.equal(result.data.retryable, false);
  assert.equal(scenario.state().failureDisposition().operation, "blocked");
  assert.equal(fs.existsSync(directory), true, "rejected retained evidence must remain available");
}

function canonicalArtifactPath(scenario, logicalKey, parameters) {
  return path.join(
    scenario.manager.specLocation(scenario.specId).directory,
    FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters).relativePath,
  );
}

function splitCheckoutContext({ executionRoot, mainRoot, manager, specId }) {
  return {
    root: executionRoot,
    mainRoot,
    executionRoot,
    specId,
    flowManager: manager,
    flowState: manager.loadReadOnly(specId),
    config: {},
  };
}

function recoverSplitCheckout(input) {
  return new SetRetryCommand().execute({
    ...splitCheckoutContext(input),
    action: "reset",
    kind: "review",
    phase: "impl",
    reason: "Changed local fixture evidence.",
    yes: true,
  });
}

function exhaustSplitCheckout({ manager, specId }) {
  for (;;) {
    manager.failCurrentAttempt({
      specId,
      failure: {
        category: "tooling",
        retryKind: "tooling",
        retryable: true,
        code: "REVIEW_PROVIDER_UNAVAILABLE",
        message: "Deterministic split-checkout tooling failure.",
      },
    });
    if (manager.canonicalState(specId).failureDisposition().operation !== "retry") return;
    manager.retryCurrentAttempt({ specId });
  }
}

function splitCheckoutReview(worker) {
  return new RunReviewCommand({
    resolveTreeSha: () => "a".repeat(40),
    resolveTargetStateDigest(ctx, phase) {
      return new ReviewTargetAuthority({
        executionRoot: ctx.executionRoot,
        artifactRoot: ctx.mainRoot,
        flowState: ctx.flowState,
        flowManager: ctx.flowManager,
      }).captureTargetStateForPhase(phase).digest;
    },
    runCommand: worker,
  });
}

test("a normal retry removes a zero-effect stopped worker before capturing its next baseline", async (t) => {
  const scenario = new TaskReviewScenario(t);
  let directory;
  const stopped = await runtimeBoundReview(
    scenario,
    stoppedWorker((options) => { directory = options.env.SENNEL_REVIEW_OUTPUT_DIR; }, { stderr: "provider error 429 rate limit" }),
  ).execute(scenario.context());
  assert.equal(stopped.ok, false, JSON.stringify(stopped));
  assert.ok(fs.existsSync(directory), "the retryable stopped worker surface is retained before retry");
  assert.equal(scenario.state().failureDisposition().operation, "retry");
  scenario.manager.retryCurrentAttempt({ specId: scenario.specId });
  scenario.reload();

  let calls = 0;
  const result = await runtimeBoundReview(scenario, stoppedWorker(() => { calls += 1; })).execute(scenario.context());
  assert.equal(calls, 1, JSON.stringify(result));
  assert.equal(fs.existsSync(directory), false, "parent cleanup must not be attributed to the replacement worker");
  assert.notEqual(result.data?.failureCode, "TASK_REVIEW_PARTIAL_EFFECT");
});

test("receipt-authorized Task Review checkout checkpoint survives reload and cleans one exact old worker", async (t) => {
  const scenario = new TaskReviewScenario(t).exhaust();
  commitRuntimeEvidence(scenario, 1);
  const initialRecovery = scenario.recover();
  assert.equal(initialRecovery.reset, true, JSON.stringify(initialRecovery));
  scenario.reload();
  const { directory, result: stopped } = await produceStoppedSurface(scenario);
  const failed = scenario.state();
  const checkpoint = readTaskReviewUnsealedCheckpoint({
    flowManager: scenario.manager, state: failed, taskId: scenario.taskId, root: scenario.root,
  });
  assert.notEqual(checkpoint, null, `the parent failure transaction stores the zero-effect checkpoint: ${JSON.stringify({ failure: failed.attempt.failure, stopped })}`);

  commitRuntimeEvidence(scenario, 2);
  scenario.reload();
  const checkpointRecovery = scenario.recover();
  assert.equal(checkpointRecovery.reset, true, JSON.stringify(checkpointRecovery));
  scenario.reload();
  const authorization = readTaskReviewRecoveryAuthorization({
    flowManager: scenario.manager, state: scenario.state(), taskId: scenario.taskId, root: scenario.root,
  });
  assert.equal(authorization.checkpointDigest, checkpoint.digest);
  assert.equal(authorization.previousAttempt.id, failed.attempt.id);
  assert.equal(authorization.currentAttempt.id, scenario.state().attempt.id);

  let calls = 0;
  const result = await runtimeBoundReview(scenario, stoppedWorker(() => { calls += 1; })).execute(scenario.context());
  assert.equal(calls, 1, JSON.stringify(result));
  assert.equal(fs.existsSync(directory), false, "only the receipt-bound old worker is cleaned");
});

test("an authorization snapshot rejects a later commit without deleting its retained worker", async (t) => {
  const scenario = new TaskReviewScenario(t).exhaust();
  commitRuntimeEvidence(scenario, 1);
  assert.equal(scenario.recover().reset, true);
  scenario.reload();
  const { directory } = await produceStoppedSurface(scenario);
  commitRuntimeEvidence(scenario, 2);
  scenario.reload();
  assert.equal(scenario.recover().reset, true);
  commitRuntimeEvidence(scenario, 3);
  scenario.reload();

  let calls = 0;
  const result = await runtimeBoundReview(scenario, stoppedWorker(() => { calls += 1; })).execute(scenario.context());
  assert.equal(calls, 0, JSON.stringify(result));
  assertPartialEffectBlocked({ scenario, result, directory });
});

test("an authorization snapshot rejects a post-grant Task-owned source edit", async (t) => {
  const scenario = new TaskReviewScenario(t).exhaust();
  commitRuntimeEvidence(scenario, 1);
  assert.equal(scenario.recover().reset, true);
  scenario.reload();
  const { directory } = await produceStoppedSurface(scenario);
  commitRuntimeEvidence(scenario, 2);
  scenario.reload();
  assert.equal(scenario.recover().reset, true);
  fs.appendFileSync(scenario.sourcePath, "unowned post-grant Task edit\n");
  scenario.reload();

  let calls = 0;
  const result = await runtimeBoundReview(scenario, stoppedWorker(() => { calls += 1; })).execute(scenario.context());
  assert.equal(calls, 0, JSON.stringify(result));
  assertPartialEffectBlocked({ scenario, result, directory });
});

test("a checkpoint rejects a Task-owned source edit before recovery authorization", async (t) => {
  const scenario = new TaskReviewScenario(t).exhaust();
  commitRuntimeEvidence(scenario, 1);
  assert.equal(scenario.recover().reset, true);
  scenario.reload();
  const { directory } = await produceStoppedSurface(scenario);
  fs.appendFileSync(scenario.sourcePath, "unowned pre-grant Task edit\n");
  scenario.reload();

  const before = scenario.state().attempt.id;
  const recovery = scenario.recover();
  assert.equal(recovery.ok, false, JSON.stringify(recovery));
  assert.equal(recovery.errors[0].code, "RETRY_NOT_AVAILABLE");
  assert.equal(scenario.state().attempt.id, before, "rejected recovery must not advance the stopped Attempt");
  assert.equal(fs.existsSync(directory), true, "a pre-authorization Task edit must retain the stopped worker");
});

test("a catalog-bound checkpoint rejects changed bytes", async (t) => {
  const scenario = new TaskReviewScenario(t).exhaust();
  commitRuntimeEvidence(scenario, 1);
  assert.equal(scenario.recover().reset, true);
  scenario.reload();
  await produceStoppedSurface(scenario);
  const state = scenario.state();
  const artifact = canonicalArtifactPath(scenario, "task.review.unsealed.checkpoint", {
    taskId: scenario.taskId,
    attemptId: state.attempt.id,
  });
  fs.appendFileSync(artifact, " ");

  assert.throws(
    () => readTaskReviewUnsealedCheckpoint({ flowManager: scenario.manager, state, taskId: scenario.taskId, root: scenario.root }),
    /hash|digest|artifact/i,
  );
});

test("a catalog-bound recovery authorization rejects changed bytes", async (t) => {
  const scenario = new TaskReviewScenario(t).exhaust();
  commitRuntimeEvidence(scenario, 1);
  assert.equal(scenario.recover().reset, true);
  scenario.reload();
  await produceStoppedSurface(scenario);
  commitRuntimeEvidence(scenario, 2);
  scenario.reload();
  assert.equal(scenario.recover().reset, true);
  scenario.reload();
  const state = scenario.state();
  const artifact = canonicalArtifactPath(scenario, "task.review.recovery.authorization", {
    taskId: scenario.taskId,
    attemptId: state.attempt.id,
  });
  fs.appendFileSync(artifact, " ");

  assert.throws(
    () => readTaskReviewRecoveryAuthorization({ flowManager: scenario.manager, state, taskId: scenario.taskId, root: scenario.root }),
    /hash|digest|artifact/i,
  );
});

test("an external execution checkout cleans the exact authorized worker", async (t) => {
  const mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-review-main-"));
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-review-execution-"));
  t.after(() => fs.rmSync(mainRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(executionRoot, { recursive: true, force: true }));
  for (const root of [mainRoot, executionRoot]) {
    fs.writeFileSync(path.join(root, "README.md"), "original source\n");
    initGitRepo(root);
    commitAll(root, "split checkout source");
  }
  const manager = new FlowManager({ root: executionRoot, mainRoot, inWorktree: true });
  const specId = "001-split-checkout";
  const taskId = "T-1";
  new TaskLifecycleFixture({
    flowManager: manager,
    specId,
    runId: "split-checkout-review",
    execution: { mode: "worktree", baseBranch: "main", featureBranch: "feature/split-checkout-review" },
    taskId,
    targetStep: "task-impl",
    specRecord: {
      requirements: [{ id: "R-1", desc: "Preserve exact Task Review recovery ownership.", task_ids: [taskId] }],
      overview: { modules: [], data_flow: [], decisions: [] },
    },
    taskDocuments: [{ id: taskId, title: "Split checkout", goal: "Keep recovery checkout-bound.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
  }).create();
  const baseline = SourceMutationBaseline.capture({ root: executionRoot, attempt: manager.canonicalState(specId).attempt });
  fs.writeFileSync(path.join(executionRoot, "README.md"), "implemented source\n");
  const manifest = SourceMutationManifest.capture({ baseline });
  manager.confirmSourceWorkerHandoff({
    specId,
    mutationManifest: manifest,
    handoffDigest: "c".repeat(64),
    effect: new SourceWorkerEffect({
      version: 1,
      stepId: "task-impl",
      completionStatus: "done",
      files: [{ requirementId: "R-1", mutationIds: manifest.mutations.map((entry) => entry.mutationId) }],
      issues: [],
      overview: { modules: [], data_flow: [], decisions: [] },
      triage: null,
      repair: null,
    }),
    result: { outcome: "passed", summary: "Split checkout implementation fixture", confirmedAt: "2026-09-08T00:00:00.000Z", artifactRefs: [] },
  });
  manager.updateStepStatus({ stepId: `${taskId}-review`, requestedStatus: "in_progress" }, { specId });
  exhaustSplitCheckout({ manager, specId });
  commitRuntimeEvidenceAt(executionRoot, 1);
  assert.equal(recoverSplitCheckout({ executionRoot, mainRoot, manager, specId }).reset, true);

  let directory;
  const stopped = await splitCheckoutReview(stoppedWorker((options) => {
    directory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
  })).execute(splitCheckoutContext({ executionRoot, mainRoot, manager, specId }));
  assert.equal(stopped.ok, false, JSON.stringify(stopped));
  assert.ok(fs.existsSync(directory), "the external checkout owns the stopped worker surface");
  commitRuntimeEvidenceAt(executionRoot, 2);
  assert.equal(recoverSplitCheckout({ executionRoot, mainRoot, manager, specId }).reset, true);

  let calls = 0;
  const result = await splitCheckoutReview(stoppedWorker(() => { calls += 1; }))
    .execute(splitCheckoutContext({ executionRoot, mainRoot, manager, specId }));
  assert.equal(calls, 1, JSON.stringify(result));
  assert.equal(fs.existsSync(directory), false, "only the external checkout's exact authorized worker is removed");
});

test("a legacy unsealed worker without a checkpoint rejects a changed HEAD", async (t) => {
  const scenario = new TaskReviewScenario(t);
  const previousAttempt = scenario.state().attempt;
  scenario.fail();
  scenario.manager.retryCurrentAttempt({ specId: scenario.specId });
  scenario.reload();
  const retained = createRetainedTaskReviewUnit({ scenario, attempt: previousAttempt });
  commitRuntimeEvidence(scenario, 1);
  scenario.reload();

  let calls = 0;
  const result = await runtimeBoundReview(scenario, stoppedWorker(() => { calls += 1; })).execute(scenario.context());
  assert.equal(calls, 0, JSON.stringify(result));
  assertPartialEffectBlocked({ scenario, result, directory: retained.directory });
});

test("a later retained-worker verification failure preserves earlier cleanup candidates", async (t) => {
  const scenario = new TaskReviewScenario(t).exhaust();
  commitRuntimeEvidence(scenario, 1);
  assert.equal(scenario.recover().reset, true);
  scenario.reload();
  const failedAttempts = scenario.manager.activityLedger(scenario.specId)
    .filter((activity) => activity.transition.operation === "fail_attempt" && activity.nodeId === `${scenario.taskId}-review`)
    .map((activity) => ({ id: activity.attemptId, nodeId: activity.nodeId, sequence: activity.sequence }))
    .filter((attempt) => typeof attempt.id === "string" && Number.isSafeInteger(attempt.sequence))
    .filter((attempt, index, attempts) => attempts.findIndex((candidate) => candidate.id === attempt.id) === index);
  assert.ok(failedAttempts.length >= 2, "exhausted recovery supplies two prior canonical Task Review Attempts");

  const [first, second] = failedAttempts.slice(-2).sort((left, right) => (
    retainedTaskReviewDirectory({ scenario, attempt: left })
      .localeCompare(retainedTaskReviewDirectory({ scenario, attempt: right }))
  ));
  const retainedSecond = createRetainedTaskReviewUnit({ scenario, attempt: second, invalidTaskSource: true });
  const retainedFirst = createRetainedTaskReviewUnit({ scenario, attempt: first });

  let calls = 0;
  const result = await runtimeBoundReview(scenario, stoppedWorker(() => { calls += 1; })).execute(scenario.context());
  assert.equal(calls, 0, JSON.stringify(result));
  assertPartialEffectBlocked({ scenario, result, directory: retainedFirst.directory });
  assert.equal(result.data.workUnit, path.relative(scenario.root, retainedSecond.directory).split(path.sep).join("/"),
    "the rejection must reach the later invalid unit, not stop at the earlier cleanup candidate");
  assert.match(result.errors[0].messages.join("\n"), /source checkpoint cannot be restored against canonical lineage/);
});
