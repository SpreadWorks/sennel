import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { FileLockReentrancyError } from "../../../src/lib/file-lock.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import { FlowDispatchAction } from "../../../src/flow/lib/run-dispatch.js";
import {
  buildCurrentFlowDefinition,
  getFlowNode,
  TaskReviewStageBinding,
  TaskReviewStageFacts,
  resolveTaskReviewStageTransition,
} from "../../../src/flow/definition.js";
import {
  ActivityArtifactReference,
  ActivityEvaluationReference,
  ActivityFindingReference,
  ActivityReferences,
  ActivityRepairReference,
  ActivityTask,
  ActivityTransition,
  CurrentAttempt,
  CurrentFlowContext,
  CurrentFlowDefinition,
  CurrentFlowState,
  CurrentFlowStateAdoptionBoundary,
  CurrentFlowStateConflictError,
  CurrentFlowStateInvariantError,
  CurrentFlowStateSnapshot,
  CurrentFlowStateStore,
  CurrentFlowStateSerializer,
  CurrentFlowStateValidator,
  DefinitionFailurePolicy,
  ExecutableStepClaim,
  FlowActivity,
  FlowActivityJournal,
  FlowDefinitionNode,
  NodeResult,
  TaskNode,
} from "../../../src/flow/lib/current-flow-state.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const NOW = "2026-08-07T00:00:00.000Z";
const LATER = "2026-08-07T00:01:00.000Z";

function definition() {
  return buildCurrentFlowDefinition();
}

function definitionWithActionOverride(base, nodeId, action) {
  const clone = (node) => new FlowDefinitionNode({
    kind: node.kind,
    id: node.id,
    key: node.key,
    contract: node.contract,
    steps: node.steps.map(clone),
    action: node.steps.length === 0
      ? node.id === nodeId ? { ...node.action.toJSON(), action } : node.action
      : null,
  });
  return new CurrentFlowDefinition({
    root: clone(base.root),
    taskTemplate: base.taskTemplate,
    dynamicTaskContainerId: base.dynamicTaskContainerId,
    dynamicTaskInsertionAfterId: base.dynamicTaskInsertionAfterId,
  });
}

function passedResult(summary = "Confirmed.", artifactRefs = [{ kind: "artifact", id: "artifact-1" }]) {
  return { outcome: "passed", summary, confirmedAt: LATER, artifactRefs };
}

function skippedResult(summary = "Skipped.") {
  return { outcome: "skipped", summary, confirmedAt: LATER, artifactRefs: [{ kind: "artifact", id: "skipped-artifact" }] };
}

function approvalActivityTask(id, key) {
  const taskDocument = { id, parent: null };
  const taskDigest = crypto.createHash("sha256")
    .update(JSON.stringify(taskDocument))
    .digest("hex");
  return new ActivityTask({
    id,
    key,
    approvalSource: {
      specRecordHash: "a".repeat(64),
      specRecordActivityId: "approval-source-activity",
      taskDigest,
      taskKey: key,
      taskDocument,
    },
  });
}

function failedResult(summary = "Attempt failed.") {
  return { outcome: "failed", summary, confirmedAt: LATER, artifactRefs: [] };
}

function incompleteResult(summary = "Attempt is incomplete.") {
  return { outcome: "incomplete", summary, confirmedAt: LATER, artifactRefs: [] };
}

function historicalProvenance(execution = "dormant") {
  return {
    kind: "historical",
    execution,
    ledger: "partial",
    creation: { status: "unavailable", reason: "NO_TRUSTED_CREATION_EVIDENCE" },
    continuation: null,
  };
}

function importedState(state, execution = "dormant") {
  return new CurrentFlowState({ ...state.toJSON(), history: historicalProvenance(execution) }, { definition: state.definition });
}

function historicalStateWithCreationAuthority(state, created) {
  return new CurrentFlowState({
    ...state.toJSON(),
    history: {
      kind: "historical",
      execution: "dormant",
      ledger: "partial",
      creation: {
        status: "available",
        source: {
          path: "flow.json",
          pointer: "/createdAt",
          hash: "a".repeat(64),
          timestamp: created.timing.startedAt,
        },
      },
      continuation: null,
    },
  }, { definition: state.definition });
}

function attemptFor(state, currentPath, id, sequence = null, {
  tooling = 0,
  semantic = null,
  blocker = null,
  incomplete = [],
  operationClaims = null,
} = {}) {
  const contract = state.definition.contractFor(currentPath.at(-1), state.root);
  const leaf = state.findNode(currentPath.at(-1));
  const nextSequence = sequence ?? leaf.attemptSequence + 1;
  const previous = state.current?.at(-1) === leaf.id ? state.attempt : null;
  const semanticConsumption = semantic ?? (previous === null
    ? 0
    : previous.consumption.semantic + (tooling === previous.consumption.tooling ? 1 : 0));
  return new CurrentAttempt({
    id,
    nodeId: currentPath.at(-1),
    sequence: nextSequence,
    startedAt: NOW,
    consumption: { semantic: semanticConsumption, tooling },
    failure: null,
    blocker,
    incomplete,
    operationClaims: operationClaims ?? [{
      operation: "execute",
      resources: [...contract.resourceContract.required],
    }],
  });
}

function startDescriptor(state, id, options = {}) {
  const descriptor = state.nextAction();
  assert.ok(descriptor, "expected a definition-owned next action");
  const attempt = attemptFor(state, descriptor.path, id, undefined, options);
  if (descriptor.operation === "start") {
    return state.startAttempt({ path: descriptor.path, attempt });
  }
  if (descriptor.operation === "recover") {
    return state.recover({ path: descriptor.path, attempt });
  }
  throw new Error(`cannot start an already-resumable action: ${descriptor.nodeId}`);
}

function fixtureTaskGateLifecycle(state, status) {
  const leafId = state.current?.at(-1) ?? null;
  const task = state.findNode(state.current?.at(-2));
  if (status !== "done" || !(task instanceof TaskNode) || task.steps.at(-1)?.id !== leafId) return null;
  const leaves = state.definition.orderedLeaves(state.root);
  const successor = leaves.slice(leaves.findIndex((leaf) => leaf.id === leafId) + 1)
    .find((leaf) => leaf.status === "pending" || leaf.status === "invalidated");
  return {
    operation: "complete-and-advance",
    taskId: task.id,
    successorStepId: successor.id,
    resetStepIds: [],
  };
}

function completeNext(state, id, { status = "done", summary = id, artifactRefs } = {}) {
  const active = startDescriptor(state, id);
  return active.confirmCurrentAttempt({
    status,
    result: status === "done" ? passedResult(summary, artifactRefs) : skippedResult(summary),
    gateTaskLifecycle: fixtureTaskGateLifecycle(active, status),
  });
}

function advanceUntil(state, targetId, prefix = "advance") {
  let next = state.nextAction();
  let count = 0;
  while (next?.nodeId !== targetId) {
    if (next === null) throw new Error(`target ${targetId} is not in the definition order`);
    state = completeNext(state, `${prefix}-${count}`);
    next = state.nextAction();
    count += 1;
    if (count > 100) throw new Error("definition traversal did not converge");
  }
  return state;
}

function flowActivity({
  id,
  state,
  currentPath,
  confirmationOrder,
  operation,
  attempt = null,
  task = null,
  status = null,
  result = null,
  failure = null,
}) {
  const node = state.findNode(currentPath.at(-1));
  const activityAttempt = ["add_task", "add_approval_task"].includes(operation)
    ? null
    : operation === "retry_attempt" ? state.attempt : attempt ?? state.attempt;
  const type = {
    add_task: "task_added",
    add_approval_task: "task_added",
    start_attempt: "attempt_started",
    retry_attempt: "attempt_retried",
    update_attempt: "attempt_updated",
    fail_attempt: "attempt_failed",
    record_failure: "failure_recorded",
    confirm_attempt: "result_confirmed",
    rewind: "recovery",
    plan_gate_repair: "recovery",
    recover_attempt: "recovery",
  }[operation];
  return new FlowActivity({
    id,
    nodeId: node.id,
    nodeKey: node.key,
    attemptId: activityAttempt?.id ?? null,
    sequence: activityAttempt?.sequence ?? null,
    confirmationOrder,
    type,
    transition: new ActivityTransition({ operation, nodeId: node.id, task, attempt, status, policy: null, outbox: null, approval: null, nonblocking: null }),
    result,
    timing: { startedAt: NOW, finishedAt: LATER, durationMs: 60000 },
    failure,
    provider: "provider",
    model: "model",
    effort: "standard",
    usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 2, cost: 0 },
    references: {
      evaluations: [{ id: "evaluation-1", label: null }],
      findings: [{ id: "finding-1", label: null }],
      repairs: [{ id: "repair-1", label: null }],
      artifacts: [{ id: "artifact-1", label: null }],
    },
    metric: null,
    note: null,
    reviewPublication: null,
  });
}

function identitySource(bootIdentity) {
  return new ProcessIdentitySource({
    platform: "linux",
    pid: process.pid,
    readBootIdentity: () => bootIdentity,
    readProcessStartFingerprint: () => "100",
  });
}

function tinyAction(id, failurePolicy = "block", maxAttempts = 1) {
  return {
    action: `run-${id}`,
    instructionsKey: `tiny.${id}`,
    contextKinds: [],
    outputSchemaRef: null,
    requiresApproval: false,
    autoApproveChoiceId: null,
    maxAttempts,
    sideEffects: null,
    failurePolicy,
    executionCommand: null,
  };
}

function tinyDefinition({ secondTransitions = null, taskSteps = null, firstOverrides = {}, firstFailurePolicy = "block" } = {}) {
  const firstContract = firstFailurePolicy === "retry"
    ? {
      semanticRetryLimit: 1,
      transitions: [
        "pending:in_progress", "in_progress:done", "in_progress:skipped", "in_progress:failed",
        "done:in_progress", "skipped:in_progress", "failed:in_progress", "invalidated:in_progress",
        "pending:invalidated", "in_progress:invalidated", "done:invalidated", "skipped:invalidated",
      ],
    }
    : null;
  return new CurrentFlowDefinition({
    root: new FlowDefinitionNode({
      kind: "flow",
      id: "flow",
      key: "flow",
      steps: [
        new FlowDefinitionNode({
          id: "phase",
          key: "phase",
          steps: [
            new FlowDefinitionNode({
              id: "first",
              key: "first",
              action: tinyAction("first", firstFailurePolicy, firstFailurePolicy === "retry" ? 2 : 1),
              ...(firstContract === null ? {} : { contract: firstContract }),
              ...firstOverrides,
            }),
            new FlowDefinitionNode({
              id: "second",
              key: "second",
              contract: {
                transitions: secondTransitions ?? [
                  "pending:in_progress", "in_progress:done", "in_progress:skipped",
                  "done:in_progress", "skipped:in_progress", "invalidated:in_progress",
                  "pending:invalidated", "in_progress:invalidated", "done:invalidated", "skipped:invalidated",
                ],
              },
              action: tinyAction("second"),
            }),
          ],
        }),
        new FlowDefinitionNode({
          id: "impl",
          key: "impl",
          steps: [
            new FlowDefinitionNode({ id: "implement", key: "implement", action: tinyAction("implement") }),
            new FlowDefinitionNode({ id: "after", key: "after", action: tinyAction("after") }),
          ],
        }),
      ],
    }),
    taskTemplate: new FlowDefinitionNode({
      kind: "task",
      id: "task",
      key: "task",
      steps: taskSteps ?? [new FlowDefinitionNode({ id: "task-work", key: "task-work", action: tinyAction("task-work") })],
    }),
    dynamicTaskContainerId: "impl",
    dynamicTaskInsertionAfterId: "implement",
  });
}

