import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import { FlowCommand } from "../../../src/flow/lib/base-command.js";
import { flowCommands } from "../../../src/lib/command-registry.js";
import { Envelope } from "../../../src/lib/flow-envelope.js";
import { FatalPostHookError } from "../../../src/lib/post-hook-error.js";
import { dispatch } from "../../../src/lib/dispatcher.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { buildFlowCommandHookContext } from "../../../src/flow/lib/flow-context.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { ExecuteCommandDirective, RepairEvidenceDirective } from "../../../src/flow/lib/next-action-directive.js";

function completedAction() {
  return {
    taskId: null,
    step: null,
    action: "completed",
    instructions: null,
    context: null,
    output_schema: null,
    requires_approval: false,
    directive: { kind: "completed", terminal: true, requiresUserAction: false },
  };
}

function reviewAction() {
  return {
    taskId: null,
    step: "draft-questions-review",
    action: "run-review",
    instructions: { key: "plan.draft-questions-review", content: "Review the draft." },
    context: {},
    output_schema: {},
    requires_approval: false,
    maxAttempts: 1,
    directive: {
      kind: "execute_step",
      terminal: false,
      requiresUserAction: false,
      action: "run-review",
    },
  };
}

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

function taskReviewAction(taskId, step, action, key) {
  return {
    taskId,
    step,
    action,
    instructions: { key, content: "Run the task-owned command." },
    context: {},
    output_schema: {},
    requires_approval: false,
    maxAttempts: 1,
    directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action },
  };
}

test("dispatcher owns the typed historical missing-producer recovery command", async () => {
  const dispatcher = new RunDispatchCommand();
  const calls = [];
  dispatcher.runRegisteredFlowCommand = async (_ctx, _target, commandName, args) => {
    calls.push({ commandName, args });
    return { ok: true, errors: [] };
  };
  const result = await dispatcher.runDispatcherOwnedRecovery(
    {},
    {},
    {
      directive: new ExecuteCommandDirective({
        actionId: "RECOVER_MISSING_PRODUCER_ARTIFACT",
        nextAction: "sennel flow run recover-missing-producer-artifact --expect-run-id recovery-run",
        instruction: "Recover the historical producer.",
        reason: "The consumer was claimed before the producer result existed.",
      }),
    },
  );
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.deepEqual(calls, [{ commandName: "recover-missing-producer-artifact", args: [] }]);
});

test("dispatcher owns definition-selected Review settlement without starting a worker", async () => {
  const dispatcher = new RunDispatchCommand();
  const calls = [];
  dispatcher.runRegisteredFlowCommand = async (_ctx, _target, commandName, args) => {
    calls.push({ commandName, args });
    return { ok: true, errors: [] };
  };
  const result = await dispatcher.runDispatcherOwnedRecovery(
    {},
    {},
    {
      directive: new ExecuteCommandDirective({
        actionId: "SETTLE_REVIEW_DEFER",
        nextAction: "sennel flow run settle-review-transition --expect-run-id review-run",
        instruction: "Persist the definition-selected Review deferral.",
        reason: "The semantic Review retry budget is exhausted.",
      }),
    },
  );
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.deepEqual(calls, [{ commandName: "settle-review-transition", args: [] }]);
});

