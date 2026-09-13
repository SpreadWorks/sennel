import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import SetRetryCommand from "../../../src/flow/lib/set-retry.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import GetStatusCommand from "../../../src/flow/lib/get-status.js";
import {
  ExhaustedReviewRetryRecoveryAdmission,
  inspectRetryRecoveryPlan,
  readRetryBaseline,
  readRetryRecoveryReceipt,
  retryEvidenceRouteForNode,
  RetryRecoveryArtifactPublication,
  RetryRecoveryBaseline,
  RetryRecoveryObservation,
  RetryRecoveryReceipt,
} from "../../../src/flow/lib/retry-recovery.js";
import { RetryRecoveryBasis } from "../../../src/flow/definition.js";
import {
  canonicalDraftDocument,
  canonicalFixtureProducerResult,
  CanonicalFlowFixture,
  makeFlowManager,
  removeCatalogedArtifactForCorruptionFixture,
  TaskLifecycleFixture,
} from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { AgentProcessStopEvidence, AgentTimeoutFailure } from "../../../src/lib/agent-failure.js";
import { ReviewFailure } from "../../../src/flow/lib/review-failure.js";
import {
  readTaskReviewUnsealedCheckpoint,
  TaskReviewRecoveryAuthorization,
} from "../../../src/flow/lib/task-review-recovery-checkpoint.js";

const roots = [];
const execFileAsync = promisify(execFile);
const FLOW_MANAGER_MODULE = new URL("../../../src/lib/flow-manager.js", import.meta.url).href;
const SET_RETRY_MODULE = new URL("../../../src/flow/lib/set-retry.js", import.meta.url).href;

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
  }).create().registerActive();
  if (nodeId.startsWith("draft-")) {
    const draft = Buffer.from(`${JSON.stringify(canonicalDraftDocument(), null, 2)}\n`);
    flow.activate("draft");
    manager.confirmCurrentAttempt({
      specId: flow.specId,
      artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: draft }],
    });
    if (nodeId === "draft-coverage-review") {
      flow.settleBefore("draft-refine").activate("draft-refine", { settlePredecessors: false });
      manager.confirmCurrentAttempt({
        specId: flow.specId,
        artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: draft }],
      });
    }
  }
  flow.activate(nodeId);
  if (failureKind !== null) {
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
  }
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

test("retry receipt basis is a typed invariant of its evidence lineage", () => {
  const previous = new RetryRecoveryBaseline({
    route: { kind: "review", phase: "test", taskId: null },
    attemptId: "attempt-1",
    attempt: 1,
    runId: "run-basis",
    specId: "001-basis",
    issue: null,
    projectDigest: "a".repeat(64),
    runtimeDigest: "b".repeat(64),
    targetDigest: "c".repeat(64),
  });
  const current = new RetryRecoveryBaseline({
    ...previous.toJSON(),
    attemptId: "attempt-2",
    attempt: 2,
  });
  assert.throws(
    () => new RetryRecoveryReceipt({
      previous,
      current,
      reason: "A changed-input receipt cannot claim unchanged evidence.",
      reevaluationCount: 1,
      basis: RetryRecoveryBasis.changedInput(),
    }),
    /basis changed-input does not match/,
  );
});

test("a non-Review canonical timeout does not require Review process-stop evidence", () => {
  const root = createTmpDir("non-review-timeout-");
  roots.push(root);
  const manager = makeFlowManager(root);
  const flow = new CanonicalFlowFixture({
    flowManager: manager,
    specId: "001-gate-timeout",
    runId: "run-gate-timeout",
  }).create().registerActive().activate("spec-gate");

  manager.failCurrentAttempt({
    specId: flow.specId,
    failure: {
      category: "provider",
      code: "AGENT_TIMEOUT",
      message: "Gate provider timed out without Review supervisor evidence.",
      retryable: false,
      retryKind: null,
    },
  });

  const failure = makeFlowManager(root).canonicalState(flow.specId).attempt.failure;
  assert.equal(failure.code, "AGENT_TIMEOUT");
  assert.equal(failure.agentStopEvidence, null);
  assert.equal(failure.retryable, false);
  assert.equal(makeFlowManager(root).canonicalState(flow.specId).failureDisposition().operation, "resolve-step-definition");
});

test("a Review timeout without stop evidence stays blocked through all reload projections", async () => {
  const fixture = retryFixture({ nodeId: "test-review", failureKind: null });
  fixture.manager.failCurrentAttempt({
    specId: fixture.flow.specId,
    failure: {
      category: "tooling",
      code: "AGENT_TIMEOUT",
      message: "The Review provider deadline elapsed without supervisor stop evidence.",
      retryable: true,
      retryKind: "tooling",
    },
  });

  const reloaded = makeFlowManager(fixture.root);
  const state = reloaded.canonicalState(fixture.flow.specId);
  const before = immutableRetryPublicationSnapshot(reloaded, fixture.flow.specId);
  const context = {
    ...commandInput(fixture),
    flowManager: reloaded,
    flowState: reloaded.loadReadOnly(fixture.flow.specId),
  };
  const status = new GetStatusCommand().execute(context);
  const next = await new GetNextActionCommand().execute(context);
  const result = new SetRetryCommand().execute(context);

  assert.equal(state.attempt.failure.agentStopEvidence, null);
  assert.equal(state.failureDisposition().operation, "blocked");
  assert.equal(status.recoveryDiagnostics?.review?.recoveryPossible ?? false, false);
  assert.notEqual(next.directive?.actionId, "RECOVER_EXHAUSTED_TOOLING_RETRY", JSON.stringify(next));
  assert.notEqual(next.directive?.kind, "retry", JSON.stringify(next));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].messages.join(" "), /trusted confirmed timeout|uncertain/i);
  assert.equal(immutableRetryPublicationSnapshot(reloaded, fixture.flow.specId), before);
});

