import fs from "fs";
import path from "path";
import { Container } from "../../../src/lib/container.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { emptySpecStub } from "../../../src/lib/spec-json.js";
import { CanonicalFlowCreateRequest } from "../../../src/flow/lib/canonical-flow-manager-store.js";
import { CurrentFlowSpecRecord, FlowExecution } from "../../../src/flow/lib/current-flow-state.js";
import { findStepById, flattenSteps } from "../../../src/flow/lib/step-tree.js";
import { createLifecycleStepTransition } from "../../../src/flow/lib/lifecycle-step-transition.js";
import { NormalStepTransition } from "../../../src/flow/lib/step-transition-policy.js";
import {
  CanonicalCommandResultPublication,
  CanonicalCommandAttemptArtifactHistory,
  attachCanonicalCommandResultArtifact,
  attachCanonicalCommandResultPublications,
} from "../../../src/flow/lib/canonical-command-result.js";
import { SpecReviewDelta, mergeSpecReviewDelta } from "../../../src/flow/lib/spec-review-artifacts.js";
import { attemptHistoryTargetForNode } from "../../../src/flow/lib/producer-artifact-readiness.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../../src/lib/flow-artifact-contract.js";
import { FlowArtifactCatalog } from "../../../src/lib/flow-version.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { readCurrentGateTransitionFacts } from "../../../src/flow/lib/gate-transition-facts.js";
import { resolveGateTransition } from "../../../src/flow/definition.js";
import { ReviewFindingFingerprint } from "../../../src/flow/lib/finding-disposition-policy.js";
import { SourceMutationManifest, SourceWorkerEffect } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { captureCurrentTaskSource } from "../../../src/flow/lib/task-mutation-lineage.js";
import { appendIssueLogFromGateResult } from "../../../src/flow/lib/run-gate.js";

/**
 * Build a fresh Container instance with `flowManager` registered for a test
 * tmp root. Mirrors the production Container.register("flowManager", ...) wiring
 * so tests exercise the same `container.get("flowManager")` access path.
 *
 * Tests run outside any real worktree, so `inWorktree` is always false
 * and `mainRoot === root`.
 */
export function makeContainer(root, options = {}) {
  const c = new Container();
  c.register("flowManager", new FlowManager({ root, mainRoot: root, inWorktree: false, ...options }));
  return c;
}

/** Convenience accessor used by tests: returns the per-test container's flowManager. */
export function makeFlowManager(root, options = {}) {
  return makeContainer(root, options).get("flowManager");
}

export function canonicalImplReviewFinding(input) {
  const identity = {
    ...input,
    scope: "flow",
    phase: "impl-review",
    taskId: null,
    category: input.failureMode,
  };
  delete identity.findingId;
  delete identity.fingerprint;
  const fingerprint = ReviewFindingFingerprint.fromFinding(identity).value;
  return Object.freeze({ ...input, findingId: fingerprint, fingerprint });
}

export function canonicalImplReviewArtifact(flowState, {
  blockingFindings = [],
  nonBlockingImprovements = [],
  repairFingerprint = "a".repeat(64),
  generatedAt = "2026-08-14T00:00:00.000Z",
} = {}) {
  const canonicalBlocking = blockingFindings.map(canonicalImplReviewFinding);
  const canonicalAdvisory = nonBlockingImprovements.map(canonicalImplReviewFinding);
  return Object.freeze({
    version: 1,
    phase: "impl",
    generatedAt,
    runId: flowState.runId,
    taskId: null,
    planRewindAt: null,
    verdict: canonicalBlocking.length > 0 ? "REJECTED" : canonicalAdvisory.length > 0 ? "ADVISORY" : "PASS",
    summary: {
      blocking: canonicalBlocking.length,
      nonBlocking: canonicalAdvisory.length,
      total: canonicalBlocking.length + canonicalAdvisory.length,
    },
    blockingFindings: canonicalBlocking,
    nonBlockingImprovements: canonicalAdvisory,
    repairFingerprint,
  });
}

/**
 * Confirm an active fixture Attempt through the same typed boundary used by
 * its production owner. Gate leaves publish canonical evidence and obtain a
 * Definition decision; ordinary producer leaves attach their canonical
 * command result to the status update.
 */
