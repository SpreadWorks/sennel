import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import SetRetryCommand from "../../../src/flow/lib/set-retry.js";
import {
  readRetryBaseline,
  retryEvidenceRouteForNode,
  RetryRecoveryArtifactPublication,
  RetryRecoveryBaseline,
  RetryRecoveryReceipt,
} from "../../../src/flow/lib/retry-recovery.js";
import { CanonicalFlowFixture, makeFlowManager, TaskLifecycleFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const roots = [];

afterEach(() => {
  while (roots.length > 0) removeTmpDir(roots.pop());
});

function retryFixture({ nodeId = "test-review", failureKind = "semantic" } = {}) {
  const root = createTmpDir("set-retry-v1-");
  roots.push(root);
  const manager = makeFlowManager(root);
  const flow = new CanonicalFlowFixture({
    flowManager: manager,
    specId: "001-retry",
    runId: `retry-${nodeId}-${failureKind}`,
  }).create().registerActive().activate(nodeId);
  manager.failCurrentAttempt({
    specId: flow.specId,
    failure: {
      category: failureKind === "semantic" ? "semantic" : "provider",
      code: failureKind === "semantic" ? "REVIEW_REJECTED" : "REVIEW_PROVIDER_UNAVAILABLE",
      message: "The retryable command result is represented by the active typed Attempt.",
      retryable: true,
      retryKind: failureKind,
    },
  });
  return { manager, flow, root };
}

function commandInput(flow, values = {}) {
  return {
    action: "reset",
    kind: "review",
    phase: "test",
    reason: "The failed Attempt is retried through the Version-1 lifecycle.",
    yes: true,
    flowState: flow.manager.load(flow.flow.specId),
    flowManager: flow.manager,
    root: flow.root,
    executionRoot: flow.root,
    ...values,
  };
}

function taskReviewRetryFixture({ taskId = "T-1" } = {}) {
  const root = createTmpDir("set-retry-task-v1-");
  roots.push(root);
  const manager = makeFlowManager(root);
  const flow = new TaskLifecycleFixture({
    flowManager: manager,
    specId: "001-task-retry",
    runId: "retry-task-review-tooling",
    taskId,
    targetStep: "task-review",
    taskDocuments: [{
      id: taskId,
      title: "Task retry baseline",
      goal: "Exercise task-scoped review recovery.",
      parent: null,
      origin: "plan",
      added_round: 0,
      status: "pending",
    }],
  }).create();
  manager.failCurrentAttempt({
    specId: "001-task-retry",
    failure: {
      category: "provider",
      code: "REVIEW_PROVIDER_UNAVAILABLE",
      message: "The task review provider is temporarily unavailable.",
      retryable: true,
      retryKind: "tooling",
    },
  });
  return { manager, flow: flow.flow, root };
}

function immutableRetryPublicationSnapshot(manager, specId) {
  return JSON.stringify({
    state: manager.canonicalState(specId).toJSON(),
    activities: manager.activityLedger(specId).map((activity) => activity?.toJSON?.() ?? activity),
    catalog: manager.artifactCatalog(specId).toJSON(),
  });
}

test("retry reset appends exactly one canonical semantic retry Activity", () => {
  const flow = retryFixture();
  const command = new SetRetryCommand();
  const before = flow.manager.activityLedger(flow.flow.specId).length;

  const result = command.execute(commandInput(flow));

  assert.equal(result.reset, true, JSON.stringify(result));
  assert.equal(result.grants.length, 1);
  assert.equal(result.grants[0].operation, "retry_attempt");
  assert.equal(flow.manager.activityLedger(flow.flow.specId).length, before + 1);
  const state = flow.manager.canonicalState(flow.flow.specId);
  assert.equal(state.attempt.sequence, 2);
  assert.equal(state.attempt.consumption.semantic, 1);
  assert.equal(state.attempt.failure, null);
  assert.equal(Object.hasOwn(flow.manager.load(flow.flow.specId), "retryRecovery"), false);
});

test("retry reset preserves tooling retry accounting in the replacement Attempt", () => {
  const flow = retryFixture({ failureKind: "tooling" });

  const result = new SetRetryCommand().execute(commandInput(flow));

  assert.equal(result.grants[0].sequence, 2);
  const state = flow.manager.canonicalState(flow.flow.specId);
  assert.equal(state.attempt.consumption.semantic, 0);
  assert.equal(state.attempt.consumption.tooling, 1);
  assert.equal(flow.manager.activityLedger(flow.flow.specId).at(-1).transition.operation, "retry_attempt");
});

test("retry reset rejects a route that does not identify the active Attempt", () => {
  const flow = retryFixture();
  const before = flow.manager.activityLedger(flow.flow.specId);

  const result = new SetRetryCommand().execute(commandInput(flow, { phase: "impl" }));

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "RETRY_NOT_AVAILABLE");
  assert.match(result.errors[0].messages.join(" "), /target is not active/);
  assert.deepEqual(flow.manager.activityLedger(flow.flow.specId), before);
});