test("generic Review failure projects the established default retry policy consistently", async (t) => {
  const scenario = new TaskReviewScenario(t);
  const result = await scenario.review(() => {
    const failure = new Error("provider disconnected before Review output");
    failure.code = "REVIEW_PROVIDER_UNAVAILABLE";
    throw failure;
  }).execute(scenario.context());

  scenario.reload();
  const failure = scenario.state().attempt.failure;
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "REVIEW_TOOLING_ERROR");
  assert.equal(result.data.retryable, true);
  assert.equal(failure.code, "REVIEW_PROVIDER_UNAVAILABLE");
  assert.equal(failure.retryable, true);
  assert.equal(failure.retryKind, "tooling");
  assert.equal(scenario.state().failureDisposition().operation, "retry");
});

test("terminal generic Review failure retains its established tooling accounting kind", async (t) => {
  const scenario = new TaskReviewScenario(t);
  const result = await scenario.review(() => {
    const failure = new Error("provider authentication was rejected before Review output");
    failure.code = "AGENT_AUTHENTICATION_FAILED";
    failure.retryable = false;
    throw failure;
  }).execute(scenario.context());

  scenario.reload();
  const failure = scenario.state().attempt.failure;
  assert.equal(result.data.retryable, false);
  assert.equal(failure.retryable, false);
  assert.equal(failure.retryKind, "tooling");
  assert.equal(scenario.state().failureDisposition().operation, "record");
});

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

for (const { nodeId, phase } of [
  { nodeId: "draft-questions-review", phase: "draft-questions" },
  { nodeId: "draft-coverage-review", phase: "draft-coverage" },
  { nodeId: "spec-review", phase: "spec" },
  { nodeId: "test-review", phase: "test" },
  { nodeId: "impl-review", phase: "impl" },
]) {
  test(`${nodeId} grants one unchanged exhausted recovery for confirmed timeout evidence`, () => {
    const fixture = retryFixture({ nodeId, failureKind: "tooling" });
    const input = () => commandInput(fixture, { phase });
    const command = new SetRetryCommand();
    let recovered = command.execute(input());
    assert.equal(recovered.grants[0].operation, "retry_attempt");
    for (let attempt = 0; attempt < 10 && recovered.grants[0].operation !== "retry_recovery_attempt"; attempt += 1) {
      fixture.manager.failCurrentAttempt({
        specId: fixture.flow.specId,
        failure: {
          category: "tooling",
          code: "AGENT_TIMEOUT",
          message: "The provider process tree was confirmed stopped.",
          retryable: true,
          retryKind: "tooling",
          agentStopEvidence: AgentProcessStopEvidence.confirmed(),
        },
      });
      recovered = command.execute(input());
      assert.notEqual(recovered.ok, false, JSON.stringify(recovered));
    }

    assert.equal(recovered.grants[0].operation, "retry_recovery_attempt", JSON.stringify(recovered));
    const reloaded = makeFlowManager(fixture.root);
    const state = reloaded.canonicalState(fixture.flow.specId);
    const route = retryEvidenceRouteForNode(state, state.attempt.nodeId);
    assert.equal(route.toJSON().phase, phase);
    const receiptArtifact = reloaded.readArtifact({
      specId: state.specId,
      logicalKey: "retry.recovery.receipt",
      parameters: { routeId: `review-${phase}`, attemptId: state.attempt.id },
      consumerNodeId: state.attempt.nodeId,
    });
    const receipt = new RetryRecoveryReceipt(JSON.parse(receiptArtifact.bytes));
    assert.equal(receipt.basis instanceof RetryRecoveryBasis, true);
    assert.equal(receipt.basis.confirmedTimeout, true);

    reloaded.failCurrentAttempt({
      specId: state.specId,
      failure: {
        category: "tooling",
        code: "AGENT_TIMEOUT",
        message: "The recovered provider process tree was confirmed stopped again.",
        retryable: true,
        retryKind: "tooling",
        agentStopEvidence: AgentProcessStopEvidence.confirmed(),
      },
    });
    const duplicate = new SetRetryCommand().execute({
      ...input(),
      flowManager: reloaded,
      flowState: reloaded.loadReadOnly(state.specId),
    });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.errors[0].messages[0], /already consumed this evidence lineage/);
  });
}

test("status and next-action project unchanged confirmed-timeout recovery", async () => {
  const fixture = retryFixture({ failureKind: "tooling" });
  const command = new SetRetryCommand();
  assert.equal(command.execute(commandInput(fixture)).grants[0].operation, "retry_attempt");
  for (let count = 0; count < 10; count += 1) {
    fixture.manager.failCurrentAttempt({
      specId: fixture.flow.specId,
      failure: {
        category: "tooling",
        code: "AGENT_TIMEOUT",
        message: "The provider process tree was confirmed stopped.",
        retryable: true,
        retryKind: "tooling",
        agentStopEvidence: AgentProcessStopEvidence.confirmed(),
      },
    });
    if (fixture.manager.canonicalState(fixture.flow.specId).failureDisposition().operation !== "retry") break;
    assert.equal(command.execute(commandInput(fixture)).grants[0].operation, "retry_attempt");
  }
  const context = {
    root: fixture.root,
    mainRoot: fixture.root,
    executionRoot: fixture.root,
    specId: fixture.flow.specId,
    flowManager: fixture.manager,
    flowState: fixture.manager.loadReadOnly(fixture.flow.specId),
  };

  const status = new GetStatusCommand().execute(context);
  const next = await new GetNextActionCommand().execute(context);

  const canonical = context.flowManager.canonicalState(context.specId);
  const route = retryEvidenceRouteForNode(canonical, canonical.attempt.nodeId);
  assert.notEqual(route, null);
  assert.notEqual(readRetryBaseline(context.flowManager, canonical, route), null);
  const recoveryPlan = inspectRetryRecoveryPlan({
    flowManager: context.flowManager,
    state: context.flowState,
    executionRoot: context.executionRoot,
    artifactRoot: context.mainRoot,
  });
  assert.equal(recoveryPlan.basis.confirmedTimeout, true, recoveryPlan.reason);
  assert.notEqual(status.recoveryDiagnostics, undefined, JSON.stringify(status));
  assert.equal(status.recoveryDiagnostics.review.recoveryPossible, true);
  assert.match(status.recoveryDiagnostics.review.recoveryCommand, /set retry reset review test/);
  assert.equal(next.directive.actionId, "RECOVER_EXHAUSTED_TOOLING_RETRY", JSON.stringify(next));
  assert.match(next.directive.nextAction, /set retry reset review test/);
});