test("dispatcher recognizes Definition-owned Gate retry, repair, and settlement directives without a worker", async () => {
  const dispatcher = new RunDispatchCommand();
  const calls = [];
  dispatcher.runRegisteredFlowCommand = async (_ctx, _target, commandName, args) => {
    calls.push({ commandName, args });
    return { ok: true, errors: [] };
  };
  const retry = await dispatcher.runDispatcherOwnedRecovery({}, {}, { directive: new ExecuteCommandDirective({
    actionId: "CLAIM_GATE_RETRY", nextAction: "sennel flow run claim-next-action --expect-run-id run",
    instruction: "Retry.", reason: "fixture",
  }) });
  const settle = await dispatcher.runDispatcherOwnedRecovery({}, {}, { directive: new ExecuteCommandDirective({
    actionId: "SETTLE_GATE_DEFER", nextAction: "sennel flow run settle-gate-transition --expect-run-id run",
    instruction: "Settle.", reason: "fixture",
  }) });
  const reconcile = await dispatcher.runDispatcherOwnedRecovery({}, {}, { directive: new ExecuteCommandDirective({
    actionId: "RECONCILE_GATE_PUBLICATION", nextAction: "sennel flow run gate --expect-run-id run",
    instruction: "Reconcile.", reason: "fixture",
  }) });
  const ordinaryGate = await dispatcher.runDispatcherOwnedRecovery({}, {}, { directive: new ExecuteCommandDirective({
    actionId: "RUN_GATE", nextAction: "sennel flow run gate --expect-run-id run",
    instruction: "Evaluate.", reason: "fixture",
  }) });
  const repair = await dispatcher.runDispatcherOwnedRepair({}, {}, { directive: new RepairEvidenceDirective({
    actionId: "REPAIR_PLAN_GATE_EVIDENCE", evidenceKind: "gate", phase: "draft",
    nextAction: "sennel flow run repair-plan-gate --expect-run-id run", instruction: "Repair.", reason: "fixture",
  }) });
  assert.equal(retry.ok, true);
  assert.equal(settle.ok, true);
  assert.equal(reconcile.ok, true);
  assert.equal(ordinaryGate, null);
  assert.equal(repair.ok, true);
  assert.deepEqual(calls, [
    { commandName: "claim-next-action", args: [] },
    { commandName: "settle-gate-transition", args: [] },
    { commandName: "gate", args: [] },
    { commandName: "repair-plan-gate", args: [] },
  ]);
});

test("dispatcher reconciles a published Gate result through the normal registry without a worker", async () => {
  const root = createTmpDir("dispatcher-gate-publication-recovery-");
  try {
    const specId = "504-gate-publication-recovery";
    const runId = "run-gate-publication-recovery";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId,
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("spec-gate");
    const result = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "spec", nodeId: "spec-gate",
    }).promote({ result: "pass", artifacts: {} });
    manager.publishCurrentAttemptResult({ specId, commandResult: result });
    let workerCalls = 0;
    const dispatcher = new RunDispatchCommand({
      nextAction: {
        async run(container, input) {
          if (flow.state().currentNodeId !== "spec-gate") return completedAction();
          const next = await new GetNextActionCommand().run(container, input);
          assert.equal(next.directive.actionId, "RECONCILE_GATE_PUBLICATION");
          return next;
        },
      },
      agent: { async call() { workerCalls += 1; } },
      repositoryFingerprint: () => "dispatcher-gate-publication-recovery-fingerprint",
      leaseFactory: () => ({ acquire() {}, release() {} }),
      handoffCoordinator: { recoverPending() {} },
    });
    dispatcher.container = commandContainer({ root, manager });

    const outcome = await dispatcher.execute({
      root,
      mainRoot: root,
      executionRoot: root,
      specId,
      flowManager: manager,
      flowState: manager.load(specId),
      expectRunId: runId,
      _envelopeType: "run",
      _envelopeKey: "dispatch",
    });

    assert.equal(outcome.dispatch?.boundary, "completed", JSON.stringify(outcome));
    assert.equal(outcome.dispatch?.dispatchCount, 1);
    assert.equal(workerCalls, 0);
    assert.equal(manager.canonicalState(specId).findNode("spec-gate").status, "done");
    const publications = manager.activityLedger(specId).filter((activity) => (
      activity.nodeId === "spec-gate" && activity.transition.operation === "publish_artifacts"
    ));
    assert.equal(publications.length, 1);
    const history = JSON.parse(manager.readArtifact({
      specId, logicalKey: "spec.gate", consumerNodeId: "approval",
    }).bytes.toString("utf8"));
    assert.deepEqual(history.attempts.map((entry) => entry.attempt), [1]);
  } finally {
    removeTmpDir(root);
  }
});