export function confirmCanonicalFixtureStep(flowManager, specId, nodeId, status = "done") {
  let current = flowManager.loadReadOnly(specId);
  const resolvedSpecId = current.specId;
  const node = flattenSteps(current.steps).find((entry) => entry.id === nodeId) ?? null;
  if (node === null) throw new Error(`canonical fixture node is absent: ${nodeId}`);
  if (["done", "skipped"].includes(node.status)) return current;
  if (current.currentNodeId !== nodeId) {
    flowManager.updateStepStatus(
      { stepId: nodeId, requestedStatus: "in_progress" },
      { specId: resolvedSpecId },
    );
    current = flowManager.loadReadOnly(resolvedSpecId);
  }
  const task = current.tasks.find((candidate) => (
    candidate.steps.some((step) => step.id === nodeId)
  )) ?? null;
  if (status === "done" && task !== null && nodeId === `${task.id}-impl`) {
    const canonical = flowManager.canonicalState(resolvedSpecId);
    const manifest = new SourceMutationManifest({
      attempt: canonical.attempt,
      baselineDigest: "a".repeat(64),
      mutations: [],
    });
    flowManager.confirmSourceWorkerHandoff({
      specId: resolvedSpecId,
      mutationManifest: manifest,
      handoffDigest: "b".repeat(64),
      effect: new SourceWorkerEffect({
        version: 1,
        stepId: "task-impl",
        completionStatus: "done",
        files: [],
        issues: [],
        overview: { modules: [], data_flow: [], decisions: [] },
        triage: null,
        repair: null,
        noChangeReason: "The fixture Task requires no source mutation.",
      }),
      result: {
        outcome: "passed",
        summary: "Fixture Task implementation completed without source mutation.",
        confirmedAt: "2026-01-01T00:00:00.000Z",
        artifactRefs: [],
      },
    });
    return flowManager.loadReadOnly(resolvedSpecId);
  }
  const gatePhase = status === "done"
    ? (task?.steps.at(-1)?.id === nodeId ? "task-impl" : nodeId === "impl-gate" ? "integration" : null)
    : null;
  if (gatePhase !== null) {
    let commandResult = null;
    let facts = readCurrentGateTransitionFacts({
      flowManager,
      flowState: current,
      phase: gatePhase,
    });
    if (facts === null) {
      commandResult = new CanonicalGatePromotion({
        state: flowManager.canonicalState(resolvedSpecId),
        phase: gatePhase,
        nodeId,
        ...(task === null ? {} : { activeTaskId: task.id }),
      }).promote({
        result: "pass",
        changed: [],
        artifacts: {
          evaluations: [],
          reasons: [],
          ...(task === null ? {} : {
            sourceFingerprint: captureCurrentTaskSource({
              root: flowManager.executionRoot(),
              flowManager,
              state: current,
              taskId: task.id,
            }).fingerprint,
          }),
        },
      });
      flowManager.publishCurrentAttemptResult({ specId: resolvedSpecId, commandResult });
      facts = readCurrentGateTransitionFacts({
        flowManager,
        flowState: flowManager.loadReadOnly(resolvedSpecId),
        phase: gatePhase,
      });
    }
    let gateTransitionDecision = resolveGateTransition(facts);
    if (task !== null) {
      if (commandResult === null) {
        const source = flowManager.readProducerArtifact({
          specId: resolvedSpecId,
          nodeId,
          logicalKey: "task.gate",
          parameters: { taskId: task.id },
        });
        commandResult = CanonicalCommandAttemptArtifactHistory.fromBytes({
          logicalKey: "task.gate",
          bytes: source.bytes,
        }).current.payload;
      }
      flowManager.recordTaskGateSettlementMetric({ specId: resolvedSpecId, decision: gateTransitionDecision });
      gateTransitionDecision = resolveGateTransition(readCurrentGateTransitionFacts({
        flowManager,
        flowState: flowManager.loadReadOnly(resolvedSpecId),
        phase: gatePhase,
      }));
      appendIssueLogFromGateResult({
        root: flowManager.executionRoot(),
        mainRoot: flowManager.executionRoot(),
        executionRoot: flowManager.executionRoot(),
        specId: resolvedSpecId,
        flowManager,
        flowState: flowManager.loadReadOnly(resolvedSpecId),
        phase: gatePhase,
        gateTransitionDecision,
      }, commandResult);
      gateTransitionDecision = resolveGateTransition(readCurrentGateTransitionFacts({
        flowManager,
        flowState: flowManager.loadReadOnly(resolvedSpecId),
        phase: gatePhase,
      }));
    }
    return flowManager.updateStepStatus(
      { stepId: nodeId, requestedStatus: status },
      { specId: resolvedSpecId, gateTransitionDecision },
    );
  }
  const canonicalCommandResult = status === "done"
    ? canonicalFixtureProducerResult(current, nodeId, { flowManager, specId: resolvedSpecId })
    : null;
  return flowManager.updateStepStatus(
    { stepId: nodeId, requestedStatus: status },
    { specId: resolvedSpecId, ...(canonicalCommandResult === null ? {} : { canonicalCommandResult }) },
  );
}