test("confirmed-timeout recovery remains consumed after changed evidence returns to its prior lineage", () => {
  const fixture = retryFixture({ failureKind: "tooling" });
  const command = new SetRetryCommand();
  const input = () => commandInput(fixture);
  const fail = (failure) => fixture.manager.failCurrentAttempt({
    specId: fixture.flow.specId,
    failure,
  });
  const confirmedTimeout = (message) => ({
    category: "tooling",
    code: "AGENT_TIMEOUT",
    message,
    retryable: true,
    retryKind: "tooling",
    agentStopEvidence: AgentProcessStopEvidence.confirmed(),
  });
  const recordedFailure = (message) => ({
    category: "tooling",
    code: "AGENT_AUTHENTICATION_FAILED",
    message,
    retryable: false,
    retryKind: null,
  });

  assert.equal(command.execute(input()).grants[0].operation, "retry_attempt");
  fail(confirmedTimeout("The first provider timeout was confirmed on evidence lineage A."));
  assert.equal(command.execute(input()).grants[0].operation, "retry_recovery_attempt");

  const changedPath = path.join(fixture.root, "lineage-cycle.js");
  fs.writeFileSync(changedPath, "export const lineage = 'B';\n");
  fail(recordedFailure("The recorded provider failure observed changed evidence lineage B."));
  assert.equal(command.execute(input()).grants[0].operation, "retry_recovery_attempt");

  fs.unlinkSync(changedPath);
  fail(recordedFailure("The recorded provider failure observed evidence returned to lineage A."));
  assert.equal(command.execute(input()).grants[0].operation, "retry_recovery_attempt");

  fail(confirmedTimeout("A later confirmed timeout cannot consume evidence lineage A twice."));
  const before = immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId);
  const rejected = command.execute(input());

  assert.equal(rejected.ok, false);
  assert.match(rejected.errors[0].messages[0], /already consumed this evidence lineage/);
  assert.equal(immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId), before);
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
  assert.equal(receipt.basis.changedInput, true);
  assert.deepEqual(receipt.current.route.toJSON(), { kind: "review", phase: "impl", taskId: "T-1" });
  assert.equal(receipt.current.attemptId, reloadedState.attempt.id);
  assert.equal(receipt.current.attempt, reloadedState.attempt.sequence);
  assert.equal(receipt.current.runId, reloadedState.runId);
  assert.equal(receipt.current.specId, reloadedState.specId);
});

test("Task Review grants one unchanged exhausted recovery only for a confirmed provider stop", async (t) => {
  const scenario = new TaskReviewScenario(t);
  const timeout = ReviewFailure.fromAgentFailure({
    phase: "impl",
    failure: new AgentTimeoutFailure({
      message: "provider timed out after its process tree stopped",
      stopEvidence: AgentProcessStopEvidence.confirmed(),
    }),
  });
  let invocation = null;
  const review = scenario.review((_command, _args, options) => {
    invocation = options;
    return { ok: false, status: 1, stdout: "", stderr: timeout.toMarkerLine(), signal: null, killed: false };
  });
  const reset = () => new SetRetryCommand().execute({
    ...scenario.context(),
    flowState: scenario.manager.loadReadOnly(scenario.specId),
    action: "reset",
    kind: "review",
    phase: "impl",
    reason: "Retry the confirmed provider timeout without changing its reviewed input.",
    yes: true,
  });

  const firstFailure = await review.execute(scenario.context());
  assert.equal(firstFailure.errors[0].code, "REVIEW_TOOLING_ERROR", JSON.stringify(firstFailure));
  assert.equal(Object.hasOwn(invocation, "timeout"), false);
  assert.equal(scenario.state().attempt.failure.agentStopEvidence.confirmed, true);
  assert.equal(reset().grants[0].operation, "retry_attempt");

  const secondFailure = await review.execute({ ...scenario.context(), flowState: scenario.manager.loadReadOnly(scenario.specId) });
  assert.equal(secondFailure.errors[0].code, "REVIEW_TOOLING_ERROR", JSON.stringify(secondFailure));
  const recovered = reset();
  assert.notEqual(recovered.ok, false, JSON.stringify(recovered));
  assert.equal(recovered.grants[0].operation, "retry_recovery_attempt", JSON.stringify(recovered));
  scenario.reload();
  const receipt = readRetryBaseline(
    scenario.manager,
    scenario.state(),
    retryEvidenceRouteForNode(scenario.state(), scenario.state().attempt.nodeId),
  );
  assert.notEqual(receipt, null);
  const receiptArtifact = scenario.manager.readArtifact({
    specId: scenario.specId,
    logicalKey: "retry.recovery.receipt",
    parameters: { routeId: "review-impl-T-1", attemptId: scenario.state().attempt.id },
    consumerNodeId: scenario.state().attempt.nodeId,
  });
  assert.equal(new RetryRecoveryReceipt(JSON.parse(receiptArtifact.bytes)).basis.toString(), "confirmed-timeout");

  scenario.manager.failCurrentAttempt({
    specId: scenario.specId,
    failure: {
      category: "tooling",
      code: "AGENT_TIMEOUT",
      message: "provider timed out again after the one-time recovery",
      retryable: true,
      retryKind: "tooling",
      agentStopEvidence: AgentProcessStopEvidence.confirmed(),
    },
  });
  const duplicate = reset();
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors[0].messages[0], /already consumed this evidence lineage/);
});