test("retry reset fails closed after the definition-owned retry budget is exhausted", () => {
  const flow = retryFixture();
  const command = new SetRetryCommand();
  let result = null;
  for (let retry = 0; retry < 10; retry += 1) {
    result = command.execute(commandInput(flow));
    if (result.ok === false) break;
    flow.manager.failCurrentAttempt({
      specId: flow.flow.specId,
      failure: {
        category: "semantic",
        code: "REVIEW_REJECTED",
        message: "The retry budget was consumed by the previous canonical Attempt.",
        retryable: true,
        retryKind: "semantic",
      },
      commandResult: { artifacts: { targetStateDigest: "b".repeat(64), treeSha: "c".repeat(40) } },
    });
  }
  const before = flow.manager.activityLedger(flow.flow.specId);

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "RETRY_NOT_AVAILABLE");
  assert.match(result.errors[0].messages.join(" "), /tooling failures|changed evidence/);
  assert.deepEqual(flow.manager.activityLedger(flow.flow.specId), before);
});

test("retry reset records one changed-evidence recovery after exhaustion", () => {
  const flow = retryFixture({ failureKind: "tooling" });
  const command = new SetRetryCommand();
  let result = null;
  for (let retry = 0; retry < 10; retry += 1) {
    result = command.execute(commandInput(flow));
    if (result.ok === false) break;
    flow.manager.failCurrentAttempt({
      specId: flow.flow.specId,
      failure: {
        category: "provider",
        code: "REVIEW_PROVIDER_UNAVAILABLE",
        message: "The retry budget was consumed by the previous canonical Attempt.",
        retryable: true,
        retryKind: "tooling",
      },
      commandResult: { artifacts: { targetStateDigest: "b".repeat(64), treeSha: "c".repeat(40) } },
    });
  }
  fs.writeFileSync(path.join(flow.root, "retry-recovery-changed.js"), "export const changed = true;\n");
  assert.equal(result.ok, false);
  const before = flow.manager.activityLedger(flow.flow.specId).length;
  const recovered = command.execute(commandInput(flow));
  assert.equal(recovered.reset, true, JSON.stringify(recovered));
  assert.equal(recovered.grants[0].operation, "retry_recovery_attempt");
  assert.equal(flow.manager.activityLedger(flow.flow.specId).length, before + 1);
  const state = flow.manager.canonicalState(flow.flow.specId);
  assert.equal(state.failureDisposition(), null);
  assert.equal(state.attempt.failure, null);
  assert.equal(flow.manager.activityLedger(flow.flow.specId).at(-1).transition.operation, "retry_recovery_attempt");
  const replay = command.execute(commandInput(flow));
  assert.equal(replay.ok, false);
  assert.match(replay.errors[0].messages.join(" "), /failed active Attempt|retryable|available/);
});

test("generic artifact publication cannot forge a Task retry recovery route or receipt", () => {
  const flow = taskReviewRetryFixture({ taskId: "T-2" });
  const before = immutableRetryPublicationSnapshot(flow.manager, flow.flow.specId);

  for (const logicalKey of ["retry.recovery.baseline", "retry.recovery.receipt"]) {
    assert.throws(
      () => flow.manager.publishArtifacts({
        specId: flow.flow.specId,
        nodeId: "T-2-review",
        artifactWrites: [{
          logicalKey,
          parameters: { routeId: "review-impl-T-1", attemptId: "forged-attempt" },
          mediaType: "application/json",
          bytes: Buffer.from("{}\n"),
        }],
      }),
      /dedicated canonical retry transition/,
    );
    assert.equal(immutableRetryPublicationSnapshot(flow.manager, flow.flow.specId), before);
  }
});