describe("Current Flow state foundation", () => {
  let tmp = null;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("enforces the exact schemaRevision 3 wire contract through its dedicated serializer and validator", () => {
    const currentDefinition = definition();
    const validator = new CurrentFlowStateValidator({ definition: currentDefinition });
    const serializer = new CurrentFlowStateSerializer({ validator });
    const fresh = CurrentFlowState.create({
      definition: currentDefinition,
      flowId: "flow-a",
      flowVersionId: "flow-a-v1",
      runId: "run-a",
      specId: "001-contract",
      request: "Original request must persist.",
    });
    const wire = serializer.serialize(fresh);
    assert.equal(wire.schemaRevision, 3);
    assert.equal(wire.current, null);
    assert.equal(wire.attempt, null);
    assert.equal(wire.context, null);
    assert.equal(wire.history, null);
    assert.deepEqual(Object.keys(wire).sort(), [
      "artifacts", "attempt", "attemptSequence", "confirmationOrder", "context", "current", "execution", "flowId",
      "flowVersionId", "history", "id", "issue", "key", "kind", "lifecycle", "outbox", "policy", "request", "result", "runId",
      "schemaRevision", "specId", "status", "steps", "version",
    ].sort());
    assert.deepEqual(serializer.deserialize(JSON.parse(serializer.bytes(fresh).toString("utf8"))).toJSON(), wire);

    const missingRequired = structuredClone(wire);
    delete missingRequired.request;
    assert.throws(() => validator.validate(missingRequired), /flow state.request is required/);
    assert.throws(() => validator.validate({ ...wire, unknown: true }), /unsupported field/);
    assert.throws(() => validator.validate({ ...wire, lifecycle: { state: "unknown" } }), /lifecycle.state is invalid/);
    assert.deepEqual(wire.execution, { mode: "direct", baseBranch: null, featureBranch: null });
    assert.throws(() => validator.validate({ ...wire, execution: { mode: "remote" } }), /execution.mode is invalid/);
    const forgedNested = structuredClone(wire);
    forgedNested.steps[0].steps[0].id = "forged-step";
    assert.throws(() => validator.validate(forgedNested), /state node does not match definition/);
    const completed = completeNext(fresh, "contract-branch").toJSON();
    completed.steps[0].steps[0].result = { outcome: "unknown", summary: "bad", confirmedAt: LATER, artifactRefs: [] };
    assert.throws(() => validator.validate(completed), /result.outcome is invalid/);
    const active = fresh.startAttempt({
      path: fresh.nextAction().path,
      attempt: attemptFor(fresh, fresh.nextAction().path, "contract-attempt"),
    }).toJSON();
    delete active.attempt.nodeId;
    assert.throws(() => validator.validate(active), /attempt.nodeId is required/);
    assert.throws(() => validator.validate({ ...wire, current: ["flow"] }), /current must be a stable node id or null/);
  });

  it("keeps dormant imports passive and grants Definition continuation only through an explicit retry", () => {
    const retryingDefinition = tinyDefinition({ firstFailurePolicy: "retry" });
    const dormant = CurrentFlowState.create({ definition: retryingDefinition, history: historicalProvenance() });
    assert.equal(dormant.nextAction(), null, "reading a dormant import must not select an executable frontier");
    assert.throws(
      () => dormant.assertPassiveExecutableTarget("first"),
      /no canonical passive successor/,
      "a dormant import cannot be claimed without an explicit historical cursor recovery",
    );

    let state = CurrentFlowState.create({ definition: retryingDefinition });
    const firstPath = state.nextAction().path;
    state = state.startAttempt({ path: firstPath, attempt: attemptFor(state, firstPath, "historical-first") });
    state = importedState(state);
    state = state.failCurrentAttempt({
      result: failedResult("The imported worker needs a retry."),
      failure: {
        category: "review",
        code: "IMPORTED_RETRY",
        message: "The imported worker needs a retry.",
        retryable: true,
        retryKind: "semantic",
      },
    });
    assert.equal(state.history.execution, "dormant", "recording a failure is not continuation admission");

    const resumed = state.retryCurrentAttempt({
      attempt: attemptFor(state, firstPath, "historical-first-retry", 2),
      kind: "semantic",
    });
    assert.equal(resumed.history.execution, "resumed");
    const reloaded = new CurrentFlowState(resumed.toJSON(), { definition: resumed.definition });
    assert.equal(reloaded.history.execution, "resumed", "continuation admission survives canonical state readback");

    let completed = reloaded.confirmCurrentAttempt({ result: passedResult("Recovered imported first step."), status: "done" });
    assert.equal(completed.nextAction().nodeId, "second", "resumed state exposes Definition's passive successor after restart");
    while (completed.nextAction() !== null) completed = completeNext(completed, `resumed-${completed.nextAction().nodeId}`);
    const finalized = completed.finalize();
    assert.equal(finalized.lifecycle.state, "finalized");
    assert.equal(finalized.history.execution, "resumed", "finalization retains import provenance and continuation authority");
  });

  it("does not resume an unadmitted dormant historical Attempt", () => {
    const tiny = tinyDefinition({ firstFailurePolicy: "retry" });
    let active = CurrentFlowState.create({ definition: tiny });
    const firstPath = active.nextAction().path;
    active = active.startAttempt({ path: firstPath, attempt: attemptFor(active, firstPath, "dormant-active") });
    const dormant = importedState(active);
    assert.equal(dormant.nextAction(), null, "an imported in-flight Attempt cannot reach a worker without a persisted admission");
    const failed = dormant.failCurrentAttempt({
      result: failedResult("An explicit retry is needed."),
      failure: {
        category: "review",
        code: "DORMANT_ATTEMPT_RETRY",
        message: "An explicit retry is needed.",
        retryable: true,
        retryKind: "semantic",
      },
    });
    assert.equal(failed.nextAction().operation, "retry");
    const resumed = failed.retryCurrentAttempt({
      attempt: attemptFor(failed, firstPath, "dormant-active-retry", 2),
      kind: "semantic",
    });
    assert.equal(resumed.nextAction().operation, "resume");
    assert.equal(resumed.history.execution, "resumed");
  });

  it("recovers a journal-first historical continuation admission and resumed Activity exactly once", () => {
    tmp = createTmpDir("current-flow-historical-journal-recovery-");
    const fixedDefinition = definition();
    const directory = path.join(tmp, "state");
    const createdStore = new CurrentFlowStateStore({ directory, definition: fixedDefinition });
    const created = createdStore.create(CurrentFlowState.create({ definition: fixedDefinition }));
    const dormant = historicalStateWithCreationAuthority(created, createdStore.journal.read()[0]);
    fs.writeFileSync(createdStore.statePath, `${JSON.stringify(dormant.toJSON())}\n`);

    const branchPath = dormant.definition.pathFor(dormant.root, "branch");
    const admission = flowActivity({
      id: "historical-admission",
      state: dormant,
      currentPath: branchPath,
      confirmationOrder: 2,
      operation: "start_attempt",
      attempt: attemptFor(dormant, branchPath, "historical-branch"),
    });
    const interruptedAdmission = new CurrentFlowStateStore({
      directory,
      definition: fixedDefinition,
      faultInjector({ phase }) {
        if (phase === "activity-appended") throw new Error("crash after historical admission append");
      },
    });
    assert.throws(
      () => interruptedAdmission.apply({ activity: admission }),
      /crash after historical admission append/,
    );
    const dormantBytes = fs.readFileSync(interruptedAdmission.statePath, "utf8");
    const readonly = new CurrentFlowStateStore({ directory, definition: fixedDefinition });
    assert.equal(readonly.load().history.execution, "dormant");
    assert.equal(fs.readFileSync(readonly.statePath, "utf8"), dormantBytes, "readback must not materialize a pending admission");
    assert.equal(readonly.journal.read().length, 2);

    const recoveredStore = new CurrentFlowStateStore({ directory, definition: fixedDefinition });
    const resumed = recoveredStore.apply({ activity: admission });
    assert.equal(resumed.history.execution, "resumed");
    assert.equal(resumed.history.continuation.confirmationOrder, 2);
    assert.equal(recoveredStore.journal.read().length, 2);
    assert.deepEqual(recoveredStore.apply({ activity: admission }).toJSON(), resumed.toJSON(), "replaying the admission is idempotent");

    const failure = flowActivity({
      id: "historical-resumed-failure",
      state: resumed,
      currentPath: branchPath,
      confirmationOrder: 3,
      operation: "fail_attempt",
      result: failedResult("The resumed attempt was interrupted."),
      failure: {
        category: "execution",
        code: "RESUMED_INTERRUPTED",
        message: "The resumed attempt was interrupted.",
        retryable: false,
        retryKind: null,
      },
    });
    const interruptedResumed = new CurrentFlowStateStore({
      directory,
      definition: fixedDefinition,
      faultInjector({ phase }) {
        if (phase === "activity-appended") throw new Error("crash after resumed Activity append");
      },
    });
    assert.throws(() => interruptedResumed.apply({ activity: failure }), /crash after resumed Activity append/);
    const resumedBytes = fs.readFileSync(interruptedResumed.statePath, "utf8");
    assert.equal(new CurrentFlowStateStore({ directory, definition: fixedDefinition }).load().confirmationOrder, 2);
    assert.equal(fs.readFileSync(interruptedResumed.statePath, "utf8"), resumedBytes, "readback must leave a pending resumed Activity alone");
    const settled = new CurrentFlowStateStore({ directory, definition: fixedDefinition }).apply({ activity: failure });
    assert.equal(settled.confirmationOrder, 3);
    assert.equal(settled.history.execution, "resumed");
    assert.deepEqual(new CurrentFlowStateStore({ directory, definition: fixedDefinition }).apply({ activity: failure }).toJSON(), settled.toJSON());

    const forgedBoundary = settled.toJSON();
    forgedBoundary.history.continuation.confirmationOrder = 3;
    fs.writeFileSync(recoveredStore.statePath, `${JSON.stringify(forgedBoundary)}\n`);
    assert.throws(
      () => new CurrentFlowStateStore({ directory, definition: fixedDefinition }).load(),
      /continuation boundary does not match its admitted Attempt/,
      "a matching order without an Attempt introduction cannot grant continuation authority",
    );
  });

  it("projects dormant history as a dispatcher block instead of completed Flow", () => {
    const dormant = CurrentFlowState.create({ definition: tinyDefinition(), history: historicalProvenance() });
    const projection = new GetNextActionCommand().executeCanonical({
      flowManager: { canonicalState: () => dormant },
      flowState: dormant,
      specId: dormant.specId,
    });
    assert.equal(projection.action, null);
    assert.equal(projection.directive.kind, "blocked");
    assert.equal(projection.directive.code, "HISTORICAL_CONTINUATION_NOT_ADMITTED");
    const dispatchAction = new FlowDispatchAction(projection);
    assert.equal(dispatchAction.isTerminal, true);
    assert.equal(dispatchAction.isContinuation, false);
  });

  it("retains only admitted pre-boundary unexecuted skips while a resumed Flow rewinds and re-executes them", () => {
    const tiny = tinyDefinition({ firstFailurePolicy: "retry" });
    const wire = CurrentFlowState.create({ definition: tiny }).toJSON();
    const phase = wire.steps[0];
    const first = phase.steps[0];
    const second = phase.steps[1];
    first.status = "skipped";
    first.result = null;
    first.attemptSequence = 0;
    second.status = "in_progress";
    phase.status = "in_progress";
    wire.current = "second";
    wire.history = historicalProvenance();
    const dormant = new CurrentFlowState(wire, { definition: tiny });
    const secondPath = tiny.pathFor(dormant.root, "second");
    let resumed = dormant.startAttempt({ path: secondPath, attempt: attemptFor(dormant, secondPath, "native-second") });
    assert.deepEqual(resumed.history.continuation.unexecutedSkipLeafIds, ["first"]);
    resumed = new CurrentFlowState(resumed.toJSON(), { definition: tiny });
    resumed = resumed.confirmCurrentAttempt({ result: passedResult("Native second completion."), status: "done" });

    const firstPath = tiny.pathFor(resumed.root, "first");
    resumed = resumed.rewind({ path: firstPath, attempt: attemptFor(resumed, firstPath, "native-first", 1) });
    assert.equal(resumed.current.at(-1), "first");
    assert.equal(resumed.history.execution, "resumed");
    assert.equal(resumed.findNode("first").attemptSequence, 1, "a rewound prefix leaf is now subject to normal Attempt evidence");
    assert.doesNotThrow(() => new CurrentFlowState(resumed.toJSON(), { definition: tiny }));
  });

  it("continues an explicitly resumed historical Task Review funnel through its Review, Triage, Repair, and Gate plans", () => {
    let state = CurrentFlowState.create({ definition: definition() }).addTask({ id: "T-historical", key: "historical" });
    state = advanceUntil(state, "T-historical-review", "historical-task");
    const reviewPath = state.nextAction().path;
    state = state.startAttempt({ path: reviewPath, attempt: attemptFor(state, reviewPath, "historical-review") });
    state = importedState(state);
    state = state.failCurrentAttempt({
      result: failedResult("Historical review retry."),
      failure: {
        category: "review",
        code: "HISTORICAL_REVIEW_RETRY",
        message: "Historical review retry.",
        retryable: true,
        retryKind: "semantic",
      },
    });
    state = state.retryCurrentAttempt({
      attempt: attemptFor(state, reviewPath, "historical-review-retry", 2),
      kind: "semantic",
    });

    const stagePlan = ({ stage, attempt, facts }) => resolveTaskReviewStageTransition(new TaskReviewStageFacts({
      binding: new TaskReviewStageBinding({
        runId: state.runId,
        specId: state.specId,
        taskId: "T-historical",
        stage,
        attemptId: attempt.id,
        attemptSequence: attempt.sequence,
        sourceFingerprint: "a".repeat(64),
        artifactDigest: "b".repeat(64),
        catalogFingerprint: "c".repeat(64),
      }),
      ...facts,
    }));
    const advanceStage = (stage, facts, targetId) => {
      const plan = stagePlan({ stage, attempt: state.attempt, facts });
      assert.equal(plan.targetStepId, targetId);
      const targetPath = state.definition.pathFor(state.root, targetId);
      state = state.completeTaskReviewStage({
        result: passedResult(`Historical ${stage} complete.`),
        plan,
        targetAttempt: attemptFor(state, targetPath, `historical-${stage}-to-${targetId}`),
      });
      assert.equal(state.current.at(-1), targetId, `${stage} must atomically expose and claim its Definition-selected target`);
      assert.equal(state.history.execution, "resumed");
    };

    advanceStage("review", {
      taskRound: 1, reviewResultCount: 1, verdict: "REJECTED", mustFixCount: 1,
    }, "T-historical-triage");
    advanceStage("triage", {
      taskRound: 1, reviewResultCount: 1, verdict: "REJECTED", mustFixCount: 1,
      triageDisposition: "apply", sameReviewBinding: true, reason: "The finding requires a repair.",
    }, "T-historical-repair");
    advanceStage("repair", {
      taskRound: 1, reviewResultCount: 4, verdict: "REJECTED", mustFixCount: 1,
      triageDisposition: "apply", repairChanged: true, sameReviewBinding: true, acceptanceCarryForwardReady: true,
    }, "T-historical-gate");
    assert.equal(state.nextAction().operation, "resume");

    state = state.confirmCurrentAttempt({
      result: passedResult("Historical Task Gate complete."),
      status: "done",
      gateTaskLifecycle: fixtureTaskGateLifecycle(state, "done"),
    });
    assert.equal(state.findNode("T-historical").status, "done");
    assert.notEqual(state.nextAction(), null, "a resumed historical Task Gate must retain the later Flow frontier");
  });

  it("rejects an unsupported historical shape before an explicit retry can persist continuation", () => {
    const retryingDefinition = tinyDefinition({ firstFailurePolicy: "retry" });
    let state = CurrentFlowState.create({ definition: retryingDefinition });
    const firstPath = state.nextAction().path;
    state = state.startAttempt({ path: firstPath, attempt: attemptFor(state, firstPath, "unsupported-shape") });
    state = importedState(state).failCurrentAttempt({
      result: failedResult("Imported worker failed."),
      failure: {
        category: "review",
        code: "UNSUPPORTED_SHAPE_RETRY",
        message: "Imported worker failed.",
        retryable: true,
        retryKind: "semantic",
      },
    });
    const malformed = state.toJSON();
    malformed.steps[1].id = "unsupported-second";
    const unsupported = new CurrentFlowState(malformed, { definition: state.definition });
    assert.equal(unsupported.history.execution, "dormant");
    assert.throws(
      () => unsupported.retryCurrentAttempt({
        attempt: attemptFor(unsupported, firstPath, "unsupported-shape-retry", 2),
        kind: "semantic",
      }),
      /state node does not match definition/,
    );
    assert.equal(unsupported.history.execution, "dormant", "failed admission leaves the imported snapshot dormant");
  });

  it("adapts every production leaf with normalized definition metadata and inserts dynamic Tasks before test execution", () => {
    const state = CurrentFlowState.create({ definition: definition(), execution: { mode: "worktree" } });
    const withFirst = state.addTask({ id: "task-1", key: "first-task" });
    const withBoth = withFirst.addTask({ id: "task-2", key: "second-task" });
    assert.deepEqual(
      withBoth.findNode("impl").steps.map((node) => node.id),
      ["implement", "task-1", "task-2", "test-execute", "test-result-review", "impl-review", "impl-triage", "impl-repair", "impl-gate", "retro", "acceptance-review", "acceptance-decision", "final-regression", "report", "finalize"],
    );
    assert.ok(withBoth.findNode("task-1") instanceof TaskNode);
    assert.deepEqual(withBoth.findNode("task-1").steps.map((step) => step.id), [
      "task-1-impl", "task-1-review", "task-1-triage", "task-1-repair", "task-1-gate",
    ]);
    const action = withBoth.definition.actionFor("task-1-review", withBoth.root);
    assert.ok(action.failurePolicy instanceof DefinitionFailurePolicy);
    assert.equal(action.failurePolicy.value, "retry");
    assert.deepEqual(action.toJSON(), {
      action: "run-review",
      instructionsKey: "task.task-review",
      contextKinds: ["task_spec", "requirements", "source"],
      outputSchemaRef: "next-action/review.schema.json",
      requiresApproval: false,
      autoApproveChoiceId: null,
      maxAttempts: 4,
      sideEffects: null,
      failurePolicy: { kind: "retry", targetNodeId: null },
      executionCommand: "sennel flow run review --phase impl",
      failureOwnership: "command-primary-dispatcher-fallback",
      artifactAuthority: { sourceScopes: ["same_task", "flow"], selection: "latest_upstream" },
    });
    const acceptancePolicy = withBoth.definition.actionFor("acceptance-review", withBoth.root).failurePolicy;
    assert.equal(acceptancePolicy.value, "amend-spec");
    assert.equal(acceptancePolicy.targetNodeId, "spec");
    assert.deepEqual(
      withBoth.definition.contractFor("task-1-review", withBoth.root).resourceContract.required,
      ["task_spec", "requirements", "source"],
    );
    const leaves = [];
    const collect = (node) => {
      if (node.steps.length === 0) leaves.push(node);
      else node.steps.forEach(collect);
    };
    collect(withBoth.definition.root);
    withBoth.definition.taskTemplate.steps.forEach(collect);
    for (const leaf of leaves) {
      const metadata = leaf.action.toJSON();
      assert.ok(Object.values(metadata).every((value) => value !== undefined), `adapter must normalize ${leaf.id}`);
      assert.deepEqual(leaf.contract.resourceContract.required, metadata.contextKinds);
    }
    assert.equal(getFlowNode("impl").children[1].id, "test-execute");
  });

  it("materializes the complete Task template recursively and rejects definition-shape forgery", () => {
    const nested = tinyDefinition({
      taskSteps: [new FlowDefinitionNode({
        id: "task-phase",
        key: "task-phase",
        steps: [new FlowDefinitionNode({
          id: "task-work",
          key: "task-work",
          action: tinyAction("task-work"),
        })],
      })],
    });
    const nestedState = CurrentFlowState.create({ definition: nested })
      .addTask({ id: "task-nested", key: "nested" });
    assert.deepEqual(
      nestedState.findNode("task-nested-phase").steps.map((step) => step.id),
      ["task-nested-phase-work"],
    );
    assert.equal(
      nested.actionFor("task-nested-phase-work", nestedState.root).action,
      "run-task-work",
    );

    const production = definition();
    const canonical = CurrentFlowState.create({ definition: production })
      .addTask({ id: "task-forged", key: "forged" })
      .toJSON();
    const canonicalTask = canonical.steps.find((node) => node.id === "impl")
      .steps.find((node) => node.id === "task-forged");
    assert.deepEqual(canonicalTask.steps.map((step) => step.id), [
      "task-forged-impl", "task-forged-review", "task-forged-triage",
      "task-forged-repair", "task-forged-gate",
    ]);
    const legacy = structuredClone(canonical);
    legacy.steps.find((node) => node.id === "impl")
      .steps.find((node) => node.id === "task-forged").steps.splice(2, 2);
    assert.throws(
      () => new CurrentFlowState(legacy, { definition: production }),
      /Task.steps does not match task template/,
    );

    const forged = structuredClone(canonical);
    const taskImpl = forged.steps.find((node) => node.id === "impl")
      .steps.find((node) => node.id === "task-forged")
      .steps.find((node) => node.id === "task-forged-impl");
    taskImpl.steps.push({
      kind: "step",
      id: "task-forged-rogue",
      key: "task.task-impl",
      status: "pending",
      result: null,
      attemptSequence: 0,
      steps: [],
    });
    assert.throws(
      () => new CurrentFlowState(forged, { definition: production }),
      /Task.steps does not match task template/,
    );

    assert.throws(
      () => tinyDefinition({
        taskSteps: [
          new FlowDefinitionNode({ id: "first-task-step", key: "duplicate", action: tinyAction("first-task-step") }),
          new FlowDefinitionNode({ id: "second-task-step", key: "duplicate", action: tinyAction("second-task-step") }),
        ],
      }),
      /task template duplicates semantic key/,
    );
    assert.throws(
      () => tinyDefinition({
        firstOverrides: { action: { ...tinyAction("first"), maxAttempts: 2 } },
      }),
      /maxAttempts must equal semanticRetryLimit \+ 1/,
    );
    assert.throws(
      () => tinyDefinition({
        firstOverrides: { action: { ...tinyAction("first"), contextKinds: ["spec"] } },
      }),
      /contextKinds must equal required resource contract/,
    );
    assert.throws(
      () => tinyDefinition({
        taskSteps: [new FlowDefinitionNode({
          kind: "task",
          id: "nested-task",
          key: "nested-task",
          action: tinyAction("nested-task"),
        })],
      }),
      /Task descendants must be Step nodes/,
    );
    assert.throws(
      () => new FlowDefinitionNode({
        id: "failed-parent",
        key: "failed-parent",
        contract: { transitions: ["pending:in_progress", "pending:failed"] },
        steps: [new FlowDefinitionNode({ id: "child", key: "child", action: tinyAction("child") })],
      }),
      /branch cannot transition to failed/,
    );
    assert.throws(
      () => new FlowDefinitionNode({
        id: "contradictory-failure",
        key: "contradictory-failure",
        contract: {
          transitions: ["pending:in_progress", "in_progress:done", "in_progress:failed"],
        },
        action: tinyAction("contradictory-failure"),
      }),
      /non-recording failure policy forbids an in_progress:failed transition/,
    );
    assert.throws(
      () => tinyDefinition({
        taskSteps: [new FlowDefinitionNode({
          id: "late-rewind",
          key: "late-rewind",
          action: {
            ...tinyAction("late-rewind"),
            failurePolicy: { kind: "amend-spec", targetNodeId: "after" },
          },
        })],
      }),
      /failure policy target must be an earlier rewindable leaf/,
    );
    assert.ok(tinyDefinition({
      taskSteps: [new FlowDefinitionNode({
        id: "early-rewind",
        key: "early-rewind",
        action: {
          ...tinyAction("early-rewind"),
          failurePolicy: { kind: "amend-spec", targetNodeId: "implement" },
        },
      })],
    }));
  });

  it("preserves production skippable semantics instead of granting a permissive default", () => {
    let state = CurrentFlowState.create({ definition: definition() });
    const branch = state.nextAction();
    assert.equal(branch.nodeId, "branch");
    assert.equal(getFlowNode("branch").skippable, true);
    state = state.startAttempt({ path: branch.path, attempt: attemptFor(state, branch.path, "branch-skip") });
    state = state.confirmCurrentAttempt({ status: "skipped", result: skippedResult("No branch needed.") });
    state = advanceUntil(state, "prepare-spec", "before-prepare");
    const prepare = state.nextAction();
    assert.equal(getFlowNode("prepare-spec").skippable, false);
    state = state.startAttempt({ path: prepare.path, attempt: attemptFor(state, prepare.path, "prepare-skip") });
    assert.throws(
      () => state.confirmCurrentAttempt({ status: "skipped", result: skippedResult("Invalid skip.") }),
      /definition forbids transition in_progress:skipped for prepare-spec/,
    );
  });

  it("rejects out-of-order starts and exposes one definition-owned flow/task frontier", () => {
    let state = CurrentFlowState.create({ definition: definition() })
      .addTask({ id: "task-1", key: "first" })
      .addTask({ id: "task-2", key: "second" });
    const taskPath = ["flow", "impl", "task-1", "task-1-impl"];
    assert.equal(state.nextAction().nodeId, "branch");
    assert.throws(
      () => state.startAttempt({ path: taskPath, attempt: attemptFor(state, taskPath, "too-early") }),
      /definition-owned next executable leaf/,
    );
    state = advanceUntil(state, "task-1-impl");
    assert.equal(state.nextAction().nodeId, "task-1-impl");
    state = completeNext(state, "task-1-impl");
    assert.equal(state.nextAction().nodeId, "task-1-review");
    state = completeNext(state, "task-1-review");
    state = completeNext(state, "task-1-triage");
    state = completeNext(state, "task-1-repair");
    state = completeNext(state, "task-1-gate");
    assert.equal(state.nextAction().nodeId, "task-2-impl");
    state = completeNext(state, "task-2-impl");
    state = completeNext(state, "task-2-review");
    state = completeNext(state, "task-2-triage");
    state = completeNext(state, "task-2-repair");
    state = completeNext(state, "task-2-gate");
    assert.equal(state.nextAction().nodeId, "test-execute");
  });

  it("admits Task insertion only at an idle lifecycle boundary", () => {
    let state = CurrentFlowState.create({ definition: definition() });
    const branchPath = state.nextAction().path;
    state = state.startAttempt({
      path: branchPath,
      attempt: attemptFor(state, branchPath, "active-branch"),
    });
    assert.throws(
      () => state.addTask({ id: "task-during-attempt", key: "active" }),
      /requires no active Attempt/,
    );

    state = state.failCurrentAttempt({
      result: failedResult("Branch execution is blocked."),
      failure: {
        category: "execution",
        code: "branch_blocked",
        message: "Branch execution is blocked.",
        retryable: false,
        retryKind: null,
      },
    });
    assert.equal(state.nextAction().operation, "blocked");
    assert.throws(
      () => state.addTask({ id: "task-after-block", key: "blocked" }),
      /requires no active Attempt/,
    );
    const persistedBypass = flowActivity({
      id: "blocked-task-add",
      state,
      currentPath: ["flow", "impl"],
      confirmationOrder: 1,
      operation: "add_task",
      task: { id: "task-through-activity", key: "blocked-activity" },
    });
    assert.throws(
      () => persistedBypass.transition.apply(state, persistedBypass),
      /requires no active Attempt/,
    );

    let idle = CurrentFlowState.create({ definition: definition() });
    idle = completeNext(idle, "branch-complete");
    assert.ok(idle.addTask({ id: "task-at-idle-boundary", key: "idle" }).findNode("task-at-idle-boundary"));
  });

  it("admits approval Tasks after a plan-gate recovery while retaining generic rewind closure", () => {
    let state = CurrentFlowState.create({ definition: definition() });
    state = advanceUntil(state, "spec-gate", "before-plan-repair");
    const gatePath = state.nextAction().path;
    state = state.startAttempt({ path: gatePath, attempt: attemptFor(state, gatePath, "spec-gate-failed") });
    state = state.failCurrentAttempt({
      result: failedResult("Spec gate rejected the plan."),
      failure: {
        category: "semantic",
        code: "GATE_REJECTED",
        message: "Spec gate rejected the plan.",
        retryable: true,
        retryKind: "semantic",
      },
    });
    const repairPath = state.definition.pathFor(state.root, "spec");
    state = state.repairPlanGate({
      path: repairPath,
      attempt: attemptFor(state, repairPath, "spec-plan-repair"),
    });
    state = state.confirmCurrentAttempt({ status: "done", result: passedResult("Spec repaired.") });
    state = advanceUntil(state, "approval", "after-plan-repair");
    state = startDescriptor(state, "recovered-approval");

    const admitted = state.admitApprovalTask(
      approvalActivityTask("task-after-plan-repair", "recovered-task"),
      { priorActivities: [{ id: "approval-source-activity", transition: { operation: "plan_gate_repair" } }] },
    );
    assert.ok(admitted.findNode("task-after-plan-repair"));
    assert.equal(admitted.findNode("test-execute").status, "invalidated");
    assert.throws(
      () => state.admitApprovalTask(
        approvalActivityTask("task-after-generic-rewind", "rejected-task"),
        { priorActivities: [{ id: "approval-source-activity", transition: { operation: "rewind" } }] },
      ),
      /requires a definition-owned plan recovery route/,
    );
  });

  it("keeps active facts in an immutable typed Attempt replacement and covers required resources with claims or incomplete work", () => {
    let state = CurrentFlowState.create({ definition: definition() }).addTask({ id: "task-1", key: "first" });
    state = advanceUntil(state, "task-1-review");
    const pathToReview = state.nextAction().path;
    const initial = attemptFor(state, pathToReview, "review-1", 1, {
      blocker: { code: "waiting", message: "Waiting for evidence." },
      incomplete: [{
        code: "source_pending",
        message: "The current Task source is not available yet.",
        operation: "collect-source",
        resources: ["source"],
      }],
      operationClaims: [{ operation: "load-context", resources: ["task_spec", "requirements"] }],
    });
    state = state.startAttempt({ path: pathToReview, attempt: initial });
    const incompleteReview = state;
    assert.throws(
      () => incompleteReview.confirmCurrentAttempt({ result: passedResult("Incomplete work cannot pass.") }),
      /blocked or incomplete Attempt cannot be confirmed/,
    );
    const replacement = initial.replaceFacts({
      blocker: { code: "resolved", message: "Evidence is now available." },
      incomplete: [],
      operationClaims: [{ operation: "load-context", resources: ["task_spec", "requirements", "source"] }],
    });
    state = state.replaceCurrentAttempt({ attempt: replacement });
    assert.throws(
      () => state.confirmCurrentAttempt({ result: passedResult("A blocker cannot pass.") }),
      /blocked or incomplete Attempt cannot be confirmed/,
    );
    assert.equal(state.attempt.id, "review-1");
    assert.equal(state.attempt.sequence, 1);
    assert.equal(state.attempt.blocker.code, "resolved");
    assert.equal(initial.blocker.code, "waiting");
    assert.equal(state.retryEligibility().semanticRemaining, 0);
    assert.equal(state.retryEligibility().toolingRemaining, 0);
    assert.throws(
      () => state.replaceCurrentAttempt({ attempt: replacement.replaceFacts({ operationClaims: [{ operation: "bad", resources: ["unknown"] }] }) }),
      /exceeds definition contract/,
    );
    assert.throws(
      () => state.replaceCurrentAttempt({ attempt: new CurrentAttempt({
        ...replacement.toJSON(),
        id: "review-other",
      }) }),
      /preserve attempt identity/,
    );
    assert.throws(
      () => state.replaceCurrentAttempt({ attempt: replacement.replaceFacts({
        incomplete: [{
          code: "duplicate",
          message: "Duplicate coverage.",
          operation: "again",
          resources: ["task_spec"],
        }],
      }) }),
      /duplicates or conflicts/,
    );
    const activeReview = state;
    state = state.failCurrentAttempt({ result: failedResult("Review needs another pass."), failure: {
      category: "review",
      code: "review_failed",
      message: "Review needs another pass.",
      retryable: true,
      retryKind: "semantic",
    } });
    assert.equal(state.nextAction().operation, "retry");
    assert.equal(state.nextAction().failureDisposition.remaining, 3);
    assert.equal(state.retryEligibility().semanticRemaining, 3);
    state = state.retryCurrentAttempt({
      attempt: attemptFor(state, pathToReview, "review-2", 2),
      kind: "semantic",
    });
    assert.equal(state.attempt.id, "review-2");
    assert.equal(state.attempt.consumption.semantic, 1);
    state = state.failCurrentAttempt({ result: failedResult("Review still needs work."), failure: {
      category: "review",
      code: "review_failed_again",
      message: "Review still needs work.",
      retryable: true,
      retryKind: "semantic",
    } });
    assert.throws(
      () => state.retryCurrentAttempt({
        attempt: attemptFor(state, pathToReview, "review-gap", 4),
        kind: "semantic",
      }),
      /immediately follow/,
    );
    assert.throws(
      () => state.retryCurrentAttempt({
        attempt: attemptFor(state, pathToReview, "review-wrong-kind", 3),
        kind: "tooling",
      }),
      /retry kind must match/,
    );

    let semanticLimit = state;
    semanticLimit = semanticLimit.retryCurrentAttempt({
      attempt: attemptFor(semanticLimit, pathToReview, "review-3", 3),
      kind: "semantic",
    });
    semanticLimit = semanticLimit.failCurrentAttempt({ result: failedResult("Review still needs work."), failure: {
      category: "review",
      code: "review_failed_third",
      message: "Review still needs work.",
      retryable: true,
      retryKind: "semantic",
    } });
    semanticLimit = semanticLimit.retryCurrentAttempt({
      attempt: attemptFor(semanticLimit, pathToReview, "review-4", 4),
      kind: "semantic",
    });
    semanticLimit = semanticLimit.failCurrentAttempt({ result: failedResult("Retry budget is exhausted."), failure: {
      category: "review",
      code: "review_exhausted",
      message: "Retry budget is exhausted.",
      retryable: true,
      retryKind: "semantic",
    } });
    assert.equal(semanticLimit.nextAction().operation, "record");
    assert.equal(semanticLimit.retryEligibility().semantic, false);
    assert.throws(
      () => semanticLimit.retryCurrentAttempt({
        attempt: attemptFor(semanticLimit, pathToReview, "review-over-budget", 5),
        kind: "semantic",
      }),
      /does not authorize retry/,
    );
    const recordedExhaustion = semanticLimit.recordCurrentFailure({
      result: failedResult("Retry budget is exhausted."),
    });
    assert.equal(recordedExhaustion.findNode("task-1-review").status, "failed");
    assert.equal(recordedExhaustion.findNode("task-1-review").result.outcome, "failed");
    assert.equal(recordedExhaustion.current, null);
    assert.equal(recordedExhaustion.nextAction().nodeId, "task-1-triage");

    const toolingAttempt = attemptFor(activeReview, pathToReview, "review-tooling-2", 2, { tooling: 1 });
    const toolingFailed = activeReview.failCurrentAttempt({ result: failedResult("Provider failed."), failure: {
      category: "provider",
      code: "provider_failed",
      message: "Provider failed.",
      retryable: true,
      retryKind: "tooling",
    } });
    const toolingLimit = toolingFailed.retryCurrentAttempt({ attempt: toolingAttempt, kind: "tooling" });
    assert.equal(toolingLimit.attempt.consumption.tooling, 1);
    const exhaustedTooling = toolingLimit.failCurrentAttempt({ result: failedResult("Provider retry budget is exhausted."), failure: {
      category: "provider",
      code: "provider_exhausted",
      message: "Provider retry budget is exhausted.",
      retryable: true,
      retryKind: "tooling",
    } });
    assert.equal(exhaustedTooling.nextAction().operation, "record");

    let implementation = CurrentFlowState.create({ definition: definition() })
      .addTask({ id: "task-no-tooling", key: "no-tooling" });
    implementation = advanceUntil(implementation, "task-no-tooling-impl", "no-tooling-prelude");
    const implementationPath = implementation.nextAction().path;
    implementation = implementation.startAttempt({
      path: implementationPath,
      attempt: attemptFor(implementation, implementationPath, "impl-1"),
    });
    implementation = implementation.failCurrentAttempt({ result: failedResult("Provider failed."), failure: {
      category: "provider",
      code: "provider_failed",
      message: "Provider failed.",
      retryable: true,
      retryKind: "tooling",
    } });
    assert.equal(implementation.nextAction().operation, "blocked");
    assert.equal(implementation.retryEligibility().tooling, false);
  });

  it("executes production failure policies instead of treating policy labels as retry prose", () => {
    let blocked = CurrentFlowState.create({ definition: definition() });
    blocked = advanceUntil(blocked, "draft-gate", "block-policy");
    const gatePath = blocked.nextAction().path;
    blocked = blocked.startAttempt({
      path: gatePath,
      attempt: attemptFor(blocked, gatePath, "draft-gate-attempt"),
    });
    blocked = blocked.failCurrentAttempt({
      result: failedResult("The gate failed."),
      failure: {
        category: "gate",
        code: "gate_failed",
        message: "The gate failed with retryable findings.",
        retryable: true,
        retryKind: "semantic",
      },
    });
    assert.equal(blocked.nextAction().operation, "resolve-step-definition");
    assert.equal(blocked.retryEligibility().semantic, false);
    assert.throws(
      () => blocked.retryCurrentAttempt({
        attempt: attemptFor(blocked, gatePath, "draft-gate-illegal-retry", 2),
        kind: "semantic",
      }),
      /does not authorize retry/,
    );

    let amendment = CurrentFlowState.create({ definition: definition() });
    amendment = advanceUntil(amendment, "acceptance-review", "amend-policy");
    const acceptancePath = amendment.nextAction().path;
    amendment = amendment.startAttempt({
      path: acceptancePath,
      attempt: attemptFor(amendment, acceptancePath, "acceptance-failure"),
    });
    amendment = amendment.failCurrentAttempt({
      result: failedResult("Acceptance found a specification defect."),
      failure: {
        category: "acceptance",
        code: "specification_incomplete",
        message: "The specification must be amended.",
        retryable: false,
        retryKind: null,
      },
    });
    const next = amendment.nextAction();
    assert.equal(next.operation, "rewind");
    assert.equal(next.nodeId, "spec");
    assert.deepEqual(next.failureDisposition.targetPath, ["flow", "plan", "spec"]);
    assert.equal(amendment.recoveryTarget(next.path).legal, true);
    amendment = amendment.rewind({
      path: next.path,
      attempt: attemptFor(amendment, next.path, "spec-amendment"),
    });
    assert.equal(amendment.current.at(-1), "spec");
    assert.equal(amendment.attempt.sequence, 2);
    assert.equal(amendment.findNode("acceptance-review").status, "invalidated");
  });

  it("uses one executable claim rule for fresh and invalidated implementation no-repair gates", () => {
    const triageResult = new NodeResult(passedResult("All implementation findings were rejected.", []));

    let fresh = CurrentFlowState.create({ definition: definition() });
    fresh = advanceUntil(fresh, "impl-triage", "fresh-no-repair");
    const freshTriagePath = fresh.nextAction().path;
    fresh = fresh.startAttempt({
      path: freshTriagePath,
      attempt: attemptFor(fresh, freshTriagePath, "fresh-impl-triage"),
    });
    const freshGatePath = fresh.definition.pathFor(fresh.root, "impl-gate");
    fresh = fresh.triageImplementationNoRepair({
      path: fresh.current,
      attempt: attemptFor(fresh, freshGatePath, "fresh-impl-gate"),
      result: triageResult,
    });
    assert.equal(fresh.findNode("impl-repair").status, "skipped");
    assert.equal(fresh.findNode("impl-gate").status, "in_progress");
    assert.equal(fresh.attempt.id, "fresh-impl-gate");

    let recovered = CurrentFlowState.create({ definition: definition() });
    recovered = advanceUntil(recovered, "acceptance-review", "recovered-no-repair");
    const acceptancePath = recovered.nextAction().path;
    recovered = recovered.startAttempt({
      path: acceptancePath,
      attempt: attemptFor(recovered, acceptancePath, "acceptance-rejected"),
    });
    const reopenedTriagePath = recovered.definition.pathFor(recovered.root, "impl-triage");
    recovered = recovered.repairAcceptanceReview({
      path: acceptancePath,
      attempt: attemptFor(recovered, reopenedTriagePath, "recovered-impl-triage"),
      result: new NodeResult(passedResult("Acceptance requested implementation reconsideration.", [])),
    });
    const activeClaim = recovered.executableStepClaim({
      nodeId: "impl-triage",
      attempt: recovered.attempt,
    });
    assert.ok(activeClaim instanceof ExecutableStepClaim);
    assert.equal(activeClaim.origin, "active");
    assert.equal(recovered.findNode("impl-repair").status, "invalidated");
    assert.equal(recovered.findNode("impl-gate").status, "invalidated");

    const recoveredGatePath = recovered.definition.pathFor(recovered.root, "impl-gate");
    recovered = recovered.triageImplementationNoRepair({
      path: recovered.current,
      attempt: attemptFor(recovered, recoveredGatePath, "recovered-impl-gate"),
      result: triageResult,
    });
    assert.equal(recovered.findNode("impl-repair").status, "skipped");
    assert.equal(recovered.findNode("impl-gate").status, "in_progress");
    assert.equal(recovered.attempt.id, "recovered-impl-gate");
    assert.equal(recovered.attempt.sequence, 2, "recover must advance the invalidated gate Attempt episode");
  });

  it("rejects malformed lifecycle JSON while preserving valid parent results through a rewind", () => {
    const tiny = tinyDefinition();
    let state = CurrentFlowState.create({ definition: tiny });
    state = completeNext(state, "first");
    state = completeNext(state, "second", { status: "skipped" });
    assert.equal(state.findNode("phase").status, "done");
    assert.equal(state.findNode("phase").result.outcome, "skipped");
    const valid = state.toJSON();
    const pendingBeforeDone = structuredClone(valid);
    pendingBeforeDone.steps[0].steps[0].status = "pending";
    pendingBeforeDone.steps[0].steps[0].result = null;
    pendingBeforeDone.steps[0].steps[0].attemptSequence = 0;
    pendingBeforeDone.steps[0].status = "in_progress";
    assert.throws(
      () => new CurrentFlowState(pendingBeforeDone, { definition: tiny }),
      /execution frontier/,
    );
    const badParent = structuredClone(valid);
    badParent.steps[0].status = "pending";
    badParent.steps[0].result = null;
    assert.throws(
      () => new CurrentFlowState(badParent, { definition: tiny }),
      /pending branch/,
    );
    const terminalChildrenActiveParent = structuredClone(valid);
    terminalChildrenActiveParent.steps[0].status = "in_progress";
    terminalChildrenActiveParent.steps[0].result = null;
    assert.throws(
      () => new CurrentFlowState(terminalChildrenActiveParent, { definition: tiny }),
      /in_progress branch cannot retain an all-terminal child set/,
    );
    const wrongLeafOutcome = structuredClone(valid);
    wrongLeafOutcome.steps[0].steps[0].result = skippedResult("wrong leaf outcome");
    assert.throws(
      () => new CurrentFlowState(wrongLeafOutcome, { definition: tiny }),
      /done leaf requires a passed result/,
    );
    const skippedPath = ["flow", "phase", "second"];
    state = state.rewind({ path: skippedPath, attempt: attemptFor(state, skippedPath, "second-rewind") });
    assert.equal(state.current.at(-1), "second");
    assert.equal(state.findNode("second").result, null);
    assert.equal(state.findNode("phase").status, "in_progress");
    assert.equal(state.findNode("phase").result.outcome, "skipped");
    const activeResult = state.toJSON();
    activeResult.steps[0].steps[1].result = passedResult("corrupt active");
    assert.throws(
      () => new CurrentFlowState(activeResult, { definition: tiny }),
      /in_progress leaf must not retain a result/,
    );
    const nonLeafCursor = state.toJSON();
    nonLeafCursor.current = "phase";
    assert.throws(
      () => new CurrentFlowState(nonLeafCursor, { definition: tiny }),
      /execution frontier active leaf must match current path/,
    );

    const production = CurrentFlowState.create({ definition: definition() });
    const productionPath = production.nextAction().path;
    const productionActive = production.startAttempt({
      path: productionPath,
      attempt: attemptFor(production, productionPath, "impossible-retry-decision"),
    });
    const impossibleRetryDecision = productionActive.toJSON();
    impossibleRetryDecision.attempt.failure = {
      category: "invalid",
      code: "retry_without_budget",
      message: "The persisted decision exceeds the fixed definition budget.",
      retryable: true,
      retryKind: "semantic",
    };
    const exhaustedWithoutRetry = new CurrentFlowState(impossibleRetryDecision, { definition: definition() });
    assert.equal(exhaustedWithoutRetry.nextAction().operation, "blocked");
    assert.equal(exhaustedWithoutRetry.retryEligibility().semantic, false);
    const unreachableRecordedFailure = exhaustedWithoutRetry.toJSON();
    unreachableRecordedFailure.steps[0].steps[0].status = "failed";
    unreachableRecordedFailure.steps[0].steps[0].result = failedResult("A block-only node cannot record failure.");
    unreachableRecordedFailure.current = null;
    unreachableRecordedFailure.attempt = null;
    assert.throws(
      () => new CurrentFlowState(unreachableRecordedFailure, { definition: definition() }),
      /status is unreachable in the definition transition graph for branch: failed/,
    );
  });

  it("uses recovery Activities for invalidated next leaves and never lets start bypass recovery", () => {
    let state = CurrentFlowState.create({ definition: definition() });
    state = advanceUntil(state, "prepare-spec");
    state = completeNext(state, "prepare-spec");
    const rewindPath = ["flow", "plan", "branch"];
    state = state.rewind({ path: rewindPath, attempt: attemptFor(state, rewindPath, "branch-rewind") });
    assert.throws(
      () => state.addTask({ id: "late-task", key: "late" }),
      /insertion is closed/,
    );
    state = state.confirmCurrentAttempt({ result: passedResult("branch repaired") });
    const recovered = state.nextAction();
    assert.equal(recovered.operation, "recover");
    assert.equal(recovered.nodeId, "prepare-spec");
    assert.throws(
      () => state.startAttempt({ path: recovered.path, attempt: attemptFor(state, recovered.path, "bypass") }),
      /definition-owned next executable leaf/,
    );
    assert.equal(state.recoveryTarget(recovered.path).operation, "recover");
    state = state.recover({ path: recovered.path, attempt: attemptFor(state, recovered.path, "prepare-recovery") });
    assert.equal(state.current.at(-1), "prepare-spec");
    assert.equal(state.findNode("prepare-spec").status, "in_progress");
  });

  it("enforces definition transitions while invalidating downstream nodes during rewind", () => {
    const restricted = tinyDefinition({
      secondTransitions: [
        "pending:in_progress",
        "in_progress:done",
        "done:in_progress",
        "invalidated:in_progress",
        "pending:invalidated",
        "in_progress:invalidated",
      ],
    });
    let state = CurrentFlowState.create({ definition: restricted });
    state = completeNext(state, "restricted-first");
    state = completeNext(state, "restricted-second");
    const firstPath = ["flow", "phase", "first"];
    assert.throws(
      () => state.rewind({
        path: firstPath,
        attempt: attemptFor(state, firstPath, "restricted-rewind"),
      }),
      /definition forbids transition done:invalidated for second/,
    );
  });

  it("resolves next action, artifact sources, and recovery legality from current state plus definition without Activity history", () => {
    let state = CurrentFlowState.create({ definition: definition(), execution: { mode: "branch" } });
    state = completeNext(state, "branch", { summary: "branch-artifact", artifactRefs: [{ kind: "issue", id: "issue-from-branch" }] });
    state = completeNext(state, "prepare", { summary: "prepare-artifact", artifactRefs: [{ kind: "spec", id: "spec-from-prepare" }] });
    state = completeNext(state, "draft", { summary: "draft-artifact", artifactRefs: [{ kind: "draft", id: "draft-from-draft" }] });
    const authority = state.artifactAuthority();
    assert.equal(state.nextAction().nodeId, "draft-questions-review");
    assert.deepEqual(authority.requiredResources, ["draft", "issue"]);
    assert.deepEqual(authority.resolutions.map((resolution) => [resolution.resourceKind, resolution.source?.nodeId]), [
      ["draft", "draft"],
      ["issue", "branch"],
    ]);
    tmp = createTmpDir("current-flow-read-api-");
    const store = new CurrentFlowStateStore({ directory: tmp, definition: definition() });
    // State queries remain journal-independent, while the Store boundary must
    // reject a state/journal pair that cannot be reproduced by replay.
    const descriptorBeforePersistence = state.nextAction().toJSON();
    const authorityBeforePersistence = authority.toJSON();
    fs.writeFileSync(store.statePath, `${JSON.stringify(state.toJSON())}\n`);
    const unrelated = flowActivity({
      id: "unapplied-history",
      state,
      currentPath: state.nextAction().path,
      confirmationOrder: 1,
      operation: "start_attempt",
      attempt: attemptFor(state, state.nextAction().path, "unapplied-attempt"),
    });
    fs.writeFileSync(path.join(tmp, "activities.jsonl"), `${JSON.stringify(unrelated.toJSON())}\n`);
    assert.deepEqual(state.nextAction().toJSON(), descriptorBeforePersistence);
    assert.deepEqual(state.artifactAuthority().toJSON(), authorityBeforePersistence);
    assert.throws(
      () => store.load(),
      /flow state content conflicts with its Activity journal/,
    );
    const rewindPath = ["flow", "plan", "prepare-spec"];
    state = state.rewind({ path: rewindPath, attempt: attemptFor(state, rewindPath, "prepare-rewind") });
    const duringRewind = state.artifactAuthority();
    assert.deepEqual(duringRewind.requiredResources, []);
    assert.equal(state.findNode("draft").status, "invalidated");
    assert.equal(duringRewind.resolutions.some((resolution) => resolution.source?.nodeId === "draft"), false);
    assert.equal(state.recoveryTarget(["flow", "plan", "draft"]).legal, false);
    state = state.confirmCurrentAttempt({ result: passedResult("prepare repaired", [{ kind: "spec", id: "repaired-spec" }]) });
    const recoveryAuthority = state.artifactAuthority();
    assert.equal(state.nextAction().nodeId, "draft");
    assert.deepEqual(
      recoveryAuthority.resolutions.filter((resolution) => !resolution.missing).map((resolution) => resolution.source.nodeId),
      ["branch"],
    );
    assert.equal(recoveryAuthority.resolutions.some((resolution) => resolution.source?.nodeId === "draft"), false);
  });

  it("resolves Task resources from the same Task and excludes sibling Task evidence", () => {
    const taskArtifacts = (taskId) => [
      { kind: "task_spec", id: `${taskId}-spec` },
      { kind: "requirements", id: `${taskId}-requirements` },
      { kind: "source", id: `${taskId}-source` },
    ];
    let state = CurrentFlowState.create({ definition: definition() })
      .addTask({ id: "task-a", key: "first" })
      .addTask({ id: "task-b", key: "second" });
    state = advanceUntil(state, "task-a-impl", "scope-prelude");
    state = completeNext(state, "task-a-impl", { artifactRefs: taskArtifacts("task-a") });
    state = completeNext(state, "task-a-review", { artifactRefs: taskArtifacts("task-a") });
    state = completeNext(state, "task-a-triage", { artifactRefs: taskArtifacts("task-a") });
    state = completeNext(state, "task-a-repair", { artifactRefs: taskArtifacts("task-a") });
    state = completeNext(state, "task-a-gate", { artifactRefs: taskArtifacts("task-a") });
    state = completeNext(state, "task-b-impl", { artifactRefs: taskArtifacts("task-b") });
    assert.equal(state.nextAction().nodeId, "task-b-review");
    const authority = state.artifactAuthority();
    assert.deepEqual(authority.requiredResources, ["task_spec", "requirements", "source"]);
    assert.ok(authority.resolutions.every((resolution) => resolution.source?.nodeId === "task-b-impl"));
    assert.equal(
      authority.resolutions.some((resolution) => resolution.source?.path.includes("task-a")),
      false,
    );
    const taskBImplPath = ["flow", "impl", "task-b", "task-b-impl"];
    state = state.rewind({
      path: taskBImplPath,
      attempt: attemptFor(state, taskBImplPath, "task-b-impl-rewind"),
    });
    assert.equal(state.findNode("task-b-review").status, "invalidated");
    assert.equal(
      state.artifactAuthority().resolutions.some((resolution) => resolution.source?.path.includes("task-a")),
      false,
    );
    state = state.confirmCurrentAttempt({
      result: passedResult("task-b repaired", taskArtifacts("task-b")),
    });
    assert.equal(state.nextAction().nodeId, "task-b-review");
    const recoveryAuthority = state.artifactAuthority();
    assert.ok(recoveryAuthority.resolutions.every((resolution) => resolution.source?.nodeId === "task-b-impl"));
    assert.equal(
      recoveryAuthority.resolutions.some((resolution) => resolution.source?.path.includes("task-a")),
      false,
    );
  });

  it("uses typed update Activity with JSONL as the only persisted activity authority", () => {
    tmp = createTmpDir("current-flow-activity-view-");
    const initial = CurrentFlowState.create({ definition: definition() });
    const store = new CurrentFlowStateStore({ directory: tmp, definition: definition() });
    const created = store.create(initial);
    const branchPath = ["flow", "plan", "branch"];
    const startAttempt = attemptFor(created, branchPath, "branch-1", 1, {
      incomplete: [{ code: "waiting", message: "Need an external value.", operation: null, resources: [] }],
    });
    const started = store.apply({ activity: flowActivity({
      id: "a1",
      state: created,
      currentPath: branchPath,
      confirmationOrder: 2,
      operation: "start_attempt",
      attempt: startAttempt,
    }) });
    const updatedAttempt = startAttempt.replaceFacts({
      blocker: { code: "ready", message: "The value arrived." },
      incomplete: [],
    });
    const updated = store.apply({ activity: flowActivity({
      id: "a2",
      state: started,
      currentPath: branchPath,
      confirmationOrder: 3,
      operation: "update_attempt",
      attempt: updatedAttempt,
    }) });
    assert.equal(updated.attempt.blocker.code, "ready");
    const journalEntries = store.journal.read();
    assert.deepEqual(journalEntries.map((entry) => entry.type), ["flow_created", "attempt_started", "attempt_updated"]);
    assert.deepEqual(journalEntries[1].timing.toJSON(), {
      startedAt: NOW,
      finishedAt: LATER,
      durationMs: 60000,
    });
    assert.equal(journalEntries[1].provider, "provider");
    assert.equal(journalEntries[1].model, "model");
    assert.equal(journalEntries[1].effort, "standard");
    assert.deepEqual(journalEntries[1].usage.toJSON(), {
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 2,
      cost: 0,
    });
    assert.ok(journalEntries[1].references.evaluations[0] instanceof ActivityEvaluationReference);
    assert.ok(journalEntries[1].references.findings[0] instanceof ActivityFindingReference);
    assert.ok(journalEntries[1].references.repairs[0] instanceof ActivityRepairReference);
    assert.ok(journalEntries[1].references.artifacts[0] instanceof ActivityArtifactReference);
    assert.equal(fs.existsSync(path.join(tmp, "activities.md")), false);
    const markdownPath = path.join(tmp, "activities.md");
    fs.writeFileSync(markdownPath, "corrupt prose must not control state\n");
    assert.equal(store.load().attempt.id, "branch-1");
    assert.equal(store.load().resumeDescriptor().operation, "resume");
    const afterMarkdown = store.apply({ activity: flowActivity({
      id: "a3",
      state: updated,
      currentPath: branchPath,
      confirmationOrder: 4,
      operation: "update_attempt",
      attempt: updatedAttempt.replaceFacts({ blocker: { code: "complete", message: "State persisted." } }),
    }) });
    assert.equal(afterMarkdown.attempt.blocker.code, "complete");
    assert.equal(fs.readFileSync(markdownPath, "utf8"), "corrupt prose must not control state\n");
  });

  it("enforces operation-specific transition payloads and distinct Activity reference types", () => {
    const state = CurrentFlowState.create({ definition: definition() });
    const currentPath = state.nextAction().path;
    const attempt = attemptFor(state, currentPath, "payload-attempt");
    const transition = (operation, overrides = {}) => new ActivityTransition({
      operation,
      nodeId: currentPath.at(-1),
      task: null,
      attempt: null,
      status: null,
      policy: null,
      outbox: null,
      approval: null,
      nonblocking: null,
      ...overrides,
    });

    assert.ok(transition("add_task", { task: { id: "task-payload", key: "payload" } }));
    const approvalTask = {
      id: "approval-task-payload",
      key: "approval-payload",
      approvalSource: {
        specRecordHash: "a".repeat(64),
        specRecordActivityId: "approval-source-activity",
        taskDigest: "5ce551c30e6a80c2b9440f7e7496826946027d048b52c7b6d873c8af91d11dab",
        taskKey: "approval-payload",
        taskDocument: { id: "approval-task-payload", parent: null },
      },
    };
    assert.ok(transition("add_approval_task", { task: approvalTask }));
    assert.throws(
      () => transition("add_approval_task", { task: {
        ...approvalTask,
        approvalSource: { ...approvalTask.approvalSource, taskDigest: "c".repeat(64) },
      } }),
      /source digest does not match its Task document/,
    );
    assert.throws(
      () => transition("add_task", { task: approvalTask }),
      /only add_approval_task requires a durable approval Task source binding/,
    );
    for (const operation of ["start_attempt", "retry_attempt", "update_attempt", "rewind", "plan_gate_repair", "recover_attempt"]) {
      assert.ok(transition(operation, { attempt }));
      assert.throws(() => transition(operation), /requires an Attempt payload/);
    }
    assert.ok(transition("fail_attempt"));
    assert.throws(() => transition("fail_attempt", { attempt }), /forbids an Attempt payload/);
    assert.ok(transition("record_failure"));
    assert.throws(() => transition("record_failure", { attempt }), /forbids an Attempt payload/);
    assert.ok(transition("confirm_attempt", { status: "done" }));
    assert.throws(() => transition("confirm_attempt", { attempt, status: "done" }), /forbids an Attempt payload/);
    assert.throws(() => transition("confirm_attempt"), /requires done or skipped status/);
    assert.throws(
      () => transition("start_attempt", { attempt, task: { id: "task-payload", key: "payload" } }),
      /only transition that requires a Task payload/,
    );

    const evaluation = new ActivityEvaluationReference({ id: "evaluation", label: null });
    assert.throws(
      () => new ActivityReferences({ evaluations: [], findings: [], repairs: [], artifacts: [evaluation] }),
      /activity reference must be an object/,
    );
  });

  it("rejects serialized Activity transitions that omit the current Task Gate lifecycle field", () => {
    const state = CurrentFlowState.create({ definition: definition() });
    const currentPath = state.nextAction().path;
    const serialized = flowActivity({
      id: "missing-gate-task-lifecycle",
      state,
      currentPath,
      confirmationOrder: 2,
      operation: "start_attempt",
      attempt: attemptFor(state, currentPath, "missing-gate-task-lifecycle-attempt"),
    }).toJSON();
    delete serialized.transition.gateTaskLifecycle;

    assert.throws(
      () => FlowActivity.fromSerialized(serialized),
      /activity\.transition\.gateTaskLifecycle is required/,
    );
  });

  it("journals non-retryable, exhausted, and incomplete Attempt outcomes without creating an unauthorized retry", () => {
    tmp = createTmpDir("current-flow-failures-");
    const runFailure = ({ name, outcome, failure, incomplete = [] }) => {
      const directory = path.join(tmp, name);
      let initial = CurrentFlowState.create({ definition: definition() });
      const store = new CurrentFlowStateStore({ directory, definition: definition() });
      initial = store.create(initial);
      const currentPath = initial.nextAction().path;
      const started = store.apply({ activity: flowActivity({
        id: `${name}-start`,
        state: initial,
        currentPath,
        confirmationOrder: 2,
        operation: "start_attempt",
        attempt: attemptFor(initial, currentPath, `${name}-attempt`, null, { incomplete }),
      }) });
      const failed = store.apply({ activity: flowActivity({
        id: `${name}-failure`,
        state: started,
        currentPath,
        confirmationOrder: 3,
        operation: "fail_attempt",
        result: {
          outcome,
          summary: `${name} execution completed without success.`,
          confirmedAt: LATER,
          artifactRefs: [],
        },
        failure,
      }) });
      assert.equal(failed.attempt.failure.category, failure.category);
      assert.equal(failed.retryEligibility().semantic, false);
      assert.equal(failed.retryEligibility().tooling, false);
      assert.equal(failed.nextAction().operation, "blocked");
      assert.equal(failed.nextAction().failureDisposition.outcome, outcome);
      assert.equal(store.journal.read().at(-1).result.outcome, outcome);
      return { store, state: failed, currentPath };
    };

    const nonRetryable = runFailure({
      name: "non-retryable",
      outcome: "failed",
      failure: {
        category: "policy",
        code: "policy_denied",
        message: "Policy does not authorize retry.",
        retryable: false,
        retryKind: null,
      },
    });
    assert.throws(
      () => nonRetryable.store.apply({ activity: flowActivity({
        id: "unauthorized-retry",
        state: nonRetryable.state,
        currentPath: nonRetryable.currentPath,
        confirmationOrder: 4,
        operation: "retry_attempt",
        attempt: attemptFor(nonRetryable.state, nonRetryable.currentPath, "forbidden-retry"),
      }) }),
      /requires a retryable failed active Attempt/,
    );
    assert.equal(nonRetryable.store.journal.read().length, 3);

    runFailure({
      name: "retry-exhausted",
      outcome: "failed",
      failure: {
        category: "retry_exhausted",
        code: "retry_budget_exhausted",
        message: "No retry budget remains.",
        retryable: false,
        retryKind: "semantic",
      },
    });
    runFailure({
      name: "incomplete",
      outcome: "incomplete",
      incomplete: [{
        code: "required_input_missing",
        message: "A required input is missing.",
        operation: "load-required-input",
        resources: [],
      }],
      failure: {
        category: "incomplete",
        code: "required_input_missing",
        message: "A required input is missing.",
        retryable: false,
        retryKind: null,
      },
    });

    const invalidDirectory = path.join(tmp, "untyped-incomplete");
    let invalidInitial = CurrentFlowState.create({ definition: definition() });
    const invalidStore = new CurrentFlowStateStore({ directory: invalidDirectory, definition: definition() });
    invalidInitial = invalidStore.create(invalidInitial);
    const invalidPath = invalidInitial.nextAction().path;
    const invalidStarted = invalidStore.apply({ activity: flowActivity({
      id: "untyped-incomplete-start",
      state: invalidInitial,
      currentPath: invalidPath,
      confirmationOrder: 2,
      operation: "start_attempt",
      attempt: attemptFor(invalidInitial, invalidPath, "untyped-incomplete-attempt"),
    }) });
    assert.throws(
      () => flowActivity({
        id: "contradictory-failure-attempt",
        state: invalidStarted,
        currentPath: invalidPath,
        confirmationOrder: 3,
        operation: "fail_attempt",
        attempt: attemptFor(invalidStarted, invalidPath, "ghost-attempt"),
        result: failedResult("The payload contradicts the active Attempt."),
        failure: {
          category: "terminal",
          code: "contradictory_attempt",
          message: "The transition carries a different Attempt.",
          retryable: false,
          retryKind: null,
        },
      }),
      /fail_attempt forbids an Attempt payload/,
    );
    assert.throws(
      () => invalidStore.apply({ activity: flowActivity({
        id: "untyped-incomplete-failure",
        state: invalidStarted,
        currentPath: invalidPath,
        confirmationOrder: 3,
        operation: "fail_attempt",
        result: incompleteResult("Required input is missing without a typed claim."),
        failure: {
          category: "incomplete",
          code: "required_input_missing",
          message: "A required input is missing.",
          retryable: false,
          retryKind: null,
        },
      }) }),
      /typed incomplete operation\/resource claims must agree/,
    );
    assert.equal(invalidStore.journal.read().length, 2);
  });

  it("recovers idempotently from journal-first and state-written crashes", () => {
    tmp = createTmpDir("current-flow-crash-");
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: definition() });
    let initial = boundary.createFresh();
    const store = boundary.openStore({ directory: tmp });
    initial = store.create(initial);
    const branchPath = ["flow", "plan", "branch"];
    const entry = flowActivity({
      id: "activity-start",
      state: initial,
      currentPath: branchPath,
      confirmationOrder: 2,
      operation: "start_attempt",
      attempt: attemptFor(initial, branchPath, "branch-1"),
    });
    const crashing = boundary.openStore({
      directory: tmp,
      faultInjector({ phase }) { if (phase === "activity-appended") throw new Error("crash after durable journal append"); },
    });
    assert.throws(() => crashing.apply({ activity: entry }), /crash after durable/);
    assert.equal(store.load().confirmationOrder, 1);
    const started = store.apply({ activity: entry });
    assert.equal(started.confirmationOrder, 2);
    assert.equal(store.apply({ activity: entry }).confirmationOrder, 2);
    assert.equal(store.journal.read().length, 2);
    assert.throws(
      () => store.apply({ activity: new FlowActivity({ ...entry.toJSON(), provider: "different" }) }),
      (error) => error instanceof CurrentFlowStateConflictError,
    );
    const confirmed = flowActivity({
      id: "activity-confirm",
      state: started,
      currentPath: branchPath,
      confirmationOrder: 3,
      operation: "confirm_attempt",
      status: "done",
      result: passedResult("branch confirmed"),
    });
    const afterStateWrite = boundary.openStore({
      directory: tmp,
      faultInjector({ phase }) { if (phase === "state-written") throw new Error("crash after state CAS"); },
    });
    assert.throws(() => afterStateWrite.apply({ activity: confirmed }), /crash after state CAS/);
    assert.equal(store.load().confirmationOrder, 3);
    assert.equal(store.apply({ activity: confirmed }).confirmationOrder, 3);
    assert.equal(store.journal.read().length, 3);
  });

  it("revalidates external state and journal-prefix changes after a cached confirmed snapshot", () => {
    tmp = createTmpDir("current-flow-validation-cache-");
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: definition() });
    const store = boundary.openStore({ directory: tmp });
    store.create(boundary.createFresh());
    const initial = store.loadSnapshot();
    const journalPath = store.journal.filePath;
    const journal = fs.readFileSync(journalPath, "utf8");
    const reformatted = journal.replace('"type":"flow_created"', '"type" : "flow_created"');

    assert.notEqual(reformatted, journal);
    fs.writeFileSync(journalPath, reformatted);
    assert.deepEqual(store.loadSnapshot().state.toJSON(), initial.state.toJSON());

    const state = fs.readFileSync(store.statePath, "utf8");
    const invalid = state.replace('"confirmationOrder": 1', '"confirmationOrder": 2');
    assert.notEqual(invalid, state);
    fs.writeFileSync(store.statePath, invalid);
    assert.throws(() => store.loadSnapshot(), /ahead of its Activity journal/);
  });

  it("rejects same-process Store writer lock reentry for reads", () => {
    tmp = createTmpDir("current-flow-direct-read-lock-");
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: definition() });
    const store = boundary.openStore({ directory: tmp });
    store.create(boundary.createFresh());
    store.lock.acquire();
    try {
      assert.throws(
        () => store.loadSnapshot(),
        (error) => error instanceof FileLockReentrancyError
          && error.code === "CURRENT_FLOW_STATE_LOCK_REENTRANT"
          && error.lockStatus === "reentrant"
          && error.cause instanceof CurrentFlowStateConflictError,
      );
    } finally {
      store.lock.release();
    }
  });

  it("rebinds raw and typed state to the store-owned definition before create", () => {
    tmp = createTmpDir("current-flow-definition-binding-");
    const fixedDefinition = definition();
    const fixedAction = CurrentFlowState.create({ definition: fixedDefinition }).nextAction().action.action;
    const foreignAction = `${fixedAction}-foreign`;
    const foreignDefinition = definitionWithActionOverride(fixedDefinition, "branch", foreignAction);
    const fixedFresh = CurrentFlowState.create({ definition: fixedDefinition });
    const foreignFresh = CurrentFlowState.create({ definition: foreignDefinition });
    assert.deepEqual(foreignFresh.toJSON(), fixedFresh.toJSON());
    assert.equal(foreignFresh.nextAction().action.action, foreignAction);

    const directlyBound = fixedDefinition.bindState(foreignFresh);
    assert.notEqual(directlyBound, foreignFresh);
    assert.equal(directlyBound.definition, fixedDefinition);
    assert.equal(directlyBound.nextAction().action.action, fixedAction);

    const typedStore = new CurrentFlowStateStore({
      directory: path.join(tmp, "typed"),
      definition: fixedDefinition,
    });
    const created = typedStore.create(foreignFresh);
    assert.equal(created.definition, fixedDefinition);
    assert.equal(created.nextAction().action.action, fixedAction);
    assert.equal(typedStore.load().nextAction().action.action, fixedAction);

    const rawStore = new CurrentFlowStateStore({
      directory: path.join(tmp, "raw"),
      definition: fixedDefinition,
    });
    const rawCreated = rawStore.create(foreignFresh.toJSON());
    assert.equal(rawCreated.definition, fixedDefinition);
    assert.equal(rawCreated.nextAction().action.action, fixedAction);
  });

  it("canonicalizes typed Activity before applying and journaling one transition", () => {
    tmp = createTmpDir("current-flow-activity-binding-");
    const fixedDefinition = definition();
    let initial = CurrentFlowState.create({ definition: fixedDefinition });
    const branchPath = initial.nextAction().path;
    const canonical = flowActivity({
      id: "canonical-start",
      state: initial,
      currentPath: branchPath,
      confirmationOrder: 2,
      operation: "start_attempt",
      attempt: attemptFor(initial, branchPath, "canonical-attempt"),
    });
    class DivergentActivity extends FlowActivity {
      toJSON() {
        const value = super.toJSON();
        return {
          ...value,
          nodeId: "prepare-spec",
          nodeKey: "plan.prepare-spec",
          transition: { ...value.transition, path: ["flow", "plan", "prepare-spec"] },
        };
      }
    }
    const divergent = new DivergentActivity(canonical.toJSON());
    const normalized = FlowActivity.canonical(divergent);
    assert.equal(normalized.constructor, FlowActivity);
    assert.equal(normalized.nodeId, "branch");

    const store = new CurrentFlowStateStore({ directory: tmp, definition: fixedDefinition });
    initial = store.create(initial);
    const applied = store.apply({ activity: divergent });
    assert.equal(applied.current.at(-1), "branch");
    assert.equal(store.journal.read()[1].nodeId, "branch");
    assert.equal(store.load().current.at(-1), "branch");
  });

  it("rejects Activity documents that omit exact observation slots", () => {
    const initial = CurrentFlowState.create({ definition: definition() });
    const branchPath = initial.nextAction().path;
    const document = flowActivity({
      id: "exact-activity",
      state: initial,
      currentPath: branchPath,
      confirmationOrder: 1,
      operation: "start_attempt",
      attempt: attemptFor(initial, branchPath, "exact-attempt"),
    }).toJSON();
    const withoutMetric = structuredClone(document);
    delete withoutMetric.metric;
    assert.throws(() => new FlowActivity(withoutMetric), /activity\.metric is required/);
    const withoutNote = structuredClone(document);
    delete withoutNote.note;
    assert.throws(() => new FlowActivity(withoutNote), /activity\.note is required/);
  });

  it("fails closed when persisted state reuses an Attempt identity that its Activity journal assigns elsewhere", () => {
    tmp = createTmpDir("current-flow-semantic-conflict-");
    const fixedDefinition = definition();
    const store = new CurrentFlowStateStore({ directory: tmp, definition: fixedDefinition });
    let state = CurrentFlowState.create({ definition: fixedDefinition });
    state = store.create(state);
    const branchPath = state.nextAction().path;
    state = store.apply({ activity: flowActivity({
      id: "branch-start",
      state,
      currentPath: branchPath,
      confirmationOrder: 2,
      operation: "start_attempt",
      attempt: attemptFor(state, branchPath, "branch-attempt"),
    }) });
    state = store.apply({ activity: flowActivity({
      id: "branch-confirm",
      state,
      currentPath: branchPath,
      confirmationOrder: 3,
      operation: "confirm_attempt",
      status: "done",
      result: passedResult("Branch completed."),
    }) });
    const preparePath = state.nextAction().path;
    state = store.apply({ activity: flowActivity({
      id: "prepare-start",
      state,
      currentPath: preparePath,
      confirmationOrder: 4,
      operation: "start_attempt",
      attempt: attemptFor(state, preparePath, "prepare-attempt"),
    }) });
    const conflictingState = state.toJSON();
    conflictingState.attempt.id = "branch-attempt";
    fs.writeFileSync(store.statePath, `${JSON.stringify(conflictingState)}\n`);

    assert.throws(
      () => store.load(),
      (error) => error instanceof CurrentFlowStateConflictError
        && /content conflicts with its Activity journal/.test(error.message),
    );
  });

  it("exposes a typed revision and rejects stale CAS without appending an Activity", () => {
    tmp = createTmpDir("current-flow-stale-revision-");
    const fixedDefinition = definition();
    const store = new CurrentFlowStateStore({ directory: tmp, definition: fixedDefinition });
    let initial = CurrentFlowState.create({ definition: fixedDefinition });
    initial = store.create(initial);
    const stale = store.loadSnapshot();
    assert.ok(stale instanceof CurrentFlowStateSnapshot);
    const currentPath = initial.nextAction().path;
    const started = store.apply({
      expectedRevision: stale.revision,
      activity: flowActivity({
        id: "revision-start",
        state: initial,
        currentPath,
        confirmationOrder: 2,
        operation: "start_attempt",
        attempt: attemptFor(initial, currentPath, "revision-attempt"),
      }),
    });
    const replacement = started.attempt.replaceFacts({
      blocker: { code: "observed", message: "The state revision advanced." },
    });
    assert.throws(
      () => store.apply({
        expectedRevision: stale.revision,
        activity: flowActivity({
          id: "revision-stale-update",
          state: started,
          currentPath,
          confirmationOrder: 3,
          operation: "update_attempt",
          attempt: replacement,
        }),
      }),
      (error) => error instanceof CurrentFlowStateConflictError
        && /changed before update/.test(error.message),
    );
    assert.equal(store.load().confirmationOrder, 2);
    assert.equal(store.journal.read().length, 2);
  });

  it("rejects a caller assertion before appending its Activity", () => {
    tmp = createTmpDir("current-flow-assert-before-append-");
    const fixedDefinition = definition();
    const store = new CurrentFlowStateStore({ directory: tmp, definition: fixedDefinition });
    const initial = store.create(CurrentFlowState.create({ definition: fixedDefinition }));
    const currentPath = initial.nextAction().path;
    assert.throws(
      () => store.apply({
        activity: flowActivity({
          id: "assertion-start",
          state: initial,
          currentPath,
          confirmationOrder: 2,
          operation: "start_attempt",
          attempt: attemptFor(initial, currentPath, "assertion-attempt"),
        }),
        assertCurrentState: () => { throw new CurrentFlowStateInvariantError("rejected state"); },
      }),
      /rejected state/,
    );
    assert.equal(store.load().confirmationOrder, 1);
    assert.equal(store.journal.read().length, 1);
  });

  it("rejects a journal changed after state validation before appending its Activity", () => {
    tmp = createTmpDir("current-flow-journal-revision-");
    const fixedDefinition = definition();
    let journalPath = null;
    const store = new CurrentFlowStateStore({
      directory: tmp,
      definition: fixedDefinition,
      faultInjector({ phase }) {
        if (phase === "activity-ready-to-append" && journalPath !== null) fs.appendFileSync(journalPath, "tampered");
      },
    });
    const initial = store.create(CurrentFlowState.create({ definition: fixedDefinition }));
    journalPath = store.journal.filePath;
    const currentPath = initial.nextAction().path;
    assert.throws(
      () => store.apply({
        activity: flowActivity({
          id: "journal-revision-start",
          state: initial,
          currentPath,
          confirmationOrder: 2,
          operation: "start_attempt",
          attempt: attemptFor(initial, currentPath, "journal-revision-attempt"),
        }),
      }),
      /Activity journal changed between read and append/,
    );
    assert.equal(JSON.parse(fs.readFileSync(store.statePath, "utf8")).confirmationOrder, 1);
  });

  it("rejects a changed journal before a duplicate creation Activity writes recovered state", () => {
    tmp = createTmpDir("current-flow-journal-recovery-revision-");
    const fixedDefinition = definition();
    const initial = CurrentFlowState.create({ definition: fixedDefinition });
    const crashingStore = new CurrentFlowStateStore({
      directory: tmp,
      definition: fixedDefinition,
      faultInjector({ phase }) {
        if (phase === "activity-appended") throw new Error("crash after flow_created append");
      },
    });
    assert.throws(() => crashingStore.create(initial), /crash after flow_created append/);
    const recoveringStore = new CurrentFlowStateStore({
      directory: tmp,
      definition: fixedDefinition,
      faultInjector({ phase }) {
        if (phase === "activity-ready-to-append") fs.appendFileSync(path.join(tmp, "activities.jsonl"), "tampered");
      },
    });
    assert.throws(
      () => recoveringStore.create(initial),
      /Activity journal changed between read and append/,
    );
    assert.equal(fs.existsSync(recoveringStore.statePath), false);
  });

  it("rejects a partial Activity journal tail rather than treating it as control input", () => {
    tmp = createTmpDir("current-flow-partial-journal-");
    const journalPath = path.join(tmp, "activities.jsonl");
    fs.writeFileSync(journalPath, "{\"id\":\"partial\"");
    assert.throws(() => new FlowActivityJournal(journalPath).read(), /partial line/);
    const store = new CurrentFlowStateStore({ directory: tmp, definition: definition() });
    assert.throws(() => store.load(), /partial line/);
  });

  it("fails closed when an Activity journal survives without its coordinated flow state", () => {
    tmp = createTmpDir("current-flow-orphan-journal-");
    let initial = CurrentFlowState.create({ definition: definition() });
    const store = new CurrentFlowStateStore({ directory: tmp, definition: definition() });
    initial = store.create(initial);
    const branchPath = initial.nextAction().path;
    store.apply({
      activity: flowActivity({
        id: "orphaned-start",
        state: initial,
        currentPath: branchPath,
        confirmationOrder: 2,
        operation: "start_attempt",
        attempt: attemptFor(initial, branchPath, "orphaned-attempt"),
      }),
    });
    fs.unlinkSync(store.statePath);
    assert.throws(
      () => store.load(),
      (error) => error instanceof CurrentFlowStateConflictError
        && /Activity journal exists without flow state/.test(error.message),
    );
  });

  it("rejects symlink and hardlink aliases for both coordinated persistence files", () => {
    tmp = createTmpDir("current-flow-file-authority-");
    const fixedDefinition = definition();
    const initial = CurrentFlowState.create({ definition: fixedDefinition });

    const stateStore = new CurrentFlowStateStore({
      directory: path.join(tmp, "state-store"),
      definition: fixedDefinition,
    });
    stateStore.create(initial);
    const outsideState = path.join(tmp, "outside-flow.json");
    fs.renameSync(stateStore.statePath, outsideState);
    fs.symlinkSync(outsideState, stateStore.statePath);
    assert.throws(
      () => stateStore.load(),
      /file authority must be a regular real file/,
    );

    const journalStore = new CurrentFlowStateStore({
      directory: path.join(tmp, "journal-store"),
      definition: fixedDefinition,
    });
    const outsideJournal = path.join(tmp, "outside-activities.jsonl");
    fs.writeFileSync(outsideJournal, "");
    fs.symlinkSync(outsideJournal, journalStore.journal.filePath);
    assert.throws(
      () => journalStore.create(initial),
      /Activity journal authority must be a regular real file/,
    );

    const linkedStateStore = new CurrentFlowStateStore({
      directory: path.join(tmp, "linked-state-store"),
      definition: fixedDefinition,
    });
    linkedStateStore.create(initial);
    fs.linkSync(linkedStateStore.statePath, path.join(tmp, "outside-state-link"));
    assert.throws(
      () => linkedStateStore.load(),
      /flow state authority must be a single-link regular real file/,
    );

    const linkedJournalStore = new CurrentFlowStateStore({
      directory: path.join(tmp, "linked-journal-store"),
      definition: fixedDefinition,
    });
    const outsideLinkedJournal = path.join(tmp, "outside-linked-activities.jsonl");
    fs.writeFileSync(outsideLinkedJournal, "");
    fs.linkSync(outsideLinkedJournal, linkedJournalStore.journal.filePath);
    assert.throws(
      () => linkedJournalStore.create(initial),
      /Activity journal authority must be a regular real file/,
    );
  });

  it("fails closed when flow state confirmation order is ahead of the durable Activity journal", () => {
    tmp = createTmpDir("current-flow-order-conflict-");
    const initial = CurrentFlowState.create({ definition: definition() });
    const store = new CurrentFlowStateStore({ directory: tmp, definition: definition() });
    store.create(initial);
    fs.writeFileSync(store.statePath, `${JSON.stringify(initial.withConfirmationOrder(2).toJSON())}\n`);
    assert.throws(
      () => store.load(),
      /flow state confirmation order is ahead of its Activity journal/,
    );
  });

  it("derives append order from the durable journal instead of caller-supplied entries", () => {
    tmp = createTmpDir("current-flow-journal-order-");
    let initial = CurrentFlowState.create({ definition: definition() });
    const branchPath = ["flow", "plan", "branch"];
    const store = new CurrentFlowStateStore({ directory: tmp, definition: definition() });
    initial = store.create(initial);
    const first = flowActivity({
      id: "first",
      state: initial,
      currentPath: branchPath,
      confirmationOrder: 2,
      operation: "start_attempt",
      attempt: attemptFor(initial, branchPath, "branch-first"),
    });
    store.apply({ activity: first });
    const duplicateOrder = flowActivity({
      id: "duplicate-order",
      state: initial,
      currentPath: branchPath,
      confirmationOrder: 2,
      operation: "start_attempt",
      attempt: attemptFor(initial, branchPath, "branch-second"),
    });
    assert.throws(
      () => store.journal.append(duplicateOrder),
      /appended only by CurrentFlowStateStore/,
    );
    assert.throws(
      () => store.apply({ activity: duplicateOrder }),
      /state confirmation order is ahead/,
    );
    const reused = flowActivity({
      id: "reused-attempt-id",
      state: initial,
      currentPath: branchPath,
      confirmationOrder: 3,
      operation: "rewind",
      attempt: attemptFor(initial, branchPath, "branch-first", 2),
    });
    const corruptPath = path.join(tmp, "attempt-id-reuse.jsonl");
    const creation = store.journal.read()[0];
    fs.writeFileSync(corruptPath, `${JSON.stringify(creation.toJSON())}\n${JSON.stringify(first.toJSON())}\n${JSON.stringify(reused.toJSON())}\n`);
    assert.throws(
      () => new FlowActivityJournal(corruptPath).read(),
      /Attempt id branch-first is reused/,
    );
    assert.equal(store.journal.read().length, 2);
  });

  it("creates only fresh state and recovers only a sole flow_created Activity journal", () => {
    tmp = createTmpDir("current-flow-fresh-create-");
    const initial = CurrentFlowState.create({ definition: definition() });
    const branchPath = ["flow", "plan", "branch"];
    const active = initial.startAttempt({
      path: branchPath,
      attempt: attemptFor(initial, branchPath, "branch-1"),
    });
    const activeStore = new CurrentFlowStateStore({ directory: path.join(tmp, "active"), definition: definition() });
    assert.throws(() => activeStore.create(active), /requires a fresh state/);
    const completed = completeNext(initial, "branch-done");
    const completedStore = new CurrentFlowStateStore({ directory: path.join(tmp, "completed"), definition: definition() });
    assert.throws(() => completedStore.create(completed), /fresh materialized state/);
    const withTask = initial.addTask({ id: "task-1", key: "first" });
    const taskStore = new CurrentFlowStateStore({ directory: path.join(tmp, "task"), definition: definition() });
    assert.throws(() => taskStore.create(withTask), /fresh materialized state/);
    const journalStore = new CurrentFlowStateStore({ directory: path.join(tmp, "journal"), definition: definition() });
    const historical = flowActivity({
      id: "existing-activity",
      state: initial,
      currentPath: branchPath,
      confirmationOrder: 1,
      operation: "start_attempt",
      attempt: attemptFor(initial, branchPath, "branch-history"),
    });
    fs.writeFileSync(journalStore.journal.filePath, `${JSON.stringify(historical.toJSON())}\n`);
    assert.throws(() => journalStore.create(initial), /requires an empty or sole flow_created Activity journal/);

    const recoveryDirectory = path.join(tmp, "creation-recovery");
    const crashingStore = new CurrentFlowStateStore({
      directory: recoveryDirectory,
      definition: definition(),
      faultInjector({ phase }) {
        if (phase === "activity-appended") throw new Error("crash after flow_created append");
      },
    });
    assert.throws(() => crashingStore.create(initial), /crash after flow_created append/);
    const durableCreation = crashingStore.journal.read()[0].toJSON();
    const recoveredStore = new CurrentFlowStateStore({ directory: recoveryDirectory, definition: definition() });
    const recovered = recoveredStore.create(initial);
    assert.equal(recovered.confirmationOrder, 1);
    assert.equal(recoveredStore.journal.read().length, 1);
    assert.deepEqual(recoveredStore.journal.read()[0].toJSON(), durableCreation);
  });

  it("reclaims a process-identified stale lock before replaying the same typed Activity", () => {
    tmp = createTmpDir("current-flow-stale-lock-");
    let initial = CurrentFlowState.create({ definition: definition() });
    const store = new CurrentFlowStateStore({ directory: tmp, definition: definition() });
    initial = store.create(initial);
    const branchPath = ["flow", "plan", "branch"];
    const entry = flowActivity({
      id: "stale-lock-start",
      state: initial,
      currentPath: branchPath,
      confirmationOrder: 2,
      operation: "start_attempt",
      attempt: attemptFor(initial, branchPath, "branch-1"),
    });
    const stranded = new CurrentFlowStateStore({
      directory: tmp,
      definition: definition(),
      processIdentitySource: identitySource("owner-boot"),
    });
    stranded.lock.acquire();
    const recovering = new CurrentFlowStateStore({
      directory: tmp,
      definition: definition(),
      processIdentitySource: identitySource("recovery-boot"),
    });
    assert.equal(recovering.apply({ activity: entry }).confirmationOrder, 2);
  });

  it("rejects forbidden legacy fields and malformed typed incomplete claims at the deserialization boundary", () => {
    const clean = CurrentFlowState.create({ definition: definition() }).toJSON();
    for (const field of ["currentTaskId", "childId", "runtimeLog", "metrics", "notes", "stepAttempts", "workerArtifactReceipts", "reviewConvergence", "reviewRecoveryBaselines", "testReviewRepairHistory", "expandedPluginHooks"]) {
      assert.throws(
        () => new CurrentFlowState({ ...clean, [field]: [] }, { definition: definition() }),
        (error) => error instanceof CurrentFlowStateInvariantError && error.message.includes(field),
      );
    }
    assert.throws(
      () => new CurrentFlowState({ ...clean, schemaRevision: 1 }, { definition: definition() }),
      /unsupported schemaRevision: 1/,
    );
    const missingCursor = structuredClone(clean);
    delete missingCursor.steps[0].attemptSequence;
    assert.throws(
      () => new CurrentFlowState(missingCursor, { definition: definition() }),
      /node.attemptSequence is required/,
    );
    assert.throws(
      () => new NodeResult(passedResult("opaque artifact", ["legacy-artifact"])),
      /artifact reference must be an object/,
    );
    assert.throws(
      () => new CurrentAttempt({
        id: "bad",
        nodeId: "branch",
        sequence: 1,
        startedAt: NOW,
        consumption: { semantic: 0, tooling: 0 },
        failure: null,
        blocker: null,
        incomplete: [{ code: "bad", message: "Bad resource.", operation: null, resources: ["spec"] }],
        operationClaims: [],
      }),
      /resources requires an operation/,
    );
  });

  it("classifies state-changing Activity operations for derived timestamp authority", () => {
    for (const operation of [
      "complete_task_review_stage",
      "settle_test_review_repair_timeout",
      "recover_task_execution_overrun",
      "advance_task_review_stage",
    ]) {
      assert.equal(ActivityTransition.isStateChangingOperation(operation), true, operation);
    }
    assert.equal(ActivityTransition.isStateChangingOperation("continue_nonblocking"), true);
    for (const operation of ["record_metric", "record_note", "record_nonblocking"]) {
      assert.equal(ActivityTransition.isStateChangingOperation(operation), false, operation);
    }
  });

  it("validates and serializes creation-time Git snapshot context", () => {
    const commit = "a".repeat(40);
    assert.deepEqual(
      new CurrentFlowContext({ gitSnapshot: { available: true, commit } }).toJSON(),
      { gitSnapshot: { available: true, commit } },
    );
    assert.deepEqual(
      new CurrentFlowContext({ gitSnapshot: { available: false, commit: null } }).toJSON(),
      { gitSnapshot: { available: false, commit: null } },
    );
    for (const context of [
      {},
      { gitSnapshot: { available: false, commit } },
      { gitSnapshot: { available: true, commit: "not-an-object-id" } },
      { gitSnapshot: { available: true, commit, extra: true } },
    ]) {
      assert.throws(() => new CurrentFlowContext(context), CurrentFlowStateInvariantError);
    }
  });
});