test("Task Review blocks unchanged timeout recovery when process-tree termination is uncertain", async (t) => {
  const scenario = new TaskReviewScenario(t);
  const timeout = ReviewFailure.fromAgentFailure({
    phase: "impl",
    failure: new AgentTimeoutFailure({
      message: "provider timed out before process-tree death could be observed",
      stopEvidence: AgentProcessStopEvidence.uncertain("process-tree-members-unavailable"),
    }),
  });
  const review = scenario.review(() => ({
    ok: false, status: 1, stdout: "", stderr: timeout.toMarkerLine(), signal: null, killed: false,
  }));

  await review.execute(scenario.context());
  const failed = scenario.state().attempt.failure;
  assert.equal(failed.code, "AGENT_TIMEOUT");
  assert.equal(failed.retryable, false);
  assert.equal(failed.retryKind, null);
  assert.equal(failed.agentStopEvidence.confirmed, false);
  assert.equal(scenario.state().failureDisposition().operation, "blocked");

  const context = {
    ...scenario.context(),
    flowState: scenario.manager.loadReadOnly(scenario.specId),
  };
  const status = new GetStatusCommand().execute(context);
  const next = await new GetNextActionCommand().execute(context);
  const reset = new SetRetryCommand().execute({
    ...context,
    action: "reset",
    kind: "review",
    phase: "impl",
    reason: "Do not retry while provider process termination remains uncertain.",
    yes: true,
  });
  assert.equal(status.recoveryDiagnostics?.review?.recoveryPossible ?? false, false);
  assert.notEqual(next.directive?.actionId, "RECOVER_EXHAUSTED_TOOLING_RETRY", JSON.stringify(next));
  assert.equal(reset.ok, false);
  assert.match(reset.errors[0].messages[0], /trusted confirmed timeout/);
});

test("Task Review source-integrity unavailability blocks status, next-action, and recovery mutation", async (t) => {
  const scenario = new TaskReviewScenario(t);
  const timeout = ReviewFailure.fromAgentFailure({
    phase: "impl",
    failure: new AgentTimeoutFailure({
      message: "provider timed out after its process tree stopped",
      stopEvidence: AgentProcessStopEvidence.confirmed(),
    }),
  });
  const review = scenario.review(() => ({
    ok: false, status: 1, stdout: "", stderr: timeout.toMarkerLine(), signal: null, killed: false,
  }));
  const resetInput = () => ({
    ...scenario.context(),
    flowState: scenario.manager.loadReadOnly(scenario.specId),
    action: "reset",
    kind: "review",
    phase: "impl",
    reason: "A Task Review recovery requires its current canonical source observation.",
    yes: true,
  });

  await review.execute(scenario.context());
  assert.equal(new SetRetryCommand().execute(resetInput()).grants[0].operation, "retry_attempt");
  await review.execute({ ...scenario.context(), flowState: scenario.manager.loadReadOnly(scenario.specId) });
  const failed = scenario.manager.canonicalState(scenario.specId);
  removeCatalogedArtifactForCorruptionFixture(
    scenario.manager,
    scenario.specId,
    "task.review.unsealed.checkpoint",
    { taskId: scenario.taskId, attemptId: failed.attempt.id },
  );
  const before = scenario.snapshot();
  const context = resetInput();

  const status = new GetStatusCommand().execute(context);
  const next = await new GetNextActionCommand().execute(context);
  const rejected = new SetRetryCommand().execute(context);

  assert.equal(status.recoveryDiagnostics?.review?.recoveryPossible ?? false, false);
  assert.notEqual(next.directive?.actionId, "RECOVER_EXHAUSTED_TOOLING_RETRY", JSON.stringify(next));
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors[0].messages[0], /Task Review source observation is unavailable/);
  assert.equal(scenario.snapshot(), before);
});

test("competing confirmed-timeout resets append exactly one exhausted recovery", async () => {
  const fixture = retryFixture({ failureKind: "tooling" });
  const command = new SetRetryCommand();
  const first = command.execute(commandInput(fixture));
  assert.equal(first.grants[0].operation, "retry_attempt");
  fixture.manager.failCurrentAttempt({
    specId: fixture.flow.specId,
    failure: {
      category: "tooling",
      code: "AGENT_TIMEOUT",
      message: "The provider tree was confirmed stopped after its deadline.",
      retryable: true,
      retryKind: "tooling",
      agentStopEvidence: AgentProcessStopEvidence.confirmed(),
    },
  });
  const barrierRoot = createTmpDir("set-retry-barrier-");
  roots.push(barrierRoot);
  const releasePath = path.join(barrierRoot, "release");
  const script = (competitor) => [
    "import fs from 'node:fs';",
    `import { FlowManager } from ${JSON.stringify(FLOW_MANAGER_MODULE)};`,
    `import SetRetryCommand from ${JSON.stringify(SET_RETRY_MODULE)};`,
    `const root=${JSON.stringify(fixture.root)};`,
    `const specId=${JSON.stringify(fixture.flow.specId)};`,
    `const readyPath=${JSON.stringify(path.join(barrierRoot, `ready-${competitor}`))};`,
    `const releasePath=${JSON.stringify(releasePath)};`,
    "const manager=new FlowManager({root,mainRoot:root,inWorktree:false});",
    "const retryExhaustedAttempt=manager.retryExhaustedAttempt.bind(manager);",
    "manager.retryExhaustedAttempt=(input)=>{fs.writeFileSync(readyPath,'ready');const deadline=Date.now()+10000;while(!fs.existsSync(releasePath)){if(Date.now()>deadline)throw new Error('recovery barrier timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return retryExhaustedAttempt(input);};",
    "const result=new SetRetryCommand().execute({action:'reset',kind:'review',phase:'test',reason:'Competing confirmed timeout recovery must remain atomic.',yes:true,root,mainRoot:root,executionRoot:root,flowManager:manager,flowState:manager.load(specId)});",
    "if (result.ok === false) { process.stderr.write(result.errors[0].messages.join(' ')); process.exitCode=1; }",
    "else process.stdout.write(JSON.stringify(result));",
  ].join("");

  const contenders = [
    execFileAsync(process.execPath, ["--input-type=module", "-e", script("one")]),
    execFileAsync(process.execPath, ["--input-type=module", "-e", script("two")]),
  ];
  const readinessDeadline = Date.now() + 10000;
  while (!(fs.existsSync(path.join(barrierRoot, "ready-one"))
    && fs.existsSync(path.join(barrierRoot, "ready-two")))) {
    if (Date.now() > readinessDeadline) throw new Error("both retry competitors did not reach the pre-lock barrier");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fs.writeFileSync(releasePath, "release");
  const attempts = await Promise.allSettled(contenders);

  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((entry) => entry.status === "rejected").length, 1);
  const recoveryActivities = fixture.manager.activityLedger(fixture.flow.specId)
    .filter((activity) => activity.transition.operation === "retry_recovery_attempt");
  assert.equal(recoveryActivities.length, 1);
  const receipts = fixture.manager.artifactCatalog(fixture.flow.specId).artifacts
    .filter((artifact) => artifact.logicalKey === "retry.recovery.receipt");
  assert.equal(receipts.length, 1);
});