test("runtime rejects a typed Task retry baseline whose route names another Task", () => {
  const flow = taskReviewRetryFixture({ taskId: "T-2" });
  const failed = flow.manager.canonicalState(flow.flow.specId);
  const specId = failed.specId;
  const candidate = failed.attempt.toJSON();
  candidate.id = "forged-task-retry-attempt";
  candidate.sequence += 1;
  candidate.startedAt = new Date().toISOString();
  candidate.consumption = { ...candidate.consumption, tooling: candidate.consumption.tooling + 1 };
  candidate.failure = null;
  const forged = new RetryRecoveryBaseline({
    route: { kind: "review", phase: "impl", taskId: "T-1" },
    attemptId: candidate.id,
    attempt: candidate.sequence,
    runId: failed.runId,
    specId: failed.specId,
    issue: failed.issue ?? null,
    projectDigest: "a".repeat(64),
    runtimeDigest: "b".repeat(64),
    targetDigest: "c".repeat(64),
  });
  const before = immutableRetryPublicationSnapshot(flow.manager, specId);

  assert.throws(
    () => flow.manager._store.runtime.retryAttempt({
      specId,
      activityId: "forged-task-retry-activity",
      attempt: candidate,
      retryRecoveryPublication: RetryRecoveryArtifactPublication.baseline(forged),
    }),
    /route does not match its owning Activity/,
  );
  assert.equal(immutableRetryPublicationSnapshot(flow.manager, specId), before);
});

test("task review retries recover from the exact exhausted Attempt baseline after source evidence changes", () => {
  const flow = taskReviewRetryFixture();
  const command = new SetRetryCommand();
  let result = null;
  for (let retry = 0; retry < 10; retry += 1) {
    result = command.execute(commandInput(flow, { phase: "impl" }));
    if (result.ok === false) break;
    flow.manager.failCurrentAttempt({
      specId: flow.flow.specId,
      failure: {
        category: "provider",
        code: "REVIEW_PROVIDER_UNAVAILABLE",
        message: "The task review provider exhausted its definition-owned retry budget.",
        retryable: true,
        retryKind: "tooling",
      },
    });
  }
  assert.equal(result.ok, false, JSON.stringify(result));
  fs.writeFileSync(path.join(flow.root, "task-review-recovery-change.js"), "export const changed = true;\n");
  const exhausted = flow.manager.canonicalState(flow.flow.specId);
  const route = retryEvidenceRouteForNode(exhausted, exhausted.attempt.nodeId);
  assert.notEqual(route, null, JSON.stringify({
    current: exhausted.current,
    currentTaskId: exhausted.currentTaskId,
    attempt: exhausted.attempt.toJSON(),
  }));
  const baseline = readRetryBaseline(flow.manager, exhausted, route);
  assert.notEqual(baseline, null, JSON.stringify({
    route: route.toJSON(),
    attempt: exhausted.attempt.toJSON(),
    baselines: flow.manager.artifactCatalog(flow.flow.specId).artifacts
      .filter((entry) => entry.logicalKey === "retry.recovery.baseline")
      .map((entry) => entry.toJSON()),
  }));

  const recovered = command.execute(commandInput(flow, { phase: "impl" }));

  assert.equal(recovered.reset, true, JSON.stringify(recovered));
  assert.equal(recovered.grants[0].operation, "retry_recovery_attempt");
  const reloaded = makeFlowManager(flow.root);
  const reloadedState = reloaded.canonicalState(flow.flow.specId);
  const receiptArtifact = reloaded.readArtifact({
    specId: flow.flow.specId,
    logicalKey: "retry.recovery.receipt",
    parameters: { routeId: "review-impl-T-1", attemptId: reloadedState.attempt.id },
    consumerNodeId: "T-1-review",
    optional: true,
  });
  assert.notEqual(receiptArtifact, null);
  const receipt = new RetryRecoveryReceipt(JSON.parse(receiptArtifact.bytes.toString("utf8")));
  assert.deepEqual(receipt.current.route.toJSON(), { kind: "review", phase: "impl", taskId: "T-1" });
  assert.equal(receipt.current.attemptId, reloadedState.attempt.id);
  assert.equal(receipt.current.attempt, reloadedState.attempt.sequence);
  assert.equal(receipt.current.runId, reloadedState.runId);
  assert.equal(receipt.current.specId, reloadedState.specId);
});