test("published Gate failure is classified once and cannot be reconciled after reload", async () => {
  const root = createTmpDir("gate-publication-failure-recovery-");
  try {
    const specId = "505-gate-publication-failure";
    initGitRepo(root);
    commitAll(root, "initial");
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-gate-publication-failure",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("spec-gate");
    const published = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "spec", nodeId: "spec-gate",
    }).promote({
      result: "fail",
      artifacts: {
        failureKind: "ai_semantic_fail",
        failureCode: "SPEC_GATE_REJECTED",
        nextAction: { diagnosis: { observations: [] } },
      },
    });
    manager.publishCurrentAttemptResult({ specId, commandResult: published });
    const publishedResultActivityId = manager.artifactCatalog(specId).artifacts.find((artifact) => (
      artifact.logicalKey === "spec.gate"
    )).activityId;
    const ctx = {
      root,
      mainRoot: root,
      executionRoot: root,
      specId,
      phase: "spec",
      config: {},
      flowManager: manager,
      flowState: manager.load(specId),
    };
    const initial = await new GetNextActionCommand().execute(ctx);
    assert.equal(initial.directive.actionId, "RECONCILE_GATE_PUBLICATION");

    const result = await new RunGateCommand().execute(ctx);
    await FLOW_COMMANDS.run.gate.post(ctx, result);
    const failed = manager.canonicalState(specId);
    assert.equal(failed.current.at(-1), "spec-gate");
    assert.equal(failed.attempt.failure.code, "SPEC_GATE_REJECTED");
    assert.equal(manager.artifactCatalog(specId).artifacts.find((artifact) => (
      artifact.logicalKey === "spec.gate"
    )).activityId, publishedResultActivityId);

    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const next = await new GetNextActionCommand().execute({ ...ctx, flowManager: reloaded, flowState: reloaded.load(specId) });
    assert.notEqual(next.directive.actionId, "RECONCILE_GATE_PUBLICATION");
    assert.equal(next.directive.actionId, "CLAIM_GATE_RETRY");
    const before = {
      state: reloaded.canonicalState(specId).toJSON(),
      activities: reloaded.activityLedger(specId),
      catalog: reloaded.artifactCatalog(specId).toJSON(),
    };
    await assert.rejects(
      new RunGateCommand().execute({ ...ctx, flowManager: reloaded, flowState: reloaded.load(specId) }),
      /canonical gate admission rejected evaluation; definition selected retry/,
    );
    assert.deepEqual(reloaded.canonicalState(specId).toJSON(), before.state);
    assert.deepEqual(reloaded.activityLedger(specId), before.activities);
    assert.deepEqual(reloaded.artifactCatalog(specId).toJSON(), before.catalog);
  } finally {
    removeTmpDir(root);
  }
});

test("dispatcher executes a definition-owned review in the parent without starting a worker", async () => {
  const root = createTmpDir("dispatcher-command-owner-");
  try {
    fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
    const specId = "501-command-owner";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-command-owner",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft-questions-review");
    const action = reviewAction();
    let workerCalls = 0;
    let commandCall = null;
    const dispatcher = new RunDispatchCommand({
      nextAction: {
        async run() {
          return flow.state().currentNodeId === "draft-questions-review"
            ? structuredClone(action)
            : completedAction();
        },
      },
      agent: { async call() { workerCalls += 1; } },
      commandRunner: async ({ command, target }) => {
        commandCall = { name: command.commandName, argv: command.argv(target) };
        flow.settle("draft-questions-review");
        return { ok: true, errors: [] };
      },
      repositoryFingerprint: () => "dispatcher-command-owner-fingerprint",
      leaseFactory: () => ({ acquire() {}, release() {} }),
      handoffCoordinator: { recoverPending() {} },
    });
    dispatcher.container = {};

    const result = await dispatcher.execute({
      root,
      mainRoot: root,
      executionRoot: root,
      specId,
      flowManager: manager,
      flowState: manager.load(specId),
      expectRunId: "run-command-owner",
      expectSpec: specId,
      _envelopeType: "run",
      _envelopeKey: "dispatch",
    });

    assert.equal(result.dispatch?.boundary, "completed", JSON.stringify(result));
    assert.equal(result.dispatch.dispatchCount, 1);
    assert.equal(workerCalls, 0);
    assert.deepEqual(commandCall, {
      name: "review",
      argv: ["--phase", "draft", "--expect-run-id", "run-command-owner"],
    });
  } finally {
    removeTmpDir(root);
  }
});