test("Store rejects a Review recovery admission bound to a different receipt without mutation", () => {
  const fixture = retryFixture({ failureKind: "tooling" });
  const command = new SetRetryCommand();
  assert.equal(command.execute(commandInput(fixture)).grants[0].operation, "retry_attempt");
  fixture.manager.failCurrentAttempt({
    specId: fixture.flow.specId,
    failure: {
      category: "tooling",
      code: "AGENT_TIMEOUT",
      message: "The provider process tree was confirmed stopped.",
      retryable: true,
      retryKind: "tooling",
      agentStopEvidence: AgentProcessStopEvidence.confirmed(),
    },
  });
  const state = fixture.manager.canonicalState(fixture.flow.specId);
  const route = retryEvidenceRouteForNode(state, state.attempt.nodeId);
  const previous = readRetryBaseline(fixture.manager, state, route);
  const next = (attemptId) => new RetryRecoveryBaseline({
    ...previous.toJSON(),
    attemptId,
    attempt: previous.attempt + 1,
  });
  const publishedReceipt = new RetryRecoveryReceipt({
    previous,
    current: next("published-next-attempt"),
    reason: "Publish only the receipt selected by the Store admission.",
    reevaluationCount: 1,
    basis: RetryRecoveryBasis.confirmedTimeout(),
  });
  const foreignReceipt = new RetryRecoveryReceipt({
    previous,
    current: next("foreign-next-attempt"),
    reason: "A foreign admission must not authorize another receipt.",
    reevaluationCount: 1,
    basis: RetryRecoveryBasis.confirmedTimeout(),
  });
  const observation = new RetryRecoveryObservation({
    digest: foreignReceipt.current.digest,
    previousDigest: previous.digest,
    projectDigest: previous.projectDigest,
    runtimeDigest: previous.runtimeDigest,
    targetDigest: previous.targetDigest,
  });
  const admission = new ExhaustedReviewRetryRecoveryAdmission({
    receipt: foreignReceipt,
    observation,
    basis: RetryRecoveryBasis.confirmedTimeout(),
    executionRoot: fixture.root,
  });
  const before = immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId);

  assert.throws(
    () => fixture.manager.retryExhaustedAttempt({
      specId: fixture.flow.specId,
      receipt: publishedReceipt,
      recoveryAdmission: admission,
    }),
    /admission receipt does not match the published receipt/,
  );
  assert.equal(immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId), before);
});

test("Store rejects checkout changes between confirmed-timeout capture and publication without mutation", () => {
  const fixture = retryFixture({ failureKind: "tooling" });
  const command = new SetRetryCommand();
  assert.equal(command.execute(commandInput(fixture)).grants[0].operation, "retry_attempt");
  fixture.manager.failCurrentAttempt({
    specId: fixture.flow.specId,
    failure: {
      category: "tooling",
      code: "AGENT_TIMEOUT",
      message: "The provider process tree was confirmed stopped.",
      retryable: true,
      retryKind: "tooling",
      agentStopEvidence: AgentProcessStopEvidence.confirmed(),
    },
  });
  const before = immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId);
  const retryExhaustedAttempt = fixture.manager.retryExhaustedAttempt.bind(fixture.manager);
  fixture.manager.retryExhaustedAttempt = (input) => {
    fs.writeFileSync(path.join(fixture.root, "capture-publication-race.js"), "export const changed = true;\n");
    return retryExhaustedAttempt(input);
  };

  const rejected = command.execute(commandInput(fixture));

  assert.equal(rejected.ok, false);
  assert.match(rejected.errors[0].messages[0], /checkout evidence changed before publication/);
  assert.equal(immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId), before);
});

test("Store rejects a stale runtime digest captured before recovery publication without mutation", () => {
  const fixture = retryFixture({ failureKind: "tooling" });
  const command = new SetRetryCommand();
  assert.equal(command.execute(commandInput(fixture)).grants[0].operation, "retry_attempt");
  fixture.manager.failCurrentAttempt({
    specId: fixture.flow.specId,
    failure: {
      category: "tooling",
      code: "AGENT_TIMEOUT",
      message: "The provider process tree was confirmed stopped.",
      retryable: true,
      retryKind: "tooling",
      agentStopEvidence: AgentProcessStopEvidence.confirmed(),
    },
  });
  const state = fixture.manager.canonicalState(fixture.flow.specId);
  const route = retryEvidenceRouteForNode(state, state.attempt.nodeId);
  const previous = readRetryBaseline(fixture.manager, state, route);
  const staleRuntimeDigest = previous.runtimeDigest === "f".repeat(64)
    ? "e".repeat(64)
    : "f".repeat(64);
  const current = new RetryRecoveryBaseline({
    ...previous.toJSON(),
    attemptId: "runtime-race-next-attempt",
    attempt: previous.attempt + 1,
    runtimeDigest: staleRuntimeDigest,
  });
  const receipt = new RetryRecoveryReceipt({
    previous,
    current,
    reason: "Reject a runtime observation that changed before the Store acquired its lock.",
    reevaluationCount: 1,
    basis: RetryRecoveryBasis.changedInput(),
  });
  const observation = new RetryRecoveryObservation({
    digest: current.digest,
    previousDigest: previous.digest,
    projectDigest: current.projectDigest,
    runtimeDigest: current.runtimeDigest,
    targetDigest: current.targetDigest,
  });
  const admission = new ExhaustedReviewRetryRecoveryAdmission({
    receipt,
    observation,
    basis: RetryRecoveryBasis.changedInput(),
    executionRoot: fixture.root,
  });
  const before = immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId);

  assert.throws(
    () => fixture.manager.retryExhaustedAttempt({
      specId: fixture.flow.specId,
      receipt,
      recoveryAdmission: admission,
    }),
    /checkout evidence changed before publication: runtimeDigest/,
  );
  assert.equal(immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId), before);
});