export function draftDocumentWithPendingQuestions({
  questions = [
    ["q1", "Which public behavior should the command guarantee?"],
    ["q2", "Which compatibility boundary should remain explicit?"],
  ],
} = {}) {
  const question = ([id, text]) => ({
    state: "AwaitingUserAnswer",
    id,
    category: "user-visible-behavior",
    question: text,
    revision: 0,
    provenance: { producer: "fixture" },
    evidenceDigest: "a".repeat(64),
  });
  return canonicalDraftDocument({
    goal: "Exercise an explicit draft question boundary.",
    questions: questions.map(question),
  });
}

export function canonicalDraftDocument({
  goal = "Exercise a canonical draft boundary.",
  questions = [],
} = {}) {
  return {
    devType: "feature",
    goal,
    analysis: {
      problem: "A non-interactive worker cannot collect a user decision.",
      proposedApproach: "The CLI must yield before starting that worker.",
      validation: "The answer is stored before the worker action is returned.",
    },
    decisionMap: {
      knownFacts: [],
      decisionPoints: [],
      resolvedByProjectRules: [],
      requiresUserJudgment: questions.map((entry) => entry.id),
      deferredToSpec: [],
    },
    scopeVerification: { in: [], out: [] },
    impactOnExisting: [],
    questionLedger: {
      revision: 0,
      publication: "fixture",
      evidenceDigest: "a".repeat(64),
      questions,
    },
    openQuestions: [],
  };
}

export function makeNormalStepTransition(state, stepId, requestedStatus = "done") {
  const step = findStepById(state.steps || [], stepId);
  if (!step) throw new Error(`unknown fixture step: ${stepId}`);
  return new NormalStepTransition({
    stepId,
    currentStepId: stepId,
    currentStatus: step.status,
    requestedStatus,
  });
}

export function makeLifecycleStepTransition(
  state,
  stepId,
  requestedStatus,
  event = "definition:keep-in-progress",
) {
  return createLifecycleStepTransition({
    flowState: state,
    stepId,
    status: requestedStatus,
    event,
    taskId: null,
  });
}

const FIXTURE_TASK_STEP_SUFFIXES = new Map([
  ["task-impl", "impl"],
  ["task-review", "review"],
  ["task-gate", "gate"],
]);

function fixtureFinalRegressionResult(flowManager, specId) {
  const rawOutputPath = flowManager === null
    ? "tests/.raw/final-regression-fixture.log"
    : flowManager.specLocation(specId).relativeArtifact("final.regression.raw-log", { attempt: "001" });
  const reason = "Fixture project policy has no supported regression command.";
  return {
    version: "1",
    completed: true,
    result: "skipped",
    failureKind: null,
    skipKind: "skipped_by_project_policy",
    reason,
    command: null,
    commandSource: null,
    rawOutputPath,
    rawOutputLines: { start: 1, end: 1 },
    process: { started: false, exitCode: null, signal: null, timedOut: false, spawnError: null },
    childProcesses: [],
    changedFiles: [],
    changedFileFingerprints: [],
    changedFileSnapshotDigest: "0".repeat(64),
    proof: {
      kind: "skipped_by_project_policy",
      commandDiscovery: {
        checkedSources: ["fixture"],
        supportedCommandFound: false,
        invalidConfiguredCommand: false,
        reason,
      },
    },
  };
}

/**
 * A fixture's synthetic `done` transition represents a real producer
 * completion. Publish its durable primary Attempt result, rather than
 * fabricating optional handoff artifacts with unrelated payload semantics.
 */