test("dispatcher-owned command uses the normal registry lifecycle pipeline", async () => {
  const root = createTmpDir("dispatcher-command-pipeline-");
  const original = flowCommands.run.review;
  try {
    const specId = "502-command-pipeline";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-command-pipeline",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft-questions-review");
    let postCalls = 0;
    class ReviewStub extends FlowCommand {
      async execute() { return { result: "ok", artifacts: { phase: "draft" } }; }
    }
    flowCommands.run.review = {
      requiresFlow: true,
      args: { flags: ["--expect-no-issue"], options: ["--phase", "--expect-run-id", "--expect-spec", "--expect-issue", "--expect-binding"] },
      command: async () => ({ default: ReviewStub }),
      async post() {
        postCalls += 1;
        flow.settle("draft-questions-review");
      },
    };
    const action = reviewAction();
    let workerCalls = 0;
    const dispatcher = new RunDispatchCommand({
      nextAction: { async run() { return flow.state().currentNodeId === action.step ? action : completedAction(); } },
      agent: { async call() { workerCalls += 1; } },
      repositoryFingerprint: () => "dispatcher-command-pipeline-fingerprint",
      leaseFactory: () => ({ acquire() {}, release() {} }),
      handoffCoordinator: { recoverPending() {} },
    });
    dispatcher.container = commandContainer({ root, manager });
    const result = await dispatcher.execute({
      root, mainRoot: root, executionRoot: root, specId, flowManager: manager,
      flowState: manager.load(specId), expectRunId: "run-command-pipeline",
      _envelopeType: "run", _envelopeKey: "dispatch",
    });
    assert.equal(result.dispatch?.boundary, "completed", JSON.stringify(result));
    assert.equal(postCalls, 1);
    assert.equal(workerCalls, 0);
  } finally {
    flowCommands.run.review = original;
    removeTmpDir(root);
  }
});

test("dispatcher preserves a command envelope failure code and does not start a worker", async () => {
  const root = createTmpDir("dispatcher-command-failure-");
  const original = flowCommands.run.review;
  try {
    const specId = "503-command-failure";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-command-failure",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft-questions-review");
    class ReviewFailureStub extends FlowCommand {
      async execute() { return Envelope.fail("run", "review", "REVIEW_STUB_FAILURE", "stub failed"); }
    }
    flowCommands.run.review = {
      requiresFlow: true,
      args: { flags: ["--expect-no-issue"], options: ["--phase", "--expect-run-id", "--expect-spec", "--expect-issue", "--expect-binding"] },
      command: async () => ({ default: ReviewFailureStub }),
    };
    let workerCalls = 0;
    const dispatcher = new RunDispatchCommand({
      nextAction: { async run() { return reviewAction(); } },
      agent: { async call() { workerCalls += 1; } },
      repositoryFingerprint: () => "dispatcher-command-failure-fingerprint",
      leaseFactory: () => ({ acquire() {}, release() {} }),
      handoffCoordinator: { recoverPending() {} },
    });
    dispatcher.container = commandContainer({ root, manager });
    const result = await dispatcher.execute({
      root, mainRoot: root, executionRoot: root, specId, flowManager: manager,
      flowState: manager.load(specId), expectRunId: "run-command-failure",
      _envelopeType: "run", _envelopeKey: "dispatch",
    });
    assert.equal(result.errors[0].code, "REVIEW_STUB_FAILURE");
    assert.equal(workerCalls, 0);
    assert.equal(flow.state().currentNodeId, "draft-questions-review");
  } finally {
    flowCommands.run.review = original;
    removeTmpDir(root);
  }
});