test("Task Review authorization rejects checkout changes at the Store lock without mutation", async (t) => {
  const scenario = new TaskReviewScenario(t);
  const timeout = ReviewFailure.fromAgentFailure({
    phase: "impl",
    failure: new AgentTimeoutFailure({
      message: "provider timed out after its process tree stopped",
      stopEvidence: AgentProcessStopEvidence.confirmed(),
    }),
  });
  const review = scenario.review(() => ({
    ok: false, status: 1, stdout: "", stderr: timeout.toMarkerLine(), signal: null, killed: false,
  }));
  const reset = () => new SetRetryCommand().execute({
    ...scenario.context(),
    flowState: scenario.manager.loadReadOnly(scenario.specId),
    action: "reset",
    kind: "review",
    phase: "impl",
    reason: "Retry only the exact Task Review checkout observed before publication.",
    yes: true,
  });

  await review.execute(scenario.context());
  assert.equal(reset().grants[0].operation, "retry_attempt");
  await review.execute({ ...scenario.context(), flowState: scenario.manager.loadReadOnly(scenario.specId) });
  const before = scenario.snapshot();
  const retryExhaustedAttempt = scenario.manager.retryExhaustedAttempt.bind(scenario.manager);
  scenario.manager.retryExhaustedAttempt = (input) => {
    fs.writeFileSync(scenario.sourcePath, "source changed during recovery publication\n");
    return retryExhaustedAttempt(input);
  };

  const rejected = reset();

  assert.equal(rejected.ok, false);
  assert.match(rejected.errors[0].messages[0], /checkout (?:evidence|observation) changed before publication/);
  assert.equal(scenario.snapshot(), before);
});

test("Store rejects a Task Review admission bound to a different typed authorization", async (t) => {
  const scenario = new TaskReviewScenario(t);
  const timeout = ReviewFailure.fromAgentFailure({
    phase: "impl",
    failure: new AgentTimeoutFailure({
      message: "provider timed out after its process tree stopped",
      stopEvidence: AgentProcessStopEvidence.confirmed(),
    }),
  });
  const review = scenario.review(() => ({
    ok: false, status: 1, stdout: "", stderr: timeout.toMarkerLine(), signal: null, killed: false,
  }));
  const reset = () => new SetRetryCommand().execute({
    ...scenario.context(),
    flowState: scenario.manager.loadReadOnly(scenario.specId),
    action: "reset",
    kind: "review",
    phase: "impl",
    reason: "Publish only the exact Task authorization selected with the recovery receipt.",
    yes: true,
  });

  await review.execute(scenario.context());
  assert.equal(reset().grants[0].operation, "retry_attempt");
  await review.execute({ ...scenario.context(), flowState: scenario.manager.loadReadOnly(scenario.specId) });
  const before = scenario.snapshot();
  const retryExhaustedAttempt = scenario.manager.retryExhaustedAttempt.bind(scenario.manager);
  scenario.manager.retryExhaustedAttempt = (input) => {
    const state = scenario.state();
    const checkpoint = readTaskReviewUnsealedCheckpoint({
      flowManager: scenario.manager,
      state,
      taskId: scenario.taskId,
      root: scenario.root,
    });
    const foreignPath = path.join(scenario.root, "foreign-authorization-observation.txt");
    fs.writeFileSync(foreignPath, "present only while capturing the mismatched authorization\n");
    const foreign = TaskReviewRecoveryAuthorization.capture({
      checkpoint,
      receipt: input.receipt,
      targetDigest: input.taskReviewRecoveryAuthorization.targetDigest,
    });
    fs.unlinkSync(foreignPath);
    return retryExhaustedAttempt({ ...input, taskReviewRecoveryAuthorization: foreign });
  };

  const rejected = reset();

  assert.equal(rejected.ok, false);
  assert.match(rejected.errors[0].messages[0], /Task authorization does not match the published authorization/);
  assert.equal(scenario.snapshot(), before);
});

for (const { nodeId, phase } of [
  { nodeId: "draft-questions-review", phase: "draft-questions" },
  { nodeId: "draft-coverage-review", phase: "draft-coverage" },
  { nodeId: "test-review", phase: "test" },
  { nodeId: "impl-review", phase: "impl" },
]) {
  test(`${nodeId} permits a prior artifact but rejects a current Attempt canonical Review artifact`, async () => {
    const fixture = retryFixture({ nodeId, failureKind: null });
    const { manager, flow } = fixture;
    const command = new SetRetryCommand();
    const input = () => commandInput(fixture, { phase });
    const publish = () => manager.publishCurrentAttemptResult({
      specId: flow.specId,
      commandResult: canonicalFixtureProducerResult(manager.loadReadOnly(flow.specId), nodeId, {
        flowManager: manager,
        specId: flow.specId,
      }),
    });
    const fail = (message) => manager.failCurrentAttempt({
      specId: flow.specId,
      failure: {
        category: "tooling",
        code: "AGENT_TIMEOUT",
        message,
        retryable: true,
        retryKind: "tooling",
        agentStopEvidence: AgentProcessStopEvidence.confirmed(),
      },
    });

    publish();
    fail("The first provider stopped after publishing its canonical Review artifact.");
    assert.equal(command.execute(input()).grants[0].operation, "retry_attempt");

    fail("The next provider stopped before publishing, leaving only its predecessor's artifact.");
    const recovered = command.execute(input());
    assert.equal(recovered.grants[0].operation, "retry_recovery_attempt", JSON.stringify(recovered));

    const currentFixture = fixture;
    const currentInput = () => commandInput(currentFixture, { phase });
    currentFixture.manager.publishCurrentAttemptResult({
      specId: currentFixture.flow.specId,
      commandResult: canonicalFixtureProducerResult(
        currentFixture.manager.loadReadOnly(currentFixture.flow.specId),
        nodeId,
        { flowManager: currentFixture.manager, specId: currentFixture.flow.specId },
      ),
    });
    currentFixture.manager.failCurrentAttempt({
      specId: currentFixture.flow.specId,
      failure: {
        category: "tooling",
        code: "AGENT_TIMEOUT",
        message: "The provider stopped after publishing its current canonical Review artifact.",
        retryable: true,
        retryKind: "tooling",
        agentStopEvidence: AgentProcessStopEvidence.confirmed(),
      },
    });
    const before = immutableRetryPublicationSnapshot(currentFixture.manager, currentFixture.flow.specId);
    const context = {
      ...currentInput(),
      flowState: currentFixture.manager.loadReadOnly(currentFixture.flow.specId),
    };
    const status = new GetStatusCommand().execute(context);
    const next = await new GetNextActionCommand().execute(context);
    const rejected = command.execute(context);

    assert.equal(status.recoveryDiagnostics?.review?.recoveryPossible ?? false, false);
    assert.notEqual(next.directive?.actionId, "RECOVER_EXHAUSTED_TOOLING_RETRY", JSON.stringify(next));
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors[0].messages[0], /current Attempt.*canonical Review artifact/);
    assert.equal(immutableRetryPublicationSnapshot(currentFixture.manager, currentFixture.flow.specId), before);
  });
}