export function canonicalFixtureProducerResult(_state, nodeId, { flowManager = null, specId = null } = {}) {
  if (nodeId === "spec-review") {
    const resolvedSpecId = specId ?? _state?.specId ?? null;
    if (flowManager === null || typeof resolvedSpecId !== "string" || resolvedSpecId === "") {
      throw new Error("canonical spec-review fixture result requires FlowManager and specId");
    }
    // The first fixture completion models the real spec-review confirmation:
    // its base may be the Store-derived, unpersisted generation-zero seed.
    const current = flowManager.readCurrentSpecReviewInput({ specId: resolvedSpecId, consumerNodeId: "spec-review" });
    const delta = new SpecReviewDelta({
      version: 2,
      stage: "spec-review",
      identity: current.review.identity.toJSON(),
      baseReviewDigest: current.review.digest,
      findings: [],
      operations: [],
    });
    const next = mergeSpecReviewDelta({ review: current.review, delta });
    const result = { result: "fixture spec-review result" };
    attachCanonicalCommandResultArtifact(result, { logicalKey: "spec.review", payload: delta.toJSON() });
    attachCanonicalCommandResultPublications(result, [new CanonicalCommandResultPublication({
      logicalKey: "spec.review",
      parameters: { revision: String(current.revision).padStart(3, "0") },
      mediaType: "application/json",
      payload: next.toJSON(),
    })]);
    return result;
  }
  const target = attemptHistoryTargetForNode(nodeId);
  if (target === null) return null;
  if (flowManager !== null) {
    const resolvedSpecId = specId ?? _state?.specId ?? null;
    if (typeof resolvedSpecId !== "string" || resolvedSpecId === "") {
      throw new Error("canonical fixture producer result requires specId");
    }
    const state = flowManager.canonicalState(resolvedSpecId);
    const alreadyPublished = state.current?.at(-1) === nodeId
      && state.attempt !== null
      && flowManager.artifactCatalog(resolvedSpecId).artifacts.some((descriptor) => (
        descriptor.logicalKey === target.logicalKey
        && flowManager.activityLedger(resolvedSpecId).some((activity) => (
          activity.id === descriptor.activityId
          && activity.nodeId === nodeId
          && activity.attemptId === state.attempt.id
          && activity.sequence === state.attempt.sequence
        ))
      ));
    if (alreadyPublished) return null;
  }
  // The acceptance-decision no-op is authorized by the cataloged semantic
  // PASS, not merely an attempt-history envelope.  Fixtures that complete a
  // whole definition therefore publish the same valid empty PASS shape a
  // real acceptance worker would produce for a Spec without requirements.
  const payload = nodeId === "acceptance-review"
    ? {
      version: 2,
      repairFingerprint: "0".repeat(64),
      mechanicalBlockers: [],
      hardBlockers: [],
      requirementJudgments: [],
      deferredFindings: [],
      userDecision: null,
      verdict: "pass",
    }
    : nodeId === "impl-review"
      ? {
        version: 1,
        phase: "impl",
        generatedAt: "2026-01-02T03:04:05.000Z",
        runId: _state.runId,
        taskId: null,
        planRewindAt: null,
        verdict: "PASS",
        summary: { blocking: 0, nonBlocking: 0, total: 0 },
        blockingFindings: [],
        nonBlockingImprovements: [],
        repairFingerprint: "a".repeat(64),
      }
    : nodeId === "final-regression"
      ? fixtureFinalRegressionResult(flowManager, specId)
    : { fixture: "canonical-producer-result", nodeId };
  const result = { result: "fixture producer result" };
  attachCanonicalCommandResultArtifact(result, {
    logicalKey: target.logicalKey,
    payload,
  });
  return result;
}

/**
 * Construct a catalog-consistent corrupted persisted state after a scenario
 * reached it through normal producer confirmation. This is test-only setup
 * for consumers that must reject a missing historical artifact; it never
 * exercises a public mutation path or invents an artifact.
 */
export function removeCatalogedArtifactForCorruptionFixture(
  flowManager,
  specId,
  logicalKey,
  parameters = {},
) {
  const location = flowManager.specLocation(specId);
  const target = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters);
  const stored = JSON.parse(fs.readFileSync(location.catalogFile, "utf8"));
  const catalog = new FlowArtifactCatalog(stored);
  const descriptor = catalog.artifacts.find((entry) => entry.relativePath === target.relativePath) ?? null;
  if (descriptor === null || descriptor.logicalKey !== logicalKey) {
    throw new Error(`corruption fixture requires cataloged ${logicalKey}`);
  }
  const artifactPath = location.resolve(descriptor.relativePath);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`corruption fixture requires ${logicalKey} bytes`);
  }
  fs.unlinkSync(artifactPath);
  const corrupted = new FlowArtifactCatalog({
    schemaRevision: catalog.schemaRevision,
    artifacts: catalog.artifacts.filter((entry) => entry.relativePath !== descriptor.relativePath),
  });
  fs.writeFileSync(location.catalogFile, `${JSON.stringify(corrupted.toJSON(), null, 2)}\n`, "utf8");
  return descriptor;
}

/**
 * Purpose-built V1 Flow fixture API.
 *
 * This class exposes the same operations normal production code uses:
 * validated fresh creation, typed Task admission, and definition-ordered
 * Attempt transitions.  It deliberately accepts a Spec document and named
 * lifecycle targets, never a mutable legacy flow.json-shaped state object.
 */