test("dispatcher preserves a fatal registry post-hook code and does not start a worker", async () => {
  const root = createTmpDir("dispatcher-command-post-failure-");
  const original = flowCommands.run.review;
  try {
    const specId = "503-command-post-failure";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-command-post-failure",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft-questions-review");
    class ReviewStub extends FlowCommand {
      async execute() { return { result: "ok" }; }
    }
    flowCommands.run.review = {
      requiresFlow: true,
      args: { flags: ["--expect-no-issue"], options: ["--phase", "--expect-run-id", "--expect-spec", "--expect-issue", "--expect-binding"] },
      command: async () => ({ default: ReviewStub }),
      async post() { throw new FatalPostHookError("REVIEW_POST_FATAL", "review post fixture failed"); },
    };
    let workerCalls = 0;
    const dispatcher = new RunDispatchCommand({
      nextAction: { async run() { return reviewAction(); } },
      agent: { async call() { workerCalls += 1; } },
      repositoryFingerprint: () => "dispatcher-command-post-failure-fingerprint",
      leaseFactory: () => ({ acquire() {}, release() {} }),
      handoffCoordinator: { recoverPending() {} },
    });
    dispatcher.container = commandContainer({ root, manager });
    const result = await dispatcher.execute({
      root, mainRoot: root, executionRoot: root, specId, flowManager: manager,
      flowState: manager.load(specId), expectRunId: "run-command-post-failure",
      _envelopeType: "run", _envelopeKey: "dispatch",
    });
    assert.equal(result.errors[0].code, "REVIEW_POST_FATAL");
    assert.equal(workerCalls, 0);
    assert.equal(flow.state().currentNodeId, "draft-questions-review");
  } finally {
    flowCommands.run.review = original;
    removeTmpDir(root);
  }
});

test("dispatcher executes materialized task review and gate commands through their registries without a worker", async () => {
  const originals = { review: flowCommands.run.review, gate: flowCommands.run.gate };
  try {
    for (const scenario of [
      { command: "review", step: "task-review", action: "run-review", key: "task.task-review", args: ["--phase", "impl"] },
      { command: "gate", step: "task-gate", action: "run-gate", key: "impl.impl-gate", args: [] },
    ]) {
      const root = createTmpDir(`dispatcher-${scenario.command}-task-owner-`);
      try {
        const specId = `504-task-${scenario.command}`;
        const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const flow = new CanonicalFlowFixture({
          flowManager: manager, specId, runId: `run-task-${scenario.command}`,
          execution: { mode: "direct", baseBranch: "main", featureBranch: null },
          specRecord: { requirements: [{ id: "R-T-1", desc: "Exercise Task command ownership.", task_ids: ["T-1"] }] },
        }).create().addTask({
          id: "T-1", title: "Task command", goal: "Exercise materialized command ownership.",
          parent: null, origin: "plan", added_round: 0, status: "pending",
        }).registerActive();
        flow.settleBefore("T-1-impl").activate("T-1-impl", { settlePredecessors: false }).settle("T-1-impl");
        if (scenario.command === "gate") {
          flow.settle("T-1-review");
          flow.settle("T-1-triage", "skipped");
          flow.settle("T-1-repair", "skipped");
        }
        flow.activate(`T-1-${scenario.command === "review" ? "review" : "gate"}`, { settlePredecessors: false });
        class TaskCommandStub extends FlowCommand {
          async execute() { return { result: "ok" }; }
        }
        let postCalls = 0;
        let postCompleted = false;
        flowCommands.run[scenario.command] = {
          requiresFlow: true,
          args: { flags: ["--expect-no-issue"], options: ["--phase", "--expect-run-id", "--expect-spec", "--expect-issue", "--expect-binding"] },
          command: async () => ({ default: TaskCommandStub }),
          async post() {
            postCalls += 1;
            postCompleted = true;
          },
        };
        const action = taskReviewAction("T-1", scenario.step, scenario.action, scenario.key);
        let workerCalls = 0;
        const dispatcher = new RunDispatchCommand({
          nextAction: { async run() { return postCompleted ? completedAction() : structuredClone(action); } },
          agent: { async call() { workerCalls += 1; } },
          repositoryFingerprint: () => `dispatcher-task-${scenario.command}-fingerprint`,
          leaseFactory: () => ({ acquire() {}, release() {} }),
          handoffCoordinator: { recoverPending() {} },
        });
        dispatcher.container = commandContainer({ root, manager });
        const result = await dispatcher.execute({
          root, mainRoot: root, executionRoot: root, specId, flowManager: manager,
          flowState: manager.load(specId), expectRunId: `run-task-${scenario.command}`,
          _envelopeType: "run", _envelopeKey: "dispatch",
        });
        assert.equal(result.dispatch?.boundary, "completed", `${scenario.command}: ${JSON.stringify(result)}`);
        assert.equal(postCalls, 1, `${scenario.command} post`);
        assert.equal(workerCalls, 0, `${scenario.command} worker`);
      } finally {
        removeTmpDir(root);
      }
    }
  } finally {
    flowCommands.run.review = originals.review;
    flowCommands.run.gate = originals.gate;
  }
});