test("confirmed timeout recovery fails closed when its producer baseline is missing", () => {
  const fixture = retryFixture({ failureKind: "tooling" });
  const command = new SetRetryCommand();
  assert.equal(command.execute(commandInput(fixture)).grants[0].operation, "retry_attempt");
  const state = fixture.manager.canonicalState(fixture.flow.specId);
  removeCatalogedArtifactForCorruptionFixture(
    fixture.manager,
    fixture.flow.specId,
    "retry.recovery.baseline",
    { routeId: "review-test", attemptId: state.attempt.id },
  );
  fixture.manager.failCurrentAttempt({
    specId: fixture.flow.specId,
    failure: {
      category: "tooling",
      code: "AGENT_TIMEOUT",
      message: "The provider process tree was confirmed stopped.",
      retryable: true,
      retryKind: "tooling",
      agentStopEvidence: AgentProcessStopEvidence.confirmed(),
    },
  });
  const before = immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId);

  const rejected = command.execute(commandInput(fixture));

  assert.equal(rejected.ok, false);
  assert.match(rejected.errors[0].messages[0], /durable parent-derived baseline/);
  assert.equal(immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId), before);
});

test("Task Review rejects unchanged timeout recovery after its current artifact is published", async (t) => {
  const scenario = new TaskReviewScenario(t);
  scenario.manager.failCurrentAttempt({
    specId: scenario.specId,
    failure: {
      category: "tooling",
      code: "REVIEW_PROVIDER_UNAVAILABLE",
      message: "The first Task Review provider interruption consumes its ordinary retry.",
      retryable: true,
      retryKind: "tooling",
    },
  });
  scenario.manager.retryCurrentAttempt({ specId: scenario.specId });
  const active = scenario.state();
  scenario.manager.publishCurrentAttemptResult({
    specId: scenario.specId,
    commandResult: canonicalFixtureProducerResult(active, "T-1-review", {
      flowManager: scenario.manager,
      specId: scenario.specId,
    }),
  });
  scenario.manager.failCurrentAttempt({
    specId: scenario.specId,
    failure: {
      category: "tooling",
      code: "AGENT_TIMEOUT",
      message: "The confirmed provider timeout occurred after publishing the current Task Review artifact.",
      retryable: true,
      retryKind: "tooling",
      agentStopEvidence: AgentProcessStopEvidence.confirmed(),
    },
  });
  const before = scenario.snapshot();
  const context = {
    ...scenario.context(),
    flowState: scenario.manager.loadReadOnly(scenario.specId),
    action: "reset",
    kind: "review",
    phase: "impl",
    reason: "A published current Task Review result must settle through its normal route.",
    yes: true,
  };

  const status = new GetStatusCommand().execute(context);
  const next = await new GetNextActionCommand().execute(context);
  const rejected = new SetRetryCommand().execute(context);

  assert.equal(status.recoveryDiagnostics?.review?.recoveryPossible ?? false, false);
  assert.notEqual(next.directive?.actionId, "RECOVER_EXHAUSTED_TOOLING_RETRY", JSON.stringify(next));
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors[0].messages[0], /current Attempt.*canonical Review artifact/);
  assert.equal(scenario.snapshot(), before);
});

test("unavailable current Review observation is not offered as an exhausted timeout recovery", async () => {
  const fixture = retryFixture({ nodeId: "draft-questions-review", failureKind: "tooling" });
  const command = new SetRetryCommand();
  const input = () => commandInput(fixture, { phase: "draft-questions" });

  assert.equal(command.execute(input()).grants[0].operation, "retry_attempt");
  const active = fixture.manager.canonicalState(fixture.flow.specId);
  const route = retryEvidenceRouteForNode(active, active.attempt.nodeId);
  assert.notEqual(readRetryBaseline(fixture.manager, active, route), null);
  // The baseline is durable, but the canonical draft required to form the
  // current Review target is unavailable.  This is an input-boundary failure,
  // not a synthetic retry-recovery fixture.
  removeCatalogedArtifactForCorruptionFixture(
    fixture.manager,
    fixture.flow.specId,
    "draft",
  );
  fixture.manager.failCurrentAttempt({
    specId: fixture.flow.specId,
    failure: {
      category: "tooling",
      code: "AGENT_TIMEOUT",
      message: "The provider stop was confirmed but the current Review target cannot be observed.",
      retryable: true,
      retryKind: "tooling",
      agentStopEvidence: AgentProcessStopEvidence.confirmed(),
    },
  });
  const before = immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId);
  const context = {
    ...input(),
    flowState: fixture.manager.loadReadOnly(fixture.flow.specId),
  };

  const plan = inspectRetryRecoveryPlan({
    flowManager: fixture.manager,
    state: context.flowState,
    executionRoot: fixture.root,
    artifactRoot: fixture.root,
  });
  const status = new GetStatusCommand().execute(context);
  const next = await new GetNextActionCommand().execute(context);
  const rejected = command.execute(context);

  assert.equal(plan.available, false);
  assert.match(plan.reason, /current retry recovery observation is unavailable/);
  assert.equal(status.recoveryDiagnostics?.review?.recoveryPossible ?? false, false);
  assert.notEqual(next.directive?.actionId, "RECOVER_EXHAUSTED_TOOLING_RETRY", JSON.stringify(next));
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors[0].messages[0], /current retry recovery observation is unavailable/);
  assert.equal(immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId), before);
});