export class CanonicalFlowFixture {
  constructor({
    flowManager,
    specId = "001-test",
    runId = "run-test",
    request = "Fixture request",
    execution = { mode: "direct" },
    autoApprove = false,
    issue = null,
    issueSnapshot = null,
    flowId = null,
    flowVersionId = null,
    specRecord = null,
    context = null,
  } = {}) {
    if (flowManager === null || typeof flowManager?.createFresh !== "function") {
      throw new TypeError("CanonicalFlowFixture requires a FlowManager");
    }
    this.flowManager = flowManager;
    this.specId = specId;
    this.runId = runId;
    this.request = request;
    this.execution = execution instanceof FlowExecution ? execution : new FlowExecution(execution);
    this.autoApprove = autoApprove === true;
    this.issue = issue;
    this.issueSnapshot = issueSnapshot;
    this.flowId = flowId;
    this.flowVersionId = flowVersionId;
    this.specRecord = specRecord;
    this.context = context;
    this.created = false;
  }

  create() {
    if (this.created) throw new Error("canonical fixture Flow is already created");
    const supplied = this.specRecord instanceof CurrentFlowSpecRecord
      ? this.specRecord.toJSON()
      : this.specRecord ?? {};
    if (supplied.tasks != null && (!Array.isArray(supplied.tasks) || supplied.tasks.length !== 0)) {
      throw new Error("CanonicalFlowFixture fresh Spec tasks must be added with addTask");
    }
    const specRecord = new CurrentFlowSpecRecord({
      ...emptySpecStub(),
      ...structuredClone(supplied),
      tasks: [],
    }, { specId: this.specId });
    this.flowManager.createFresh(new CanonicalFlowCreateRequest({
      specId: this.specId,
      runId: this.runId,
      request: this.request,
      execution: this.execution.toJSON(),
      policy: { autoApprove: this.autoApprove, nonblocking: null },
      issue: this.issue,
      ...(this.issue === null ? {} : {
        issueSnapshot: this.issueSnapshot ?? `# Issue #${this.issue}\n`,
      }),
      context: this.context,
      flowId: this.flowId ?? `flow-${this.runId}`,
      flowVersionId: this.flowVersionId ?? `flow-v1-${this.runId}`,
      specRecord,
    }));
    this.created = true;
    return this;
  }

  addTask(task) {
    this.#assertCreated();
    if (task?.steps !== undefined) {
      throw new Error("CanonicalFlowFixture.addTask accepts a Spec Task document, not runtime Task steps");
    }
    this.flowManager.addTask(structuredClone(task), { specId: this.specId });
    return this;
  }

  addTasks(tasks) {
    if (!Array.isArray(tasks)) throw new TypeError("CanonicalFlowFixture.addTasks requires an array");
    for (const task of tasks) this.addTask(task);
    return this;
  }

  registerActive() {
    this.#assertCreated();
    this.flowManager.addActiveFlow(this.specId, this.execution.mode);
    return this;
  }

  state() {
    this.#assertCreated();
    return this.flowManager.loadReadOnly(this.specId);
  }

  location() {
    this.#assertCreated();
    return this.flowManager.specLocation(this.specId);
  }

  leaves() {
    return flattenSteps(this.state().steps);
  }

  /** Confirm every definition leaf before `nodeId`, leaving no active Attempt. */
  settleBefore(nodeId) {
    const index = this.#leafIndex(nodeId);
    for (const step of this.leaves().slice(0, index)) {
      if (["done", "skipped"].includes(step.status)) continue;
      this.settle(step.id);
    }
    return this;
  }

  /** Confirm one named definition leaf through an explicit typed Attempt. */
  settle(nodeId, status = "done") {
    this.#assertCreated();
    const state = this.state();
    const node = flattenSteps(state.steps).find((entry) => entry.id === nodeId) ?? null;
    if (node === null) throw new Error(`canonical fixture node is absent: ${nodeId}`);
    if (["done", "skipped"].includes(node.status)) return this;
    if (state.currentNodeId !== nodeId) {
      const task = this.#firstTaskForNode(state, nodeId);
      if (task !== null) {
        this.flowManager.startTask(task.id, { specId: this.specId });
      } else {
        this.flowManager.updateStepStatus({ stepId: nodeId, requestedStatus: "in_progress" }, { specId: this.specId });
      }
    }
    confirmCanonicalFixtureStep(this.flowManager, this.specId, nodeId, status);
    return this;
  }