test("finalize cleanup returns at completion without reading a removed execution root", async () => {
  const mainRoot = createTmpDir("dispatcher-finalize-cleanup-main-");
  const executionRoot = path.join(mainRoot, "execution");
  try {
    fs.mkdirSync(executionRoot, { recursive: true });
    const specId = "504-finalize-cleanup";
    const manager = new FlowManager({ root: executionRoot, mainRoot, inWorktree: true, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-finalize-cleanup",
      execution: { mode: "worktree", baseBranch: "main", featureBranch: "feature/finalize-cleanup" },
    }).create().registerActive().activate("finalize-cleanup");
    const action = {
      taskId: null, step: "finalize-cleanup", action: "run-finalize-cleanup",
      instructions: { key: "impl.finalize-cleanup", content: "Clean up." }, context: {}, output_schema: {},
      requires_approval: false, maxAttempts: 1,
      directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "run-finalize-cleanup" },
    };
    const dispatcher = new RunDispatchCommand({
      nextAction: { async run() { throw new Error("next-action must not read a removed execution root"); } },
      commandRunner: async () => {
        fs.rmSync(executionRoot, { recursive: true, force: true });
        return { ok: true, errors: [], data: { status: "done", assurance: { completed: true } } };
      },
      repositoryFingerprint: () => "dispatcher-finalize-cleanup-fingerprint",
      leaseFactory: () => ({ acquire() {}, release() {} }),
      handoffCoordinator: { recoverPending() {} },
    });
    dispatcher.container = {};
    // The first next-action read starts the loop; all reads after cleanup must
    // be avoided because the command has removed this worktree.
    let reads = 0;
    dispatcher.nextAction = { async run() { return reads++ < 2 ? structuredClone(action) : (() => { throw new Error("unexpected next-action read"); })(); } };
    const result = await dispatcher.execute({
      root: executionRoot, mainRoot, executionRoot, specId, flowManager: manager,
      flowState: manager.load(specId), expectRunId: "run-finalize-cleanup",
      _envelopeType: "run", _envelopeKey: "dispatch",
    });
    assert.equal(result.dispatch.boundary, "completed");
    assert.equal(result.dispatch.dispatchCount, 1);
    assert.equal(reads, 2);
  } finally {
    removeTmpDir(mainRoot);
  }
});