for (const failure of [
  { code: "AGENT_TEMPORARY_RATE_LIMIT", retryable: true, retryKind: "tooling" },
  { code: "AGENT_AUTHENTICATION_FAILED", retryable: false, retryKind: null },
  { code: "AGENT_USAGE_LIMIT_REACHED", retryable: false, retryKind: null },
  { code: "SUBPROCESS_FAILURE", retryable: false, retryKind: null },
  {
    code: "AGENT_TIMEOUT",
    retryable: false,
    retryKind: null,
    agentStopEvidence: AgentProcessStopEvidence.uncertain("process-tree-death-not-observed"),
  },
]) {
  test(`unchanged exhausted recovery rejects ${failure.code}`, () => {
    const fixture = retryFixture({ failureKind: "tooling" });
    const command = new SetRetryCommand();
    assert.equal(command.execute(commandInput(fixture)).grants[0].operation, "retry_attempt");
    fixture.manager.failCurrentAttempt({
      specId: fixture.flow.specId,
      failure: {
        category: "tooling",
        code: failure.code,
        message: "Only a confirmed process-tree stop may recover unchanged input.",
        retryable: failure.retryable,
        retryKind: failure.retryKind,
        ...(failure.agentStopEvidence === undefined ? {} : { agentStopEvidence: failure.agentStopEvidence }),
      },
    });
    const before = immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId);

    const rejected = command.execute(commandInput(fixture));

    assert.equal(rejected.ok, false);
    assert.equal(rejected.errors[0].code, "INVALID_RECOVERY_INPUT");
    assert.match(rejected.errors[0].messages[0], /trusted confirmed timeout/);
    assert.equal(immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId), before);
  });
}

for (const failure of [
  { label: "rate-limit failure", code: "AGENT_TEMPORARY_RATE_LIMIT", retryable: true, retryKind: "tooling" },
  { label: "authentication failure", code: "AGENT_AUTHENTICATION_FAILED", retryable: false, retryKind: null },
  { label: "quota failure", code: "AGENT_USAGE_LIMIT_REACHED", retryable: false, retryKind: null },
  { label: "general subprocess failure", code: "SUBPROCESS_FAILURE", retryable: false, retryKind: null },
]) {
  test(`changed input recovers a recorded ${failure.label}`, async () => {
    const fixture = retryFixture({ failureKind: "tooling" });
    const command = new SetRetryCommand();
    assert.equal(command.execute(commandInput(fixture)).grants[0].operation, "retry_attempt");
    fixture.manager.failCurrentAttempt({
      specId: fixture.flow.specId,
      failure: {
        category: "tooling",
        code: failure.code,
        message: "Changed canonical input authorizes one explicit reevaluation of a recorded provider failure.",
        retryable: failure.retryable,
        retryKind: failure.retryKind,
      },
    });
    fs.writeFileSync(
      path.join(fixture.root, `terminal-${failure.code.toLowerCase()}.js`),
      "export const changed = true;\n",
    );
    const context = {
      ...commandInput(fixture),
      flowState: fixture.manager.loadReadOnly(fixture.flow.specId),
    };

    const status = new GetStatusCommand().execute(context);
    const next = await new GetNextActionCommand().execute(context);
    assert.equal(fixture.manager.canonicalState(fixture.flow.specId).failureDisposition().operation, "record");
    const recovered = command.execute(context);

    assert.equal(status.recoveryDiagnostics.review.recoveryPossible, true);
    assert.equal(next.directive.actionId, "RECOVER_EXHAUSTED_TOOLING_RETRY", JSON.stringify(next));
    assert.notEqual(recovered.ok, false, JSON.stringify(recovered));
    assert.equal(recovered.grants[0].operation, "retry_recovery_attempt");
    const state = fixture.manager.canonicalState(fixture.flow.specId);
    const route = retryEvidenceRouteForNode(state, state.attempt.nodeId);
    assert.equal(readRetryRecoveryReceipt(fixture.manager, state, route).basis.changedInput, true);
  });
}

test("changed input cannot recover an uncertain timeout", async () => {
  const fixture = retryFixture({ failureKind: "tooling" });
  const command = new SetRetryCommand();
  assert.equal(command.execute(commandInput(fixture)).grants[0].operation, "retry_attempt");
  fixture.manager.failCurrentAttempt({
    specId: fixture.flow.specId,
    failure: {
      category: "tooling",
      code: "AGENT_TIMEOUT",
      message: "Changed input cannot establish that the provider process tree stopped.",
      retryable: false,
      retryKind: null,
      agentStopEvidence: AgentProcessStopEvidence.uncertain("process-tree-death-not-observed"),
    },
  });
  fs.writeFileSync(path.join(fixture.root, "uncertain-timeout-change.js"), "export const changed = true;\n");
  const before = immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId);
  const context = { ...commandInput(fixture), flowState: fixture.manager.loadReadOnly(fixture.flow.specId) };

  const status = new GetStatusCommand().execute(context);
  const next = await new GetNextActionCommand().execute(context);
  const rejected = command.execute(context);

  assert.equal(status.recoveryDiagnostics?.review?.recoveryPossible ?? false, false);
  assert.notEqual(next.directive?.actionId, "RECOVER_EXHAUSTED_TOOLING_RETRY", JSON.stringify(next));
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors[0].messages[0], /Definition disposition does not authorize exhausted tooling recovery/);
  assert.equal(immutableRetryPublicationSnapshot(fixture.manager, fixture.flow.specId), before);
});