  /** Start one ordinary Flow leaf after settling all definition predecessors. */
  activate(nodeId, { settlePredecessors = true } = {}) {
    if (settlePredecessors) this.settleBefore(nodeId);
    const task = this.#firstTaskForNode(this.state(), nodeId);
    if (task !== null) {
      this.flowManager.startTask(task.id, { specId: this.specId });
    } else {
      this.flowManager.updateStepStatus({ stepId: nodeId, requestedStatus: "in_progress" }, { specId: this.specId });
    }
    return this;
  }

  /** Start a Task only through the production typed Task-start operation. */
  activateTask(taskId, { settlePredecessors = true } = {}) {
    this.#assertCreated();
    const task = this.state().tasks.find((entry) => entry.id === taskId) ?? null;
    if (task === null) throw new Error(`canonical fixture Task is absent: ${taskId}`);
    const firstStep = task.steps[0] ?? null;
    if (firstStep === null) throw new Error(`canonical fixture Task has no Steps: ${taskId}`);
    if (settlePredecessors) this.settleBefore(firstStep.id);
    this.flowManager.startTask(taskId, { specId: this.specId });
    return this;
  }

  /** Leave the first Task leaf pending after all static pre-Task leaves. */
  prepareTaskFrontier() {
    this.#assertCreated();
    const firstTaskLeaf = this.leaves().find((step) => (
      this.state().tasks.some((task) => task.steps.some((candidate) => candidate.id === step.id))
    )) ?? null;
    if (firstTaskLeaf === null) throw new Error("canonical fixture has no admitted Task frontier");
    this.settleBefore(firstTaskLeaf.id);
    return this;
  }

  #leafIndex(nodeId) {
    const index = this.leaves().findIndex((step) => step.id === nodeId);
    if (index < 0) throw new Error(`canonical fixture node is absent: ${nodeId}`);
    return index;
  }

  #firstTaskForNode(state, nodeId) {
    return state.tasks.find((task) => task.steps[0]?.id === nodeId) ?? null;
  }

  #assertCreated() {
    if (!this.created) throw new Error("canonical fixture Flow must be created first");
  }
}

function assertFixtureFields(input, allowed, fixtureName) {
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      throw new TypeError(`${fixtureName} does not accept legacy field: ${field}`);
    }
  }
}

const FRESH_FLOW_FIXTURE_FIELDS = new Set([
  "flowManager", "specId", "runId", "request", "execution", "autoApprove",
  "issue", "issueSnapshot", "flowId", "flowVersionId", "specRecord", "context",
]);

/** A fresh canonical Flow with no mutable state import or state replacement API. */
export class FreshFlowFixture {
  constructor(input = {}) {
    assertFixtureFields(input, FRESH_FLOW_FIXTURE_FIELDS, "FreshFlowFixture");
    this.flow = new CanonicalFlowFixture(input);
  }

  create() { this.flow.create(); return this; }
  addTask(task) { this.flow.addTask(task); return this; }
  addTasks(tasks) { this.flow.addTasks(tasks); return this; }
  registerActive() { this.flow.registerActive(); return this; }
  state() { return this.flow.state(); }
  location() { return this.flow.location(); }
}

const FLOW_AT_STEP_FIXTURE_FIELDS = new Set([
  ...FRESH_FLOW_FIXTURE_FIELDS,
  "taskDocuments", "targetStep",
]);

/** Builds a named active Flow leaf using only definition-ordered typed transitions. */
export class FlowAtStepFixture {
  constructor(input = {}) {
    assertFixtureFields(input, FLOW_AT_STEP_FIXTURE_FIELDS, "FlowAtStepFixture");
    if (typeof input.targetStep !== "string" || input.targetStep.length === 0) {
      throw new TypeError("FlowAtStepFixture requires a targetStep");
    }
    this.targetStep = input.targetStep;
    this.taskDocuments = input.taskDocuments ?? [];
    if (!Array.isArray(this.taskDocuments)) {
      throw new TypeError("FlowAtStepFixture taskDocuments must be an array");
    }
    const { taskDocuments, targetStep, ...flowInput } = input;
    if (flowInput.specRecord == null && this.taskDocuments.length > 0) {
      flowInput.specRecord = {
        requirements: this.taskDocuments.map((task) => ({
          id: `R-${task.id}`,
          desc: `Exercise canonical Task ${task.id}.`,
          task_ids: [task.id],
        })),
      };
    }
    this.flow = new FreshFlowFixture(flowInput);
  }

  create() {
    this.flow.create().addTasks(this.taskDocuments).registerActive();
    this.flow.flow.activate(this.targetStep);
    return this;
  }

  state() { return this.flow.state(); }
  location() { return this.flow.location(); }
}