test("a successful dispatcher-owned repair that makes no durable progress stalls within the configured bound", async () => {
  const root = createTmpDir("dispatcher-repair-stall-");
  try {
    const specId = "505-repair-stall";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-repair-stall",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive();
    const action = {
      taskId: null, step: "draft", action: "write-draft", instructions: { key: "plan.draft", content: "Repair." },
      context: {}, output_schema: {}, requires_approval: false, maxAttempts: 1,
      directive: {
        kind: "repair_evidence", terminal: false, requiresUserAction: false,
        actionId: "REPAIR_PLAN_GATE_EVIDENCE", evidenceKind: "gate", phase: "draft",
        instruction: "Repair the governed evidence.", reason: "fixture", nextAction: "sennel flow run repair-plan-gate",
      },
    };
    let repairCalls = 0;
    let workerCalls = 0;
    const dispatcher = new RunDispatchCommand({
      nextAction: { async run() { return structuredClone(action); } },
      repairCommandRunner: async () => {
        repairCalls += 1;
        return { ok: true, errors: [] };
      },
      agent: { async call() { workerCalls += 1; } },
      repositoryFingerprint: () => "dispatcher-repair-stall-fingerprint",
      maxStalledDispatches: 2,
      leaseFactory: () => ({ acquire() {}, release() {} }),
      handoffCoordinator: { recoverPending() {} },
    });
    dispatcher.container = {};
    const result = await dispatcher.execute({
      root, mainRoot: root, executionRoot: root, specId, flowManager: manager,
      flowState: flow.state(), expectRunId: "run-repair-stall",
      _envelopeType: "run", _envelopeKey: "dispatch",
    });
    assert.equal(result.errors[0].code, "FLOW_DISPATCH_STALLED");
    assert.equal(result.data.dispatch.dispatchCount, 2);
    assert.equal(repairCalls, 2);
    assert.equal(workerCalls, 0);
  } finally {
    removeTmpDir(root);
  }
});

test("dispatcher target selection fails closed for mismatched direct and worktree flows before a worker can start", async () => {
  for (const mode of ["direct", "worktree"]) {
    const mainRoot = createTmpDir(`dispatcher-target-${mode}-main-`);
    const root = mode === "worktree" ? path.join(mainRoot, "execution") : mainRoot;
    try {
      fs.mkdirSync(root, { recursive: true });
      const specId = `506-target-${mode}`;
      const manager = new FlowManager({ root, mainRoot, inWorktree: mode === "worktree", specId });
      new CanonicalFlowFixture({
        flowManager: manager, specId, runId: `run-target-${mode}`,
        execution: mode === "worktree"
          ? { mode: "worktree", baseBranch: "main", featureBranch: `feature/target-${mode}` }
          : { mode: "direct", baseBranch: "main", featureBranch: null },
      }).create().registerActive();
      let workerCalls = 0;
      const container = {
        ...commandContainer({ root, manager }),
        get(name) {
          if (name === "inWorktree") return mode === "worktree";
          return commandContainer({ root, manager }).get(name);
        },
      };
      const output = [];
      await dispatch({
        container,
        entry: flowCommands.run.dispatch,
        argv: ["--expect-run-id", "different-run"],
        envelopeType: "run",
        envelopeKey: "dispatch",
        stdout: (text) => output.push(text),
        stderr: () => {},
        setExitCode: () => {},
        buildHookCtx: (activeContainer, input) => buildFlowCommandHookContext(
          activeContainer,
          flowCommands.run.dispatch,
          input,
        ),
      });
      const result = JSON.parse(output.join(""));
      assert.equal(
        ["ACTIVE_FLOW_MISMATCH", "FLOW_TARGET_NOT_FOUND"].includes(result.errors[0].code),
        true,
        `${mode}: ${result.errors[0].code}`,
      );
      assert.equal(workerCalls, 0, mode);
    } finally {
      removeTmpDir(mainRoot);
    }
  }
});
