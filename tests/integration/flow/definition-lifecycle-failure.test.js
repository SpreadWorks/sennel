import assert from "node:assert/strict";
import { test } from "node:test";

import { Command } from "../../../src/lib/command.js";
import { flowCommands } from "../../../src/lib/command-registry.js";
import { dispatch } from "../../../src/lib/dispatcher.js";
import { Envelope } from "../../../src/lib/flow-envelope.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { buildCurrentFlowDefinition, DEFINITION_FAILURE_OWNERS, resolveGateTransition } from "../../../src/flow/definition.js";
import RunGateCommand, { appendIssueLogFromGateResult } from "../../../src/flow/lib/run-gate.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { readCurrentGateTransitionFacts } from "../../../src/flow/lib/gate-transition-facts.js";
import { captureCurrentTaskSource } from "../../../src/flow/lib/task-mutation-lineage.js";
import { TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION } from "../../../src/flow/lib/task-gate-classification-recovery.js";
import { CanonicalFlowFixture, TaskLifecycleFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function commandContainer({ root, manager }) {
  const values = {
    paths: { root },
    flowManager: manager,
    mainRoot: root,
    config: null,
    inWorktree: false,
  };
  return {
    get(name) { return values[name] ?? null; },
    has(name) { return Object.hasOwn(values, name); },
  };
}

function hookContext({ root, manager, specId }) {
  return {
    root,
    mainRoot: root,
    executionRoot: root,
    flowManager: manager,
    flowState: manager.loadReadOnly(specId),
    specId,
    flowResolutionError: null,
  };
}

class ThrowingCommand extends Command {
  static outputMode = "envelope";
  static calls = 0;

  execute() {
    ThrowingCommand.calls += 1;
    const error = new Error("registry command fixture failed");
    error.code = "REGISTRY_COMMAND_FIXTURE_FAILED";
    throw error;
  }
}

async function dispatchRegistryCommand({ root, manager, specId, commandName, CommandClass = ThrowingCommand }) {
  const entry = flowCommands.run[commandName];
  const originalCommand = entry.command;
  const out = [];
  try {
    if (Object.hasOwn(CommandClass, "calls")) CommandClass.calls = 0;
    entry.command = async () => ({ default: CommandClass });
    await dispatch({
      container: commandContainer({ root, manager }),
      entry,
      argv: [],
      envelopeType: "run",
      envelopeKey: commandName,
      stdout: (chunk) => out.push(chunk),
      stderr: () => {},
      setExitCode: () => {},
      buildHookCtx: () => hookContext({ root, manager, specId }),
    });
  } finally {
    entry.command = originalCommand;
  }
  return JSON.parse(out.join(""));
}

async function dispatchRegistryFailure(input) {
  return dispatchRegistryCommand(input);
}

class RecoveryOnlyGateCommand extends RunGateCommand {
  static workerCalls = 0;

  async executeCanonicalTaskGate(input) {
    RecoveryOnlyGateCommand.workerCalls += 1;
    return super.executeCanonicalTaskGate(input);
  }
}

function taskGateFixture({ root, specId, result: gateResult, publish = true }) {
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  new TaskLifecycleFixture({
    flowManager: manager,
    specId,
    runId: `run-${specId}`,
    request: "Resume every durable Task Gate settlement boundary.",
    taskDocuments: [
      { id: "T-1", title: "First", goal: "Settle the first Task Gate", parent: null, origin: "plan", added_round: 0, status: "pending" },
      { id: "T-2", title: "Second", goal: "Receive the successor", parent: null, origin: "plan", added_round: 0, status: "pending" },
    ],
    taskId: "T-1",
    targetStep: "task-gate",
  }).create();
  const sourceFingerprint = captureCurrentTaskSource({
    root,
    flowManager: manager,
    state: manager.loadReadOnly(specId),
    taskId: "T-1",
  }).fingerprint;
  const artifacts = gateResult === "pass"
    ? { sourceFingerprint }
    : {
      failureKind: "ai_semantic_fail",
      failureCode: "TASK_GATE_REJECTED",
      sourceFingerprint,
      nextAction: { diagnosis: { observations: [] } },
    };
  const result = new CanonicalGatePromotion({
    state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
  }).promote({ result: gateResult, artifacts });
  if (publish) manager.publishCurrentAttemptResult({ specId, commandResult: result });
  return { manager, result };
}

function taskGateDecision(manager, specId) {
  return resolveGateTransition(readCurrentGateTransitionFacts({
    flowManager: manager,
    flowState: manager.loadReadOnly(specId),
    phase: "task-impl",
  }));
}

function taskGateAttemptHistorySize(manager, specId) {
  const source = manager.readArtifact({
    specId, logicalKey: "task.gate", parameters: { taskId: "T-1" }, consumerNodeId: "T-1-impl",
  });
  return JSON.parse(source.bytes.toString("utf8")).attempts.length;
}

function taskGateIssueEntries(manager, specId) {
  const source = manager.readArtifact({
    specId, logicalKey: "issue.log", consumerNodeId: "T-1-gate", optional: true,
  });
  if (source === null) return [];
  return JSON.parse(source.bytes.toString("utf8")).entries.filter((entry) => (
    entry.phase === "task-impl" && entry.taskId === "T-1"
  ));
}

function applyTaskGateSettlementStage({ manager, root, specId, result, gateResult, stage }) {
  let decision = taskGateDecision(manager, specId);
  if (gateResult === "fail" && ["classification", "metric", "issue-log"].includes(stage)) {
    const stepAttempt = manager.recordGateObservationDecision({ specId, decision });
    if (stepAttempt !== null) result.stepAttempt = stepAttempt.toJSON();
    decision = taskGateDecision(manager, specId);
  }
  if (["metric", "issue-log"].includes(stage)) {
    manager.recordTaskGateSettlementMetric({ specId, decision });
    decision = taskGateDecision(manager, specId);
  }
  if (stage === "issue-log") {
    appendIssueLogFromGateResult({
      root, mainRoot: root, executionRoot: root,
      specId, flowManager: manager, flowState: manager.loadReadOnly(specId), phase: "task-impl",
      gateTransitionDecision: decision,
      gitState: { headSha: "a".repeat(40), worktreeHash: "b".repeat(64) },
    }, result);
  }
}

async function resumeTaskGateSettlement({ root, specId }) {
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const attemptBefore = manager.canonicalState(specId).attempt;
  const historyBefore = taskGateAttemptHistorySize(manager, specId);
  const ctx = {
    ...hookContext({ root, manager, specId }),
    config: {},
    phase: "task-impl",
    gitState: { headSha: "a".repeat(40), worktreeHash: "b".repeat(64) },
  };
  RecoveryOnlyGateCommand.workerCalls = 0;
  const result = await new RecoveryOnlyGateCommand().execute(ctx);
  await flowCommands.run.gate.post(ctx, result);
  assert.equal(RecoveryOnlyGateCommand.workerCalls, 0, "recovery must not invoke the Task Gate worker");
  assert.equal(taskGateAttemptHistorySize(manager, specId), historyBefore, "recovery must not append a Gate result Attempt");
  const matchingAttemptActivities = manager.activityLedger(specId).filter((activity) => (
    activity.nodeId === "T-1-gate"
    && activity.attemptId === attemptBefore.id
    && activity.sequence === attemptBefore.sequence
  ));
  assert.ok(matchingAttemptActivities.length > 0);
  return { manager, result, attemptBefore };
}

test("definition-owned registry command failures settle their exact active Attempt", async (t) => {
  for (const scenario of [
    { commandName: "test-execute", nodeId: "test-execute" },
    { commandName: "test-result-review", nodeId: "test-result-review" },
    { commandName: "retro", nodeId: "retro" },
    { commandName: "acceptance-review", nodeId: "acceptance-review" },
    { commandName: "final-regression", nodeId: "final-regression" },
  ]) {
    await t.test(`${scenario.commandName} command failure`, async () => {
      const root = createTmpDir(`definition-lifecycle-${scenario.commandName}-`);
      try {
        const specId = `901-${scenario.commandName}`;
        const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        new CanonicalFlowFixture({
          flowManager: manager,
          specId,
          runId: `run-${scenario.commandName}`,
          execution: { mode: "direct", baseBranch: "main", featureBranch: null },
        }).create().registerActive().activate(scenario.nodeId);

        const envelope = await dispatchRegistryFailure({ root, manager, specId, commandName: scenario.commandName });
        const state = manager.canonicalState(specId);
        assert.equal(envelope.errors[0].code, "REGISTRY_COMMAND_FIXTURE_FAILED");
        assert.equal(ThrowingCommand.calls, 1, "the registry command executes exactly once");
        assert.equal(state.current.at(-1), scenario.nodeId);
        assert.equal(state.attempt.failure.code, "REGISTRY_COMMAND_FIXTURE_FAILED");
        assert.equal(state.attempt.failure.category, "tooling");
      } finally {
        removeTmpDir(root);
      }
    });
  }
});

test("failed envelope records tooling failure for a dispatcher-primary command", async () => {
  const root = createTmpDir("definition-lifecycle-envelope-");
  const entry = flowCommands.run["test-execute"];
  const originalCommand = entry.command;
  try {
    const specId = "902-test-execute-envelope";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-test-execute-envelope",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("test-execute");
    class FailedEnvelopeCommand extends Command {
      static outputMode = "envelope";
      execute() { return Envelope.fail("run", "test-execute", "TEST_EXECUTE_ENVELOPE_FAILED", "test execution envelope failed"); }
    }
    entry.command = async () => ({ default: FailedEnvelopeCommand });
    const out = [];
    await dispatch({
      container: commandContainer({ root, manager }), entry, argv: [], envelopeType: "run", envelopeKey: "test-execute",
      stdout: (chunk) => out.push(chunk), stderr: () => {}, setExitCode: () => {},
      buildHookCtx: () => hookContext({ root, manager, specId }),
    });
    assert.equal(JSON.parse(out.join("")).errors[0].code, "TEST_EXECUTE_ENVELOPE_FAILED");
    assert.equal(manager.canonicalState(specId).attempt.failure.retryKind, null);
  } finally {
    entry.command = originalCommand;
    removeTmpDir(root);
  }
});

test("command-primary fallback does not overwrite a command-recorded review or gate failure", async (t) => {
  for (const scenario of [
    { commandName: "review", nodeId: "draft-questions-review", category: "semantic", retryKind: "semantic" },
    { commandName: "gate", nodeId: "draft-gate", category: "tooling", retryKind: "tooling" },
  ]) {
    await t.test(scenario.commandName, async () => {
      const root = createTmpDir(`definition-lifecycle-self-recorded-${scenario.commandName}-`);
      const entry = flowCommands.run[scenario.commandName];
      const originalCommand = entry.command;
      try {
        const specId = `903-self-recorded-${scenario.commandName}`;
        const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        new CanonicalFlowFixture({
          flowManager: manager,
          specId,
          runId: `run-self-recorded-${scenario.commandName}`,
          execution: { mode: "direct", baseBranch: "main", featureBranch: null },
        }).create().registerActive().activate(scenario.nodeId);
        class SelfRecordingCommand extends Command {
          static outputMode = "envelope";
          execute() {
            manager.failCurrentAttempt({
              specId,
              failure: { category: scenario.category, code: "COMMAND_OWNED_FAILURE", message: "command recorded its failure", retryable: true, retryKind: scenario.retryKind },
              result: { outcome: "failed", summary: "command recorded its failure", confirmedAt: new Date().toISOString(), artifactRefs: [] },
            });
            throw Object.assign(new Error("after recording"), { code: "AFTER_COMMAND_RECORD" });
          }
        }
        entry.command = async () => ({ default: SelfRecordingCommand });
        await dispatch({
          container: commandContainer({ root, manager }), entry, argv: [], envelopeType: "run", envelopeKey: scenario.commandName,
          stdout: () => {}, stderr: () => {}, setExitCode: () => {},
          buildHookCtx: () => hookContext({ root, manager, specId }),
        });
        const failures = manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed");
        assert.equal(failures.length, 1);
        assert.equal(manager.canonicalState(specId).attempt.failure.code, "COMMAND_OWNED_FAILURE");
      } finally {
        entry.command = originalCommand;
        removeTmpDir(root);
      }
    });
  }
});

test("every definition-owned parent command declares exactly one typed failure owner", () => {
  const definition = buildCurrentFlowDefinition();
  const owners = [];
  const visit = (node) => {
    if (node.action?.executionCommand != null) {
      owners.push({ id: node.id, owner: node.action.failureOwnership, executionCommand: node.action.executionCommand });
    }
    node.steps.forEach(visit);
  };
  visit(definition.root);
  definition.taskTemplate.steps.forEach(visit);
  assert.ok(owners.length > 0);
  for (const entry of owners) {
    assert.ok(DEFINITION_FAILURE_OWNERS.some((owner) => owner.equals(entry.owner)), `${entry.id} owner`);
    const commandName = entry.executionCommand.split(/\s+/)[3];
    assert.ok(flowCommands.run[commandName]?.failureOwnership.equals(entry.owner), `${entry.id} registry owner`);
  }
  assert.deepEqual(
    owners.filter((entry) => entry.owner.toJSON() === "dispatcher-primary").map((entry) => entry.id),
    ["test-gate", "test-execute", "test-result-review", "retro"],
  );
});

test("command-primary fallback preserves a command-recorded semantic failure", async (t) => {
  for (const scenario of [
    { commandName: "acceptance-review", nodeId: "acceptance-review" },
    { commandName: "final-regression", nodeId: "final-regression" },
  ]) {
    await t.test(scenario.commandName, async () => {
      const root = createTmpDir(`definition-lifecycle-fallback-${scenario.commandName}-`);
      const entry = flowCommands.run[scenario.commandName];
      const originalCommand = entry.command;
      try {
        const specId = `905-${scenario.commandName}`;
        const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        new CanonicalFlowFixture({
          flowManager: manager,
          specId,
          runId: `run-${scenario.commandName}-fallback`,
          execution: { mode: "direct", baseBranch: "main", featureBranch: null },
        }).create().registerActive().activate(scenario.nodeId);
        class SelfRecordingCommand extends Command {
          static outputMode = "envelope";
          execute() {
            manager.failCurrentAttempt({
              specId,
              failure: {
                category: "semantic",
                code: "COMMAND_PRIMARY_SEMANTIC_FAILURE",
                message: "command recorded its semantic failure",
                retryable: false,
                retryKind: null,
              },
              result: {
                outcome: "failed",
                summary: "command recorded its semantic failure",
                confirmedAt: new Date().toISOString(),
                artifactRefs: [],
              },
            });
            throw Object.assign(new Error("after command failure record"), { code: "FALLBACK_MUST_NOT_OVERWRITE" });
          }
        }
        entry.command = async () => ({ default: SelfRecordingCommand });
        await dispatch({
          container: commandContainer({ root, manager }), entry, argv: [], envelopeType: "run", envelopeKey: scenario.commandName,
          stdout: () => {}, stderr: () => {}, setExitCode: () => {},
          buildHookCtx: () => hookContext({ root, manager, specId }),
        });
        const failures = manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed");
        assert.equal(failures.length, 1);
        assert.equal(manager.canonicalState(specId).attempt.failure.code, "COMMAND_PRIMARY_SEMANTIC_FAILURE");
      } finally {
        entry.command = originalCommand;
        removeTmpDir(root);
      }
    });
  }
});

test("review and gate registry post failures settle the bound Attempt", async (t) => {
  for (const scenario of [
    { commandName: "review", nodeId: "draft-questions-review" },
    { commandName: "gate", nodeId: "draft-gate" },
  ]) {
    await t.test(scenario.commandName, async () => {
      const root = createTmpDir(`definition-lifecycle-${scenario.commandName}-post-`);
      const entry = flowCommands.run[scenario.commandName];
      const originalPost = entry.post;
      try {
        const specId = `906-${scenario.commandName}-post`;
        const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        new CanonicalFlowFixture({
          flowManager: manager,
          specId,
          runId: `run-${scenario.commandName}-post`,
          execution: { mode: "direct", baseBranch: "main", featureBranch: null },
        }).create().registerActive().activate(scenario.nodeId);
        class PassingCommand extends Command {
          static outputMode = "envelope";
          static calls = 0;
          execute() {
            PassingCommand.calls += 1;
            return { result: "pass" };
          }
        }
        entry.post = () => {
          throw Object.assign(new Error(`${scenario.commandName} registry post failed`), {
            code: `${scenario.commandName.toUpperCase()}_POST_FIXTURE_FAILED`,
          });
        };
        const envelope = await dispatchRegistryCommand({
          root,
          manager,
          specId,
          commandName: scenario.commandName,
          CommandClass: PassingCommand,
        });
        const failure = manager.canonicalState(specId).attempt.failure;
        assert.equal(PassingCommand.calls, 1, "the producer command returns before its registry post failure");
        assert.equal(envelope.ok, true, "the established post-hook envelope contract remains a warning");
        assert.equal(envelope.errors.some((error) => error.level === "warn" && error.code === "POST_HOOK_FAILED"), true);
        assert.equal(failure.category, "tooling");
        assert.equal(failure.code, `${scenario.commandName.toUpperCase()}_POST_FIXTURE_FAILED`);
        assert.equal(manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed").length, 1);
      } finally {
        entry.post = originalPost;
        removeTmpDir(root);
      }
    });
  }
});

test("published Task Gate post failure preserves the result and direct recovery settles without a worker", async () => {
  const root = createTmpDir("definition-lifecycle-task-gate-publication-");
  const entry = flowCommands.run.gate;
  const originalCommand = entry.command;
  const originalPost = entry.post;
  try {
    const specId = "907-task-gate-publication";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    new TaskLifecycleFixture({
      flowManager: manager,
      specId,
      runId: "run-task-gate-publication",
      request: "Recover a published Task Gate result.",
      taskDocuments: [{ id: "T-1", title: "Task", goal: "Exercise settlement", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1",
      targetStep: "task-gate",
    }).create();
    const source = captureCurrentTaskSource({
      root,
      flowManager: manager,
      state: manager.loadReadOnly(specId),
      taskId: "T-1",
    });
    const published = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
    }).promote({ result: "pass", artifacts: { sourceFingerprint: source.fingerprint } });
    class PublishedGateCommand extends Command {
      static outputMode = "envelope";
      execute() { return published; }
    }
    entry.command = async () => ({ default: PublishedGateCommand });
    entry.post = (ctx, result) => {
      ctx.flowManager.publishCurrentAttemptResult({ specId, commandResult: result });
      throw Object.assign(new Error("Task Gate post failed after publication"), { code: "TASK_GATE_POST_AFTER_PUBLICATION" });
    };
    await dispatchRegistryCommand({ root, manager, specId, commandName: "gate", CommandClass: PublishedGateCommand });
    assert.equal(manager.canonicalState(specId).attempt.failure, null, "fallback must not overwrite the published Task Gate result");
    entry.post = originalPost;
    const ctx = {
      ...hookContext({ root, manager, specId }),
      config: {},
      phase: "task-impl",
    };
    const result = await new RunGateCommand().execute(ctx);
    await entry.post(ctx, result);
    assert.equal(manager.canonicalState(specId).findNode("T-1-gate").status, "done");
    assert.equal(manager.activityLedger(specId).filter((activity) => activity.transition.operation === "record_metric").length, 1);
  } finally {
    entry.command = originalCommand;
    entry.post = originalPost;
    removeTmpDir(root);
  }
});

test("Task Gate fallback admission rejects a result published after its initial read", async () => {
  const root = createTmpDir("task-gate-fallback-publication-race-");
  try {
    const specId = "907-task-gate-fallback-race";
    const { manager, result } = taskGateFixture({ root, specId, result: "pass", publish: false });
    const failCurrentAttemptIfCurrent = manager.failCurrentAttemptIfCurrent.bind(manager);
    let raced = false;
    manager.failCurrentAttemptIfCurrent = (input) => {
      raced = true;
      manager.publishCurrentAttemptResult({ specId, commandResult: result });
      return failCurrentAttemptIfCurrent(input);
    };
    const envelope = await dispatchRegistryFailure({
      root, manager, specId, commandName: "gate", CommandClass: ThrowingCommand,
    });
    assert.equal(raced, true);
    assert.equal(envelope.errors[0].code, "REGISTRY_COMMAND_FIXTURE_FAILED");
    assert.equal(manager.canonicalState(specId).attempt.failure, null);
    assert.equal(taskGateAttemptHistorySize(manager, specId), 1);
    assert.equal(manager.activityLedger(specId).some((activity) => (
      activity.nodeId === "T-1-gate"
      && activity.transition.operation === "fail_attempt"
      && activity.failure?.category === "tooling"
    )), false);
  } finally {
    removeTmpDir(root);
  }
});

test("Task Gate fallback records tooling failure when no result was published", async () => {
  const root = createTmpDir("task-gate-fallback-unpublished-");
  try {
    const specId = "907-task-gate-fallback-unpublished";
    const { manager } = taskGateFixture({ root, specId, result: "pass", publish: false });
    const before = manager.canonicalState(specId).attempt;
    const envelope = await dispatchRegistryFailure({
      root, manager, specId, commandName: "gate", CommandClass: ThrowingCommand,
    });
    const state = manager.canonicalState(specId);
    assert.equal(envelope.errors[0].code, "REGISTRY_COMMAND_FIXTURE_FAILED");
    assert.equal(state.attempt.id, before.id, "fallback must settle the original Task Gate Attempt");
    assert.equal(state.attempt.sequence, before.sequence);
    assert.equal(state.attempt.failure.category, "tooling");
    assert.equal(state.attempt.failure.code, "REGISTRY_COMMAND_FIXTURE_FAILED");
    assert.equal(state.attempt.consumption.semantic, 0, "tooling fallback must not consume semantic retry budget");
    assert.equal(manager.readProducerArtifact({
      specId, nodeId: "T-1-gate", logicalKey: "task.gate", parameters: { taskId: "T-1" }, optional: true,
    }), null, "unpublished fallback must not invent a Task Gate result");
    assert.equal(state.findNode("T-1").status, "in_progress");
    assert.equal(state.findNode("T-1-gate").status, "in_progress");
  } finally {
    removeTmpDir(root);
  }
});

test("Task Gate PASS settlement resumes after every durable pre-terminal boundary", async (t) => {
  for (const stage of ["publication", "metric", "issue-log"]) {
    await t.test(stage, async () => {
      const root = createTmpDir(`task-gate-pass-settlement-${stage}-`);
      try {
        const specId = `908-task-gate-pass-${stage}`;
        const { manager, result } = taskGateFixture({ root, specId, result: "pass" });
        applyTaskGateSettlementStage({ manager, root, specId, result, gateResult: "pass", stage });
        const resumed = await resumeTaskGateSettlement({ root, specId });
        const state = resumed.manager.canonicalState(specId);
        assert.equal(state.findNode("T-1-gate").status, "done");
        assert.equal(state.nextAction().nodeId, "T-2-impl");
        const activities = resumed.manager.activityLedger(specId);
        const publication = activities.find((activity) => (
          activity.nodeId === "T-1-gate" && activity.transition.operation === "publish_artifacts"
        ));
        const metric = activities.filter((activity) => (
          activity.transition.operation === "record_metric"
          && activity.metric?.phase === "task-impl"
          && activity.metric?.counter === "gateRetry"
        ));
        const issues = taskGateIssueEntries(resumed.manager, specId);
        const issueDescriptor = resumed.manager.artifactCatalog(specId).artifacts.find((artifact) => (
          artifact.logicalKey === "issue.log"
        ));
        const issueActivity = activities.find((activity) => activity.id === issueDescriptor.activityId);
        const terminal = activities.find((activity) => (
          activity.nodeId === "T-1-gate" && activity.transition.operation === "confirm_attempt"
        ));
        assert.equal(metric.length, 1, "PASS reset metric must be recorded once");
        assert.equal(metric[0].metric.reset, true);
        assert.equal(issues.length, 1, "PASS issue-log entry must be recorded once");
        assert.ok(publication.confirmationOrder < metric[0].confirmationOrder);
        assert.ok(metric[0].confirmationOrder < issueActivity.confirmationOrder);
        assert.ok(issueActivity.confirmationOrder < terminal.confirmationOrder, "terminal lifecycle must be last");
      } finally {
        removeTmpDir(root);
      }
    });
  }
});

test("Task Gate semantic settlement resumes after classification, metric, and issue-log boundaries", async (t) => {
  for (const stage of ["publication", "classification", "metric", "issue-log"]) {
    await t.test(stage, async () => {
      const root = createTmpDir(`task-gate-fail-settlement-${stage}-`);
      try {
        const specId = `909-task-gate-fail-${stage}`;
        const { manager, result } = taskGateFixture({ root, specId, result: "fail" });
        applyTaskGateSettlementStage({ manager, root, specId, result, gateResult: "fail", stage });
        const resumed = stage === "issue-log"
          ? await (async () => {
            const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
            const attemptBefore = reloaded.canonicalState(specId).attempt;
            const historyBefore = taskGateAttemptHistorySize(reloaded, specId);
            RecoveryOnlyGateCommand.workerCalls = 0;
            const next = await new GetNextActionCommand().execute({
              ...hookContext({ root, manager: reloaded, specId }), phase: "task-impl",
            });
            assert.equal(next.directive.actionId, "CLAIM_GATE_RETRY");
            assert.equal(RecoveryOnlyGateCommand.workerCalls, 0);
            assert.equal(taskGateAttemptHistorySize(reloaded, specId), historyBefore);
            return { manager: reloaded, attemptBefore };
          })()
          : await resumeTaskGateSettlement({ root, specId });
        const state = resumed.manager.canonicalState(specId);
        assert.equal(state.current.at(-1), "T-1-gate");
        assert.equal(state.attempt.id, resumed.attemptBefore.id);
        assert.equal(state.attempt.sequence, resumed.attemptBefore.sequence);
        assert.equal(state.attempt.failure.code, "TASK_GATE_REJECTED");
        const next = await new GetNextActionCommand().execute({
          ...hookContext({ root, manager: resumed.manager, specId }), phase: "task-impl",
        });
        assert.equal(next.directive.actionId, "CLAIM_GATE_RETRY");
        const activities = resumed.manager.activityLedger(specId);
        const publication = activities.find((activity) => (
          activity.nodeId === "T-1-gate" && activity.transition.operation === "publish_artifacts"
        ));
        const classification = activities.filter((activity) => (
          activity.nodeId === "T-1-gate" && activity.transition.operation === "fail_attempt"
        ));
        const metric = activities.filter((activity) => (
          activity.transition.operation === "record_metric"
          && activity.metric?.phase === "task-impl"
          && activity.metric?.counter === "gateRetry"
        ));
        const issues = taskGateIssueEntries(resumed.manager, specId);
        const issueDescriptor = resumed.manager.artifactCatalog(specId).artifacts.find((artifact) => (
          artifact.logicalKey === "issue.log"
        ));
        const issueActivity = activities.find((activity) => activity.id === issueDescriptor.activityId);
        assert.equal(classification.length, 1, "semantic classification must be recorded once");
        assert.equal(metric.length, 1, "semantic retry metric must be recorded once");
        assert.equal(metric[0].metric.reset, false);
        assert.equal(issues.length, 1, "semantic issue-log entry must be recorded once");
        assert.ok(publication.confirmationOrder < classification[0].confirmationOrder);
        assert.ok(classification[0].confirmationOrder < metric[0].confirmationOrder);
        assert.ok(metric[0].confirmationOrder < issueActivity.confirmationOrder);
      } finally {
        removeTmpDir(root);
      }
    });
  }
});

test("Task Gate settlement audibly supersedes a legacy post-publication tooling classification", async () => {
  const root = createTmpDir("task-gate-classification-recovery-");
  try {
    const specId = "910-task-gate-classification-recovery";
    const { manager } = taskGateFixture({ root, specId, result: "fail" });
    const stateBefore = manager.canonicalState(specId);
    assert.equal(manager.failCurrentAttemptIfCurrent({
      specId,
      expectedRunId: stateBefore.runId,
      expectedAttempt: stateBefore.attempt,
      failure: {
        category: "tooling",
        code: "POST_HOOK_FAILED",
        message: "legacy post hook failed after Gate publication",
        retryable: false,
        retryKind: null,
      },
    }), true);

    const conflictedFacts = readCurrentGateTransitionFacts({
      flowManager: manager,
      flowState: manager.loadReadOnly(specId),
      phase: "task-impl",
    });
    assert.equal(conflictedFacts.failure.category, "semantic");
    assert.equal(conflictedFacts.taskSettlementProgress.classificationRecorded, false);
    assert.equal(conflictedFacts.taskSettlementProgress.classificationRecovery.status, "required");
    const recoveryDecision = resolveGateTransition(conflictedFacts);

    const resumed = await resumeTaskGateSettlement({ root, specId });
    const settled = resumed.manager.canonicalState(specId);
    assert.equal(settled.attempt.failure.category, "semantic");
    assert.equal(settled.attempt.failure.code, "TASK_GATE_REJECTED");
    const activities = resumed.manager.activityLedger(specId).filter((activity) => (
      activity.nodeId === "T-1-gate"
      && activity.attemptId === settled.attempt.id
      && activity.sequence === settled.attempt.sequence
    ));
    const toolingFailure = activities.find((activity) => activity.failure?.category === "tooling");
    const recovery = activities.find((activity) => (
      activity.transition.operation === TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION
    ));
    const semanticFailure = activities.find((activity) => activity.failure?.category === "semantic");
    assert.ok(toolingFailure, "the superseded tooling failure must remain in the audit ledger");
    assert.ok(recovery, "the classification correction must be an explicit recovery Activity");
    assert.ok(semanticFailure, "normal Task Gate settlement must record the authoritative semantic failure");
    assert.ok(toolingFailure.confirmationOrder < recovery.confirmationOrder);
    assert.ok(recovery.confirmationOrder < semanticFailure.confirmationOrder);

    const settledFacts = readCurrentGateTransitionFacts({
      flowManager: resumed.manager,
      flowState: resumed.manager.loadReadOnly(specId),
      phase: "task-impl",
    });
    assert.equal(settledFacts.taskSettlementProgress.classificationRecovery.status, "recorded");
    assert.equal(settledFacts.taskSettlementProgress.classificationRecorded, true);
    assert.throws(
      () => resumed.manager.recoverTaskGateClassification({ specId, decision: recoveryDecision }),
      /changed|already complete|does not match|stale|requires one Definition-selected tooling conflict/,
    );
    const next = await new GetNextActionCommand().execute({
      ...hookContext({ root, manager: resumed.manager, specId }), phase: "task-impl",
    });
    assert.equal(next.directive.actionId, "CLAIM_GATE_RETRY");
  } finally {
    removeTmpDir(root);
  }
});

test("Task Gate settlement rejects a stale decision after the canonical revision advances", () => {
  const root = createTmpDir("task-gate-stale-settlement-");
  try {
    const specId = "910-task-gate-stale-settlement";
    const { manager } = taskGateFixture({ root, specId, result: "pass" });
    const decision = taskGateDecision(manager, specId);
    manager.addNote("Concurrent canonical observation.", { specId });
    const before = {
      state: manager.canonicalState(specId).toJSON(),
      activities: manager.activityLedger(specId),
      catalog: manager.artifactCatalog(specId).toJSON(),
    };
    assert.throws(
      () => manager.recordTaskGateSettlementMetric({ specId, decision }),
      /stale|snapshot changed/,
    );
    assert.deepEqual(manager.canonicalState(specId).toJSON(), before.state);
    assert.deepEqual(manager.activityLedger(specId), before.activities);
    assert.deepEqual(manager.artifactCatalog(specId).toJSON(), before.catalog);
  } finally {
    removeTmpDir(root);
  }
});

test("pre, post, and onError hook failures preserve the original failure and settle the bound Attempt", async (t) => {
  for (const scenario of [
    {
      name: "pre",
      install(entry) {
        const original = entry.pre;
        entry.pre = () => { throw Object.assign(new Error("pre failed"), { code: "PRE_FIXTURE_FAILED" }); };
        return () => { entry.pre = original; };
      },
      expectedCode: "PRE_FIXTURE_FAILED",
      expectedCalls: 0,
    },
    {
      name: "post",
      install(entry) {
        const original = entry.post;
        entry.post = () => { throw Object.assign(new Error("post failed"), { code: "POST_FIXTURE_FAILED" }); };
        return () => { entry.post = original; };
      },
      expectedCode: "POST_FIXTURE_FAILED",
      expectedCalls: 1,
    },
    {
      name: "onError",
      install(entry) {
        const original = entry.onError;
        entry.onError = () => { throw Object.assign(new Error("onError failed"), { code: "ON_ERROR_FIXTURE_FAILED" }); };
        return () => { entry.onError = original; };
      },
      expectedCode: "COMMAND_FIXTURE_FAILED",
      expectedCalls: 1,
      commandFails: true,
    },
  ]) {
    await t.test(`${scenario.name} hook`, async () => {
      const root = createTmpDir(`definition-lifecycle-${scenario.name}-hook-`);
      const entry = flowCommands.run["test-execute"];
      const originalCommand = entry.command;
      let restoreHook = () => {};
      try {
        const specId = `904-${scenario.name}-hook`;
        const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        new CanonicalFlowFixture({
          flowManager: manager,
          specId,
          runId: `run-${scenario.name}-hook`,
          execution: { mode: "direct", baseBranch: "main", featureBranch: null },
        }).create().registerActive().activate("test-execute");
        let calls = 0;
        class HookCommand extends Command {
          static outputMode = "envelope";
          execute() {
            calls += 1;
            if (scenario.commandFails) throw Object.assign(new Error("command failed"), { code: "COMMAND_FIXTURE_FAILED" });
            return { result: "fixture" };
          }
        }
        entry.command = async () => ({ default: HookCommand });
        restoreHook = scenario.install(entry);
        await dispatch({
          container: commandContainer({ root, manager }), entry, argv: [], envelopeType: "run", envelopeKey: "test-execute",
          stdout: () => {}, stderr: () => {}, setExitCode: () => {},
          buildHookCtx: () => hookContext({ root, manager, specId }),
        });
        assert.equal(calls, scenario.expectedCalls);
        assert.equal(manager.canonicalState(specId).attempt.failure.code, scenario.expectedCode);
      } finally {
        restoreHook();
        entry.command = originalCommand;
        removeTmpDir(root);
      }
    });
  }
});