const TASK_LIFECYCLE_FIXTURE_FIELDS = new Set([
  ...FRESH_FLOW_FIXTURE_FIELDS,
  "taskDocuments", "taskId", "targetStep",
]);

/** Builds a Task lifecycle frontier from Spec Task documents, never runtime Task blobs. */
export class TaskLifecycleFixture {
  constructor(input = {}) {
    assertFixtureFields(input, TASK_LIFECYCLE_FIXTURE_FIELDS, "TaskLifecycleFixture");
    if (!Array.isArray(input.taskDocuments) || input.taskDocuments.length === 0) {
      throw new TypeError("TaskLifecycleFixture requires taskDocuments");
    }
    if (typeof input.taskId !== "string" || input.taskId.length === 0) {
      throw new TypeError("TaskLifecycleFixture requires a taskId");
    }
    this.taskId = input.taskId;
    this.targetStep = input.targetStep ?? "task-impl";
    const { taskDocuments, taskId, targetStep, ...flowInput } = input;
    if (flowInput.specRecord == null) {
      flowInput.specRecord = {
        requirements: taskDocuments.map((task) => ({
          id: `R-${task.id}`,
          desc: `Exercise canonical Task ${task.id}.`,
          task_ids: [task.id],
        })),
      };
    }
    this.flow = new FreshFlowFixture(flowInput);
    this.taskDocuments = taskDocuments;
  }

  create() {
    this.flow.create().addTasks(this.taskDocuments).registerActive();
    const suffix = this.targetStep.replace(/^task-/, "");
    if (!new Set(["impl", "review", "gate"]).has(suffix)) {
      throw new TypeError(`TaskLifecycleFixture targetStep is unsupported: ${this.targetStep}`);
    }
    const nodeId = `${this.taskId}-${suffix}`;
    this.flow.flow.settleBefore(`${this.taskId}-impl`);
    this.flow.flow.activateTask(this.taskId, { settlePredecessors: false });
    for (const predecessor of ["impl", "review"]) {
      if (predecessor === suffix) break;
      this.flow.flow.settle(`${this.taskId}-${predecessor}`);
    }
    if (suffix !== "impl") this.flow.flow.activate(nodeId, { settlePredecessors: false });
    return this;
  }

  state() { return this.flow.state(); }
  location() { return this.flow.location(); }
}

/**
 * Purpose-specific causal fixture for commands that consume auto-check input.
 *
 * It creates only a fresh V1 Flow and reaches input phases through the normal
 * typed lifecycle APIs. In particular, its draft is published through the
 * producer-owned catalog while `draft` is active; it is not a root-file setup
 * shortcut or a legacy state converter.
 */
export class CanonicalAutoCheckScenario {
  constructor({
    flowManager,
    specId = "001-test",
    runId = "run-001-test",
    request = "add a progress bar",
    issue = null,
    execution = { mode: "branch", baseBranch: "main", featureBranch: "feature/001-test" },
    autoApprove = false,
  } = {}) {
    this.flow = new CanonicalFlowFixture({
      flowManager,
      specId,
      runId,
      request,
      issue,
      execution,
      autoApprove,
      specRecord: {
        goal: "canonical auto-check fixture",
        requirements: [{ id: "R-T-1", desc: "Exercise the auto-check Task.", task_ids: ["T-1"] }],
      },
    });
    this.flowManager = flowManager;
    this.specId = specId;
    this.created = false;
  }

  create() {
    if (this.created) throw new Error("canonical auto-check scenario is already created");
    this.flow.create().addTask({
      id: "T-1",
      title: "Auto-check fixture task",
      goal: "Exercise canonical auto-check input.",
      parent: null,
      origin: "plan",
      added_round: 0,
      status: "pending",
    }).registerActive();
    this.created = true;
    return this;
  }

  /** Persist a valid draft but deliberately leave draft-gate unfinished. */
  draftSavedBeforeGate(draftText) {
    this.#assertCreated();
    this.#publishDraft(draftText);
    this.flow.settle("draft");
    return this;
  }

  /** Reach the only phase in which auto-check may consume the saved draft. */
  draftGateDone(draftText) {
    this.draftSavedBeforeGate(draftText);
    this.flow.activate("draft-gate").settle("draft-gate");
    return this;
  }

  /** Reach the spec-approved skip path through definition-ordered transitions. */
  approvalDone() {
    this.#assertCreated();
    this.flow.settleBefore("approval").settle("approval");
    return this;
  }

  state() { return this.flow.state(); }

  #publishDraft(draftText) {
    if (typeof draftText !== "string" || draftText.trim() === "") {
      throw new Error("canonical auto-check draft text is required");
    }
    let parsed;
    try {
      parsed = JSON.parse(draftText);
    } catch (error) {
      throw new Error(`canonical auto-check draft text must be JSON: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("canonical auto-check draft text must encode an object");
    }
    this.flow.activate("draft");
    this.flowManager.publishArtifacts({
      specId: this.specId,
      nodeId: "draft",
      artifactWrites: [{
        logicalKey: "draft",
        mediaType: "application/json",
        bytes: Buffer.from(draftText, "utf8"),
      }],
    });
  }

  #assertCreated() {
    if (!this.created) throw new Error("canonical auto-check scenario must be created first");
  }
}

/**
 * Causal V1 setup for the next-action command contract.
 *
 * The command observes a definition-selected worker frontier.  This fixture
 * therefore admits Task documents through spec.json, then reaches a target
 * only through the Store's definition-ordered Attempt transitions.  It has
 * no mutable-state import or arbitrary path writer.
 */
export class CanonicalNextActionScenario {
  constructor({
    flowManager,
    specId = "001-test",
    runId = "run-001-test",
    request = "Fixture request",
    execution = { mode: "direct" },
    autoApprove = false,
    issue = null,
    specRecord = null,
  } = {}) {
    this.flowManager = flowManager;
    this.specId = specId;
    this.usesDefaultSpecRecord = specRecord === null;
    this.flow = new CanonicalFlowFixture({
      flowManager,
      specId,
      runId,
      request,
      execution,
      autoApprove,
      issue,
      specRecord: specRecord ?? { requirements: [] },
    });
    this.created = false;
  }

  create({ tasks = [] } = {}) {
    if (this.created) throw new Error("canonical next-action scenario is already created");
    if (this.usesDefaultSpecRecord && tasks.length > 0) {
      this.flow.specRecord = {
        requirements: tasks.map((task) => ({
          id: `R-${task.id}`,
          desc: `Exercise canonical Task ${task.id}.`,
          task_ids: [task.id],
        })),
      };
    }
    this.flow.create().addTasks(tasks).registerActive();
    this.created = true;
    return this;
  }

  /** Leave one Flow Step active for an established worker-envelope assertion. */
  atFlowStep(stepId) {
    this.#assertCreated();
    this.flow.activate(stepId);
    return this;
  }

  /** Leave the definition-next Step pending; get-next-action must claim it. */
  beforeFlowStep(stepId) {
    this.#assertCreated();
    this.flow.settleBefore(stepId);
    return this;
  }

  /** Reach a Task child through typed Task admission and typed Task start. */
  atTaskStep(taskId, stepId = "task-impl") {
    this.#assertCreated();
    const suffix = this.#taskSuffix(stepId);
    const nodeId = `${taskId}-${suffix}`;
    this.flow.settleBefore(`${taskId}-impl`);
    this.flow.activateTask(taskId, { settlePredecessors: false });
    for (const predecessor of ["impl", "review"]) {
      if (predecessor === suffix) break;
      this.flow.settle(`${taskId}-${predecessor}`);
    }
    if (suffix !== "impl") this.flow.activate(nodeId, { settlePredecessors: false });
    return this;
  }

  /** Leave the first Task child pending at the definition-owned Task frontier. */
  beforeTask(taskId) {
    this.#assertCreated();
    this.flow.settleBefore(`${taskId}-impl`);
    return this;
  }

  settleAll() {
    this.#assertCreated();
    for (const node of this.flow.leaves()) this.flow.settle(node.id);
    return this;
  }

  state() {
    this.#assertCreated();
    return this.flow.state();
  }

  #taskSuffix(stepId) {
    const value = String(stepId);
    if (["impl", "review", "gate"].includes(value)) return value;
    const suffix = FIXTURE_TASK_STEP_SUFFIXES.get(value);
    if (suffix === undefined) throw new Error(`canonical next-action Task Step is unknown: ${value}`);
    return suffix;
  }

  #assertCreated() {
    if (!this.created) throw new Error("canonical next-action scenario must be created first");
  }
}

export function setStepDone(state, ...ids) {
  for (const id of ids) {
    const step = findStepById(state.steps, id);
    if (step) step.status = "done";
  }
}

/**
 * Write a .sennel/config.json with the given language into tmp.
 */
export function setupFlowConfig(tmp, lang) {
  const managedDir = path.join(tmp, ".sennel");
  fs.mkdirSync(managedDir, { recursive: true });
  fs.writeFileSync(path.join(managedDir, "config.json"), JSON.stringify({
    lang,
    type: "base",
    docs: { languages: [lang], defaultLanguage: lang },
  }));
}
