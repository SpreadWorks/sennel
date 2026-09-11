import { projectAdvisorySummary } from "./advisory-summary.js";
/**
 * Canonical persistence boundary used by FlowManager.
 *
 * This module deliberately does not know how to read, write, or infer the
 * retired root-level flow.json layout.  It turns the small manager-facing
 * surface into operations on the one Version-1 Store, and exposes a read-only
 * command view only at the process boundary.  Persistent mutations must be
 * represented by typed Activities rather than by mutating that view.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildCurrentFlowDefinition,
  InterruptedFinalizeSyncRuntimeLogFact,
  NonGateAppendRepairEvidenceAction,
  NonGateFailCurrentAttemptAction,
  NonGateIncrementRetryAction,
  NonGateRecordNonblockingAction,
  NonGateSetStepStatusAction,
  NonGateTransitionDecision,
  RetroStaleEvidenceRecoveryDecision,
  GateTransitionDecision,
  TaskExecutionOverrunDecision,
  resolveGateTransition,
  resolveNonGateTransition,
  resolveTaskExecutionOverrun,
  scenarioValidityTransitionDefinition,
  testExecuteTransitionDefinition,
  testResultReviewTransitionDefinition,
  DraftCoverageRepairCompletionDecision,
  resolveSourceQualityIssueRecoveryPlan,
  TaskReviewStageBinding, TaskReviewStageFacts, resolveTaskReviewStageTransition,
  resolveTaskReviewStageCompletion,
  TaskNoChangeContinuationFacts, selectTaskNoChangeContinuation,
} from "../definition.js";
import { AtomicFile } from "../../lib/atomic-file.js";
import { normalizeAgentMetricDimension } from "../../lib/agent-metrics.js";
import { managedDir } from "../../lib/config.js";
import {
  FLOW_ARTIFACT_CONTRACTS,
  FlowArtifactAttemptHistory,
  FlowArtifactAttemptRecord,
  FlowArtifactUpdater,
} from "../../lib/flow-artifact-contract.js";
import { FlowSpecId } from "../../lib/flow-spec-id.js";
import { FlowVersion } from "../../lib/flow-version.js";
import {
  ActivityMetric,
  ActivityNote,
  ActivityNonBlockingRecord,
  ActivityDispatchApproval,
  CurrentAttempt,
  CurrentAttemptIdentity,
  ActivityReferences,
  CanonicalFlowArtifactBaseline,
  CanonicalFlowRuntimeArtifactRead,
  CanonicalFlowRuntimeArtifactWrite,
  FlowExecution,
  CurrentFlowSpecRecord,
  CanonicalSourceWorkerSpecCompletion,
  CanonicalSourceWorkerUpgradeResult,
  CurrentFlowNonBlockingPolicy,
  CurrentFlowState,
  CurrentFlowStateConflictError,
  CurrentFlowStateInvariantError,
  ApprovalTaskAdmission,
  FlowActivity,
  TaskNode,
} from "./current-flow-state.js";
import { CanonicalFlowRuntime } from "./canonical-flow-runtime.js";
import {
  attachedCanonicalCommandResultArtifact,
  attachCanonicalCommandResultArtifact, CanonicalCommandResultArtifact,
  attachedCanonicalCommandResultPublications,
} from "./canonical-command-result.js";
import { attachedTaskReviewPublicationBinding } from "./canonical-review-artifacts.js";
import { PlanGateRepairRecord } from "./plan-gate-repair.js";
import { TaskReviewEpisodeBinding, TaskReviewStageInputs, TaskReviewStageResult, TaskReviewSourcePublicationAdmission } from "./task-review-stage-artifacts.js";
import { TaskReviewAccounting } from "./task-review-accounting.js";
import { CanonicalTaskContext } from "./task-canonical-context.js";
import { TaskStepIdentity } from "./task-step-identity.js";
import { TaskReviewReconciliationRecord } from "./task-review-reconciliation-record.js";
import { TaskReviewReconciliationAdmission } from "./task-review-reconciliation.js";
import { readCurrentGateTransitionFacts } from "./gate-transition-facts.js";
import { readTaskExecutionOverrunFacts, TaskExecutionOverrunAdmission } from "./task-execution-overrun.js";
import { CanonicalImplementationRepairRecord } from "./review-recurrence.js";
import {
  buildDeferredSemanticFindingsPublication,
  DeferredFlowFindingsPublication,
} from "./flow-findings.js";
import { IssueLogDocument } from "./issue-log-store.js";
import { finalizationOutboxIdentity } from "./flow-outbox.js";
import { FinalizeSyncInterruptedError } from "./finalize-sync-diagnostics.js";
import { CanonicalScenarioValidityRepairEvidence } from "./scenario-validity-repair-evidence.js";
import { CanonicalTestSourceRevision } from "./canonical-test-artifacts.js";
import { buildRepairFingerprint } from "./repair-fingerprint.js";
import { sameNonGateTransitionDecision } from "./non-gate-transition-application.js";
import { readTestChainTransitionFactsFromSnapshot, TestChainTransitionSnapshot } from "./test-chain-transition-facts.js";
import { CanonicalOverviewUpdate } from "./canonical-overview-update.js";
import { CanonicalSpecApproval } from "./canonical-spec-approval.js";
import { CanonicalFileMapUpdate, CanonicalSourceRequirementAuthority } from "./canonical-file-map.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { CanonicalRequirementDefinitions } from "./canonical-requirement-definitions.js";
import { nonblockingRouteFor } from "./nonblocking-route.js";
import { DraftLifecycle } from "./draft-lifecycle.js";
import { DRAFT_ARTIFACT_WRITER_STEPS } from "./draft-artifact-promotion.js";
import {
  createDraftCompletionReceipt,
  DraftCompletionAbsentLineage,
  DraftCompletionCatalogBinding,
  DraftCompletionDecisionEvidence,
  DraftCompletionLineage,
  DraftCompletionRevision,
  draftCompletionDocumentDigest,
  isDraftCompletionConnector,
  StepConnectionReceipt,
} from "./draft-completion-connector.js";
import { ExternalBlockedOutcome, StepAttempt } from "./step-outcome.js";
import { CanonicalSpecReview } from "./spec-review-artifacts.js";
import { TaskCollection } from "../../spec/lib/render-contract.js";
import { SourceMutationPublicationAdmission } from "./source-mutation-publication-admission.js";
import {
  CanonicalSourceHandoffCheckpoint,
  SourceHandoffEvent,
  SourceHandoffSettlement,
  SourceMutationManifest,
  SourceWorkerEffect,
  SourceWorkerCanonicalObservationAdvance,
  SourceWorkerHandoffIdentity,
} from "./worker-artifact-handoff.js";
import {
  assertSourceHandoffEventTransition,
  readSourceHandoffAuthorityFromView,
  readSettledSourceHandoffAuthoritiesFromView,
  SourceHandoffPersistenceAdmission,
  sourceHandoffArtifactWrites,
} from "./source-handoff-persistence.js";
import { captureCurrentTaskSource, TaskExecutionBudget, TaskMutationLineage, TaskMutationLineageSet, readTaskMutationLineagesFromCatalog } from "./task-mutation-lineage.js";
import { DefinitionLifecycleTransition } from "./step-transition-policy.js";
import {
  captureRetryRecoveryBaseline,
  containsRetryRecoveryArtifactWrite,
  retryEvidenceRouteForNode,
  RetryRecoveryArtifactPublication,
  RetryRecoveryReceipt,
} from "./retry-recovery.js";
import {
  TaskReviewUnsealedCheckpoint,
  TaskReviewRecoveryAuthorization,
  taskReviewCheckpointArtifact,
} from "./task-review-recovery-checkpoint.js";
import { TaskReviewAbortedWorkUnit, TaskReviewAbortedWorkUnitRetryAdmission } from "./task-review-aborted-work-unit.js";
import { validateUpgradeResultArtifact } from "./upgrade-result-artifact.js";
import {
  taskGateSettlementIssueLogActivityId,
  taskGateSettlementIssueLogId,
  taskGateSettlementMetricActivityId,
} from "./canonical-gate-artifacts.js";
import { TestReviewRepairWorkerTimeout } from "./test-review-repair-timeout.js";
import { TaskGateClassificationRecoveryIdentity } from "./task-gate-classification-recovery.js";
import {
  MissingProducerArtifactRecoveryAdmission,
  MissingProducerArtifactRoute,
  ProducerArtifactPublicationAdmission,
  ProducerArtifactReadinessAdmission,
  StepConnectionAdmission,
  AcceptanceDecisionNoOpAdmission,
  attemptHistoryTargetForNode,
  producerArtifactReadinessesForConsumer,
  producerArtifactReadinessesForProducer,
} from "./producer-artifact-readiness.js";

const EXECUTION_MODES = new Set(["direct", "branch", "worktree"]);
const TERMINAL_STATUSES = new Set(["done", "skipped"]);
const TASK_RUNTIME_STEP_ALIASES = new Set(["task-impl", "task-review", "task-triage", "task-repair", "task-gate"]);
const RAW_ACTIVITY_MUTATION_OPTION_FIELDS = Object.freeze([
  "taskSpec",
  "specRecord",
  "artifactWrites",
  "artifactRemovals",
  "artifactBaselines",
  "testSourceBaseline",
  "sourceWorkerUpgrade",
  "admission",
]);

/**
 * The public manager never accepts a caller-authored Activity as new state.
 * Typed Store methods derive the Activity and its admission together.  This
 * error keeps the remaining raw method intentionally narrow: it is only a
 * crash-replay bridge for an Activity that is already in the immutable ledger.
 */
export class CanonicalRawActivityReplayOnlyError extends CurrentFlowStateInvariantError {
  constructor(message = "canonical raw Activity mutation is forbidden; use a typed FlowManager operation") {
    super(message);
    this.name = "CanonicalRawActivityReplayOnlyError";
    this.code = "CANONICAL_RAW_ACTIVITY_MUTATION_FORBIDDEN";
  }
}

function rawActivityReplayMatches(existing, proposed) {
  return JSON.stringify(existing.toJSON()) === JSON.stringify(proposed.toJSON());
}

function rawActivityHasMutationOptions(options) {
  return RAW_ACTIVITY_MUTATION_OPTION_FIELDS.some((field) => Object.hasOwn(options, field));
}

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CurrentFlowStateInvariantError(`${field} must be a non-empty string`);
  }
  return value;
}

function canonicalTaskAddition(task) {
  if (task === null || typeof task !== "object" || Array.isArray(task)) {
    throw new CurrentFlowStateInvariantError("canonical Task must be an object");
  }
  const id = requiredText(task.id, "canonical Task.id");
  const key = requiredText(task.key ?? task.id, "canonical Task.key");
  const taskSpec = structuredClone(task);
  delete taskSpec.key;
  return Object.freeze({ id, key, taskSpec: { ...taskSpec, id } });
}

function canonicalSpecId(value) {
  return FlowSpecId.from(requiredText(value, "specId")).toString();
}

function catalogRelativePath(value) {
  const relativePath = requiredText(value, "canonical catalog relativePath").replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new CurrentFlowStateInvariantError("canonical catalog relativePath must be a normalized relative path");
  }
  return relativePath;
}

function executionMode(value) {
  if (!EXECUTION_MODES.has(value)) {
    throw new CurrentFlowStateInvariantError(`execution.mode is invalid: ${value}`);
  }
  return value;
}

function activityId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function stableActivityId(prefix, facts) {
  const digest = crypto.createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  return `${prefix}-${digest}`;
}

function timestampAfter(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new CurrentFlowStateInvariantError("recovery timestamp source is invalid");
  return new Date(timestamp + 1).toISOString();
}

function testChainPlanDigest(decision) {
  const plan = JSON.stringify(decision.plan.toJSON());
  return crypto.createHash("sha256").update(plan).digest("hex");
}

function testChainPlanActivityId(decision) {
  return `test-chain-plan-${testChainPlanDigest(decision)}`;
}

function testChainPlanTiming(state) {
  const timestamp = state.attempt?.startedAt;
  if (typeof timestamp !== "string" || timestamp === "") {
    throw new CurrentFlowStateInvariantError("test-chain plan settlement requires the current Attempt timestamp");
  }
  return Object.freeze({ startedAt: timestamp, finishedAt: timestamp, durationMs: 0 });
}

function testChainPlanResult(state, { outcome, summary }) {
  return Object.freeze({
    outcome,
    summary,
    confirmedAt: testChainPlanTiming(state).finishedAt,
    artifactRefs: [],
  });
}

function testChainReplacementAttempt(state, nodeId, decision) {
  const node = state.findNode(nodeId);
  if (node === null || node.steps.length !== 0) {
    throw new CurrentFlowStateInvariantError("test-chain plan replacement target must be a definition leaf");
  }
  const requiredResources = state.definition.contractForNode(node).resourceContract.required;
  return new CurrentAttempt({
    id: `attempt-${nodeId}-test-chain-${testChainPlanDigest(decision)}`,
    nodeId,
    sequence: node.attemptSequence + 1,
    startedAt: testChainPlanTiming(state).startedAt,
    consumption: { semantic: 0, tooling: 0 },
    failure: null,
    blocker: null,
    incomplete: [],
    operationClaims: requiredResources.length === 0
      ? []
      : [{ operation: "resolve-command-context", resources: requiredResources }],
  }).toJSON();
}

function hasExactTestChainStatus(actions, { stepId, status }) {
  return actions.length === 1
    && actions[0].update.stepId === stepId
    && actions[0].update.status === status;
}

/**
 * Rechecks the Definition-selected action against the authoritative catalog
 * while the Version Store holds its publication lock. This is deliberately a
 * verifier, never another route selector.
 */
class TestChainPlanAdmission {
  constructor(decision) {
    if (!(decision instanceof NonGateTransitionDecision)) {
      throw new CurrentFlowStateInvariantError("test-chain plan admission requires a typed Definition decision");
    }
    this.decision = decision;
    this.facts = decision.facts;
    Object.freeze(this);
  }

  assert(view) {
    const { state, catalog, activities } = view;
    const descriptors = Array.isArray(catalog) ? catalog : catalog.artifacts;
    if (state.runId !== this.facts.runId
      || state.specId !== this.facts.specId
      || state.current?.at(-1) !== this.facts.stepId
      || state.attempt?.id !== this.facts.currentAttempt.id
      || state.attempt?.sequence !== this.facts.currentAttempt.sequence) {
      throw new CurrentFlowStateConflictError("Definition plan no longer addresses the current test-chain Attempt");
    }
    for (const publication of [this.facts.catalogPublication, this.facts.sourcePublication]) {
      const descriptor = descriptors.find((entry) => entry.relativePath === publication.artifactId) ?? null;
      const activity = activities.find((entry) => entry.id === publication.producerActivityId) ?? null;
      if (descriptor === null || descriptor.hash !== publication.fingerprint
        || descriptor.activityId !== publication.producerActivityId
        || activity === null || activity.nodeId !== publication.stepId
        || activity.attemptId !== publication.attempt.id
        || activity.sequence !== publication.attempt.sequence) {
        throw new CurrentFlowStateConflictError("Definition plan catalog publication changed before settlement");
      }
    }
    const definition = TEST_CHAIN_TRANSITION_DEFINITIONS[this.facts.stepId] ?? null;
    if (definition === null) {
      throw new CurrentFlowStateInvariantError("test-chain plan admission has no Definition");
    }
    let current;
    try {
      const facts = readTestChainTransitionFactsFromSnapshot({
        snapshot: new TestChainTransitionSnapshot(view),
        readCatalogedArtifact: (descriptor) => view.readCatalogedArtifact(descriptor),
        readRuntimeArtifact: (input) => view.readRuntimeArtifact(input),
      });
      current = resolveNonGateTransition(facts, definition);
    } catch (error) {
      if (error instanceof CurrentFlowStateConflictError) throw error;
      throw new CurrentFlowStateConflictError(`Definition plan facts changed before settlement: ${error.message}`);
    }
    if (!sameNonGateTransitionDecision(this.decision, current)) {
      throw new CurrentFlowStateConflictError("Definition plan changed before test-chain settlement");
    }
  }
}

/** Reject dispatcher fallback if its Task Gate producer has published a result. */
class TaskGateFallbackFailureAdmission {
  constructor({ specId, runId, attempt, nodeId, taskId } = {}) {
    this.specId = canonicalSpecId(specId);
    this.runId = requiredText(runId, "Task Gate fallback runId");
    this.attempt = CurrentAttemptIdentity.from(attempt);
    this.nodeId = requiredText(nodeId, "Task Gate fallback nodeId");
    this.taskId = requiredText(taskId, "Task Gate fallback taskId");
    if (this.nodeId !== `${this.taskId}-gate`) {
      throw new CurrentFlowStateInvariantError("Task Gate fallback node does not match its Task");
    }
    Object.freeze(this);
  }

  assert(view) {
    const { state, catalog } = view;
    const descriptors = Array.isArray(catalog) ? catalog : catalog.artifacts;
    if (state.specId !== this.specId || state.runId !== this.runId
      || state.current?.at(-1) !== this.nodeId || !this.attempt.matches(state)) {
      throw new CurrentFlowStateConflictError("dispatcher Task Gate fallback Attempt changed before failure recording");
    }
    const resultPath = FLOW_ARTIFACT_CONTRACTS.resolve("task.gate", { taskId: this.taskId }).relativePath;
    const descriptor = descriptors.find((candidate) => candidate.relativePath === resultPath) ?? null;
    if (descriptor === null) return;
    const bytes = view.readCatalogedArtifact(descriptor);
    const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
      logicalKey: "task.gate",
      bytes,
    });
    if (history.current.attempt >= this.attempt.sequence) {
      throw new CurrentFlowStateConflictError("dispatcher Task Gate fallback cannot overwrite a published result");
    }
  }
}

/** Re-admits one Task Gate metric against the exact published producer view. */
export class TaskGateSettlementAdmission {
  constructor(decision, effect, issueEntry = null) {
    if (!(decision instanceof GateTransitionDecision) || decision.facts.scope !== "task") {
      throw new CurrentFlowStateInvariantError("Task Gate settlement admission requires a Task Gate decision");
    }
    if (typeof decision.facts.snapshotRevision !== "string" || decision.facts.snapshotRevision === "") {
      throw new CurrentFlowStateInvariantError("Task Gate settlement admission requires a canonical snapshot revision");
    }
    this.decision = decision;
    this.facts = decision.facts;
    this.effect = requiredText(effect, "Task Gate settlement effect");
    if (!["classification-recovery", "classification", "metric", "issue-log", "terminal", "continuation"].includes(this.effect)) {
      throw new CurrentFlowStateInvariantError("Task Gate settlement effect is invalid");
    }
    this.issueEntry = issueEntry === null ? null : structuredClone(issueEntry);
    if (this.effect === "issue-log" && this.issueEntry === null) {
      throw new CurrentFlowStateInvariantError("Task Gate issue-log settlement requires its canonical entry");
    }
    if (this.effect !== "issue-log" && this.issueEntry !== null) {
      throw new CurrentFlowStateInvariantError("only Task Gate issue-log settlement accepts an issue entry");
    }
    Object.freeze(this);
  }

  assert(view) {
    const { state, catalog, activities } = view;
    if (view.revision !== this.facts.snapshotRevision) {
      throw new CurrentFlowStateConflictError("Task Gate settlement snapshot changed before effect recording");
    }
    const descriptors = Array.isArray(catalog) ? catalog : catalog.artifacts;
    if (state.runId !== this.facts.target.runId || state.specId !== this.facts.target.specId
      || state.current?.at(-1) !== this.facts.target.stepId
      || state.attempt?.id !== this.facts.currentAttempt.id
      || state.attempt?.sequence !== this.facts.currentAttempt.sequence) {
      throw new CurrentFlowStateConflictError("Task Gate settlement Attempt changed before effect recording");
    }
    const publication = this.facts.catalogPublication;
    const descriptor = descriptors.find((candidate) => candidate.relativePath === publication.artifactId) ?? null;
    const activity = activities.find((candidate) => candidate.id === publication.producerActivityId) ?? null;
    if (descriptor === null || descriptor.hash !== publication.fingerprint
      || descriptor.activityId !== publication.producerActivityId
      || activity === null || activity.nodeId !== this.facts.target.stepId
      || activity.attemptId !== this.facts.currentAttempt.id
      || activity.sequence !== this.facts.currentAttempt.sequence) {
      throw new CurrentFlowStateConflictError("Task Gate settlement publication changed before effect recording");
    }
    const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
      logicalKey: "task.gate",
      bytes: view.readCatalogedArtifact(descriptor),
    });
    if (history.current.attempt !== this.facts.currentAttempt.sequence
      || !resolveGateTransition(this.facts).plan.action.identity.matches(this.decision.plan.action.identity)) {
      throw new CurrentFlowStateConflictError("Task Gate settlement decision changed before effect recording");
    }
    const progress = this.facts.taskSettlementProgress;
    const metric = this.decision.plan.retryMetric;
    const classificationComplete = this.facts.result !== "fail" || progress.classificationRecorded;
    const metricComplete = metric === null || progress.hasMetric(metric);
    const expected = this.effect === "classification-recovery"
      ? progress.classificationRecovery.required
        && !progress.classificationRecorded
        && progress.metricOperations.length === 0 && !progress.issueLogRecorded
      : this.effect === "classification"
      ? !progress.classificationRecovery.required
        && this.facts.result === "fail" && !progress.classificationRecorded
        && progress.metricOperations.length === 0 && !progress.issueLogRecorded
      : this.effect === "metric"
        ? classificationComplete && metric !== null && !progress.hasMetric(metric)
          && progress.metricOperations.length === 0 && !progress.issueLogRecorded
        : this.effect === "issue-log"
          ? classificationComplete && metricComplete && !progress.issueLogRecorded
          : classificationComplete && metricComplete && progress.issueLogRecorded
            && (this.effect === "continuation" || (
              !progress.terminalLifecycleRecorded
              && this.decision.plan.updates.some((update) => update.status === "done")
            ));
    if (!expected) throw new CurrentFlowStateConflictError("Task Gate settlement effect is already complete or does not match its decision");
    if (this.effect !== "issue-log") return;
    const issueLogId = taskGateSettlementIssueLogId({
      runId: this.facts.target.runId,
      nodeId: this.facts.target.stepId,
      attempt: this.facts.currentAttempt,
      publicationActivityId: this.facts.catalogPublication.producerActivityId,
      catalogFingerprint: this.facts.catalogPublication.fingerprint,
    });
    const receipt = this.issueEntry.gateReceipt;
    if (this.issueEntry.issueLogId !== issueLogId
      || this.issueEntry.taskId !== this.facts.target.taskId
      || this.issueEntry.step !== this.facts.target.stepId
      || receipt?.catalogFingerprint !== this.facts.catalogPublication.fingerprint
      || receipt?.attempt?.id !== this.facts.currentAttempt.id
      || receipt?.attempt?.sequence !== this.facts.currentAttempt.sequence
      || JSON.stringify(receipt?.lineage) !== JSON.stringify(this.facts.lineage.toJSON())) {
      throw new CurrentFlowStateConflictError("Task Gate issue-log entry is not bound to the canonical result");
    }
  }

  issueLogActivityId() {
    if (this.effect !== "issue-log") return null;
    return taskGateSettlementIssueLogActivityId({ issueLogId: this.issueEntry.issueLogId });
  }
}

class CombinedAdmission {
  constructor(...admissions) { this.admissions = admissions.filter(Boolean); Object.freeze(this.admissions); Object.freeze(this); }
  assert(view) { for (const admission of this.admissions) admission.assert(view); }
}

function nextTaskExecutionBudget({ state, taskId, lineages }) {
  const implementations = lineages.filter((lineage) => lineage.role === "implementation");
  const task = state.findNode(taskId);
  const review = task?.steps?.find((step) => step.id === `${taskId}-review`);
  const gate = task?.steps?.find((step) => step.id === `${taskId}-gate`);
  return new TaskExecutionBudget({
    round: implementations.length + 1,
    reviewAttemptSequenceAtStart: review?.attemptSequence,
    gateAttemptSequenceAtStart: gate?.attemptSequence,
  });
}

/** Reject a legacy-overrun Task implementation before publishing handoff protocol state. */
class TaskSourceHandoffPreparationAdmission {
  constructor(identity) {
    if (!(identity instanceof SourceWorkerHandoffIdentity) || identity.stepId !== "task-impl" || identity.taskId === null) {
      throw new CurrentFlowStateInvariantError("Task source handoff preparation requires its typed implementation identity");
    }
    this.identity = identity;
    Object.freeze(this);
  }
  assert(view) {
    const lineages = readTaskMutationLineagesFromCatalog({
      state: view.state,
      catalog: view.catalog,
      activities: view.activities,
      taskId: this.identity.taskId,
      readCatalogedArtifact: (descriptor) => view.readCatalogedArtifact(descriptor),
    });
    nextTaskExecutionBudget({ state: view.state, taskId: this.identity.taskId, lineages });
  }
}

const TEST_CHAIN_TRANSITION_DEFINITIONS = Object.freeze({
  "scenario-validity": scenarioValidityTransitionDefinition,
  "test-execute": testExecuteTransitionDefinition,
  "test-result-review": testResultReviewTransitionDefinition,
});
function canonicalOutboxInput(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CurrentFlowStateInvariantError("canonical outbox input must be an object");
  }
  return Object.freeze({
    id: requiredText(value.id, "canonical outbox id"),
    operation: requiredText(value.operation, "canonical outbox operation"),
  });
}

function canonicalIssueLogEntry(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CurrentFlowStateInvariantError("canonical issue-log entry must be an object");
  }
  return structuredClone(value);
}

function canonicalOutboxActivity({ outbox, attempt, result = null, failure = null, failureCode = null, recovery = null, exactRecoveryReceipt = null } = {}) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new CurrentFlowStateInvariantError("canonical outbox attempt must be a positive integer");
  }
  return Object.freeze({
    ...canonicalOutboxInput(outbox),
    attempt,
    result,
    failure,
    failureCode,
    recovery,
    exactRecoveryReceipt,
  });
}

function projectNode(node) {
  const children = node.steps.map((step) => projectNode(step));
  return {
    id: node.id,
    key: node.key,
    status: node.status,
    result: node.result?.toJSON() ?? null,
    attemptSequence: node.attemptSequence,
    // Command consumers use the established tree convention: a missing
    // `children` property is a leaf.  An empty array would be interpreted as
    // another branch level and corrupt depth-first lifecycle resolution.
    ...(children.length > 0 && { children }),
  };
}

function taskNode(state, taskId) {
  const node = state.findNode(taskId);
  return node instanceof TaskNode ? node : null;
}

function projectTask(state, entry) {
  const node = taskNode(state, entry.id);
  if (node === null) {
    throw new CurrentFlowStateInvariantError(`canonical spec Task is absent from Flow state: ${entry.id}`);
  }
  return {
    ...structuredClone(entry.document),
    id: entry.id,
    key: entry.key,
    status: node.status,
    steps: node.steps.map((step) => projectNode(step)),
  };
}

function currentTaskId(state) {
  if (state.current === null) return null;
  return state.current
    .map((nodeId) => state.findNode(nodeId))
    .find((node) => node instanceof TaskNode)?.id ?? null;
}

function taskIdForNode(state, nodeId) {
  const nodePath = state.definition.pathFor(state.root, nodeId);
  if (nodePath === null) return null;
  return nodePath
    .map((id) => state.findNode(id))
    .find((node) => node instanceof TaskNode)?.id ?? null;
}

function runtimeMetadataNode(state, stepId, location) {
  const requested = requiredText(stepId, "step runtime metadata stepId");
  const explicit = state.findNode(requested);
  if (explicit !== null) {
    const taskId = taskIdForNode(state, explicit.id);
    if (taskId !== null) location.taskArtifactLocation(taskId);
    return explicit;
  }
  if (!TASK_RUNTIME_STEP_ALIASES.has(requested)) {
    throw new CurrentFlowStateInvariantError(`canonical runtime Step is absent: ${requested}`);
  }
  const activeId = state.current?.at(-1) ?? null;
  const active = activeId === null ? null : state.findNode(activeId);
  const taskId = active === null ? null : taskIdForNode(state, active.id);
  if (active === null || taskId === null || active.id !== `${taskId}-${requested.slice("task-".length)}`) {
    throw new CurrentFlowStateInvariantError(`canonical runtime Task Step is not active: ${requested}`);
  }
  location.taskArtifactLocation(taskId);
  return active;
}

function observationTimestamp(activity) {
  return activity.timing?.finishedAt ?? null;
}

function projectObservations(state, activities) {
  if (!Array.isArray(activities)) {
    throw new CurrentFlowStateInvariantError("canonical runtime observations require an Activity list");
  }
  const metrics = [];
  const notes = [];
  for (const activity of activities) {
    const taskId = taskIdForNode(state, activity.nodeId);
    const timestamp = observationTimestamp(activity);
    if (activity.metric !== null) metrics.push(activity.metric.toMetricEntry({ taskId, timestamp }));
    if (activity.note !== null) notes.push(activity.note.toNoteEntry({ taskId, timestamp }));
  }
  return Object.freeze({ metrics: Object.freeze(metrics), notes: Object.freeze(notes) });
}

/** Dispatch code reads this established convenience field, but V1 derives it
 * from typed approval Activities instead of storing a mutable receipt array. */
function projectDispatchApprovals(activities) {
  if (!Array.isArray(activities)) {
    throw new CurrentFlowStateInvariantError("canonical runtime dispatch approvals require an Activity list");
  }
  const receipts = new Map();
  for (const activity of activities) {
    const approval = activity.transition.approval;
    if (approval === null) continue;
    const receipt = approval.toJSON();
    const previous = receipts.get(receipt.actionDigest);
    if (previous && JSON.stringify(previous) !== JSON.stringify(receipt)) {
      throw new CurrentFlowStateInvariantError("canonical Flow has conflicting dispatch approval receipts");
    }
    receipts.set(receipt.actionDigest, receipt);
  }
  return Object.freeze([...receipts.values()]);
}

function projectedState(state, specRecord, activities = []) {
  if (!(state instanceof CurrentFlowState)) {
    throw new CurrentFlowStateInvariantError("canonical runtime view requires CurrentFlowState");
  }
  if (!(specRecord instanceof CurrentFlowSpecRecord)) {
    throw new CurrentFlowStateInvariantError("canonical runtime view requires CurrentFlowSpecRecord");
  }
  const mode = state.execution.mode;
  const observations = projectObservations(state, activities);
  const flowDispatchApprovals = projectDispatchApprovals(activities);
  const advisorySummary = projectAdvisorySummary(activities);
  return {
    schemaRevision: state.schemaRevision,
    flowId: state.flowId,
    flowVersionId: state.flowVersionId,
    runId: state.runId,
    specId: state.specId,
    request: state.request,
    version: state.version,
    lifecycle: state.lifecycle.state,
    execution: state.execution.toJSON(),
    policy: state.policy.toJSON(),
    // Kept only as a process-boundary convenience for the established agent
    // input assembler.  Persistence remains the nested policy record above.
    autoApprove: state.policy.autoApprove,
    issue: state.issue,
    baseBranch: state.execution.baseBranch,
    featureBranch: state.execution.featureBranch,
    // These are command-view conveniences, never a second persisted schema.
    worktree: mode === "worktree",
    currentTaskId: currentTaskId(state),
    currentNodeId: state.current?.at(-1) ?? null,
    // Compatibility views for existing command input/report assemblers.  They
    // are derived from activities on every read and are never written back to
    // flow.json.
    metrics: observations.metrics,
    notes: observations.notes,
    // Read-model projection from immutable Activity facts. This is never a
    // flow.json field and is deliberately not accepted by state constructors.
    ...(advisorySummary.length > 0 && { advisorySummary: Object.freeze(advisorySummary) }),
    // Compatibility view for the dispatcher. This array is Activity-derived
    // and is intentionally absent from the exact flow.json schema. Preserve
    // the historical omission until an explicit approval actually exists.
    ...(flowDispatchApprovals.length > 0 && { flowDispatchApprovals }),
    steps: state.root.steps.map((step) => projectNode(step)),
    // A freshly written Spec may declare Tasks before the explicit
    // `add_task` Activities materialize their lifecycle nodes.  The Spec is
    // authoritative for their instructions; this runtime view exposes only
    // Task nodes that the Activity ledger has actually admitted.
    tasks: specRecord.tasks
      .filter((entry) => taskNode(state, entry.id) !== null)
      .map((entry) => projectTask(state, entry)),
  };
}

function resultFor(status, nodeId) {
  return {
    outcome: status === "done" ? "passed" : "skipped",
    summary: `canonical runtime transition for ${nodeId}`,
    confirmedAt: new Date().toISOString(),
    artifactRefs: [],
  };
}

/**
 * Project the one Gate failure outcome that the process boundary must expose.
 * The canonical failure is already persisted by failCurrentAttempt; this
 * record is only the typed command-result view consumed by the dispatcher.
 */
function gateExternalBlockedStepAttempt(state, decision) {
  if (decision.disposition.operation !== "external-blocked") return null;
  const nodeId = state.current?.at(-1);
  const attempt = state.attempt;
  if (nodeId === undefined || attempt === null) return null;
  const task = state.findNode(state.current.at(-2));
  const failureCode = decision.facts.failure?.code || "GATE_EXTERNAL_BLOCKED";
  return new StepAttempt({
    runId: state.runId,
    taskId: task instanceof TaskNode ? task.id : null,
    stepId: nodeId,
    attempt: attempt.sequence,
    outcome: new ExternalBlockedOutcome({
      reason: decision.disposition.reason || failureCode,
      resumeInstruction: "Resolve the Gate provider failure and publish a fresh current Gate observation.",
      failureCode,
      retryable: false,
    }),
  });
}

function commandResultPayload(value, nodeId, artifactLogicalKey) {
  const fallback = Object.freeze({ nodeId, outcome: "completed" });
  if (value == null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({ nodeId, outcome: "completed", value: String(value) });
  }
  // Flow command envelopes are JSON values.  A clone through JSON prevents a
  // command-local class instance, function, or undefined field from leaking
  // into the permanent artifact contract.
  let result;
  try {
    result = JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new CurrentFlowStateInvariantError(`canonical command result must be JSON-serializable: ${error.message}`);
  }
  const attached = attachedCanonicalCommandResultArtifact(value);
  if (attached !== null && attached.logicalKey !== artifactLogicalKey) {
    throw new CurrentFlowStateInvariantError(
      `canonical command result artifact does not belong to ${artifactLogicalKey}: ${attached.logicalKey}`,
    );
  }
  return Object.freeze({
    nodeId,
    outcome: "completed",
    result,
    ...(attached !== null && { artifact: attached.toJSON() }),
  });
}

function emptyAttempt(state, nodeId) {
  const node = state.findNode(nodeId);
  if (node === null || node.steps.length !== 0) {
    throw new CurrentFlowStateInvariantError(`Attempt target must be a leaf: ${nodeId}`);
  }
  const requiredResources = state.definition.contractForNode(node).resourceContract.required;
  if (requiredResources.length > 0) {
    throw new CurrentFlowStateInvariantError(
      `canonical runtime requires a typed Attempt with resource claims for ${nodeId}`,
    );
  }
  return new CurrentAttempt({
    id: activityId(`attempt-${nodeId}`),
    nodeId,
    sequence: node.attemptSequence + 1,
    startedAt: new Date().toISOString(),
    consumption: { semantic: 0, tooling: 0 },
    failure: null,
    blocker: null,
    incomplete: [],
    operationClaims: [],
  }).toJSON();
}

/**
 * Starting a worker is itself the command-context resolution operation.  The
 * Attempt records that operation once, with the definition-owned resource
 * kinds it resolved; it never copies those requirements into flow.json.
 */
function commandContextAttempt(state, nodeId) {
  const node = state.findNode(nodeId);
  if (node === null || node.steps.length !== 0) {
    throw new CurrentFlowStateInvariantError(`Attempt target must be a leaf: ${nodeId}`);
  }
  const requiredResources = state.definition.contractForNode(node).resourceContract.required;
  return new CurrentAttempt({
    id: activityId(`attempt-${nodeId}`),
    nodeId,
    sequence: node.attemptSequence + 1,
    startedAt: new Date().toISOString(),
    consumption: { semantic: 0, tooling: 0 },
    failure: null,
    blocker: null,
    incomplete: [],
    operationClaims: requiredResources.length === 0
      ? []
      : [{ operation: "resolve-command-context", resources: requiredResources }],
  }).toJSON();
}

function draftCompletionLineageBinding({ catalog, activities, logicalKey, expectedDigest = null, expectedByteLength = null } = {}) {
  const descriptor = catalog.artifacts.find((entry) => entry.logicalKey === logicalKey) ?? null;
  if (descriptor === null) return new DraftCompletionAbsentLineage({ logicalKey, reason: "not-published" });
  if (expectedDigest !== null && (descriptor.hash !== expectedDigest || descriptor.size !== expectedByteLength)) {
    throw new CurrentFlowStateInvariantError(`draft completion lineage is stale for ${logicalKey}`);
  }
  const activity = activities.find((entry) => entry.id === descriptor.activityId) ?? null;
  if (activity?.attemptId === null || activity?.sequence === null) {
    throw new CurrentFlowStateInvariantError(`draft completion lineage has no producing Attempt for ${logicalKey}`);
  }
  return new DraftCompletionCatalogBinding({
    logicalKey,
    digest: descriptor.hash,
    byteLength: descriptor.size,
    activityId: descriptor.activityId,
    attempt: { id: activity.attemptId, sequence: activity.sequence },
    revision: logicalKey === "draft" ? { digest: descriptor.hash, byteLength: descriptor.size } : null,
  });
}

function draftCompletionOutputBinding({ logicalKey, bytes, activityId: producingActivityId, attempt } = {}) {
  return new DraftCompletionCatalogBinding({
    logicalKey,
    digest: crypto.createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    activityId: producingActivityId,
    attempt,
    revision: null,
  });
}

function gateRetryAttempt(state) {
  const nodeId = state.current?.at(-1);
  const parent = state.current === null ? null : state.findNode(state.current.at(-2));
  const taskGate = parent instanceof TaskNode && nodeId === `${parent.id}-gate`;
  if ((!new Set(["draft-gate", "spec-gate", "impl-gate"]).has(nodeId) && !taskGate) || state.attempt === null) {
    throw new CurrentFlowStateInvariantError("definition-owned Gate retry requires the active Gate Attempt");
  }
  const node = state.findNode(nodeId);
  const requiredResources = state.definition.contractForNode(node).resourceContract.required;
  return new CurrentAttempt({
    id: activityId(`attempt-${nodeId}-gate-retry`), nodeId,
    sequence: node.attemptSequence + 1, startedAt: new Date().toISOString(),
    consumption: { semantic: state.attempt.consumption.semantic + 1, tooling: state.attempt.consumption.tooling },
    failure: null, blocker: null, incomplete: [],
    operationClaims: requiredResources.length === 0 ? [] : [{ operation: "resolve-command-context", resources: requiredResources }],
  }).toJSON();
}

function leafNodes(node, values = []) {
  if (node.steps.length === 0) {
    values.push(node);
    return values;
  }
  for (const child of node.steps) leafNodes(child, values);
  return values;
}

function retryAttempt(state) {
  if (state.attempt === null || state.attempt.failure === null) {
    throw new CurrentFlowStateInvariantError("canonical retry requires a failed active Attempt");
  }
  const previous = state.attempt;
  const kind = previous.failure.retryKind;
  if (kind === null) {
    throw new CurrentFlowStateInvariantError("canonical retry requires a retryable Attempt failure kind");
  }
  return new CurrentAttempt({
    id: activityId(`attempt-${previous.nodeId}`),
    nodeId: previous.nodeId,
    sequence: previous.sequence + 1,
    startedAt: new Date().toISOString(),
    consumption: {
      semantic: previous.consumption.semantic + (kind === "semantic" ? 1 : 0),
      tooling: previous.consumption.tooling + (kind === "tooling" ? 1 : 0),
    },
    failure: null,
    blocker: null,
    incomplete: [],
    operationClaims: previous.operationClaims.map((claim) => claim.toJSON()),
  }).toJSON();
}

function exhaustedRecoveryAttempt(state, id = null) {
  if (state.attempt === null || state.attempt.failure === null) {
    throw new CurrentFlowStateInvariantError("canonical exhausted recovery requires a failed active Attempt");
  }
  const contract = state.definition.contractForNode(state.findNode(state.current.at(-1)));
  return new CurrentAttempt({
    id: id ?? activityId(`attempt-${state.attempt.nodeId}`),
    nodeId: state.attempt.nodeId,
    sequence: state.attempt.sequence + 1,
    startedAt: new Date().toISOString(),
    consumption: {
      semantic: state.attempt.consumption.semantic,
      tooling: contract.toolingRetryLimit ?? 0,
    },
    failure: null,
    blocker: null,
    incomplete: [],
    operationClaims: state.attempt.operationClaims.map((claim) => claim.toJSON()),
  }).toJSON();
}

function nullableString(value, field) {
  if (value == null) return null;
  return requiredText(value, field);
}

function nullableNonNegativeInteger(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CurrentFlowStateInvariantError(`${field} must be a non-negative safe integer or null`);
  }
  return value;
}

function nullableCost(value) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CurrentFlowStateInvariantError("metric.cost must be a non-negative number or null");
  }
  return value;
}

/** Normalizes public metric payloads into the typed Activity ledger value. */
function canonicalMetric(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CurrentFlowStateInvariantError("canonical metric payload must be an object");
  }
  const tokens = payload.tokens == null
    ? null
    : {
        input: nullableNonNegativeInteger(payload.tokens.input ?? 0, "metric.tokens.input"),
        output: nullableNonNegativeInteger(payload.tokens.output ?? 0, "metric.tokens.output"),
        cacheRead: nullableNonNegativeInteger(payload.tokens.cacheRead ?? 0, "metric.tokens.cacheRead"),
        cacheCreation: nullableNonNegativeInteger(payload.tokens.cacheCreation ?? 0, "metric.tokens.cacheCreation"),
      };
  const counter = nullableString(payload.counter, "metric.counter");
  return new ActivityMetric({
    phase: requiredText(payload.phase, "metric.phase"),
    counter,
    delta: counter === null ? null : nullableNonNegativeInteger(payload.delta ?? 1, "metric.delta"),
    reset: payload.reset === true,
    kind: nullableString(payload.kind, "metric.kind"),
    provider: nullableString(payload.provider, "metric.provider"),
    profileKey: nullableString(payload.profileKey, "metric.profileKey"),
    callCount: nullableNonNegativeInteger(payload.callCount, "metric.callCount"),
    responseChars: nullableNonNegativeInteger(payload.responseChars, "metric.responseChars"),
    durationMs: nullableNonNegativeInteger(payload.durationMs, "metric.durationMs"),
    model: nullableString(payload.model, "metric.model"),
    tokens,
    cost: nullableCost(payload.cost),
    cachedResponse: payload.cachedResponse === true,
    costIncomplete: payload.costIncomplete === true,
  });
}

function observationNodeId(state, options = {}) {
  if (Object.hasOwn(options, "taskId")) {
    if (options.taskId === null) return state.root.id;
    const task = taskNode(state, options.taskId);
    if (task === null) throw new CurrentFlowStateInvariantError(`canonical observation Task is absent: ${options.taskId}`);
    return task.id;
  }
  return currentTaskId(state) ?? state.root.id;
}

/** Transient dispatcher metadata; it never becomes a flow.json authority. */
class CanonicalStepRuntimeLog {
  constructor(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new CurrentFlowStateInvariantError("step runtime metadata must be an object");
    }
    const fields = ["nodeId", "runId", "sequence", "attempt", "command", "startedAt", "endedAt", "exitCode"];
    for (const field of fields) {
      if (!Object.hasOwn(value, field)) throw new CurrentFlowStateInvariantError(`step runtime metadata.${field} is required`);
    }
    for (const field of Object.keys(value)) {
      if (!fields.includes(field)) throw new CurrentFlowStateInvariantError(`step runtime metadata contains unsupported field: ${field}`);
    }
    this.nodeId = requiredText(value.nodeId, "step runtime metadata.nodeId");
    this.runId = requiredText(value.runId, "step runtime metadata.runId");
    this.sequence = nullableNonNegativeInteger(value.sequence, "step runtime metadata.sequence");
    this.attempt = nullableNonNegativeInteger(value.attempt, "step runtime metadata.attempt");
    this.command = requiredText(value.command, "step runtime metadata.command");
    for (const field of ["startedAt", "endedAt"]) {
      if (value[field] !== null && Number.isNaN(Date.parse(value[field]))) {
        throw new CurrentFlowStateInvariantError(`step runtime metadata.${field} must be an ISO timestamp or null`);
      }
      this[field] = value[field];
    }
    if (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) {
      throw new CurrentFlowStateInvariantError("step runtime metadata.exitCode must be an integer or null");
    }
    this.exitCode = value.exitCode;
    Object.freeze(this);
  }

  toJSON() {
    return {
      nodeId: this.nodeId,
      runId: this.runId,
      sequence: this.sequence,
      attempt: this.attempt,
      command: this.command,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      exitCode: this.exitCode,
    };
  }
}

function specRecordAt(location) {
  try {
    return new CurrentFlowSpecRecord(
      JSON.parse(fs.readFileSync(location.specFile, "utf8")),
      { specId: location.specId.toString() },
    );
  } catch (cause) {
    throw new CurrentFlowStateInvariantError(`canonical spec.json is invalid: ${cause.message}`);
  }
}

/**
 * A fully validated fresh-flow request.  Creation intentionally takes a
 * Spec record rather than a loose object so the same serializer is used by
 * normal runtime creation and by the migration API.
 */
export class CanonicalFlowCreateRequest {
  constructor({
    specId,
    runId,
    request,
    execution = { mode: "direct" },
    policy = { autoApprove: false, nonblocking: null },
    issue = null,
    flowId = null,
    flowVersionId = null,
    specRecord,
    issueSnapshot = null,
    context = null,
    tasks = [],
  } = {}) {
    this.specId = canonicalSpecId(specId);
    this.runId = requiredText(runId, "runId");
    if (typeof request !== "string") {
      throw new CurrentFlowStateInvariantError("request must be a string");
    }
    this.request = request;
    if (execution === null || typeof execution !== "object" || Array.isArray(execution)) {
      throw new CurrentFlowStateInvariantError("execution is required");
    }
    this.execution = Object.freeze(new FlowExecution({
      ...execution,
      mode: executionMode(execution.mode),
    }).toJSON());
    if (policy === null || typeof policy !== "object" || typeof policy.autoApprove !== "boolean" || !Object.hasOwn(policy, "nonblocking")) {
      throw new CurrentFlowStateInvariantError("policy must include autoApprove and nonblocking");
    }
    this.policy = Object.freeze({ autoApprove: policy.autoApprove, nonblocking: policy.nonblocking });
    this.flowId = flowId ?? `flow-${this.runId}`;
    this.flowVersionId = flowVersionId ?? `flow-v1-${this.runId}`;
    if (issue !== null && (!Number.isSafeInteger(issue) || issue < 1)) {
      throw new CurrentFlowStateInvariantError("issue must be a positive integer or null");
    }
    this.issue = issue;
    // A Spec document need not duplicate its identity.  Creation already
    // owns the location-bound specId, so pass it through the same typed
    // parser used by normal prepare and migration callers rather than making
    // an otherwise valid `spec.json` invent a legacy id field.
    this.specRecord = CurrentFlowSpecRecord.from(specRecord, { specId: this.specId });
    if (this.specRecord.specId.toString() !== this.specId) {
      throw new CurrentFlowStateInvariantError("canonical create Spec record must match specId");
    }
    if (this.specRecord.tasks.length !== 0) {
      throw new CurrentFlowStateInvariantError(
        "fresh canonical spec.json.tasks must be empty; Tasks are added through typed Activities",
      );
    }
    if (issueSnapshot !== null && typeof issueSnapshot !== "string") {
      throw new CurrentFlowStateInvariantError("issueSnapshot must be a string or null");
    }
    if ((this.issue === null) !== (issueSnapshot === null)) {
      throw new CurrentFlowStateInvariantError(
        "canonical fresh Flow Issue identity and immutable issue.md snapshot must be present together",
      );
    }
    this.issueSnapshot = issueSnapshot;
    this.context = context;
    if (!Array.isArray(tasks)) throw new CurrentFlowStateInvariantError("fresh Tasks must be an array");
    const ids = new Set();
    this.tasks = Object.freeze(tasks.map((task, index) => {
      if (task === null || typeof task !== "object" || Array.isArray(task)) {
        throw new CurrentFlowStateInvariantError(`fresh Tasks[${index}] must be an object`);
      }
      const id = requiredText(task.id, `fresh Tasks[${index}].id`);
      const key = requiredText(task.key ?? task.id, `fresh Tasks[${index}].key`);
      if (ids.has(id)) throw new CurrentFlowStateInvariantError(`fresh Tasks duplicate id: ${id}`);
      ids.add(id);
      const document = structuredClone(task);
      delete document.key;
      return Object.freeze({ id, key, document: Object.freeze({ ...document, id }) });
    }));
    Object.freeze(this);
  }
}

/**
 * The manager's only persisted-state gateway.  No root-level flow.json
 * fallback exists here: an absent Version root is simply an absent Flow.
 */
export class CanonicalFlowManagerStore {
  constructor({ root, mainRoot, specRoot, activeFlowsProvider = () => [], versionStoreFaultInjector = null } = {}) {
    this.mainRoot = requiredText(mainRoot, "mainRoot");
    this.root = requiredText(root, "root");
    this.definition = buildCurrentFlowDefinition();
    this.runtime = new CanonicalFlowRuntime({
      repositoryRoot: this.mainRoot,
      executionRoot: this.root,
      specRoot,
      definition: this.definition,
      versionStoreFaultInjector,
    });
    this.activeFlowsProvider = activeFlowsProvider;
    Object.freeze(this);
  }

  location(specId) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    return this.runtime.location(resolved);
  }

  pathFor(specId) {
    const resolved = this.#resolveSpecId(specId);
    return resolved === null ? null : this.location(resolved).flowStateFile;
  }

  pathForCurrent() {
    const flows = this.activeFlowsProvider().load?.() ?? this.activeFlowsProvider();
    if (!Array.isArray(flows) || flows.length !== 1) return null;
    return this.pathFor(flows[0].specId);
  }

  load(specId) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) return null;
    const location = this.location(resolved);
    if (!fs.existsSync(location.directory)) return null;
    const snapshot = this.runtime.loadSnapshot(resolved);
    if (snapshot === null) return null;
    return projectedState(snapshot.state, specRecordAt(location), snapshot.activities);
  }

  loadReadOnly(specId) {
    return this.load(specId);
  }

  /** Return the typed state for a command that needs definition-owned facts. */
  canonicalState(specId) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) return null;
    return this.runtime.load(resolved);
  }

  /**
   * Read the typed Activity ledger for a command that must derive a durable
   * input revision from catalog publications.  This is deliberately read-only:
   * command code receives historical facts, never a mutable Activity array.
   */
  activityLedger(specId) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) return Object.freeze([]);
    const snapshot = this.runtime.loadSnapshot(resolved);
    if (snapshot === null) return Object.freeze([]);
    return Object.freeze(snapshot.activities.map((activity) => Object.freeze(activity.toJSON())));
  }

  // Gate evidence readers share the public FlowManager catalog vocabulary;
  // the Store exposes the same read-only authority for its admission checks.
  artifactCatalog(specId) { return this.catalog(specId); }

  /** Read the published review only. Absence is a valid pre-review state. */
  readCurrentSpecReview({ specId = null, consumerNodeId } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const consumer = FlowArtifactUpdater.fromActivityNodeId(
      requiredText(consumerNodeId, "canonical review consumer nodeId"),
    ).toString();
    const contract = FLOW_ARTIFACT_CONTRACTS.require("spec.review");
    if (!contract.ownership.consumers.includes(consumer)) {
      throw new CurrentFlowStateInvariantError(
        `canonical artifact consumer is not authorized: ${consumer}/spec.review`,
      );
    }
    const artifact = this.runtime.readCurrentSpecReview(resolved);
    if (artifact === null) return null;
    return Object.freeze({
      revision: artifact.revision,
      descriptor: artifact.descriptor,
      bytes: Buffer.from(artifact.bytes),
      review: artifact.review,
    });
  }

  /** Return the parent-derived review input for spec-review. This is the only
   * place an unpersisted generation-zero review may exist. */
  readCurrentSpecReviewInput({ specId = null, consumerNodeId } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const consumer = FlowArtifactUpdater.fromActivityNodeId(
      requiredText(consumerNodeId, "canonical review input consumer nodeId"),
    ).toString();
    if (consumer !== "spec-review") {
      throw new CurrentFlowStateInvariantError("only spec-review may consume an unpublished canonical review seed");
    }
    const artifact = this.runtime.readCurrentSpecReviewInput(resolved);
    return Object.freeze({
      revision: artifact.revision,
      descriptor: artifact.descriptor,
      bytes: Buffer.from(artifact.bytes),
      review: artifact.review,
      persisted: artifact.persisted,
    });
  }

  /** Store-owned atomic source for Definition transition facts. */
  transitionSnapshot(specId) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) return null;
    const snapshot = this.runtime.loadTransitionSnapshot(resolved);
    if (snapshot === null) return null;
    return Object.freeze({
      state: snapshot.state,
      revision: snapshot.revision,
      activities: Object.freeze(snapshot.activities.map((activity) => Object.freeze(activity.toJSON()))),
      catalog: Object.freeze(snapshot.catalog.map((descriptor) => Object.freeze(structuredClone(descriptor)))),
    });
  }

  /** Store-local counterpart used by Gate facts during lock re-admission. */
  readCanonicalTransitionSnapshot(specId) {
    return this.transitionSnapshot(specId);
  }

  /** Read one lock-scoped canonical view for a Definition fact adapter. */
  readCanonicalTransitionView({ specId = null, read } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    return this.runtime.readCanonicalTransitionView(resolved, read);
  }

  /**
   * Atomically claim the next definition-owned action through an Attempt.
   * Querying `get next-action` is the command-context operation, so this is
   * the only normal entrypoint that may begin a fresh worker Attempt.
   */
  beginNextAction(specId) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    if (state.lifecycle.state !== "active") {
      throw new CurrentFlowStateInvariantError(`cannot begin an action for a ${state.lifecycle.state} Flow`);
    }
    const next = state.nextAction();
    if (next === null) return state;
    if (next.operation === "resume") return state;
    if (next.operation === "resolve-step-definition") {
      throw new CurrentFlowStateInvariantError(
        "the active Step requires its canonical Definition-selected Action before it can be claimed",
      );
    }
    if (next.executable) {
      this.#beginExecutableNode(state, resolved, next.nodeId);
      return this.runtime.load(resolved);
    }
    if (next.operation === "retry") {
      const attempt = retryAttempt(state);
      this.runtime.retryAttempt({
        specId: resolved,
        activityId: activityId("attempt-retried"),
        attempt,
        retryRecoveryPublication: this.#retryBaselinePublication(state, next.nodeId, attempt),
      });
      return this.runtime.load(resolved);
    }
    // Rewind and terminal failure decisions need an explicit command with
    // their evidence. A within-budget retry is already fully authorized by
    // the failed Attempt and its definition-owned failure policy.
    return state;
  }

  recoverInterruptedFinalizeSync({ specId = null, runtimeLog = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const runtimeReceipt = new InterruptedFinalizeSyncRuntimeLogFact({ receipt: runtimeLog }).receipt;
    if (runtimeReceipt === null || runtimeReceipt.runId !== state.runId) {
      throw new CurrentFlowStateInvariantError("interrupted finalize-sync runtime receipt does not match the active Flow");
    }
    const identity = finalizationOutboxIdentity(state, "finalize-sync");
    const existing = this.outboxStatus({ specId: resolved, id: identity.idempotencyKey, operation: identity.operation });
    if (state.current?.at(-1) !== "finalize-sync" || state.attempt === null || existing.status !== "pending") {
      throw new CurrentFlowStateInvariantError("interrupted finalize-sync recovery is no longer eligible");
    }
    const recoveryIdentity = {
      flowVersionId: state.identity.flowVersionId,
      runId: state.runId,
      outboxId: identity.idempotencyKey,
      outboxAttempt: existing.attempt,
      runtimeLog: runtimeReceipt,
    };
    const recoveryDigest = crypto.createHash("sha256").update(JSON.stringify(recoveryIdentity)).digest("hex");
    const cleanupNode = state.findNode("finalize-cleanup");
    const requiredResources = state.definition.contractForNode(cleanupNode).resourceContract.required;
    const cleanupAttempt = new CurrentAttempt({
      id: `attempt-finalize-cleanup-${recoveryDigest}`,
      nodeId: "finalize-cleanup",
      sequence: cleanupNode.attemptSequence + 1,
      startedAt: runtimeReceipt.startedAt,
      consumption: { semantic: 0, tooling: 0 },
      failure: null,
      blocker: null,
      incomplete: [],
      operationClaims: requiredResources.length === 0
        ? []
        : [{ operation: "resolve-command-context", resources: requiredResources }],
    }).toJSON();
    const interruption = new FinalizeSyncInterruptedError({ runtimeLog: runtimeReceipt });
    const issue = new IssueLogDocument((() => {
      const existingIssue = this.readArtifact({ specId: resolved, logicalKey: "issue.log", consumerNodeId: "finalize-cleanup", optional: true });
      return existingIssue === null ? { entries: [] } : JSON.parse(existingIssue.bytes.toString("utf8"));
    })());
    issue.append(canonicalIssueLogEntry({
      step: "finalize-sync",
      reason: interruption.message,
      trigger: "interrupted",
      timestamp: runtimeReceipt.startedAt,
      runtimeLog: runtimeReceipt,
    }), `interrupted-finalize-sync-${state.runId}-${runtimeReceipt.sequence}`);
    return this.runtime.recoverInterruptedFinalizeSync({
      specId: resolved,
      activityId: `interrupted-finalize-sync-recovered-${recoveryDigest}`,
      cleanupAttempt,
      outbox: canonicalOutboxActivity({ outbox: { id: identity.idempotencyKey, operation: identity.operation }, attempt: existing.attempt, failure: interruption.message, failureCode: interruption.code, recovery: null, exactRecoveryReceipt: existing.exactRecoveryReceipt }),
      artifactWrites: [{ logicalKey: "issue.log", mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(issue.toJSON(), null, 2)}\n`, "utf8") }],
      timing: { startedAt: runtimeReceipt.startedAt, finishedAt: runtimeReceipt.startedAt, durationMs: 0 },
      references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    });
  }

  createFresh(request) {
    const input = request instanceof CanonicalFlowCreateRequest
      ? request
      : new CanonicalFlowCreateRequest(request);
    this.runtime.createFresh({
      specId: input.specId,
      flowId: input.flowId,
      flowVersionId: input.flowVersionId,
      runId: input.runId,
      request: input.request,
      issue: input.issue,
      execution: input.execution,
      policy: input.policy,
      specRecord: input.specRecord,
      issueSnapshot: input.issueSnapshot,
      context: input.context,
    });
    for (const task of input.tasks) {
      this.runtime.addTask({
        specId: input.specId,
        activityId: activityId("task-added"),
        taskId: task.id,
        key: task.key,
        taskSpec: task.document,
      });
    }
    const location = this.location(input.specId);
    const snapshot = this.runtime.loadSnapshot(input.specId);
    return projectedState(snapshot.state, specRecordAt(location), snapshot.activities);
  }

  assertWritable(specId) {
    const location = this.location(specId);
    location.assertAuthority(null, { mustExist: true });
    return this.runtime.assertWritable(specId);
  }

  executionRoot() { return this.root; }

  resolveWorktreePaths(state) {
    if (state?.execution?.mode !== "worktree" && state?.worktree !== true) {
      return { worktreePath: null, mainRepoPath: null };
    }
    const worktreePath = this.root === this.mainRoot
      ? path.join(
          managedDir(this.mainRoot),
          "worktree",
          state.execution.featureBranch.replace(/\//g, "-"),
        )
      : this.root;
    return { worktreePath, mainRepoPath: this.mainRoot };
  }

  updateStepStatus(transition, opts = {}) {
    const specId = this.#resolveSpecId(opts.specId ?? transition?.specId);
    if (specId === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(specId);
    const nodeId = requiredText(transition?.stepId, "canonical transition.stepId");
    const requestedStatus = requiredText(transition?.requestedStatus, "canonical transition.requestedStatus");
    if (requestedStatus === "in_progress") {
      if (state.current !== null) {
        throw new CurrentFlowStateInvariantError("canonical transition cannot replace an active Attempt");
      }
      return this.#beginExecutableNode(state, specId, nodeId);
    }
    if (requestedStatus === "pending") {
      // A definition lifecycle may reset a terminal leaf after a rejected
      // review.  In Version 1 that is never a mutable status patch: rewinding
      // creates the replacement Attempt and invalidates its definition-owned
      // downstream leaves through one typed recovery transition.
      if (state.current !== null) {
        throw new CurrentFlowStateInvariantError("canonical reset cannot replace an active Attempt");
      }
      return this.rewindTo(nodeId, { specId });
    }
    if (!TERMINAL_STATUSES.has(requestedStatus)) {
      throw new CurrentFlowStateInvariantError(
        `canonical transition status requires an explicit recovery Activity: ${requestedStatus}`,
      );
    }
    let confirmingState = state;
    if (confirmingState.current === null) {
      // Lifecycle plans often settle definition-owned no-op leaves (for
      // example a passed review's triage/repair leaves).  Materialize the
      // same short Attempt a normal command would own, then confirm it.  This
      // keeps Activity order, Attempt sequence, crash recovery, and state
      // transition in the one Store rather than restoring a callback patch.
      this.#beginExecutableNode(state, specId, nodeId);
      confirmingState = this.runtime.load(specId);
    } else if (confirmingState.current.at(-1) !== nodeId) {
      throw new CurrentFlowStateInvariantError(`canonical transition does not own current node: ${nodeId}`);
    }
    const gateTaskLifecycle = this.#taskGatePassLifecycle({
      state: confirmingState,
      nodeId,
      status: requestedStatus,
      decision: opts.gateTransitionDecision,
      suppliedLifecycle: opts.gateTaskLifecycle,
      transition,
    });
    this.#integrationGatePassAdmission({
      state: confirmingState,
      nodeId,
      status: requestedStatus,
      decision: opts.gateTransitionDecision,
    });
    const artifactWrites = opts.canonicalCommandResult === undefined
      ? []
      : [
          ...this.#attemptHistoryWrites({
          specId,
          state: confirmingState,
          nodeId,
          commandResult: opts.canonicalCommandResult,
          }),
          ...this.#commandPublicationWrites(opts.canonicalCommandResult),
        ];
    return this.runtime.confirmAttempt({
      specId,
      activityId: activityId("attempt-confirmed"),
      status: requestedStatus,
      result: resultFor(requestedStatus, nodeId),
      artifactWrites,
      gateTaskLifecycle,
      ...(requestedStatus === "done" && { admission: new CombinedAdmission(
        this.#producerCompletionAdmission(nodeId, artifactWrites),
        gateTaskLifecycle === null ? null : new TaskGateSettlementAdmission(opts.gateTransitionDecision, "terminal"),
      ) }),
    });
  }

  updateStepStatuses(transitions, opts = {}) {
    if (!Array.isArray(transitions) || transitions.length === 0) {
      throw new CurrentFlowStateInvariantError("canonical transitions must be a non-empty array");
    }
    let result = null;
    for (const transition of transitions) result = this.updateStepStatus(transition, opts);
    return result;
  }

  finalizeDownstream({ specId = null, action, stepIds } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const operation = action === "skip" ? "skip_finalize_downstream"
      : action === "reset" ? "reset_finalize_downstream"
        : null;
    if (operation === null) throw new CurrentFlowStateInvariantError("finalization downstream action is invalid");
    return this.runtime.finalizeDownstream({
      specId: resolved,
      activityId: activityId(operation),
      operation,
      stepIds,
    });
  }

  /**
   * Start the first definition-owned leaf of a Task.  A Task is not a second
   * mutable status machine: its status is derived from those child Steps.
   */
  startTask(taskId, opts = {}) {
    const specId = this.#resolveSpecId(opts.specId);
    if (specId === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(specId);
    const task = taskNode(state, requiredText(taskId, "canonical Task id"));
    if (task === null) throw new CurrentFlowStateInvariantError(`canonical Task is absent: ${taskId}`);
    if (task.status === "done" || task.status === "skipped") {
      throw new CurrentFlowStateInvariantError(`canonical Task is already terminal: ${taskId}`);
    }
    if (state.current !== null) {
      if (currentTaskId(state) === task.id) return state;
      throw new CurrentFlowStateInvariantError("canonical Task start cannot replace an active Attempt");
    }
    const first = leafNodes(task)[0] ?? null;
    const next = state.nextAction();
    if (first === null || next?.nodeId !== first.id) {
      throw new CurrentFlowStateInvariantError(`canonical Task is not the next executable Task: ${taskId}`);
    }
    return this.runtime.startAttempt({
      specId,
      activityId: activityId("task-attempt-started"),
      nodeId: first.id,
      attempt: commandContextAttempt(state, first.id),
      admission: this.#consumerAdmission(state, first.id),
    });
  }

  /**
   * Task completion is verified from its canonical child Steps.  There is no
   * independent `currentTaskId` or writable Task status to drift from them.
   */
  completeTask(taskId, opts = {}) {
    const specId = this.#resolveSpecId(opts.specId);
    if (specId === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(specId);
    const task = taskNode(state, requiredText(taskId, "canonical Task id"));
    if (task === null) throw new CurrentFlowStateInvariantError(`canonical Task is absent: ${taskId}`);
    if (task.status !== "done") {
      throw new CurrentFlowStateInvariantError(`canonical Task cannot complete before all child Steps are done: ${taskId}`);
    }
    const location = this.location(specId);
    const snapshot = this.runtime.loadSnapshot(specId);
    return projectedState(snapshot.state, specRecordAt(location), snapshot.activities);
  }

  /** Re-read the canonical observation before applying a selected Gate action. */
  #admitGateDecision(state, decision, operation) {
    if (!(decision instanceof GateTransitionDecision)) {
      throw new CurrentFlowStateInvariantError("definition-owned Gate operation requires a typed Gate decision");
    }
    const facts = readCurrentGateTransitionFacts({
      flowManager: this, flowState: this.loadReadOnly(state.specId), phase: decision.facts.phase,
    });
    if (facts === null) throw new CurrentFlowStateInvariantError("definition-owned Gate observation is no longer current");
    const current = resolveGateTransition(facts);
    if (current.disposition.operation !== operation
      || !current.plan.action.identity.matches(decision.plan.action.identity)) {
      throw new CurrentFlowStateInvariantError("definition-owned Gate action is stale or no longer admitted");
    }
    return current;
  }

  /** Task Gate completion has one admission path: the current Definition pass plan. */
  #taskGatePassLifecycle({ state, nodeId, status, decision, suppliedLifecycle, transition = null }) {
    const parent = state.current === null ? null : state.findNode(state.current.at(-2));
    const taskGate = parent instanceof TaskNode && nodeId === `${parent.id}-gate`;
    if (!taskGate) return null;
    if (status === "skipped") {
      if (!(transition instanceof DefinitionLifecycleTransition)
        || transition.event !== "review:post"
        || transition.currentStepId !== `${parent.id}-review`
        || transition.action.step !== nodeId
        || transition.action.status !== "skipped"
        || captureCurrentTaskSource({ root: this.root, flowManager: this, state, taskId: parent.id }).fingerprint !== transition.action.taskSourceFingerprint) {
        throw new CurrentFlowStateInvariantError("Task Gate skip requires the Definition-selected no-change Review lifecycle");
      }
      const leaves = state.definition.orderedLeaves(state.root);
      const gateIndex = leaves.findIndex((candidate) => candidate.id === nodeId);
      const successorStepId = leaves.slice(gateIndex + 1)
        .find((candidate) => candidate.status === "pending" || candidate.status === "invalidated")?.id ?? null;
      if (successorStepId === null) throw new CurrentFlowStateInvariantError("Task Gate skip has no canonical successor");
      return { operation: "complete-and-advance", taskId: parent.id, successorStepId, resetStepIds: [] };
    }
    if (status !== "done") return null;
    if (suppliedLifecycle !== undefined) {
      throw new CurrentFlowStateInvariantError("Task Gate completion accepts only its Definition-selected lifecycle effect");
    }
    const selected = this.#admitGateDecision(state, decision, "pass");
    const lifecycle = selected.plan.taskLifecycle?.toJSON?.() ?? null;
    if (lifecycle === null) {
      throw new CurrentFlowStateInvariantError("Task Gate pass Definition plan requires a sealed lifecycle effect");
    }
    return lifecycle;
  }

  /** The flow-level integration Gate is completed only by its PASS decision. */
  #integrationGatePassAdmission({ state, nodeId, status, decision }) {
    if (nodeId !== "impl-gate" || status !== "done") return;
    this.#admitGateDecision(state, decision, "pass");
  }

  retryGateTransition({ specId = null, decision } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const current = this.#admitGateDecision(state, decision, "retry");
    return this.runtime.retryGateAttempt({
      specId: resolved, activityId: activityId("gate-retry"), attempt: gateRetryAttempt(state),
      references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
      admission: current.facts.scope === "task"
        ? new TaskGateSettlementAdmission(current, "continuation")
        : undefined,
    });
  }

  /** Persist one Definition-selected Task Gate metric at most once per result. */
  recordTaskGateSettlementMetric({ specId = null, decision } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const current = this.#admitGateDecision(state, decision, decision.disposition.operation);
    if (current.facts.scope !== "task" || current.plan.retryMetric === null) {
      throw new CurrentFlowStateInvariantError("Task Gate settlement metric requires the Definition-selected metric effect");
    }
    if (current.facts.taskSettlementProgress.hasMetric(current.plan.retryMetric)) return state;
    const effect = current.plan.retryMetric;
    return this.runtime.recordMetric({
      specId: resolved,
      activityId: taskGateSettlementMetricActivityId({
        publicationActivityId: current.facts.catalogPublication.producerActivityId,
        nodeId: current.facts.target.stepId,
        attempt: current.facts.currentAttempt.toJSON(),
        operation: effect.operation,
      }),
      // Flow-wide task observations are anchored to the stable Task identity;
      // the Gate leaf remains part of the deterministic effect identity.
      nodeId: current.facts.target.taskId,
      metric: canonicalMetric({
        phase: effect.phase,
        counter: "gateRetry",
        delta: effect.operation === "increment" ? 1 : 0,
        ...(effect.operation === "reset" ? { reset: true } : {}),
      }),
      admission: new TaskGateSettlementAdmission(current, "metric"),
    });
  }

  /** Supersede one legacy post-publication tooling classification without deleting its audit record. */
  recoverTaskGateClassification({ specId = null, decision } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const current = this.#admitGateDecision(state, decision, decision.disposition.operation);
    const progress = current.facts.taskSettlementProgress?.classificationRecovery;
    if (current.facts.scope !== "task" || progress?.required !== true || state.attempt?.failure?.category !== "tooling") {
      throw new CurrentFlowStateInvariantError("Task Gate classification recovery requires one Definition-selected tooling conflict");
    }
    const identity = new TaskGateClassificationRecoveryIdentity({
      publicationActivityId: current.facts.catalogPublication.producerActivityId,
      failedActivityId: progress.failedActivityId,
      attempt: current.facts.currentAttempt,
    });
    return this.runtime.recoverTaskGateClassification({
      specId: resolved,
      activityId: identity.activityId,
      attempt: new CurrentAttempt({ ...state.attempt.toJSON(), failure: null }),
      references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
      admission: new TaskGateSettlementAdmission(current, "classification-recovery"),
    });
  }

  recordGateObservationDecision({ specId = null, decision } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const current = this.#admitGateDecision(state, decision, decision.disposition.operation);
    if (current.facts.result !== "fail") {
      throw new CurrentFlowStateInvariantError("Gate observation recording requires a failed Gate result");
    }
    const failure = current.facts.failure;
    this.failCurrentAttempt({
      specId: resolved,
      failure: {
        category: failure.category,
        code: failure.code,
        message: "Gate rejected the current Attempt.",
        retryable: current.disposition.operation === "retry",
        retryKind: current.disposition.operation === "retry" ? "semantic" : null,
      },
      result: {
        outcome: "failed", summary: "Gate rejected the current Attempt.",
        confirmedAt: new Date().toISOString(), artifactRefs: [],
      },
      admission: current.facts.scope === "task"
        ? new TaskGateSettlementAdmission(current, "classification")
        : undefined,
    });
    // The failure above is the sole canonical state mutation. Return a typed
    // process-boundary view without recording another observation or
    // inventing a route from command output.
    const failedState = this.runtime.load(resolved);
    return gateExternalBlockedStepAttempt(failedState, current);
  }

  settleGateTransition(input = {}) {
    if (Object.hasOwn(input, "artifactWrites") || Object.hasOwn(input, "artifactBaselines")) {
      throw new CurrentFlowStateInvariantError("canonical Gate settlement accepts only its deferred flow.findings publication");
    }
    const { specId = null, decision } = input;
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const current = this.#admitGateDecision(state, decision, "defer");
    const findings = buildDeferredSemanticFindingsPublication({
      flowManager: this, flowState: this.loadReadOnly(resolved), nodeId: state.current.at(-1),
      sourceStep: state.current.at(-1), sourceArtifact: current.facts.catalogPublication.artifactId,
      attempts: current.facts.retry.used + 1,
      round: current.facts.taskBudget?.round ?? current.facts.retry.used + 1,
    });
    if (findings.deferred.length === 0) {
      throw new CurrentFlowStateInvariantError("Gate settlement requires at least one canonical deferred finding");
    }
    return this.runtime.deferFailedGate({
      specId: resolved, activityId: activityId("gate-failure-deferred"), nodeId: state.current.at(-1),
      attempt: commandContextAttempt(state, state.current.at(-1)),
      result: { outcome: "passed", summary: "Gate findings deferred after semantic retry exhaustion", confirmedAt: new Date().toISOString(), artifactRefs: [] },
      findingsPublication: findings,
      gateTaskLifecycle: current.plan.taskLifecycle?.toJSON?.() ?? null,
      admission: current.facts.scope === "task"
        ? new TaskGateSettlementAdmission(current, "continuation")
        : undefined,
    });
  }

  /** Apply only the current Definition-selected stale Task round closure. */
  recoverTaskExecutionOverrun({ specId = null, decision } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (!(decision instanceof TaskExecutionOverrunDecision)) {
      throw new CurrentFlowStateInvariantError("Task execution overrun recovery requires a Definition decision");
    }
    const facts = readTaskExecutionOverrunFacts({ flowManager: this, specId: resolved });
    const selected = resolveTaskExecutionOverrun(facts);
    if (selected === null || !selected.matches(decision)) {
      throw new CurrentFlowStateInvariantError("Task execution overrun recovery is stale or no longer Definition-selected");
    }
    const state = this.runtime.load(resolved);
    return this.runtime.recoverTaskExecutionOverrun({
      specId: resolved,
      activityId: activityId("task-execution-overrun-recovered"),
      nodeId: `${selected.facts.taskId}-impl`,
      attempt: state.attempt,
      references: {
        evaluations: [{ id: selected.facts.gate.failure.activityId, label: selected.facts.gate.failure.code }], findings: [],
        repairs: [
          { id: selected.facts.repair.activityId, label: "stale plan-gate-repair Activity" },
          { id: selected.facts.repair.recordId, label: selected.facts.repair.sourceIssueLogId },
        ],
        artifacts: [
          { id: selected.facts.gate.publication.relativePath, label: selected.facts.gate.publication.hash },
          { id: selected.facts.issueLog.relativePath, label: selected.facts.issueLog.hash },
        ],
      },
      admission: new TaskExecutionOverrunAdmission({ facts: selected.facts, root: this.executionRoot() }),
    });
  }

  /**
   * Perform the guarded plan-gate rewind as one Version Store transaction.
   * The frozen source observations are appended to cataloged issue-log.json
   * and referenced by the replacement Attempt Activity; flow.json carries no
   * mutable repair marker or copied history.
   */
  repairPlanGate({ specId = null, record, issueLog, decision = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const repair = PlanGateRepairRecord.from(record);
    const state = this.runtime.load(resolved);
    const activeTaskGate = TaskStepIdentity.fromStateNode(
      this.loadReadOnly(resolved), state.current?.at(-1),
    )?.definitionId === "task-gate";
    const gateDecision = (new Set(["draft-gate", "spec-gate"]).has(state.current?.at(-1)) || activeTaskGate)
      ? this.#admitGateDecision(state, decision, "repair")
      : null;
    if (repair.phase === "task-impl") {
      const effect = decision?.plan?.taskLifecycle ?? null;
      if (effect?.operation !== "repair-task-impl"
        || effect.taskId !== repair.route.gateStepId.slice(0, -"-gate".length)
        || effect.successorStepId !== repair.targetStepId
        || JSON.stringify(effect.resetStepIds) !== JSON.stringify(repair.route.resetStepIds)) {
        throw new CurrentFlowStateInvariantError("Task Gate repair record does not match the sealed Definition lifecycle plan");
      }
    }
    repair.assertFlow(state);
    if (state.current?.at(-1) !== repair.route.gateStepId) {
      throw new CurrentFlowStateInvariantError("canonical plan gate repair source gate is not active");
    }
    const source = issueLog?.entries?.find((entry) => entry?.issueLogId === repair.sourceIssueLogId) ?? null;
    if (!repair.matchesIssueLogEntry(source)) {
      throw new CurrentFlowStateInvariantError("canonical plan gate repair source evidence changed before rewind");
    }
    const target = repair.targetStepId;
    const nextIssueLog = repair.appendToIssueLog(issueLog);
    return this.runtime.planGateRepair({
      specId: resolved,
      activityId: activityId("plan-gate-repaired"),
      nodeId: target,
      attempt: commandContextAttempt(state, target),
      references: {
        evaluations: [],
        findings: [],
        repairs: [repair.activityReference()],
        artifacts: [],
      },
      artifactWrites: [{
        logicalKey: "issue.log",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(nextIssueLog, null, 2)}\n`, "utf8"),
      }],
      admission: new CombinedAdmission(
        this.#replacementConsumerAdmission(state, {
          route: "repair-plan-gate",
          targetNodeId: target,
        }),
        gateDecision?.facts.scope === "task"
          ? new TaskGateSettlementAdmission(gateDecision, "continuation")
          : null,
      ),
      gateTaskLifecycle: decision?.plan?.taskLifecycle?.toJSON?.() ?? null,
    });
  }

  /** Re-open a definition-authorized terminal/invalidated node as an Attempt. */
  rewindTo(nodeId, opts = {}) {
    const specId = this.#resolveSpecId(opts.specId);
    if (specId === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(specId);
    const expected = opts.expectedFailedAttempt == null
      ? null
      : CurrentAttemptIdentity.from(opts.expectedFailedAttempt);
    if (expected !== null && !expected.matchesFailed(state)) {
      throw new CurrentFlowStateInvariantError("canonical failed Attempt changed before rewind");
    }
    const target = requiredText(nodeId, "canonical recovery nodeId");
    const recovery = state.recoveryTarget(state.definition.pathFor(state.root, target)).assertLegal();
    if (expected !== null && recovery.operation !== "rewind") {
      throw new CurrentFlowStateInvariantError("canonical failed Attempt has no definition-owned rewind target");
    }
    const attempt = commandContextAttempt(state, target);
    if (recovery.operation === "rewind") {
      const rewound = this.runtime.rewind({
        specId,
        activityId: activityId("attempt-rewound"),
        nodeId: target,
        attempt,
        expectedAttempt: expected,
        admission: this.#consumerAdmission(state, target),
        retryRecoveryPublication: this.#retryBaselinePublication(state, target, attempt),
      });
      if (rewound === null) {
        throw new CurrentFlowStateInvariantError("canonical failed Attempt changed before rewind");
      }
      return rewound;
    }
    if (recovery.operation === "recover") {
      return this.runtime.recover({
        specId,
        activityId: activityId("attempt-recovered"),
        nodeId: target,
        attempt,
        admission: this.#consumerAdmission(state, target),
        retryRecoveryPublication: this.#retryBaselinePublication(state, target, attempt),
      });
    }
    throw new CurrentFlowStateInvariantError(`canonical recovery is unavailable for ${target}`);
  }

  /** Atomically publish repair-required acceptance evidence and reopen impl triage. */
  repairAcceptanceReview({ specId = null, commandResult } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    if (state.current?.at(-1) !== "acceptance-review") {
      throw new CurrentFlowStateInvariantError("acceptance repair requires active acceptance-review Attempt");
    }
    const attached = attachedCanonicalCommandResultArtifact(commandResult);
    if (attached?.logicalKey !== "acceptance.review") {
      throw new CurrentFlowStateInvariantError("acceptance repair requires its canonical acceptance.review result");
    }
    const artifactWrites = [
      ...this.#attemptHistoryWrites({ specId: resolved, state, nodeId: "acceptance-review", commandResult }),
      ...this.#commandPublicationWrites(commandResult),
    ];
    const acceptanceWrite = artifactWrites.find((write) => write.logicalKey === "acceptance.review") ?? null;
    if (acceptanceWrite === null) {
      throw new CurrentFlowStateInvariantError("acceptance repair requires a cataloged acceptance.review publication");
    }
    // The reference names the exact cataloged bytes, not an unwrapped command
    // payload.  The worker route later resolves this digest through the
    // catalog, making the Activity's input binding durable and unforgeable.
    const acceptanceDigest = crypto.createHash("sha256").update(acceptanceWrite.bytes).digest("hex");
    return this.runtime.repairAcceptanceReview({
      specId: resolved,
      activityId: activityId("acceptance-review-repaired"),
      attempt: commandContextAttempt(state, "impl-triage"),
      result: {
        outcome: "passed",
        summary: "acceptance review requires implementation repair",
        confirmedAt: new Date().toISOString(),
        artifactRefs: [{ kind: "acceptance-review", id: acceptanceDigest }],
      },
      references: { evaluations: [], findings: [], repairs: [], artifacts: [{ id: acceptanceDigest, label: "acceptance.review" }] },
      artifactWrites,
      admission: this.#replacementConsumerAdmission(state, {
        route: "repair-acceptance-review",
        targetNodeId: "impl-triage",
      }),
    });
  }

  /**
   * Canonical stale-test-evidence recovery.  The source and target are fixed
   * by the Flow definition, so this is not a generic lifecycle mutation API.
   */
  rewindTestEvidence({ specId = null, decision = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const sourceStepId = state.current?.at(-1) ?? null;
    if (sourceStepId !== "impl-gate") {
      throw new CurrentFlowStateInvariantError("canonical test evidence rewind requires the active integration Gate");
    }
    const selected = this.#admitGateDecision(state, decision, "recovery");
    const effect = selected.plan.recoveryEffect;
    if (effect?.operation !== "rewind-test-evidence"
      || effect.sourceStepId !== sourceStepId
      || effect.targetStepId !== "test-execute") {
      throw new CurrentFlowStateInvariantError("integration test evidence rewind requires its sealed Definition recovery effect");
    }
    return this.runtime.rewindTestEvidence({
      specId: resolved,
      activityId: activityId("test-evidence-rewound"),
      attempt: commandContextAttempt(state, "test-execute"),
    });
  }

  /** Apply only the Definition-sealed stale-evidence recovery selected for retro. */
  applyRetroStaleEvidenceRecoveryDecision({ specId = null, decision } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (!(decision instanceof RetroStaleEvidenceRecoveryDecision)) {
      throw new CurrentFlowStateInvariantError("retro stale evidence recovery requires a typed Definition decision");
    }
    const snapshot = this.transitionSnapshot(resolved);
    const state = snapshot?.state ?? null;
    const { facts, plan } = decision;
    const identity = plan.action;
    if (state === null
      || state.current?.at(-1) !== "retro"
      || facts.specId !== resolved
      || facts.runId !== state.runId
      || facts.snapshotRevision !== snapshot.revision
      || facts.attemptId !== state.attempt?.id
      || facts.sequence !== state.attempt?.sequence
      || identity.specId !== resolved
      || identity.runId !== state.runId
      || identity.stepId !== "retro"
      || identity.attemptId !== state.attempt?.id
      || identity.sequence !== state.attempt?.sequence
      || identity.snapshotRevision !== snapshot.revision
      || identity.catalogFingerprint !== facts.catalogFingerprint
      || plan.effect.operation !== "rewind-test-evidence"
      || plan.effect.sourceStepId !== "retro"
      || plan.effect.targetStepId !== "test-execute") {
      throw new CurrentFlowStateInvariantError("retro stale evidence recovery decision is stale or targets another Attempt");
    }
    const currentFingerprint = buildRepairFingerprint({
      root: this.root,
      artifactRoot: this.root,
      specPath: this.location(resolved).relativeSpecFile,
    });
    if (currentFingerprint.hash !== facts.currentFingerprint) {
      throw new CurrentFlowStateConflictError("retro stale evidence recovery repository fingerprint changed before apply");
    }
    for (const publication of facts.publications) {
      const current = snapshot.catalog.find((entry) => entry.logicalKey === publication.logicalKey) ?? null;
      if (current === null
        || current.relativePath !== publication.relativePath
        || current.hash !== publication.hash
        || current.activityId !== publication.activityId) {
        throw new CurrentFlowStateConflictError("retro stale evidence recovery catalog evidence changed before apply");
      }
    }
    return this.runtime.rewindTestEvidence({
      specId: resolved,
      activityId: activityId("retro-stale-test-evidence-rewound"),
      attempt: commandContextAttempt(state, "test-execute"),
    });
  }

  /** Replace a rejected test-review with a catalog-evidence-bound test Attempt. */
  repairTestReview({ specId = null, references } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    if (state.current?.at(-1) !== "test-review") {
      throw new CurrentFlowStateInvariantError("canonical test-review repair requires active test-review");
    }
    return this.runtime.repairTestReview({
      specId: resolved,
      activityId: activityId("test-review-repaired"),
      attempt: commandContextAttempt(state, "test"),
      references,
    });
  }

  /**
   * A repair worker whose handoff was not accepted cannot be replayed. Its
   * failed Attempt remains auditable while the retained canonical test source
   * enters the normal scenario-validity and fresh test-review path.
   */
  settleTimedOutTestReviewRepair({ specId = null, references = undefined } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    if (state.current?.at(-1) !== "test"
      || !TestReviewRepairWorkerTimeout.isFailureCode(state.attempt?.failure?.code)) {
      throw new CurrentFlowStateInvariantError("test-review repair timeout settlement requires its failed test Attempt");
    }
    return this.runtime.settleTimedOutTestReviewRepair({
      specId: resolved,
      activityId: activityId("test-review-repair-timeout-settled"),
      attempt: commandContextAttempt(state, "test"),
      result: {
        outcome: "passed",
        summary: "Test-review repair timed out without an accepted handoff; retained test evidence proceeds to scenario validity.",
        confirmedAt: new Date().toISOString(),
        artifactRefs: [],
      },
      references: references ?? { evaluations: [], findings: [], repairs: [], artifacts: [] },
    });
  }

  /** Enter the fixed scenario-validity → implementation bootstrap route. */
  preimplementationBootstrap({ specId = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    if (state.current?.at(-1) !== "scenario-validity") {
      throw new CurrentFlowStateInvariantError("canonical preimplementation bootstrap requires active scenario-validity");
    }
    return this.runtime.preimplementationBootstrap({
      specId: resolved,
      activityId: activityId("preimplementation-bootstrapped"),
      attempt: commandContextAttempt(state, "implement"),
    });
  }

  /** Revalidate the fixed existing-implementation route after scenario validity. */
  recoverExistingImplementation({ specId = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    if (state.current?.at(-1) !== "scenario-validity") {
      throw new CurrentFlowStateInvariantError("canonical existing implementation recovery requires active scenario-validity");
    }
    return this.runtime.recoverExistingImplementation({
      specId: resolved,
      activityId: activityId("existing-implementation-recovered"),
      attempt: commandContextAttempt(state, "test-execute"),
    });
  }

  /** Reopen draft through one of the three definition-owned recovery routes. */
  reopenDraft({ specId = null, route } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (!new Set(["preimplementation", "task-addition", "spec-correction"]).has(route)) {
      throw new CurrentFlowStateInvariantError("canonical draft reopen route is invalid");
    }
    const state = this.runtime.load(resolved);
    if (state.current === null || state.current.at(-1) === "draft") {
      throw new CurrentFlowStateInvariantError("canonical draft reopen requires an active post-draft Attempt");
    }
    const taskNodes = state.findNode(state.definition.dynamicTaskContainerId)?.steps ?? [];
    const hasDoneTask = taskNodes.some((task) => task.status === "done");
    if (route === "task-addition" && !hasDoneTask) {
      throw new CurrentFlowStateInvariantError("canonical task-addition reopen requires a completed Task");
    }
    if (route === "preimplementation" && hasDoneTask) {
      throw new CurrentFlowStateInvariantError("canonical preimplementation reopen cannot follow a completed Task");
    }
    return this.runtime.reopenDraft({
      specId: resolved,
      activityId: activityId(`draft-reopened-${route}`),
      route,
      attempt: commandContextAttempt(state, "draft"),
    });
  }

  retryCurrentAttempt(opts = {}) {
    const specId = this.#resolveSpecId(opts.specId);
    if (specId === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(specId);
    const attempt = retryAttempt(state);
    if (state.nextAction()?.operation !== "retry") {
      throw new CurrentFlowStateInvariantError("the definition failure policy does not authorize retry");
    }
    const taskReviewArchiveAdmission = this.#taskReviewAbortedWorkUnitsForRetry(state, opts.taskReviewAbortedWorkUnits ?? []);
    return this.runtime.retryAttempt({
      specId,
      activityId: activityId("attempt-retried"),
      attempt,
      retryRecoveryPublication: this.#retryBaselinePublication(
        state,
        state.current?.at(-1),
        attempt,
        taskReviewArchiveAdmission?.archives ?? [],
      ),
      admission: taskReviewArchiveAdmission,
    });
  }

  /** Begin only the repair episode selected by the final-regression Definition. */
  beginFinalRegressionRepair({ specId = null, decision } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (!(decision instanceof NonGateTransitionDecision)
      || decision.facts.stepId !== "final-regression"
      || decision.disposition.operation !== "repair") {
      throw new CurrentFlowStateInvariantError("final-regression repair requires its typed Definition decision");
    }
    const snapshot = this.transitionSnapshot(resolved);
    const state = snapshot?.state ?? null;
    const identity = decision.plan.action.identity;
    if (state === null
      || decision.facts.specId !== resolved
      || decision.facts.snapshotRevision !== snapshot.revision
      || state.current?.at(-1) !== "final-regression"
      || state.attempt?.failure === null
      || identity.specId !== resolved
      || identity.attempt.id !== state.attempt.id
      || identity.attempt.sequence !== state.attempt.sequence) {
      throw new CurrentFlowStateInvariantError("final-regression repair decision is stale or targets another Attempt");
    }
    const attempt = retryAttempt(state);
    return this.runtime.retryAttempt({
      specId: resolved,
      activityId: activityId("final-regression-repair-started"),
      attempt,
      retryRecoveryPublication: this.#retryBaselinePublication(state, "final-regression", attempt),
    });
  }

  reconcileTaskReview({ specId = null, record, baseline, admission } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (!(record instanceof TaskReviewReconciliationRecord) || !(admission instanceof TaskReviewReconciliationAdmission)
      || admission.proposal.digest !== record.proposal.digest || record.proposal.specId !== resolved) {
      throw new CurrentFlowStateInvariantError("Task Review reconciliation requires its exact typed admission and record");
    }
    const state = this.runtime.load(resolved);
    return this.runtime.retryRecoveryAttempt({
      specId: resolved, activityId: activityId("task-review-reconciled"),
      attempt: exhaustedRecoveryAttempt(state, record.currentAttempt.id), admission,
      retryRecoveryPublication: new RetryRecoveryArtifactPublication({ baseline, reconciliation: record }),
      references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    });
  }

  retryExhaustedAttempt({ specId = null, receipt, taskReviewRecoveryAuthorization = null, taskReviewAbortedWorkUnits = [] } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const typed = receipt instanceof RetryRecoveryReceipt ? receipt : new RetryRecoveryReceipt(receipt);
    if (taskReviewRecoveryAuthorization !== null && !(taskReviewRecoveryAuthorization instanceof TaskReviewRecoveryAuthorization)) {
      throw new CurrentFlowStateInvariantError("Task Review recovery authorization must be typed");
    }
    const state = this.runtime.load(resolved);
    if (state.current === null || state.attempt?.failure === null) {
      throw new CurrentFlowStateInvariantError("canonical exhausted recovery requires a failed active Attempt");
    }
    const nodeId = state.current.at(-1);
    const route = retryEvidenceRouteForNode(state, nodeId);
    if (route === null || !typed.previous.route.equals(route)) {
      throw new CurrentFlowStateInvariantError("exhausted recovery receipt route does not match the active leaf");
    }
    if (
      typed.previous.attemptId !== state.attempt.id
      || typed.previous.attempt !== state.attempt.sequence
      || typed.previous.runId !== state.runId
      || typed.previous.specId !== state.specId
      || typed.previous.issue !== (state.issue ?? null)
      || typed.current.runId !== state.runId
      || typed.current.specId !== state.specId
      || typed.current.issue !== (state.issue ?? null)
      || typed.current.attempt !== state.attempt.sequence + 1
    ) {
      throw new CurrentFlowStateInvariantError("exhausted recovery receipt identity does not match the active Attempt and Flow");
    }
    const nextAttempt = exhaustedRecoveryAttempt(state, typed.current.attemptId);
    const taskReviewArchiveAdmission = this.#taskReviewAbortedWorkUnitsForRetry(state, taskReviewAbortedWorkUnits);
    return this.runtime.retryRecoveryAttempt({
      specId: resolved,
      activityId: activityId("attempt-recovered-after-exhaustion"),
      attempt: nextAttempt,
      retryRecoveryPublication: RetryRecoveryArtifactPublication.receipt(typed, taskReviewRecoveryAuthorization, taskReviewArchiveAdmission?.archives ?? []),
      references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
      admission: taskReviewArchiveAdmission,
    });
  }

  addTask(task, opts = {}) {
    const specId = this.#resolveSpecId(opts.specId);
    if (specId === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const addition = canonicalTaskAddition(task);
    return this.runtime.addTask({
      specId,
      activityId: activityId("task-added"),
      taskId: addition.id,
      key: addition.key,
      taskSpec: addition.taskSpec,
    });
  }

  /**
   * Parent-only Task admission used by approval continuation.  The runtime
   * persists a distinct Activity and checks the typed recovery authority
   * under the catalog lock before adding the Task or updating spec.json.
   */
  #addApprovalTask(task, { specId, sourceDescriptor, sourceTask }) {
    const addition = canonicalTaskAddition(task);
    return this.runtime.addApprovalTask({
      specId,
      activityId: activityId("approval-task-added"),
      taskId: addition.id,
      key: addition.key,
      taskSpec: addition.taskSpec,
      admission: new ApprovalTaskAdmission({ sourceDescriptor, sourceTask }),
    });
  }

  applyActivity(activity, opts = {}) {
    const specId = this.#resolveSpecId(opts.specId);
    if (specId === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (rawActivityHasMutationOptions(opts)) {
      throw new CanonicalRawActivityReplayOnlyError(
        "canonical raw Activity replay cannot carry mutation options",
      );
    }
    const proposed = FlowActivity.canonical(activity);
    const existing = this.runtime.activities(specId).find((entry) => entry.id === proposed.id) ?? null;
    if (existing !== null) {
      if (!rawActivityReplayMatches(existing, proposed)) {
        throw new CanonicalRawActivityReplayOnlyError(
          "canonical raw Activity replay must exactly match the immutable ledger Activity",
        );
      }
      return this.runtime.apply(specId, proposed);
    }
    // Preserve the stronger finalized-state diagnostic for the historical
    // public call.  The Runtime still rejects it without an append; active
    // Flows receive the explicit replay-only boundary error below.
    if (this.runtime.load(specId)?.lifecycle.state === "finalized") {
      return this.runtime.apply(specId, proposed);
    }
    throw new CanonicalRawActivityReplayOnlyError();
  }

  /**
   * Shared producer boundary for durable non-result artifacts.  Callers name
   * a definition leaf; the Store derives the catalog claim and Activity
   * identity from that leaf instead of accepting a path or an authority.
   */
  publishArtifacts({ specId = null, nodeId, artifactWrites, artifactRemovals = undefined, artifactBaselines = undefined, testSourceBaseline = undefined, admission = undefined, publicationActivityId = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    if (containsRetryRecoveryArtifactWrite(artifactWrites)) {
      throw new CurrentFlowStateInvariantError(
        "retry recovery artifacts require the dedicated canonical retry transition",
      );
    }
    const producerNodeId = requiredText(nodeId, "canonical artifact publication nodeId");
    if (publicationActivityId !== null && (
      !(admission instanceof TaskGateSettlementAdmission)
      || admission.effect !== "issue-log"
      || publicationActivityId !== admission.issueLogActivityId()
    )) {
      throw new CurrentFlowStateInvariantError("canonical artifact publication Activity id is reserved for Task Gate issue-log settlement");
    }
    this.#assertDraftPublication(producerNodeId, artifactWrites);
    const expectedAttempt = state.current?.at(-1) === producerNodeId && state.attempt !== null
      ? CurrentAttemptIdentity.from(state.attempt)
      : null;
    return this.runtime.publishArtifacts({
      specId: resolved,
      activityId: publicationActivityId === null
        ? activityId("artifacts-published")
        : requiredText(publicationActivityId, "canonical artifact publication Activity id"),
      nodeId: producerNodeId,
      artifactWrites,
      artifactRemovals,
      artifactBaselines,
      testSourceBaseline,
      admission,
      ...(expectedAttempt === null ? {} : { expectedAttempt }),
    });
  }

  /** Publish the immutable pre-worker authority and its first event together. */
  publishSourceHandoffCheckpoint({ specId = null, checkpoint, rollbackBlob, preparedEvent } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (!(checkpoint instanceof CanonicalSourceHandoffCheckpoint)
      || !(preparedEvent instanceof SourceHandoffEvent)
      || !Buffer.isBuffer(rollbackBlob)) {
      throw new CurrentFlowStateInvariantError("source handoff checkpoint publication requires typed checkpoint, event, and rollback blob");
    }
    const identity = checkpoint.identity;
    if (!identity.matches(preparedEvent.identity) || preparedEvent.kind !== "prepared"
      || preparedEvent.sequence !== 1 || preparedEvent.previousDigest !== null
      || preparedEvent.checkpointDigest !== checkpoint.digest
      || crypto.createHash("sha256").update(rollbackBlob).digest("hex") !== checkpoint.rollbackBlobDigest) {
      throw new CurrentFlowStateInvariantError("source handoff checkpoint publication binding is invalid");
    }
    const existing = this.readSourceHandoffAuthority({ specId: resolved, identity, optional: true });
    if (existing !== null) {
      if (existing.checkpoint.digest !== checkpoint.digest || existing.event.digest !== preparedEvent.digest
        || !existing.rollbackBlob.equals(rollbackBlob)) {
        throw new CurrentFlowStateConflictError("source handoff checkpoint conflicts with its existing canonical publication");
      }
      return existing;
    }
    this.publishArtifacts({
      specId: resolved,
      nodeId: identity.nodeId,
      artifactWrites: sourceHandoffArtifactWrites({ checkpoint, rollbackBlob, event: preparedEvent }),
      admission: new CombinedAdmission(
        identity.stepId === "task-impl" ? new TaskSourceHandoffPreparationAdmission(identity) : null,
        new SourceHandoffPersistenceAdmission({
          identity, checkpoint, expectedPreviousEventDigest: null, validateCapture: true,
        }),
      ),
    });
    return this.readSourceHandoffAuthority({ specId: resolved, identity });
  }

  /** Append one immutable, digest-linked event with catalog-lock CAS. */
  appendSourceHandoffEvent({ specId = null, event } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (!(event instanceof SourceHandoffEvent)) throw new CurrentFlowStateInvariantError("source handoff event must be typed");
    const authority = this.readSourceHandoffAuthority({ specId: resolved, identity: event.identity });
    if (authority.settled) throw new CurrentFlowStateConflictError("source handoff is already settled");
    if (event.checkpointDigest !== authority.checkpoint.digest
      || event.sequence !== authority.events.length + 1
      || event.previousDigest !== authority.event.digest) {
      throw new CurrentFlowStateConflictError("source handoff event does not extend the canonical event head");
    }
    assertSourceHandoffEventTransition(authority.event, event);
    this.publishArtifacts({
      specId: resolved,
      nodeId: event.identity.nodeId,
      artifactWrites: sourceHandoffArtifactWrites({ event }),
      admission: new SourceHandoffPersistenceAdmission({
        identity: event.identity, checkpoint: authority.checkpoint,
        expectedCheckpointDigest: authority.checkpoint.digest,
        expectedPreviousEventDigest: authority.event.digest,
      }),
    });
    return this.readSourceHandoffAuthority({ specId: resolved, identity: event.identity });
  }

  /** Read one complete source handoff authority through one coherent catalog view. */
  readSourceHandoffAuthority({ specId = null, identity, optional = false, requireUnsettled = false } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const expected = identity instanceof SourceWorkerHandoffIdentity ? identity : new SourceWorkerHandoffIdentity(identity);
    const authority = this.runtime.readCanonicalTransitionView(resolved, (view) => (
      readSourceHandoffAuthorityFromView({ view, identity: expected, root: this.root, canonicalLocation: this.location(resolved) })
    ));
    if (authority === null && !optional) throw new CurrentFlowStateInvariantError("canonical source handoff checkpoint is absent");
    if (authority !== null && requireUnsettled && authority.settled) {
      throw new CurrentFlowStateConflictError("canonical source handoff is already settled");
    }
    return authority;
  }

  /** Publish one non-acceptance terminal decision with event-head CAS. */
  settleSourceHandoff({ specId = null, settlement, expectedAttempt = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (!(settlement instanceof SourceHandoffSettlement) || settlement.kind === "accepted") {
      throw new CurrentFlowStateInvariantError("standalone source handoff settlement must be a typed non-acceptance decision");
    }
    const authority = this.readSourceHandoffAuthority({ specId: resolved, identity: settlement.identity });
    if (authority.settled) {
      if (authority.settlement.digest !== settlement.digest) {
        throw new CurrentFlowStateConflictError("source handoff has a different terminal settlement");
      }
      return authority;
    }
    const expected = expectedAttempt === null
      ? CurrentAttemptIdentity.from(settlement.identity.attempt)
      : CurrentAttemptIdentity.from(expectedAttempt);
    const identityAttempt = CurrentAttemptIdentity.from(settlement.identity.attempt);
    if (expected.id !== identityAttempt.id || expected.nodeId !== identityAttempt.nodeId || expected.sequence !== identityAttempt.sequence) {
      throw new CurrentFlowStateInvariantError("source handoff settlement expected Attempt does not match its identity");
    }
    if (settlement.checkpointDigest !== authority.checkpoint.digest
      || settlement.eventDigest !== authority.event.digest) {
      throw new CurrentFlowStateConflictError("source handoff settlement does not bind the canonical event head");
    }
    this.publishArtifacts({
      specId: resolved,
      nodeId: settlement.identity.nodeId,
      artifactWrites: sourceHandoffArtifactWrites({ settlement }),
      admission: new SourceHandoffPersistenceAdmission({
        identity: settlement.identity,
        checkpoint: authority.checkpoint,
        expectedCheckpointDigest: authority.checkpoint.digest,
        expectedPreviousEventDigest: authority.event.digest,
        settlement,
      }),
    });
    return this.readSourceHandoffAuthority({ specId: resolved, identity: settlement.identity });
  }

  /** Enumerate canonical checkpoints; runtime handoff directories are never discovery authority. */
  sourceHandoffAuthorities({ specId = null, unsettledOnly = false } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) return Object.freeze([]);
    return this.runtime.readCanonicalTransitionView(resolved, (view) => {
      const settled = readSettledSourceHandoffAuthoritiesFromView({ view });
      const settledIds = new Set(settled.map((entry) => entry.identity.storageId));
      const identities = view.catalog.artifacts
        .filter((entry) => entry.logicalKey === "source.handoff.checkpoint")
        .map((descriptor) => {
          let document;
          try { document = JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8")); } catch (cause) {
            throw new CurrentFlowStateInvariantError(`canonical source handoff checkpoint is invalid: ${cause.message}`);
          }
          return new SourceWorkerHandoffIdentity(document.identity);
        })
        .filter((identity) => !unsettledOnly || !settledIds.has(identity.storageId));
      const authorities = identities.map((entry) => readSourceHandoffAuthorityFromView({
        view, identity: entry, root: this.root, canonicalLocation: this.location(resolved),
      }));
      return Object.freeze(authorities.filter((entry) => !unsettledOnly || !entry.settled));
    });
  }

  settledSourceHandoffAuthorities({ specId = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) return Object.freeze([]);
    return this.runtime.readCanonicalTransitionView(resolved, (view) => (
      readSettledSourceHandoffAuthoritiesFromView({ view })
    ));
  }

  promoteDraftQuestionAndKeepRefineActive({
    specId = null,
    questionId,
    questionRevision,
    digest,
    byteLength,
    sourceBytes,
    sourcePayloadDigest,
    handoffDigest,
    handoffRequestDigest,
  } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (typeof questionId !== "string" || questionId.trim() === "") throw new CurrentFlowStateInvariantError("draft promotion questionId is required");
    if (!Number.isSafeInteger(questionRevision) || questionRevision < 0) throw new CurrentFlowStateInvariantError("draft promotion questionRevision is invalid");
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(byteLength) || byteLength < 0) throw new CurrentFlowStateInvariantError("draft promotion baseline is invalid");
    if (!Buffer.isBuffer(sourceBytes)) throw new CurrentFlowStateInvariantError("draft promotion sourceBytes are required");
    if (typeof sourcePayloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(sourcePayloadDigest)) {
      throw new CurrentFlowStateInvariantError("draft promotion sourcePayloadDigest is invalid");
    }
    if (typeof handoffDigest !== "string" || !/^[a-f0-9]{64}$/.test(handoffDigest)) {
      throw new CurrentFlowStateInvariantError("draft promotion handoffDigest is invalid");
    }
    if (typeof handoffRequestDigest !== "string" || !/^[a-f0-9]{64}$/.test(handoffRequestDigest)) {
      throw new CurrentFlowStateInvariantError("draft promotion handoffRequestDigest is invalid");
    }
    const actualSourceDigest = crypto.createHash("sha256").update(sourceBytes).digest("hex");
    if (actualSourceDigest !== sourcePayloadDigest) {
      throw new CurrentFlowStateInvariantError("draft promotion sourceBytes do not match sourcePayloadDigest");
    }
    let sourceDraft;
    try {
      sourceDraft = new DraftLifecycle(JSON.parse(sourceBytes.toString("utf8")));
    } catch (cause) {
      throw new CurrentFlowStateInvariantError(`draft promotion source draft is invalid: ${cause.message}`);
    }
    let promotedDraft;
    try {
      promotedDraft = sourceDraft.withQuestionLedger(
        sourceDraft.questionLedger.transitionCandidate(questionId, questionRevision),
      );
    } catch (cause) {
      throw new CurrentFlowStateInvariantError(`draft promotion does not match source ledger: ${cause.message}`);
    }
    const promotedBytes = Buffer.from(`${JSON.stringify(promotedDraft, null, 2)}\n`, "utf8");
    this.#assertDraftPublication("draft-refine", [{ logicalKey: "draft", bytes: promotedBytes }]);
    const promotedDigest = crypto.createHash("sha256").update(promotedBytes).digest("hex");
    const state = this.runtime.load(resolved);
    if (state.current?.at(-1) !== "draft-refine" || state.attempt === null) throw new CurrentFlowStateInvariantError("draft promotion requires active draft-refine");
    return this.runtime.publishArtifacts({
      specId: resolved, activityId: activityId("draft-question-promoted"), nodeId: "draft-refine",
      expectedAttempt: CurrentAttemptIdentity.from(state.attempt),
      artifactBaselines: [new CanonicalFlowArtifactBaseline({ logicalKey: "draft", digest, byteLength })],
      artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: promotedBytes }],
      references: new ActivityReferences({
        evaluations: [],
        findings: [],
        repairs: [],
        artifacts: [
          { id: handoffDigest, label: "draft-refine handoff" },
          { id: handoffRequestDigest, label: "draft-refine handoff request" },
          { id: sourcePayloadDigest, label: "draft-refine sealed draft payload" },
          { id: promotedDigest, label: `draft question ${questionId}@${questionRevision} promoted artifact` },
        ],
      }),
    });
  }

  /** System-only writer for the upgrade command's sole durable evidence. */
  publishUpgradeResult({ specId = null, artifact } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (artifact?.logicalKey !== "upgrade.result") {
      throw new CurrentFlowStateInvariantError("canonical upgrade publication requires upgrade.result");
    }
    if (artifact.mediaType !== "application/json" || !Buffer.isBuffer(artifact.bytes)) {
      throw new CurrentFlowStateInvariantError("canonical upgrade publication requires JSON Buffer bytes");
    }
    let document;
    try {
      document = JSON.parse(artifact.bytes.toString("utf8"));
    } catch (cause) {
      throw new CurrentFlowStateInvariantError(`canonical upgrade result must be JSON: ${cause.message}`);
    }
    const validation = validateUpgradeResultArtifact(document);
    if (!validation.ok) {
      throw new CurrentFlowStateInvariantError(`canonical upgrade result is invalid: ${validation.reason}`);
    }
    if (document.dryRun === true) {
      throw new CurrentFlowStateInvariantError("canonical upgrade result must record a materialized upgrade");
    }
    return this.runtime.publishUpgradeResult({
      specId: resolved,
      activityId: activityId("upgrade-result-published"),
      artifactWrite: artifact,
    });
  }

  publishPluginArtifacts({ specId = null, artifactWrites } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    return this.runtime.publishPluginArtifacts({
      specId: resolved,
      activityId: activityId("plugin-artifacts-published"),
      artifactWrites,
    });
  }

  /**
   * Atomically apply one Task implementation's additions-only overview
   * contribution. The catalog remains the reader/writer authority for
   * spec.json; no command gets a Version path or a mutable state callback.
   */
  updateTaskOverview({ specId = null, taskId, additions } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const update = new CanonicalOverviewUpdate({ taskId, additions });
    const state = this.runtime.load(resolved);
    const nodeId = state.current?.at(-1) ?? null;
    update.assertActiveNode(nodeId);
    const current = this.readArtifact({
      specId: resolved,
      logicalKey: "spec.record",
      consumerNodeId: nodeId,
    });
    let document;
    try {
      document = JSON.parse(current.bytes.toString("utf8"));
    } catch (error) {
      throw new CurrentFlowStateInvariantError(`canonical spec.json is invalid: ${error.message}`);
    }
    const outcome = update.applyTo(document);
    if (!outcome.applied) return outcome.toJSON();
    this.runtime.updateSpecRecord({
      specId: resolved,
      activityId: activityId("spec-record-updated"),
      nodeId,
      specRecord: new CurrentFlowSpecRecord(outcome.document, { specId: resolved }),
    });
    return outcome.toJSON();
  }

  /** Apply user confirmation to the sole cataloged Spec record. */
  updateSpecApproval({ specId = null, approval } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const nodeId = state.current?.at(-1) ?? null;
    if (nodeId !== "approval") {
      throw new CurrentFlowStateInvariantError("canonical Spec approval requires the active approval Attempt");
    }
    const update = approval instanceof CanonicalSpecApproval
      ? approval
      : new CanonicalSpecApproval(approval);
    const source = this.readArtifact({
      specId: resolved,
      logicalKey: "spec.record",
      consumerNodeId: nodeId,
    });
    const next = update.apply(JSON.parse(source.bytes.toString("utf8")));
    this.runtime.updateSpecRecord({
      specId: resolved,
      activityId: activityId("spec-approval-recorded"),
      nodeId,
      specRecord: new CurrentFlowSpecRecord(next, { specId: resolved }),
    });
    return update.toJSON();
  }

  /**
   * Parent-owned approval continuation. Task admission happens while the
   * approval Attempt remains active; a crash can therefore only replay the
   * missing additions before the one confirmation that writes approval.
   */
  approveSpecContinuation({ specId = null, approval, expectedSpecDigest = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const update = approval instanceof CanonicalSpecApproval
      ? approval
      : new CanonicalSpecApproval(approval);
    let state = this.runtime.load(resolved);
    if (state.current?.at(-1) !== "approval") {
      throw new CurrentFlowStateInvariantError("canonical Spec approval requires the active approval Attempt");
    }
    const source = this.readArtifact({
      specId: resolved,
      logicalKey: "spec.record",
      consumerNodeId: "approval",
    });
    if (expectedSpecDigest !== null && source.descriptor.hash !== expectedSpecDigest) {
      throw new CurrentFlowStateConflictError("canonical spec.record changed before approval confirmation");
    }
    const document = JSON.parse(source.bytes.toString("utf8"));
    const sourceHash = source.descriptor.hash;
    const taskContainer = state.findNode(state.definition.dynamicTaskContainerId);
    const existing = new Set((taskContainer?.steps || []).map((task) => task.id));
    const added = [];
    for (const task of new TaskCollection(document.tasks ?? []).admissionOrder()) {
      if (existing.has(task.id.value)) continue;
      const currentSource = this.readArtifact({
        specId: resolved,
        logicalKey: "spec.record",
        consumerNodeId: "approval",
      });
      if (currentSource.descriptor.hash !== sourceHash) {
        throw new CurrentFlowStateConflictError("canonical spec.record changed during approval Task admission");
      }
      const currentDocument = JSON.parse(currentSource.bytes.toString("utf8"));
      const sourceTask = (currentDocument.tasks ?? []).find((candidate) => candidate.id === task.id.value) ?? null;
      if (sourceTask === null) {
        throw new CurrentFlowStateConflictError(`canonical spec.record lost approval Task: ${task.id.value}`);
      }
      const { id, parent, ...taskDocument } = task;
      this.#addApprovalTask({
        id: id.value,
        parent: parent === null ? null : parent.value,
        ...structuredClone(taskDocument),
      }, {
        specId: resolved,
        sourceDescriptor: currentSource.descriptor,
        sourceTask,
      });
      existing.add(id.value);
      added.push(id.value);
      state = this.runtime.load(resolved);
    }
    const existingApproval = document.user_approval?.approved === true
      ? document.user_approval
      : null;
    const approvedDocument = existingApproval === null ? update.apply(document) : document;
    const confirmedAt = existingApproval?.confirmed_at ?? update.confirmedAt;
    this.runtime.confirmAttempt({
      specId: resolved,
      activityId: activityId("spec-approval-confirmed"),
      result: {
        outcome: "passed",
        summary: "explicit Spec approval confirmed",
        confirmedAt,
        artifactRefs: [],
      },
      specRecord: new CurrentFlowSpecRecord(approvedDocument, { specId: resolved }),
    });
    return Object.freeze({ user_approval: update.toJSON(), added: Object.freeze(added) });
  }

  /**
   * Append one durable issue fact through the current producer's Activity.
   *
   * This replaces the former independent issue-log file writer for normal
   * runtime paths: the catalog descriptor and its append-only publication
   * Activity are now committed by this same Version Store boundary.
   */
  appendIssueLog({ specId = null, entry, idempotencyKey, admission = undefined } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const nodeId = state.current?.at(-1) ?? null;
    if (nodeId === null) throw new CurrentFlowStateInvariantError("canonical issue-log append requires an active Attempt");
    const key = requiredText(idempotencyKey, "canonical issue-log idempotencyKey");
    const existing = this.readArtifact({
      specId: resolved,
      logicalKey: "issue.log",
      consumerNodeId: nodeId,
      optional: true,
    });
    let document;
    try {
      document = new IssueLogDocument(existing === null
        ? { entries: [] }
        : JSON.parse(existing.bytes.toString("utf8")));
    } catch (error) {
      throw new CurrentFlowStateInvariantError(`canonical issue-log is invalid: ${error.message}`);
    }
    const appended = document.append(canonicalIssueLogEntry(entry), key);
    if (!appended.appended) {
      return Object.freeze({ ...appended, total: document.entries.length });
    }
    const taskSettlement = admission instanceof TaskGateSettlementAdmission
      && admission.effect === "issue-log";
    if (taskSettlement && key !== entry?.issueLogId) {
      throw new CurrentFlowStateInvariantError("Task Gate issue-log settlement requires its stable idempotency key");
    }
    this.publishArtifacts({
      specId: resolved,
      nodeId,
      artifactWrites: [{
        logicalKey: "issue.log",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(document.toJSON(), null, 2)}\n`, "utf8"),
      }],
      admission,
      publicationActivityId: taskSettlement ? admission.issueLogActivityId() : null,
    });
    return Object.freeze({ ...appended, total: document.entries.length });
  }

  /** Atomically merge a requirement's file-map paths through its catalog contract. */
  updateFileMap({ specId = null, requirementId, paths } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const nodeId = state.current?.at(-1) ?? null;
    const updater = nodeId === null ? null : FlowArtifactUpdater.fromActivityNodeId(nodeId).toString();
    if (updater !== "implement" && updater !== "task-impl") {
      throw new CurrentFlowStateInvariantError("canonical file-map updates require an active implementation Attempt");
    }
    const update = new CanonicalFileMapUpdate({ requirementId, paths });
    const spec = JSON.parse(this.readArtifact({
      specId: resolved, logicalKey: "spec.record", consumerNodeId: nodeId,
    }).bytes.toString("utf8"));
    const current = this.readArtifact({
      specId: resolved, logicalKey: "file.map", consumerNodeId: nodeId, optional: true,
    });
    const fileMap = current === null ? {} : JSON.parse(current.bytes.toString("utf8"));
    const next = update.apply({ spec, fileMap });
    this.publishArtifacts({
      specId: resolved,
      nodeId,
      artifactWrites: [{
        logicalKey: "file.map",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"),
      }],
    });
    return next;
  }

  recordDispatchApproval({ specId = null, receipt } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const normalized = new ActivityDispatchApproval(receipt).toJSON();
    const snapshot = this.runtime.loadSnapshot(resolved);
    if (normalized.runId !== snapshot.state.runId) {
      throw new CurrentFlowStateInvariantError("canonical dispatch approval receipt runId does not match the Flow");
    }
    const existing = projectDispatchApprovals(snapshot.activities)
      .find((candidate) => candidate.actionDigest === normalized.actionDigest) ?? null;
    if (existing !== null) {
      if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
        throw new CurrentFlowStateInvariantError("canonical dispatch approval cannot replace its exact receipt");
      }
      return existing;
    }
    this.runtime.recordDispatchApproval({
      specId: resolved,
      activityId: `dispatch-approval-${normalized.approvalToken}`,
      approval: normalized,
    });
    return normalized;
  }

  /**
   * The persisted outbox is deliberately just the active work set.  Begin,
   * completion, and failure are typed Activities, so recovery derives prior
   * outcomes from the journal instead of reviving an old mutable outbox blob.
   */
  beginOutbox({ specId = null, id, operation } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const outbox = canonicalOutboxInput({ id, operation });
    const existing = this.outboxStatus({ specId: resolved, ...outbox });
    if (["pending", "done"].includes(existing.status)) return existing;
    this.runtime.beginOutbox({
      specId: resolved,
      activityId: activityId("outbox-started"),
      outbox: canonicalOutboxActivity({
        outbox,
        attempt: existing.status === "failed" ? existing.attempt + 1 : 1,
      }),
    });
    return this.outboxStatus({ specId: resolved, ...outbox });
  }

  completeOutbox({ specId = null, id, operation, result = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const outbox = canonicalOutboxInput({ id, operation });
    const existing = this.outboxStatus({ specId: resolved, ...outbox });
    if (existing.status === "done") return existing;
    if (existing.status !== "pending") {
      throw new CurrentFlowStateInvariantError("canonical outbox completion requires an outstanding operation");
    }
    this.runtime.completeOutbox({
      specId: resolved,
      activityId: activityId("outbox-completed"),
      outbox: canonicalOutboxActivity({
        outbox,
        attempt: existing.attempt,
        result,
        exactRecoveryReceipt: existing.exactRecoveryReceipt,
      }),
    });
    return Object.freeze({ ...this.outboxStatus({ specId: resolved, ...outbox }), result });
  }

  failOutbox({ specId = null, id, operation, failure, failureCode = null, recovery = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const outbox = canonicalOutboxInput({ id, operation });
    const existing = this.outboxStatus({ specId: resolved, ...outbox });
    if (existing.status !== "pending") {
      throw new CurrentFlowStateInvariantError("canonical outbox failure requires an outstanding operation");
    }
    this.runtime.failOutbox({
      specId: resolved,
      activityId: activityId("outbox-failed"),
      outbox: canonicalOutboxActivity({
        outbox,
        attempt: existing.attempt,
        failure: requiredText(failure, "canonical outbox failure"),
        failureCode,
        recovery,
        exactRecoveryReceipt: existing.exactRecoveryReceipt,
      }),
    });
    return this.outboxStatus({ specId: resolved, ...outbox });
  }

  reopenOutboxExact({ specId = null, id, operation, attempt, failure, recoveryKey = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const outbox = canonicalOutboxInput({ id, operation });
    const existing = this.outboxStatus({ specId: resolved, ...outbox });
    if (existing.status !== "failed") {
      throw new CurrentFlowStateInvariantError("exact recovery requires a failed canonical outbox entry");
    }
    if (existing.attempt !== attempt) {
      throw new CurrentFlowStateInvariantError("exact recovery attempt does not match the canonical outbox entry");
    }
    if (existing.failure !== failure) {
      throw new CurrentFlowStateInvariantError("exact recovery failure does not match the canonical outbox entry");
    }
    if (
      existing.exactRecoveryReceipt !== null
      && (
        recoveryKey === null
        || existing.exactRecoveryReceipt.recoveryKey === recoveryKey
      )
    ) {
      throw new CurrentFlowStateInvariantError("exact recovery was already consumed for this canonical outbox entry");
    }
    this.runtime.reopenOutbox({
      specId: resolved,
      activityId: stableActivityId("outbox-reopened", {
        id: outbox.id,
        operation: outbox.operation,
        attempt,
        failure,
        recoveryKey,
      }),
      timing: (() => {
        const recoveredAt = timestampAfter(existing.updatedAt);
        return { startedAt: recoveredAt, finishedAt: recoveredAt, durationMs: 0 };
      })(),
      outbox: canonicalOutboxActivity({
        outbox,
        attempt,
        exactRecoveryReceipt: {
          idempotencyKey: outbox.id,
          attempt,
          failure,
          recoveryKey,
        },
      }),
    });
    return this.outboxStatus({ specId: resolved, ...outbox });
  }

  outboxStatus({ specId = null, id, operation } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const outbox = canonicalOutboxInput({ id, operation });
    const snapshot = this.runtime.loadSnapshot(resolved);
    const confirmedActivities = snapshot.activities.slice(0, snapshot.state.confirmationOrder);
    const matching = confirmedActivities.filter((activity) => (
      activity.transition.outbox !== null && activity.transition.outbox.id === outbox.id
    ));
    for (const activity of matching) {
      if (activity.transition.outbox.operation !== outbox.operation) {
        throw new CurrentFlowStateInvariantError("canonical outbox id cannot change its operation");
      }
    }
    const latest = matching.at(-1) ?? null;
    const active = snapshot.state.outbox.find(outbox.id);
    if (active !== null && active.operation !== outbox.operation) {
      throw new CurrentFlowStateInvariantError("canonical outbox id cannot change its operation");
    }
    const attempts = matching.map((activity) => activity.transition.outbox.attempt);
    const timing = latest?.timing?.toJSON() ?? null;
    const status = active !== null
      ? "pending"
      : latest?.transition.operation === "complete_outbox"
        ? "done"
        : ["fail_outbox", "recover_interrupted_finalize_sync"].includes(latest?.transition.operation)
          ? "failed"
          : "missing";
    return Object.freeze({
      ...outbox,
      status,
      attempt: attempts.at(-1) ?? 0,
      startedAt: matching.findLast((activity) => (
        activity.transition.outbox.attempt === attempts.at(-1)
        && ["begin_outbox", "reopen_outbox"].includes(activity.transition.operation)
      ))?.timing?.startedAt ?? null,
      updatedAt: timing?.finishedAt ?? null,
      failure: latest?.transition.outbox?.failure ?? null,
      failureHistory: Object.freeze(matching
        .filter((activity) => ["fail_outbox", "recover_interrupted_finalize_sync"].includes(activity.transition.operation))
        .map((activity) => Object.freeze({
          attempt: activity.transition.outbox.attempt,
          failure: activity.transition.outbox.failure,
          recordedAt: activity.timing?.finishedAt ?? null,
          code: activity.transition.outbox.failureCode,
          recovery: activity.transition.outbox.recovery?.toJSON() ?? null,
        }))),
      exactRecoveryReceipt: latest?.transition.outbox?.exactRecoveryReceipt?.toJSON() ?? null,
      result: latest?.transition.outbox?.result?.toJSON() ?? null,
      activityId: latest?.id ?? null,
    });
  }

  /**
   * The normal worker completion boundary.  One Store operation appends the
   * confirmation Activity, advances flow.json, writes producer-owned bytes,
   * and replaces the catalog descriptors.  It deliberately accepts no
   * mutable flow-state callback.
   */
  confirmCurrentAttempt({ specId = null, status = "done", result = null, references = undefined, specRecord = undefined, artifactWrites = [], artifactRemovals = undefined, artifactBaselines = undefined, testSourceBaseline = undefined, gateTransitionDecision = null, gateTaskLifecycle = undefined } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    if (state.current === null) throw new CurrentFlowStateInvariantError("canonical completion requires an active Attempt");
    const nodeId = state.current.at(-1);
    const confirmation = result ?? resultFor(status, nodeId);
    const sealedTaskLifecycle = this.#taskGatePassLifecycle({
      state,
      nodeId,
      status,
      decision: gateTransitionDecision,
      suppliedLifecycle: gateTaskLifecycle,
    });
    this.#integrationGatePassAdmission({
      state,
      nodeId,
      status,
      decision: gateTransitionDecision,
    });
    return this.runtime.confirmAttempt({
      specId: resolved,
      activityId: activityId("attempt-confirmed"),
      status,
      result: confirmation,
      references,
      specRecord,
      artifactWrites,
      artifactRemovals,
      artifactBaselines,
      testSourceBaseline,
      gateTaskLifecycle: sealedTaskLifecycle,
      ...(status === "done" && { admission: new CombinedAdmission(
        this.#producerCompletionAdmission(nodeId, artifactWrites),
        sealedTaskLifecycle === null ? null : new TaskGateSettlementAdmission(gateTransitionDecision, "terminal"),
      ) }),
    });
  }

  /**
   * Apply the one Definition-selected coverage-repair completion decision.
   * The Store never chooses a connector: it validates the selected facts,
   * publishes the selected draft derivation, and confirms repair together.
   */
  confirmDraftCoverageRepairCompletion({
    specId = null,
    decision,
    draft,
    result = null,
    references = undefined,
    artifactWrites = [],
    artifactRemovals = undefined,
    artifactBaselines = [],
  } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (!(decision instanceof DraftCoverageRepairCompletionDecision)) {
      throw new CurrentFlowStateInvariantError("draft coverage repair completion requires a Definition-selected decision");
    }
    const { facts, connector } = decision;
    const state = this.runtime.load(resolved);
    const sourceNode = state.findNode(facts.sourceStepId);
    const repairWrites = artifactWrites.filter((entry) => entry?.logicalKey === "draft.coverage.repair");
    if (repairWrites.length > 1) {
      throw new CurrentFlowStateInvariantError("draft coverage repair completion has duplicate repair audit publications");
    }
    const repairWrite = repairWrites[0] ?? null;
    if (sourceNode?.status === "done") {
      const completionActivity = this.runtime.activities(resolved).findLast(
        (activity) => activity.transition.operation === "complete_draft_completion"
          && activity.transition.stepConnectionReceipt?.sourceStepId === facts.sourceStepId,
      ) ?? null;
      if (completionActivity === null) {
        throw new CurrentFlowStateInvariantError("completed draft coverage repair has no Step connection receipt");
      }
      const receipt = StepConnectionReceipt.fromJSON(
        completionActivity.transition.stepConnectionReceipt.toJSON(),
      );
      const replayDraft = connector.applyTo(draft);
      if (!receipt.matchesReplay({
        connector,
        facts,
        publishedDraft: replayDraft,
        repairArtifactBytes: repairWrite?.bytes ?? null,
      })) {
        throw new CurrentFlowStateInvariantError("draft coverage repair completion rejected a stale completed plan");
      }
      return state;
    }
    if (state.current !== null && (
      state.current.at(-1) !== facts.sourceStepId
      || state.attempt?.failure !== null
    )) {
      throw new CurrentFlowStateInvariantError("draft coverage repair completion does not own the active Attempt");
    }
    const source = this.readArtifact({
      specId: resolved,
      logicalKey: "draft",
      consumerNodeId: facts.sourceStepId,
    });
    if (
      source.descriptor.hash !== facts.draftDigest
      || source.descriptor.size !== facts.draftByteLength
    ) {
      throw new CurrentFlowStateInvariantError("draft coverage repair completion rejected a stale canonical draft revision");
    }
    const review = this.readArtifact({
      specId: resolved, logicalKey: "draft.coverage.review", consumerNodeId: facts.sourceStepId,
    });
    if (review.descriptor.hash !== facts.reviewArtifactDigest) {
      throw new CurrentFlowStateInvariantError("draft coverage repair completion rejected a stale coverage review artifact");
    }
    const reviewDocument = CanonicalCommandAttemptArtifactHistory.fromBytes({
      logicalKey: "draft.coverage.review", bytes: review.bytes,
    }).current.payload;
    if (reviewDocument.verdict !== facts.reviewVerdict
      || (reviewDocument.sourceDraftRevision?.digest ?? null) !== facts.reviewDraftDigest) {
      throw new CurrentFlowStateInvariantError("draft coverage repair completion facts do not match the canonical coverage review");
    }
    let triagePublication = null;
    if (facts.triageArtifactDigest !== null) {
      triagePublication = this.readArtifact({
        specId: resolved, logicalKey: "draft.coverage.triage", consumerNodeId: facts.sourceStepId,
      });
      if (triagePublication.descriptor.hash !== facts.triageArtifactDigest) {
        throw new CurrentFlowStateInvariantError("draft coverage repair completion rejected a stale coverage triage artifact");
      }
      let triageDocument;
      try {
        triageDocument = JSON.parse(triagePublication.bytes.toString("utf8"));
      } catch (cause) {
        throw new CurrentFlowStateInvariantError(`draft coverage repair completion triage artifact is invalid: ${cause.message}`);
      }
      if (draftCompletionDocumentDigest(triageDocument) !== facts.triageDocumentDigest) {
        throw new CurrentFlowStateInvariantError("draft coverage repair completion facts do not match the canonical coverage triage");
      }
    }
    const questionsReview = this.runtime.catalog(resolved).artifacts
      .find((artifact) => artifact.logicalKey === "draft.questions.review") ?? null;
    if (questionsReview === null || questionsReview.hash !== facts.questionsReviewArtifactDigest) {
      throw new CurrentFlowStateInvariantError("draft coverage repair completion rejected a stale questions review artifact");
    }
    if (draftCompletionDocumentDigest(draft) !== facts.draftDocumentDigest) {
      throw new CurrentFlowStateInvariantError("draft coverage repair completion rejected a changed selected draft");
    }
    if (!isDraftCompletionConnector(connector)) {
      throw new CurrentFlowStateInvariantError("draft coverage repair completion connector is invalid");
    }
    const publishedDraft = connector.applyTo(draft);
    const publishedDraftBytes = Buffer.from(`${JSON.stringify(publishedDraft, null, 2)}\n`, "utf8");
    const baseline = new CanonicalFlowArtifactBaseline({
      logicalKey: "draft",
      digest: facts.draftDigest,
      byteLength: facts.draftByteLength,
    });
    const suppliedBaselines = artifactBaselines.map((entry) => CanonicalFlowArtifactBaseline.from(entry));
    const suppliedDraftBaseline = suppliedBaselines.find((entry) => entry.artifact.logicalKey === "draft") ?? null;
    if (suppliedDraftBaseline !== null && (
      suppliedDraftBaseline.digest !== baseline.digest
      || suppliedDraftBaseline.byteLength !== baseline.byteLength
    )) {
      throw new CurrentFlowStateInvariantError("draft coverage repair completion baseline conflicts with the selected revision");
    }
    const factBaselines = [baseline];
    factBaselines.push(new CanonicalFlowArtifactBaseline({
      logicalKey: "draft.coverage.review", digest: review.descriptor.hash, byteLength: review.descriptor.size,
    }));
    if (facts.triageArtifactDigest !== null) {
      factBaselines.push(new CanonicalFlowArtifactBaseline({
        logicalKey: "draft.coverage.triage", digest: triagePublication.descriptor.hash, byteLength: triagePublication.descriptor.size,
      }));
    }
    factBaselines.push(new CanonicalFlowArtifactBaseline({
      logicalKey: "draft.questions.review", digest: questionsReview.hash, byteLength: questionsReview.size,
    }));
    const baselineByPath = new Map();
    for (const candidate of [...suppliedBaselines, ...factBaselines]) {
      const previous = baselineByPath.get(candidate.artifact.relativePath) ?? null;
      if (previous !== null && (previous.digest !== candidate.digest || previous.byteLength !== candidate.byteLength)) {
        throw new CurrentFlowStateInvariantError("draft coverage repair completion has conflicting fact baselines");
      }
      baselineByPath.set(candidate.artifact.relativePath, candidate);
    }
    const baselines = [...baselineByPath.values()];
    if (artifactWrites.some((entry) => entry?.logicalKey === "draft")) {
      throw new CurrentFlowStateInvariantError("draft coverage repair completion owns the only draft publication");
    }
    const publishesDraft = true;
    const writes = [
      ...(publishesDraft ? [{
        logicalKey: "draft",
        mediaType: "application/json",
        bytes: publishedDraftBytes,
      }] : []),
      ...artifactWrites,
    ];
    const sourceAttempt = state.current?.at(-1) === facts.sourceStepId
      ? state.attempt
      : new CurrentAttempt(commandContextAttempt(state, facts.sourceStepId));
    const sourceClaim = state.executableStepClaim({
      nodeId: facts.sourceStepId,
      attempt: sourceAttempt,
    });
    const sourceAttemptIdentity = {
      id: sourceClaim.identity.id,
      sequence: sourceClaim.identity.sequence,
    };
    const catalog = this.runtime.catalog(resolved);
    const activities = this.runtime.activities(resolved).map((activity) => activity.toJSON());
    const completionActivityId = activityId("draft-coverage-repair-confirmed");
    if (facts.source === "coverage-repair" && repairWrite === null) {
      throw new CurrentFlowStateInvariantError("draft coverage repair completion requires its canonical repair audit publication");
    }
    if ((repairWrite === null) !== (facts.repairDocumentDigest === null)) {
      throw new CurrentFlowStateInvariantError("draft coverage repair completion repair facts do not match its publication plan");
    }
    if (repairWrite !== null) {
      let repairDocument;
      try {
        repairDocument = JSON.parse(repairWrite.bytes.toString("utf8"));
      } catch (cause) {
        throw new CurrentFlowStateInvariantError(`draft coverage repair completion repair artifact is invalid: ${cause.message}`);
      }
      if (facts.repairDocumentDigest === null
        || draftCompletionDocumentDigest(repairDocument) !== facts.repairDocumentDigest) {
        throw new CurrentFlowStateInvariantError("draft coverage repair completion facts do not match the canonical repair audit");
      }
    }
    const lineage = new DraftCompletionLineage({
      questionsReview: draftCompletionLineageBinding({
        catalog, activities, logicalKey: "draft.questions.review", expectedDigest: facts.questionsReviewArtifactDigest,
        expectedByteLength: questionsReview.size,
      }),
      questionsRefine: draftCompletionLineageBinding({
        catalog, activities, logicalKey: "draft", expectedDigest: facts.draftDigest, expectedByteLength: facts.draftByteLength,
      }),
      coverageReview: draftCompletionLineageBinding({
        catalog, activities, logicalKey: "draft.coverage.review", expectedDigest: facts.reviewArtifactDigest,
        expectedByteLength: review.descriptor.size,
      }),
      coverageTriage: facts.triageArtifactDigest === null
        ? new DraftCompletionAbsentLineage({
          logicalKey: "draft.coverage.triage",
          reason: facts.source === "coverage-pass" ? "coverage-pass" : "missing-selected-lineage",
        })
        : draftCompletionLineageBinding({
          catalog, activities, logicalKey: "draft.coverage.triage", expectedDigest: facts.triageArtifactDigest,
          expectedByteLength: catalog.artifacts.find((entry) => entry.logicalKey === "draft.coverage.triage")?.size,
        }),
      coverageRepair: repairWrite === null
        ? new DraftCompletionAbsentLineage({ logicalKey: "draft.coverage.repair", reason: "coverage-pass" })
        : draftCompletionOutputBinding({
          logicalKey: "draft.coverage.repair",
          bytes: repairWrite.bytes,
          activityId: completionActivityId,
          attempt: sourceAttemptIdentity,
        }),
      canonicalDraft: draftCompletionLineageBinding({
        catalog, activities, logicalKey: "draft", expectedDigest: facts.draftDigest, expectedByteLength: facts.draftByteLength,
      }),
    });
    const receipt = createDraftCompletionReceipt({
      connector,
      sourceAttempt: sourceAttemptIdentity,
      draftInput: { digest: facts.draftDigest, byteLength: facts.draftByteLength },
      publishedDraft,
      lineage,
      decisionEvidence: new DraftCompletionDecisionEvidence({
        reviewVerdict: facts.reviewVerdict,
        reviewDraftRevision: facts.reviewDraftDigest === null ? null : { digest: facts.reviewDraftDigest, byteLength: facts.draftByteLength },
        source: facts.source,
        eligibilityIssues: [...facts.eligibilityIssues],
        triageArtifactDigest: facts.triageArtifactDigest,
        repairArtifactDigest: repairWrite === null ? null : crypto.createHash("sha256").update(repairWrite.bytes).digest("hex"),
        discardedOperationCount: facts.repair?.discardedOperations?.length ?? 0,
      }),
    });
    const connectorArtifact = {
      kind: "draft-completion-connector",
      id: receipt.id,
    };
    const baseConfirmation = result ?? {
      outcome: "passed",
      summary: "Draft coverage repair completion confirmed the canonical draft.",
      confirmedAt: new Date().toISOString(),
    };
    const confirmation = {
      ...baseConfirmation,
      artifactRefs: [...(baseConfirmation.artifactRefs ?? []), connectorArtifact],
    };
    const baseReferences = references ?? {
      evaluations: [],
      findings: [],
      repairs: [],
      artifacts: [],
    };
    const confirmationReferences = {
      ...baseReferences,
      artifacts: [...(baseReferences.artifacts ?? []), {
        id: receipt.id,
        label: "draft completion connector",
      }],
    };
    return this.runtime.completeDraftCompletion({
      specId: resolved,
      activityId: completionActivityId,
      result: confirmation,
      references: confirmationReferences,
      receipt,
      artifactWrites: writes,
      artifactRemovals,
      artifactBaselines: baselines,
      admission: this.#stepConnectionAdmission(state, facts.sourceStepId, writes),
    });
  }

  /** Settle only the acceptance-review-owned, artifactless no-op decision. */
  completeAcceptanceDecisionNoOp({ specId = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    let state = this.runtime.load(resolved);
    if (state.current === null) {
      this.#beginExecutableNode(state, resolved, "acceptance-decision");
      state = this.runtime.load(resolved);
    }
    if (state.current?.at(-1) !== "acceptance-decision" || state.attempt?.failure !== null) {
      throw new CurrentFlowStateInvariantError("acceptance decision no-op requires its active unfailed Attempt");
    }
    return this.runtime.completeAcceptanceDecisionNoOp({
      specId: resolved,
      activityId: activityId("acceptance-decision-noop-completed"),
      result: resultFor("done", "acceptance-decision"),
      references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
      admission: new AcceptanceDecisionNoOpAdmission(),
    });
  }

  /**
   * Commit a sealed source-worker effect and its Attempt confirmation in one
   * Version Store transaction. Workers never receive this surface.
   */
  confirmSourceWorkerHandoff({ specId = null, effect, mutationManifest, handoffDigest, result, upgradeResult = null, taskStageBinding = null, sourceMutationBaseline = null, sourceHandoffSettlement = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (!(effect instanceof SourceWorkerEffect)) {
      throw new CurrentFlowStateInvariantError("canonical source worker effect must be a sealed SourceWorkerEffect");
    }
    if (!(mutationManifest instanceof SourceMutationManifest)) {
      throw new CurrentFlowStateInvariantError("canonical source worker handoff requires a sealed SourceMutationManifest");
    }
    const state = this.runtime.load(resolved);
    if (state.attempt === null
      || mutationManifest.attempt.id !== state.attempt.id
      || mutationManifest.attempt.nodeId !== state.attempt.nodeId
      || mutationManifest.attempt.sequence !== state.attempt.sequence) {
      throw new CurrentFlowStateInvariantError("canonical source worker mutation manifest does not target the current Attempt");
    }
    const nodeId = state.current?.at(-1) ?? null;
    const effectTargetsActiveNode = nodeId === effect.stepId
      || (effect.stepId.startsWith("task-") && taskIdForNode(state, nodeId) !== null && nodeId === `${taskIdForNode(state, nodeId)}-${effect.stepId.slice(5)}`);
    if (!effectTargetsActiveNode) throw new CurrentFlowStateInvariantError("source worker effect does not target the active Attempt");
    if (!(sourceHandoffSettlement instanceof SourceHandoffSettlement)
      || sourceHandoffSettlement.kind !== "accepted"
      || sourceHandoffSettlement.handoffDigest !== handoffDigest) {
      throw new CurrentFlowStateInvariantError("source worker acceptance requires its typed accepted settlement");
    }
    const sourceHandoffAuthority = this.readSourceHandoffAuthority({
      specId: resolved, identity: sourceHandoffSettlement.identity,
    });
    if (sourceHandoffAuthority.settled
      || sourceHandoffSettlement.checkpointDigest !== sourceHandoffAuthority.checkpoint.digest
      || sourceHandoffSettlement.eventDigest !== sourceHandoffAuthority.event.digest) {
      throw new CurrentFlowStateConflictError("source worker settlement does not bind the unsettled canonical handoff");
    }
    const settlementWrites = sourceHandoffArtifactWrites({ settlement: sourceHandoffSettlement });
    const settlementAdmission = new SourceHandoffPersistenceAdmission({
      identity: sourceHandoffSettlement.identity,
      checkpoint: sourceHandoffAuthority.checkpoint,
      expectedCheckpointDigest: sourceHandoffAuthority.checkpoint.digest,
      expectedPreviousEventDigest: sourceHandoffAuthority.event.digest,
      settlement: sourceHandoffSettlement,
    });
    const acceptanceAdmission = new CombinedAdmission(
      settlementAdmission,
      new SourceMutationPublicationAdmission({
        baseline: sourceHandoffAuthority.checkpoint.baseline,
        manifest: mutationManifest,
      }),
    );
    const specSource = this.readArtifact({ specId: resolved, logicalKey: "spec.record", consumerNodeId: nodeId });
    let spec = JSON.parse(specSource.bytes.toString("utf8"));
    const requirementDefinitions = new CanonicalRequirementDefinitions(spec.requirements).applyTo(spec);
    spec = requirementDefinitions.document;
    const sourceTaskId = effect.stepId.startsWith("task-") ? taskIdForNode(state, nodeId) : null;
    if (effect.stepId.startsWith("task-") && sourceTaskId === null) {
      throw new CurrentFlowStateInvariantError("Task source effect requires an active canonical Task");
    }
    const requirementAuthority = CanonicalSourceRequirementAuthority.fromSpec(spec, { taskId: sourceTaskId });
    requirementAuthority.assertBindings(
      effect.files,
      mutationManifest.mutations.map((mutation) => mutation.mutationId),
    );
    if (effect.overview !== null) {
      const taskId = taskIdForNode(state, nodeId);
      if (taskId === null) throw new CurrentFlowStateInvariantError("source overview effect requires an active Task implementation");
      spec = new CanonicalOverviewUpdate({ taskId, additions: effect.overview.additions }).applyTo(spec).document;
    }
    const artifactWrites = [...settlementWrites];
    if (effect.stepId === "task-impl") {
      const taskId = taskIdForNode(state, nodeId);
      if (taskId === null) throw new CurrentFlowStateInvariantError("Task mutation lineage requires an active Task");
      const priorLineages = this.taskMutationLineages({ specId: resolved, taskId });
      const lineage = new TaskMutationLineage({
        runId: state.runId,
        specId: state.specId,
        taskId,
        role: "implementation",
        attempt: mutationManifest.attempt,
        budget: nextTaskExecutionBudget({ state, taskId, lineages: priorLineages }),
        sourceFingerprint: mutationManifest.digest,
        manifest: mutationManifest.toJSON(),
        noChangeReason: effect.noChangeReason?.text ?? null,
      });
      artifactWrites.push({
        logicalKey: "task.mutation.lineage",
        parameters: { taskId, attemptId: mutationManifest.attempt.id },
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(lineage.toJSON(), null, 2)}\n`, "utf8"),
      });
    }
    const sourceWorkerUpgrade = upgradeResult === null
      ? null
      : new CanonicalSourceWorkerUpgradeResult({ bytes: upgradeResult });
    if (sourceWorkerUpgrade !== null) artifactWrites.push(sourceWorkerUpgrade);
    if (effect.triage !== null && effect.stepId === "impl-triage") {
      artifactWrites.push({
        logicalKey: "impl.triage",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(effect.triage.toJSON(), null, 2)}\n`, "utf8"),
      });
    }
    if (effect.files.length > 0) {
      const existing = this.readArtifact({ specId: resolved, logicalKey: "file.map", consumerNodeId: nodeId, optional: true });
      let fileMap = existing === null ? {} : JSON.parse(existing.bytes.toString("utf8"));
      for (const change of effect.files) {
        fileMap = new CanonicalFileMapUpdate({ requirementId: change.requirementId, paths: change.resolvePaths(mutationManifest) })
          .apply({ spec, fileMap });
      }
      artifactWrites.push({ logicalKey: "file.map", mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(fileMap, null, 2)}\n`, "utf8") });
    }
    if (effect.issues.length > 0 && effect.stepId !== "task-repair") {
      const recoveryPlan = resolveSourceQualityIssueRecoveryPlan({ sourceStep: effect.stepId, taskId: sourceTaskId });
      if (recoveryPlan === null) {
        throw new CurrentFlowStateInvariantError("source quality issues have no eligible Definition-backed recovery route");
      }
      this.#appendSourceQualityIssues({
        state, effect, handoffDigest, result, artifactWrites, recoveryPlan,
      });
    }
    if (["task-triage", "task-repair"].includes(effect.stepId)) {
      return this.#confirmTaskReviewSourceStage({ state, spec, effect, mutationManifest, handoffDigest, result, artifactWrites, taskStageBinding, sourceMutationBaseline, settlementAdmission: acceptanceAdmission });
    }
    if (effect.repair !== null) {
      const repairRecord = CanonicalImplementationRepairRecord.capture({
        repair: effect.repair,
        mutationManifest,
      });
      artifactWrites.push({
        logicalKey: "impl.repair",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(repairRecord.toJSON(), null, 2)}\n`, "utf8"),
      });
      return this.runtime.repairImplementation({
        specId: resolved,
        activityId: activityId("impl-repair-invalidated"),
        attempt: commandContextAttempt(state, "test-execute"),
        result,
        references: {
          evaluations: [],
          findings: effect.repair.appliedFindingKeys.map((id) => ({ id, label: "impl-repair applied finding" })),
          repairs: [{ id: handoffDigest, label: "source worker repair handoff" }],
          artifacts: [{ id: handoffDigest, label: "worker-handoff" }],
        },
        artifactWrites,
        admission: acceptanceAdmission,
        ...(sourceWorkerUpgrade === null ? {} : { sourceWorkerUpgrade: true }),
      });
    }
    if (effect.triage !== null && effect.triage.dispositions.every((entry) => entry.disposition === "reject")) {
      return this.runtime.triageImplementationNoRepair({
        specId: resolved,
        activityId: activityId("impl-triage-no-repair"),
        attempt: commandContextAttempt(state, "impl-gate"),
        result,
        references: {
          evaluations: [],
          findings: effect.triage.dispositions.map((entry) => ({ id: entry.findingKey, label: "impl-triage rejected finding" })),
          repairs: [],
          artifacts: [{ id: handoffDigest, label: "worker-handoff" }],
        },
        artifactWrites,
        admission: acceptanceAdmission,
        ...(sourceWorkerUpgrade === null ? {} : { sourceWorkerUpgrade: true }),
      });
    }
    if (effect.triage !== null) {
      return this.runtime.triageImplementationForRepair({
        specId: resolved,
        activityId: activityId("impl-triage-repair"),
        attempt: commandContextAttempt(state, "impl-repair"),
        result,
        references: {
          evaluations: [],
          findings: effect.triage.dispositions.map((entry) => ({ id: entry.findingKey, label: "impl-triage applying finding" })),
          repairs: [{ id: handoffDigest, label: "source worker triage handoff" }],
          artifacts: [{ id: handoffDigest, label: "worker-handoff" }],
        },
        artifactWrites,
        admission: acceptanceAdmission,
        ...(sourceWorkerUpgrade === null ? {} : { sourceWorkerUpgrade: true }),
      });
    }
    const sourceSpecChanged = requirementDefinitions.changed || effect.overview !== null;
    return this.runtime.confirmAttempt({
      specId: resolved,
      activityId: activityId(nodeId === "impl-repair" ? "impl-repair-invalidation-confirmed" : "source-handoff-confirmed"),
      result,
      status: effect.completionStatus,
      ...(sourceSpecChanged ? { specRecord: new CanonicalSourceWorkerSpecCompletion(spec) } : {}),
      artifactWrites,
      admission: new CombinedAdmission(
        acceptanceAdmission,
        effect.completionStatus === "done" ? this.#producerCompletionAdmission(nodeId, artifactWrites) : null,
      ),
      ...(sourceWorkerUpgrade === null ? {} : { sourceWorkerUpgrade: true }),
    });
  }

  #confirmTaskReviewSourceStage({ state, spec, effect, mutationManifest, handoffDigest, result, artifactWrites, taskStageBinding, sourceMutationBaseline, settlementAdmission }) {
    state.assertAttemptConfirmable();
    if (!(taskStageBinding instanceof TaskReviewEpisodeBinding)) throw new CurrentFlowStateInvariantError("Task source stage requires its parent-owned immutable episode binding");
    const taskId = taskIdForNode(state, state.current.at(-1));
    const context = new CanonicalTaskContext({ state: { runId: state.runId, specId: state.specId, currentTaskId: taskId }, spec, sourceFingerprint: taskStageBinding.sourceFingerprint });
    let inputs;
    try {
      inputs = new TaskReviewStageInputs({ flowManager: this, state, taskId, context, stage: effect.stepId });
    } catch (cause) {
      throw new CurrentFlowStateInvariantError(`Task source stage canonical inputs are invalid: ${cause.message}`);
    }
    if (!inputs.binding.matches(taskStageBinding)) throw new CurrentFlowStateInvariantError("Task source stage binding changed before publication");
    if (effect.triage !== null) {
      inputs.assertTriage(effect.triage);
      if (mutationManifest.paths().length !== 0) throw new CurrentFlowStateInvariantError("Task triage cannot publish source edits");
    } else {
      inputs.assertRepair(effect.repair, mutationManifest);
      const lineage = new TaskMutationLineage({ runId: state.runId, specId: state.specId, taskId, role: "repair", attempt: mutationManifest.attempt, budget: inputs.lineageSet.currentBudget, sourceFingerprint: mutationManifest.digest, manifest: mutationManifest.toJSON() });
      artifactWrites.push({ logicalKey: "task.mutation.lineage", parameters: { taskId, attemptId: mutationManifest.attempt.id }, mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(lineage.toJSON(), null, 2)}\n`) });
    }
    const stageResult = new TaskReviewStageResult({ inputs, effect, manifest: mutationManifest, attempt: state.attempt, handoffDigest });
    const payload = stageResult.toJSON();
    const commandResult = attachCanonicalCommandResultArtifact({ ...result }, new CanonicalCommandResultArtifact({ logicalKey: `task.${effect.stepId.slice(5)}`, payload }));
    const stageWrites = this.#attemptHistoryWrites({ specId: state.specId, state, nodeId: state.current.at(-1), commandResult });
    artifactWrites.push(...stageWrites);
    const artifactDigest = crypto.createHash("sha256").update(stageWrites.find((write) => write.logicalKey === `task.${effect.stepId.slice(5)}`).bytes).digest("hex");
    const noChangeContinuation = effect.triage !== null && inputs.lineageSet.paths.length === 0 && effect.triage.dispositions.every((entry) => entry.disposition === "reject")
      ? selectTaskNoChangeContinuation(new TaskNoChangeContinuationFacts({
          source: { fingerprint: inputs.binding.sourceFingerprint, allowList: inputs.lineageSet.paths, reasons: inputs.lineageSet.noChangeReasons() },
          review: { verdict: inputs.review.document.verdict, canonical: true, artifactDigest: inputs.review.reference.digest, sourceFingerprint: inputs.review.document.canonicalTaskSource.fingerprint },
          triage: { disposition: "all-reject", artifactDigest, reviewArtifactDigest: inputs.review.reference.digest, sourceFingerprint: inputs.binding.sourceFingerprint },
          acceptance: { handoffId: `task-no-change:${state.attempt.id}`, reviewArtifactDigest: inputs.review.reference.digest, sourceFingerprint: inputs.binding.sourceFingerprint },
        }))
      : null;
    const dispositions = effect.triage?.dispositions ?? inputs.triage.document.dispositions;
    const facts = new TaskReviewStageFacts({
      binding: new TaskReviewStageBinding({ runId: state.runId, specId: state.specId, taskId, stage: effect.stepId.slice(5), attemptId: state.attempt.id, attemptSequence: state.attempt.sequence, sourceFingerprint: taskStageBinding.sourceFingerprint, artifactDigest, catalogFingerprint: this.catalog(state.specId).hash }),
      taskRound: inputs.binding.taskRound, reviewResultCount: inputs.binding.reviewOrdinal,
      verdict: inputs.review.document.verdict, mustFixCount: inputs.review.document.blockingFindings.length,
      sourceNoChange: inputs.lineageSet.paths.length === 0,
      triageDisposition: dispositions.some((entry) => entry.disposition === "apply") ? "apply" : "all-reject",
      repairChanged: effect.repair === null ? null : mutationManifest.paths().length > 0,
      sameReviewBinding: true, noChangeContinuation, acceptanceCarryForwardReady: stageResult.unreviewedAfterRepair,
      reason: effect.triage === null ? effect.repair.summary : dispositions.map((entry) => entry.rationale).join("\n"),
    });
    const completionPlan = resolveTaskReviewStageCompletion({
      facts,
      sourceQualityIssueCount: effect.issues.length,
    });
    if (completionPlan.qualityRecovery !== null) {
      this.#appendSourceQualityIssues({
        state, effect, handoffDigest, result, artifactWrites,
        recoveryPlan: completionPlan.qualityRecovery,
      });
    }
    const plan = completionPlan.transition;
    return this.runtime.completeTaskReviewStage({ specId: state.specId, activityId: activityId("task-review-stage-confirmed"), result, artifactWrites, admission: new CombinedAdmission(settlementAdmission, this.#producerCompletionAdmission(state.current.at(-1), artifactWrites)), plan, ...(plan.targetStepId === null ? {} : { targetAttempt: commandContextAttempt(state, plan.targetStepId) }) });
  }

  #appendSourceQualityIssues({ state, effect, handoffDigest, result, artifactWrites, recoveryPlan }) {
    const nodeId = state.current.at(-1);
    const taskId = taskIdForNode(state, nodeId);
    const existing = this.readArtifact({ specId: state.specId, logicalKey: "issue.log", consumerNodeId: nodeId, optional: true });
    const issues = new IssueLogDocument(existing === null ? { entries: [] } : JSON.parse(existing.bytes.toString("utf8")));
    effect.issues.forEach((entry, index) => {
      issues.append({
        step: nodeId,
        classification: entry.classification,
        reason: entry.reason,
        origin: { sourceStep: effect.stepId, sourceNodeId: nodeId },
        evidence: { ref: `worker-handoff:${handoffDigest}#effects.json`, digest: handoffDigest },
        recoveryStep: recoveryPlan.recoveryStep,
        remainingRisk: entry.remainingRisk,
        taskId,
        timestamp: result.confirmedAt,
      }, `source-handoff:${handoffDigest}:${index}`);
    });
    artifactWrites.push({ logicalKey: "issue.log", mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(issues.toJSON(), null, 2)}\n`, "utf8") });
  }

  /** Read only the immutable source lineages belonging to one canonical Task. */
  taskMutationLineages({ specId = null, taskId } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const id = requiredText(taskId, "Task mutation lineage taskId");
    const state = this.runtime.load(resolved);
    if (!state.findNode(id)) throw new CurrentFlowStateInvariantError(`canonical Task is absent: ${id}`);
    const catalog = this.catalog(resolved);
    const activities = this.runtime.activities(resolved);
    return readTaskMutationLineagesFromCatalog({
      state, catalog, activities, taskId: id,
      readCatalogedArtifact: (entry) => {
        const match = entry.relativePath.match(/mutation-lineage\/([^/]+)\.json$/);
        if (match === null) throw new CurrentFlowStateInvariantError("Task mutation lineage catalog path is invalid");
        return this.readArtifact({
          specId: resolved, logicalKey: "task.mutation.lineage",
          parameters: { taskId: id, attemptId: match[1] }, consumerNodeId: "task-review",
        }).bytes;
      },
    });
  }

  /**
   * Record a typed terminal failure for the active Attempt while preserving
   * its producer result in the same journal-first transaction.  This is the
   * error counterpart to `confirmCurrentAttempt`; callers never mutate a
   * status blob or write a retry artifact beside flow.json.
   */
  failCurrentAttempt({ specId = null, failure, result, commandResult = undefined, taskReviewUnsealedCheckpoint = null, taskReviewAbortedWorkUnit = null, admission = undefined } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    if (state.current === null || state.attempt === null) {
      throw new CurrentFlowStateInvariantError("canonical failure requires an active Attempt");
    }
    if (failure === null || typeof failure !== "object" || Array.isArray(failure)) {
      throw new CurrentFlowStateInvariantError("canonical failure facts are required");
    }
    const nodeId = state.current.at(-1);
    const now = new Date().toISOString();
    const failureResult = result ?? {
      outcome: "failed",
      summary: requiredText(failure.message, "canonical failure.message"),
      confirmedAt: now,
      artifactRefs: [],
    };
    if (taskReviewUnsealedCheckpoint !== null && !(taskReviewUnsealedCheckpoint instanceof TaskReviewUnsealedCheckpoint)) {
      throw new CurrentFlowStateInvariantError("Task Review failure checkpoint must be typed");
    }
    if (taskReviewUnsealedCheckpoint !== null) taskReviewUnsealedCheckpoint.assertActiveState(state);
    if (taskReviewAbortedWorkUnit !== null && !(taskReviewAbortedWorkUnit instanceof TaskReviewAbortedWorkUnit)) {
      throw new CurrentFlowStateInvariantError("Task Review aborted worker archive must be typed");
    }
    if (taskReviewAbortedWorkUnit !== null) taskReviewAbortedWorkUnit.assertActiveState(state);
    const artifactWrites = commandResult === undefined
      ? []
      : [
          ...this.#attemptHistoryWrites({
            specId: resolved,
            state,
            nodeId,
            commandResult,
          }),
          ...this.#commandPublicationWrites(commandResult),
        ];
    if (taskReviewUnsealedCheckpoint !== null) artifactWrites.push(taskReviewCheckpointArtifact(taskReviewUnsealedCheckpoint));
    if (taskReviewAbortedWorkUnit !== null) artifactWrites.push(taskReviewAbortedWorkUnit.artifactWrite);
    return this.runtime.failAttempt({
      specId: resolved,
      activityId: activityId("attempt-failed"),
      failure,
      result: failureResult,
      artifactWrites,
      admission,
    });
  }

  /**
   * Settle the exact definition-owned terminal disposition of the active
   * failed Attempt.  The caller supplies neither a result nor a target: both
   * are derived from the failed Activity and typed failure policy, so a CLI
   * continuation cannot turn a stale display decision into another route.
   */
  settleCurrentFailure({ specId = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const descriptor = state.nextAction();
    const expected = state.attempt === null ? null : CurrentAttemptIdentity.from(state.attempt);
    if (descriptor?.operation === "record") {
      const failedAttempt = state.attempt.failure;
      const expectedOutcome = descriptor.failureDisposition.outcome;
      const failure = [...this.activityLedger(resolved)].reverse().find((activity) => (
        activity.transition.operation === "fail_attempt"
        && activity.nodeId === state.current.at(-1)
        && activity.attemptId === state.attempt.id
        && activity.sequence === state.attempt.sequence
        && activity.failure?.category === failedAttempt.category
        && activity.failure?.code === failedAttempt.code
        && activity.failure?.message === failedAttempt.message
        && activity.failure?.retryable === failedAttempt.retryable
        && activity.failure?.retryKind === failedAttempt.retryKind
        && activity.result?.outcome === expectedOutcome
      )) ?? null;
      if (failure?.result == null) {
        throw new CurrentFlowStateInvariantError("canonical failed Attempt result is unavailable for recording");
      }
      const recorded = this.runtime.recordFailure({
        specId: resolved,
        activityId: activityId("attempt-failure-recorded"),
        result: failure.result,
        expectedAttempt: expected,
        admission: this.#settlementAdmission(state, failure.result),
      });
      if (recorded === null) {
        throw new CurrentFlowStateInvariantError("canonical failed Attempt changed before failure recording");
      }
      return recorded;
    }
    if (descriptor?.operation === "rewind") {
      const target = descriptor.failureDisposition.targetPath.at(-1);
      return this.rewindTo(target, { specId: resolved, expectedFailedAttempt: expected });
    }
    throw new CurrentFlowStateInvariantError("canonical failure disposition has no settle transition");
  }

  /**
   * Repair a Version-1 run created by the historical settlement bug.  It is
   * deliberately a narrow reconciliation, not a state editor: only the
   * catalog's missing primary producer output and the immutable ledger's
   * immediately recorded failure authorize restoring the old failed cursor.
   */
  recoverMissingProducerArtifact({ specId = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const candidate = this.#historicalMissingProducerArtifactCandidate(state, resolved);
    if (candidate === null) {
      throw new CurrentFlowStateInvariantError("missing producer artifact recovery cannot reconstruct the recorded producer Attempt");
    }
    return this.runtime.recoverMissingProducerArtifact({
      specId: resolved,
      activityId: activityId("missing-producer-artifact-recovered"),
      producerNodeId: candidate.producerNodeId,
      attempt: candidate.producerAttempt.toJSON(),
      references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
      admission: new MissingProducerArtifactRecoveryAdmission({
        runId: state.runId,
        consumerAttempt: candidate.consumerAttempt,
        producerAttempt: candidate.producerAttempt,
        readiness: candidate.readiness,
      }),
    });
  }

  /** The single typed route consumed by next-action and the dispatcher. */
  missingProducerArtifactRoute({ specId = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) return null;
    const state = this.runtime.load(resolved);
    const catalog = this.runtime.catalog(resolved);
    const activities = this.activityLedger(resolved);
    const historical = this.#historicalMissingProducerArtifactCandidate(state, resolved);
    if (historical !== null && !historical.readiness.isReady({ state, catalog, activities })) {
      return new MissingProducerArtifactRoute({
        kind: historical.consumerAttempt === null ? "historical-gap" : "historical-consumer",
        producerNodeId: historical.producerNodeId,
        consumerNodeId: historical.consumerNodeId,
        readiness: historical.readiness,
      });
    }
    const producerNodeId = state.current?.at(-1) ?? null;
    const failed = state.attempt?.failure == null ? null : state.attempt;
    if (producerNodeId === null || failed === null) return null;
    const failureDisposition = state.nextAction();
    if (failureDisposition?.operation !== "record") return null;
    const failure = [...activities].reverse().find((activity) => (
      activity.nodeId === producerNodeId
      && activity.attemptId === failed.id
      && activity.sequence === failed.sequence
      && activity.transition.operation === "fail_attempt"
    )) ?? null;
    if (failure?.result === undefined) return null;
    const readiness = producerArtifactReadinessesForProducer({ producerNodeId })
      .find((candidate) => !candidate.isReady({ state, catalog, activities })) ?? null;
    if (readiness === null) return null;
    return new MissingProducerArtifactRoute({
      kind: "active-producer",
      producerNodeId,
      consumerNodeId: readiness.consumerNodeId,
      readiness,
    });
  }

  /**
   * Record a command-bound tooling failure only when the exact Attempt that
   * started that command is still active.  A producer may have already
   * confirmed, failed, retried, or replaced that Attempt while lifecycle
   * hooks were running; in all of those cases this is deliberately a no-op.
   */
  failCurrentAttemptIfCurrent({ specId = null, expectedRunId, expectedAttempt, failure, result, commandResult = undefined, taskGateFallback = null, taskReviewAbortedWorkUnit = null, sourceHandoffSettlement = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const expected = CurrentAttemptIdentity.from(expectedAttempt);
    const state = this.runtime.load(resolved);
    if (expectedRunId !== state.identity.runId.toString()) return false;
    if (!expected.matches(state)) return false;
    if (taskReviewAbortedWorkUnit !== null && !(taskReviewAbortedWorkUnit instanceof TaskReviewAbortedWorkUnit)) {
      throw new CurrentFlowStateInvariantError("Task Review aborted worker archive must be typed");
    }
    if (taskReviewAbortedWorkUnit !== null) taskReviewAbortedWorkUnit.assertActiveState(state);
    const nodeId = state.current.at(-1);
    const now = new Date().toISOString();
    const failureResult = result ?? {
      outcome: "failed",
      summary: requiredText(failure?.message, "canonical failure.message"),
      confirmedAt: now,
      artifactRefs: [],
    };
    const artifactWrites = commandResult === undefined
      ? []
      : [
          ...this.#attemptHistoryWrites({
            specId: resolved,
            state,
            nodeId,
            commandResult,
          }),
          ...this.#commandPublicationWrites(commandResult),
        ];
    if (taskReviewAbortedWorkUnit !== null) artifactWrites.push(taskReviewAbortedWorkUnit.artifactWrite);
    let admission = taskGateFallback === null
      ? undefined
      : new TaskGateFallbackFailureAdmission({
        specId: resolved,
        runId: expectedRunId,
        attempt: expected,
        nodeId: taskGateFallback.nodeId,
        taskId: taskGateFallback.taskId,
      });
    if (sourceHandoffSettlement !== null) {
      if (!(sourceHandoffSettlement instanceof SourceHandoffSettlement)
        || sourceHandoffSettlement.kind !== "quarantined") {
        throw new CurrentFlowStateInvariantError("source failure requires a typed quarantined handoff settlement");
      }
      const authority = this.readSourceHandoffAuthority({
        specId: resolved,
        identity: sourceHandoffSettlement.identity,
        requireUnsettled: true,
      });
      if (sourceHandoffSettlement.checkpointDigest !== authority.checkpoint.digest
        || sourceHandoffSettlement.eventDigest !== authority.event.digest
        || authority.identity.runId !== expectedRunId
        || authority.identity.attempt.id !== expected.id
        || authority.identity.attempt.nodeId !== expected.nodeId
        || authority.identity.attempt.sequence !== expected.sequence) {
        throw new CurrentFlowStateConflictError("source failure settlement does not bind the current canonical Attempt and event head");
      }
      artifactWrites.push(...sourceHandoffArtifactWrites({ settlement: sourceHandoffSettlement }));
      admission = new CombinedAdmission(
        admission,
        new SourceHandoffPersistenceAdmission({
          identity: authority.identity,
          checkpoint: authority.checkpoint,
          expectedCheckpointDigest: authority.checkpoint.digest,
          expectedPreviousEventDigest: authority.event.digest,
          settlement: sourceHandoffSettlement,
        }),
      );
    }
    const recorded = this.runtime.failAttempt({
      specId: resolved,
      activityId: activityId("attempt-tooling-failed"),
      failure,
      result: failureResult,
      artifactWrites,
      expectedAttempt: expected,
      admission,
    });
    return recorded !== null;
  }

  acceptFinalRegressionFailure({ specId = null, commandResult } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    if (state.current?.at(-1) !== "final-regression" || state.attempt?.failure === null) {
      throw new CurrentFlowStateInvariantError(
        "canonical final-regression acceptance requires its failed active Attempt",
      );
    }
    const attempt = commandContextAttempt(state, "final-regression");
    const artifactWrites = [
      ...this.#attemptHistoryWrites({
        specId: resolved,
        state,
        nodeId: "final-regression",
        commandResult,
        attemptSequence: attempt.sequence,
      }),
      ...this.#commandPublicationWrites(commandResult),
    ];
    return this.runtime.acceptFinalRegressionFailure({
      specId: resolved,
      activityId: activityId("final-regression-failure-accepted"),
      attempt,
      result: {
        outcome: "passed",
        summary: "explicitly accepted final-regression failure",
        confirmedAt: new Date().toISOString(),
        artifactRefs: [],
      },
      artifactWrites,
    });
  }

  deferFailedReview(input = {}) {
    if (Object.hasOwn(input, "artifactWrites") || Object.hasOwn(input, "artifactBaselines")) {
      throw new CurrentFlowStateInvariantError("canonical Review deferral accepts only a deferred flow.findings publication");
    }
    const { specId = null, findingsPublication } = input;
    if (!(findingsPublication instanceof DeferredFlowFindingsPublication)) {
      throw new CurrentFlowStateInvariantError("canonical Review deferral requires a deferred flow.findings publication");
    }
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const nodeId = state.current?.at(-1) ?? null;
    if (nodeId === null || !nodeId.endsWith("-review") || state.attempt?.failure === null) {
      throw new CurrentFlowStateInvariantError("canonical Review deferral requires its failed active Attempt");
    }
    const attempt = commandContextAttempt(state, nodeId);
    return this.runtime.deferFailedReview({
      specId: resolved,
      activityId: activityId("review-failure-deferred"),
      nodeId,
      attempt,
      result: {
        outcome: "passed",
        summary: "Review findings deferred to acceptance",
        confirmedAt: new Date().toISOString(),
        artifactRefs: [],
      },
      findingsPublication,
    });
  }

  /**
   * Persist a current Attempt's typed result before a non-terminal command
   * outcome (for example a rejected review) returns control to the planner.
   * The same history writer is reused by confirmation, so a later retry or
   * confirmation cannot duplicate or replace this attempt's bytes.
   */
  publishCurrentAttemptResult({ specId = null, commandResult } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    if (state.current === null) throw new CurrentFlowStateInvariantError("canonical result publication requires an active Attempt");
    const nodeId = state.current.at(-1);
    const artifactWrites = [
      ...this.#attemptHistoryWrites({
      specId: resolved,
      state,
      nodeId,
      commandResult,
      }),
      ...this.#commandPublicationWrites(commandResult),
    ];
    if (artifactWrites.length === 0) return state;
    return this.runtime.publishArtifacts({
      specId: resolved,
      activityId: activityId("attempt-result-published"),
      nodeId,
      artifactWrites,
      expectedAttempt: CurrentAttemptIdentity.from(state.attempt),
    });
  }

  /**
   * Publish one canonical Task Review result and apply the Definition-selected
   * review-funnel connector in the same journal transaction.
   */
  confirmTaskReviewResult({ specId = null, commandResult } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    state.assertAttemptConfirmable();
    const nodeId = state.current?.at(-1) ?? null;
    const identity = TaskStepIdentity.fromStateNode(this.loadReadOnly(resolved), nodeId);
    if (identity?.definitionId !== "task-review" || state.attempt === null) {
      throw new CurrentFlowStateInvariantError("Task Review confirmation requires its active canonical Attempt");
    }
    const artifact = attachedCanonicalCommandResultArtifact(commandResult);
    if (artifact?.logicalKey !== "task.review") {
      throw new CurrentFlowStateInvariantError("Task Review confirmation requires its canonical result artifact");
    }
    const payload = artifact.payload;
    if (payload.taskId !== identity.taskId || !["PASS", "ADVISORY", "REJECTED"].includes(payload.verdict)) {
      throw new CurrentFlowStateInvariantError("Task Review result does not belong to the active Task");
    }
    const source = captureCurrentTaskSource({
      root: this.executionRoot(),
      flowManager: this,
      state: this.loadReadOnly(resolved),
      taskId: identity.taskId,
    });
    if (payload.canonicalTaskSource?.fingerprint !== source.fingerprint) {
      throw new CurrentFlowStateInvariantError("Task Review result source binding is stale");
    }
    const publicationBinding = attachedTaskReviewPublicationBinding(commandResult);
    if (publicationBinding === null) {
      throw new CurrentFlowStateInvariantError("Task Review confirmation requires its parent-owned execution publication binding");
    }
    const lineageSet = new TaskMutationLineageSet({
      runId: state.runId,
      specId: resolved,
      taskId: identity.taskId,
      lineages: this.taskMutationLineages({ specId: resolved, taskId: identity.taskId }),
    });
    const accounting = TaskReviewAccounting.fromCanonicalState({
      flowManager: this,
      state,
      taskId: identity.taskId,
    });
    const reviewResultCount = accounting.requireInflightReviewOrdinal();
    const artifactWrites = [
      ...this.#attemptHistoryWrites({ specId: resolved, state, nodeId, commandResult }),
      ...this.#commandPublicationWrites(commandResult),
    ];
    const reviewWrite = artifactWrites.find((write) => write.logicalKey === "task.review") ?? null;
    if (reviewWrite === null) {
      throw new CurrentFlowStateInvariantError("Task Review confirmation requires a new semantic result publication");
    }
    const artifactDigest = crypto.createHash("sha256").update(reviewWrite.bytes).digest("hex");
    const sourceNoChange = payload.noChange === true
      && source.entries.length === 0
      && lineageSet.paths.length === 0
      && JSON.stringify(payload.noChangeReasons) === JSON.stringify(source.noChangeReasons);
    let noChangeContinuation = null;
    if (sourceNoChange && ["PASS", "ADVISORY"].includes(payload.verdict)) {
      noChangeContinuation = selectTaskNoChangeContinuation(new TaskNoChangeContinuationFacts({
        source: {
          fingerprint: source.fingerprint,
          allowList: lineageSet.paths,
          reasons: source.noChangeReasons,
        },
        review: {
          verdict: payload.verdict,
          canonical: true,
          artifactDigest,
          sourceFingerprint: payload.canonicalTaskSource.fingerprint,
        },
        acceptance: {
          handoffId: `task-no-change:${state.attempt.id}`,
          reviewArtifactDigest: artifactDigest,
          sourceFingerprint: source.fingerprint,
        },
      }));
    }
    const mustFixCount = (payload.blockingFindings ?? [])
      .filter((finding) => finding?.disposition === "must-fix").length;
    const facts = new TaskReviewStageFacts({
      binding: new TaskReviewStageBinding({
        runId: state.runId,
        specId: resolved,
        taskId: identity.taskId,
        stage: "review",
        attemptId: state.attempt.id,
        attemptSequence: state.attempt.sequence,
        sourceFingerprint: source.fingerprint,
        artifactDigest,
        catalogFingerprint: this.catalog(resolved).hash,
      }),
      taskRound: lineageSet.currentBudget.round,
      reviewResultCount,
      verdict: payload.verdict,
      mustFixCount,
      sourceNoChange,
      noChangeContinuation,
    });
    const plan = resolveTaskReviewStageTransition(facts);
    return this.runtime.completeTaskReviewStage({
      specId: resolved,
      activityId: activityId("task-review-stage-confirmed"),
      result: resultFor("done", nodeId),
      artifactWrites,
      admission: new TaskReviewSourcePublicationAdmission({ root: this.executionRoot(), lineageSet, sourceFingerprint: source.fingerprint, producerAdmission: this.#producerCompletionAdmission(nodeId, artifactWrites), publicationBinding }),
      plan,
      ...(plan.targetStepId === null ? {} : { targetAttempt: commandContextAttempt(state, plan.targetStepId) }),
    });
  }

  /**
   * Apply one sealed Definition plan after its producer observation has been
   * published.  This boundary is intentionally the only test-chain consumer
   * that interprets typed Plan effects: the registry supplies no fallback
   * route and no action may become visible without the full Store commit.
   */
  applyTestChainTransitionDecision({ specId = null, decision, nonblockingRecord = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (!(decision instanceof NonGateTransitionDecision)) {
      throw new CurrentFlowStateInvariantError("test-chain settlement requires a typed Definition decision");
    }
    const state = this.runtime.load(resolved);
    const admission = new TestChainPlanAdmission(decision);
    const id = testChainPlanActivityId(decision);
    const existing = this.runtime.activities(resolved).find((activity) => activity.id === id) ?? null;
    if (existing !== null) return this.runtime.load(resolved);

    const actions = decision.plan.actions;
    const statuses = actions.filter((action) => action instanceof NonGateSetStepStatusAction);
    const increments = actions.filter((action) => action instanceof NonGateIncrementRetryAction);
    const failures = actions.filter((action) => action instanceof NonGateFailCurrentAttemptAction);
    const repairs = actions.filter((action) => action instanceof NonGateAppendRepairEvidenceAction);
    const nonblocking = actions.filter((action) => action instanceof NonGateRecordNonblockingAction);
    if (statuses.length + increments.length + failures.length + repairs.length + nonblocking.length !== actions.length
      || statuses.length > 1 || increments.length > 1 || failures.length > 1 || repairs.length > 1 || nonblocking.length > 1) {
      throw new CurrentFlowStateInvariantError("test-chain Definition plan has an unsupported action composition");
    }
    if (actions.length === 0) return state;
    if (statuses.some((action) => action.update.stepId !== decision.facts.stepId)) {
      throw new CurrentFlowStateInvariantError("test-chain Definition plan status targets another Step");
    }
    if (increments.some((action) => action.stepId !== decision.facts.stepId)) {
      throw new CurrentFlowStateInvariantError("test-chain Definition plan retry targets another Step");
    }

    if (repairs.length === 1) {
      const repair = repairs[0];
      const failure = failures[0] ?? null;
      if (repair.stepId !== "scenario-validity" || failure === null
        || failure.code !== "SCENARIO_VALIDITY_REJECTED" || failure.category !== "semantic"
        || failure.retryable || failure.retryKind !== null
        || nonblocking.length !== 0 || increments.length !== 0
        || !hasExactTestChainStatus(statuses, { stepId: decision.facts.stepId, status: "in_progress" })) {
        throw new CurrentFlowStateInvariantError("scenario repair must use its exact Definition-selected settlement actions");
      }
      const catalog = this.runtime.catalog(resolved);
      const activities = this.runtime.activities(resolved);
      const revision = CanonicalTestSourceRevision.fromCatalog({ state, catalog, activities });
      if (revision.digest !== repair.testSourceRevision) {
        throw new CurrentFlowStateConflictError("scenario repair test source revision changed before settlement");
      }
      const evidence = new CanonicalScenarioValidityRepairEvidence({
        state,
        summary: repair.summary,
        testSourceRevision: revision,
        timestamp: testChainPlanTiming(state).finishedAt,
      });
      const existingIssueLog = this.readArtifact({
        specId: resolved,
        logicalKey: "issue.log",
        consumerNodeId: "scenario-validity",
        optional: true,
      });
      const document = new IssueLogDocument(existingIssueLog === null
        ? { entries: [] }
        : JSON.parse(existingIssueLog.bytes.toString("utf8")));
      const appended = evidence.exists
        ? document.append(canonicalIssueLogEntry(evidence.toIssueLogEntry()), evidence.idempotencyKey)
        : { appended: false };
      const artifactWrites = appended.appended ? [{
        logicalKey: "issue.log",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(document.toJSON(), null, 2)}\n`, "utf8"),
      }] : [];
      const artifactBaselines = [new CanonicalFlowArtifactBaseline({
        logicalKey: "issue.log",
        digest: existingIssueLog?.descriptor.hash ?? null,
        byteLength: existingIssueLog?.bytes.length ?? 0,
      })];
      return this.runtime.repairScenarioValidity({
        specId: resolved,
        activityId: id,
        attempt: testChainReplacementAttempt(state, "test", decision),
        failure: {
          category: failure.category,
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
          retryKind: failure.retryKind,
        },
        result: testChainPlanResult(state, { outcome: "failed", summary: failure.message }),
        timing: testChainPlanTiming(state),
        references: {
          evaluations: [],
          findings: [],
          repairs: evidence.exists ? [{ id: evidence.idempotencyKey, label: evidence.idempotencyKey }] : [],
          artifacts: [],
        },
        artifactWrites,
        artifactBaselines,
        admission,
      });
    }

    if (nonblocking.length === 1) {
      if (failures.length !== 0 || increments.length !== 0 || nonblockingRecord === null
        || nonblocking[0].stepId !== decision.facts.stepId
        || !hasExactTestChainStatus(statuses, { stepId: decision.facts.stepId, status: "in_progress" })) {
        throw new CurrentFlowStateInvariantError("nonblocking test-chain settlement requires its one typed observation");
      }
      return this.runtime.recordNonblocking({
        specId: resolved,
        activityId: id,
        nodeId: decision.facts.stepId,
        nonblocking: nonblockingRecord,
        artifactWrites: [],
        timing: testChainPlanTiming(state),
        admission,
      });
    }

    if (failures.length === 1) {
      const failure = failures[0];
      if (!hasExactTestChainStatus(statuses, { stepId: decision.facts.stepId, status: "in_progress" })
        || (increments.length === 1) !== (failure.retryKind === "semantic" && failure.retryable)) {
        throw new CurrentFlowStateInvariantError("test-chain failure settlement conflicts with its sealed Definition plan");
      }
      return this.runtime.failAttempt({
        specId: resolved,
        activityId: id,
        failure: {
          category: failure.category,
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
          retryKind: failure.retryKind,
        },
        result: testChainPlanResult(state, { outcome: "failed", summary: failure.message }),
        timing: testChainPlanTiming(state),
        admission,
      });
    }

    if (hasExactTestChainStatus(statuses, { stepId: decision.facts.stepId, status: "done" }) && increments.length === 0) {
      return this.runtime.confirmAttempt({
        specId: resolved,
        activityId: id,
        status: "done",
        result: testChainPlanResult(state, {
          outcome: "passed",
          summary: `canonical runtime transition for ${decision.facts.stepId}`,
        }),
        timing: testChainPlanTiming(state),
        admission,
      });
    }
    throw new CurrentFlowStateInvariantError("test-chain Definition plan has no persistence settlement");
  }

  /**
   * Dispatcher command metadata is intentionally transient.  It is stored
   * beneath this Version's `.runtime` root and is resolved from a real node
   * id, never from a guessed legacy spec sibling path.
   */
  setStepRuntimeLog(stepId, runtimeLog, opts = {}) {
    const specId = this.#resolveSpecId(opts.specId);
    if (specId === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(specId);
    const location = this.location(specId);
    const node = runtimeMetadataNode(state, stepId, location);
    if (/[/\\]/.test(node.id)) {
      throw new CurrentFlowStateInvariantError("canonical runtime Step id cannot escape the runtime directory");
    }
    const metadata = new CanonicalStepRuntimeLog({ ...runtimeLog, nodeId: node.id });
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve("runtime.step-metadata", { stepId: node.id });
    const target = location.resolve(artifact.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    return new AtomicFile(target, { phaseNamespace: "canonical-step-runtime-metadata" })
      .write(Buffer.from(`${JSON.stringify(metadata.toJSON(), null, 2)}\n`, "utf8"));
  }

  /**
   * Write one classified `.runtime` payload.  Runtime bytes remain outside
   * the catalog and may be discarded without affecting resume/recovery, but
   * the contract still checks that their producer owns the typed path.
   */
  writeRuntimeArtifact({ specId = null, nodeId, artifact, expectedAttempt = null } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    return this.runtime.writeRuntimeArtifact({
      specId: resolved,
      nodeId: requiredText(nodeId, "canonical runtime artifact nodeId"),
      artifact: CanonicalFlowRuntimeArtifactWrite.from(artifact),
      expectedAttempt,
    });
  }

  /**
   * Resolve a transient diagnostic through the same typed contract as its
   * writer.  It intentionally has no catalog descriptor, while callers still
   * cannot reconstruct a Version path or read a foreign producer's output.
   */
  readRuntimeArtifact({ specId = null, logicalKey, parameters = {}, consumerNodeId, optional = false } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    return new CanonicalFlowRuntimeArtifactRead({
      location: this.location(resolved),
      logicalKey: requiredText(logicalKey, "canonical runtime artifact logicalKey"),
      parameters,
      consumerNodeId: requiredText(consumerNodeId, "canonical runtime artifact consumer nodeId"),
      optional,
    }).read();
  }

  /**
   * Keep metric history in activities.jsonl.  The public `state.metrics`
   * convenience view is reconstructed by `load()` from these observations.
   */
  appendMetric(payload, opts = {}) {
    if (payload == null) return null;
    const specId = this.#resolveSpecId(opts.specId);
    if (specId === null) return null;
    const state = this.runtime.load(specId);
    return this.runtime.recordMetric({
      specId,
      activityId: activityId("metric-recorded"),
      nodeId: observationNodeId(state, opts),
      metric: canonicalMetric(payload),
    });
  }

  incrementMetric(phase, counter, opts = {}) {
    if (!phase) return null;
    return this.appendMetric({ phase, counter, delta: 1 }, opts);
  }

  accumulateAgentMetrics(phase, options = {}) {
    if (!phase) return null;
    const { usage, responseChars, model, durationMs, provider, profileKey } = options;
    return this.appendMetric({
      phase,
      kind: "agent",
      provider: normalizeAgentMetricDimension(provider),
      profileKey: normalizeAgentMetricDimension(profileKey),
      callCount: 1,
      responseChars: responseChars || 0,
      ...(durationMs != null && { durationMs }),
      ...(model && { model }),
      ...(usage && {
        tokens: {
          input: usage.input_tokens || 0,
          output: usage.output_tokens || 0,
          cacheRead: usage.cache_read_tokens || 0,
          cacheCreation: usage.cache_creation_tokens || 0,
        },
        ...(usage.cost_usd != null && { cost: usage.cost_usd }),
      }),
    }, options);
  }

  addNote(text, opts = {}) {
    const specId = this.#resolveSpecId(opts.specId);
    if (specId === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(specId);
    return this.runtime.recordNote({
      specId,
      activityId: activityId("note-recorded"),
      nodeId: observationNodeId(state, opts),
      note: new ActivityNote({ text }),
    });
  }

  setAutoApprove(autoApprove, opts = {}) {
    if (typeof autoApprove !== "boolean") {
      throw new CurrentFlowStateInvariantError("canonical policy.autoApprove must be boolean");
    }
    const specId = this.#resolveSpecId(opts.specId);
    if (specId === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(specId);
    if (state.policy.autoApprove === autoApprove) return state;
    return this.runtime.setPolicy({
      specId,
      activityId: activityId("policy-updated"),
      policy: { autoApprove, nonblocking: state.policy.nonblocking?.toJSON() ?? null },
    });
  }

  /** One-way advisory policy activation through the typed policy Activity. */
  activateNonblockingPolicy({ specId = null, policy } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    if (state.policy.nonblocking !== null) return state.policy.nonblocking.toJSON();
    const next = policy instanceof CurrentFlowNonBlockingPolicy
      ? policy
      : new CurrentFlowNonBlockingPolicy(policy);
    this.runtime.setPolicy({
      specId: resolved,
      activityId: activityId("policy-nonblocking-enabled"),
      policy: { autoApprove: state.policy.autoApprove, nonblocking: next.toJSON() },
    });
    return next.toJSON();
  }

  /** Record one exact observation or decision in the canonical Activity ledger. */
  recordNonblocking({ specId = null, nodeId, record, artifactWrites = undefined } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const target = requiredText(nodeId, "canonical nonblocking nodeId");
    if (state.current?.at(-1) !== target) {
      throw new CurrentFlowStateInvariantError("canonical nonblocking record requires the active current Attempt");
    }
    const fact = record instanceof ActivityNonBlockingRecord ? record : new ActivityNonBlockingRecord(record);
    const identity = JSON.stringify(fact.toJSON());
    const stableId = `nonblocking-${crypto.createHash("sha256").update(identity).digest("hex")}`;
    const existing = this.runtime.activities(resolved).find((activity) => activity.id === stableId) ?? null;
    if (existing !== null) {
      if (JSON.stringify(existing.transition.nonblocking?.toJSON?.() ?? null) !== identity) {
        throw new CurrentFlowStateInvariantError("canonical nonblocking activity identity conflict");
      }
      return existing;
    }
    return this.runtime.recordNonblocking({
      specId: resolved,
      activityId: stableId,
      nodeId: target,
      nonblocking: fact.toJSON(),
      artifactWrites,
    });
  }

  /**
   * Apply an evidence-bound advisory decision and its definition-owned
   * continuation through Activities only.  The decision fact is written
   * first; an interrupted continuation is therefore recoverable by replaying
   * this operation with the same immutable identity.
   */
  applyNonblockingDecision({ specId = null, nodeId, sourceStep, record } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const target = requiredText(nodeId, "canonical nonblocking decision nodeId");
    const route = nonblockingRouteFor(requiredText(sourceStep, "canonical nonblocking decision sourceStep"));
    if (route === null) throw new CurrentFlowStateInvariantError("canonical nonblocking decision route is unavailable");
    const fact = record instanceof ActivityNonBlockingRecord ? record : new ActivityNonBlockingRecord(record);
    if (fact.kind !== "decision") throw new CurrentFlowStateInvariantError("canonical nonblocking continuation requires a decision fact");
    const identity = JSON.stringify(fact.toJSON());
    const stableId = `nonblocking-${crypto.createHash("sha256").update(identity).digest("hex")}`;
    const existing = this.runtime.activities(resolved).find((activity) => activity.id === stableId) ?? null;
    if (existing !== null) return fact.toJSON();
    if (fact.action === "continue") {
      this.runtime.continueNonblocking({
        specId: resolved,
        activityId: stableId,
        nodeId: target,
        nonblocking: fact.toJSON(),
        skippedNodeIds: route.skippedSteps,
      });
      return fact.toJSON();
    }
    this.recordNonblocking({ specId: resolved, nodeId: target, record: fact });
    let state = this.runtime.load(resolved);
    // An identical replay after the typed continuation has completed is a
    // no-op; a crash between Activities resumes from the exact current leaf.
    if (state.current?.at(-1) !== target) return fact.toJSON();
    // A repair/retry always creates a new current Attempt episode. The
    // immutable decision remains tied to the prior artifact digest; a fresh
    // producer publication is required before another decision can be made.
    this.updateStepStatus({ stepId: target, requestedStatus: "done" }, { specId: resolved });
    this.rewindTo(target, { specId: resolved });
    return fact.toJSON();
  }

  park(specId) { return this.runtime.park({ specId: canonicalSpecId(specId), activityId: activityId("flow-parked") }); }
  resume(specId) { return this.runtime.resume({ specId: canonicalSpecId(specId), activityId: activityId("flow-resumed") }); }
  finalize(specId) { return this.runtime.finalize({ specId: canonicalSpecId(specId), activityId: activityId("flow-finalized") }); }

  catalog(specId) { return this.runtime.catalog(canonicalSpecId(specId)); }
  restart(specId) { return this.runtime.restart(canonicalSpecId(specId)); }

  /**
   * Resolve one cataloged input through the same Version Store that wrote it.
   * Command code never infers a Version directory or trusts a raw path.
   */
  readArtifact({ specId = null, logicalKey, parameters = {}, consumerNodeId, optional = false } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (optional !== true && optional !== false) {
      throw new CurrentFlowStateInvariantError("canonical artifact optional must be boolean");
    }
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(requiredText(logicalKey, "canonical artifact logicalKey"), parameters);
    const consumer = FlowArtifactUpdater.fromActivityNodeId(
      requiredText(consumerNodeId, "canonical artifact consumer nodeId"),
    ).toString();
    if (!artifact.contract.ownership.consumers.includes(consumer)) {
      throw new CurrentFlowStateInvariantError(
        `canonical artifact consumer is not authorized: ${consumer}/${artifact.logicalKey}`,
      );
    }
    const catalog = this.runtime.catalog(resolved);
    const descriptor = catalog.artifacts.find((entry) => entry.relativePath === artifact.relativePath) ?? null;
    if (descriptor === null) {
      if (optional) return null;
      throw new CurrentFlowStateInvariantError(`canonical artifact is absent from catalog: ${artifact.relativePath}`);
    }
    if (descriptor.logicalKey !== artifact.logicalKey) {
      throw new CurrentFlowStateInvariantError("canonical artifact catalog logical key conflicts with its resolved contract");
    }
    const location = this.location(resolved);
    location.assertAuthority(artifact.relativePath, { mustExist: true });
    return Object.freeze({
      descriptor: Object.freeze(descriptor.toJSON()),
      relativePath: artifact.relativePath,
      bytes: Buffer.from(fs.readFileSync(location.resolve(artifact.relativePath))),
    });
  }

  /** Read one active producer-owned attempt artifact for an advisory observation. */
  readActiveProducerArtifact({ specId = null, nodeId, logicalKey, parameters = {} } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const target = requiredText(nodeId, "canonical producer nodeId");
    if (state.current?.at(-1) !== target) {
      throw new CurrentFlowStateInvariantError("canonical producer artifact requires the active current Attempt");
    }
    if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
      throw new CurrentFlowStateInvariantError("canonical producer artifact parameters must be an object");
    }
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(
      requiredText(logicalKey, "canonical producer artifact logicalKey"),
      parameters,
    );
    const producer = FlowArtifactUpdater.fromActivityNodeId(target).toString();
    if (artifact.contract.authoritySlot.publicationStep !== producer) {
      throw new CurrentFlowStateInvariantError(`canonical producer does not own artifact: ${producer}/${artifact.logicalKey}`);
    }
    const catalog = this.runtime.catalog(resolved);
    const descriptor = catalog.artifacts.find((entry) => entry.relativePath === artifact.relativePath) ?? null;
    if (descriptor === null || descriptor.logicalKey !== artifact.logicalKey) {
      throw new CurrentFlowStateInvariantError(`canonical producer artifact is absent from catalog: ${artifact.relativePath}`);
    }
    const location = this.location(resolved);
    location.assertAuthority(artifact.relativePath, { mustExist: true });
    return Object.freeze({
      descriptor: Object.freeze(descriptor.toJSON()),
      relativePath: artifact.relativePath,
      bytes: Buffer.from(fs.readFileSync(location.resolve(artifact.relativePath))),
    });
  }

  /**
   * Read an artifact owned by the active producer role.  Unlike the older
   * single-slot helper this also supports intentionally shared producer
   * contracts (for example flow findings), while retaining the same current
   * Activity and catalog authority checks.
   */
  readProducerArtifact({ specId = null, nodeId, logicalKey, parameters = {}, optional = false } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    const state = this.runtime.load(resolved);
    const target = requiredText(nodeId, "canonical producer nodeId");
    if (state.current?.at(-1) !== target) {
      throw new CurrentFlowStateInvariantError("canonical producer artifact requires the active current Attempt");
    }
    if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
      throw new CurrentFlowStateInvariantError("canonical producer artifact parameters must be an object");
    }
    if (optional !== true && optional !== false) {
      throw new CurrentFlowStateInvariantError("canonical producer artifact optional must be boolean");
    }
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(
      requiredText(logicalKey, "canonical producer artifact logicalKey"),
      parameters,
    );
    const producer = FlowArtifactUpdater.fromActivityNodeId(target).toString();
    if (!artifact.contract.ownership.producers.includes(producer)) {
      throw new CurrentFlowStateInvariantError(`canonical producer does not own artifact: ${producer}/${artifact.logicalKey}`);
    }
    const catalog = this.runtime.catalog(resolved);
    const descriptor = catalog.artifacts.find((entry) => entry.relativePath === artifact.relativePath) ?? null;
    if (descriptor === null) {
      if (optional) return null;
      throw new CurrentFlowStateInvariantError(`canonical producer artifact is absent from catalog: ${artifact.relativePath}`);
    }
    if (descriptor.logicalKey !== artifact.logicalKey) {
      throw new CurrentFlowStateInvariantError(`canonical producer artifact is absent from catalog: ${artifact.relativePath}`);
    }
    const location = this.location(resolved);
    location.assertAuthority(artifact.relativePath, { mustExist: true });
    return Object.freeze({
      descriptor: Object.freeze(descriptor.toJSON()),
      relativePath: artifact.relativePath,
      bytes: Buffer.from(fs.readFileSync(location.resolve(artifact.relativePath))),
    });
  }

  /**
   * Resolve a cataloged artifact whose exact path came from an already
   * cataloged producer reference (for example a deferred-finding source).
   * This intentionally does not accept an arbitrary filesystem path: the
   * catalog descriptor, contract classification, and consumer ownership must
   * all agree before bytes are returned.
   */
  readCatalogArtifact({ specId = null, relativePath, consumerNodeId, optional = false } = {}) {
    const resolved = this.#resolveSpecId(specId);
    if (resolved === null) throw new CurrentFlowStateInvariantError("no canonical active Flow");
    if (optional !== true && optional !== false) {
      throw new CurrentFlowStateInvariantError("canonical catalog artifact optional must be boolean");
    }
    const requestedPath = catalogRelativePath(relativePath);
    const catalog = this.runtime.catalog(resolved);
    const descriptor = catalog.artifacts.find((entry) => entry.relativePath === requestedPath) ?? null;
    if (descriptor === null) {
      if (optional) return null;
      throw new CurrentFlowStateInvariantError(`canonical artifact is absent from catalog: ${requestedPath}`);
    }
    const classified = FLOW_ARTIFACT_CONTRACTS.classify(requestedPath);
    if (descriptor.logicalKey !== classified.logicalKey.toString()) {
      throw new CurrentFlowStateInvariantError("canonical artifact catalog logical key conflicts with its classified path");
    }
    const consumer = FlowArtifactUpdater.fromActivityNodeId(
      requiredText(consumerNodeId, "canonical catalog artifact consumer nodeId"),
    ).toString();
    if (!classified.ownership.consumers.includes(consumer)) {
      throw new CurrentFlowStateInvariantError(
        `canonical catalog artifact consumer is not authorized: ${consumer}/${classified.logicalKey}`,
      );
    }
    const location = this.location(resolved);
    location.assertAuthority(requestedPath, { mustExist: true });
    return Object.freeze({
      descriptor: Object.freeze(descriptor.toJSON()),
      relativePath: requestedPath,
      bytes: Buffer.from(fs.readFileSync(location.resolve(requestedPath))),
    });
  }

  #resolveSpecId(specId) {
    if (specId != null) return canonicalSpecId(specId);
    const provider = this.activeFlowsProvider();
    const entries = typeof provider?.load === "function" ? provider.load() : provider;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    if (entries.length !== 1) {
      throw new CurrentFlowStateInvariantError("multiple active flows require an explicit --spec <specId>");
    }
    return canonicalSpecId(entries[0].specId);
  }

  #retryBaselinePublication(state, nodeId, attempt, taskReviewAbortedWorkUnits = []) {
    const baseline = captureRetryRecoveryBaseline({
      flowState: this.load(state.specId),
      flowManager: this,
      executionRoot: this.root,
      artifactRoot: this.mainRoot,
      nodeId,
      attempt,
      specPath: this.runtime.location(state.specId).relativeSpecFile,
    });
    if (baseline === null) {
      if (taskReviewAbortedWorkUnits.length > 0) {
        throw new CurrentFlowStateInvariantError("Task Review aborted work units require a retry recovery baseline");
      }
      return null;
    }
    return RetryRecoveryArtifactPublication.baseline(baseline, taskReviewAbortedWorkUnits);
  }

  #taskReviewAbortedWorkUnitsForRetry(state, values) {
    if (!Array.isArray(values) || values.some((value) => !(value instanceof TaskReviewAbortedWorkUnit))) {
      throw new CurrentFlowStateInvariantError("Task Review retry archive requires typed work units");
    }
    if (values.length === 0) return null;
    const nodeId = state.current?.at(-1) ?? null;
    const task = TaskStepIdentity.fromStateNode(this.loadReadOnly(state.specId), nodeId);
    if (task?.definitionId !== "task-review") {
      throw new CurrentFlowStateInvariantError("Task Review retry archive requires the active Task Review node");
    }
    return new TaskReviewAbortedWorkUnitRetryAdmission({ state, archives: values });
  }

  #beginExecutableNode(state, specId, nodeId) {
    const claim = state.executableStepClaim({
      nodeId,
      attempt: new CurrentAttempt(commandContextAttempt(state, nodeId)),
    });
    const input = {
      specId,
      activityId: activityId(claim.operation === "recover" ? "attempt-recovered" : "attempt-started"),
      nodeId: claim.nodeId,
      // A lifecycle/direct transition begins the same sealed claim selected
      // by CurrentFlowState as `get next-action`; Store owns only Activity
      // persistence and consumer admission.
      attempt: claim.attempt.toJSON(),
      admission: this.#consumerAdmission(state, claim.nodeId),
    };
    input.retryRecoveryPublication = this.#retryBaselinePublication(state, claim.nodeId, input.attempt);
    return claim.operation === "recover"
      ? this.runtime.recover(input)
      : this.runtime.startAttempt(input);
  }

  #historicalMissingProducerArtifactCandidate(state, specId) {
    const consumerAttempt = state.attempt;
    const consumerNodeId = state.current?.at(-1) ?? null;
    const leaves = state.definition.orderedLeaves(state.root);
    const activities = this.activityLedger(specId);
    const candidateFor = ({ readiness, consumer = null }) => {
      const producerNodeId = readiness.producerNodeId;
      const producer = state.findNode(producerNodeId);
      if (producer?.status !== "failed") return null;
      const record = [...activities].reverse().find((activity) => (
        activity.nodeId === producerNodeId
        && activity.transition.operation === "record_failure"
        && activity.sequence === producer.attemptSequence
      )) ?? null;
      const failed = record === null ? null : [...activities].slice(0, activities.indexOf(record)).reverse().find((activity) => (
        activity.nodeId === producerNodeId
        && activity.attemptId === record.attemptId
        && activity.sequence === record.sequence
        && activity.transition.operation === "fail_attempt"
      )) ?? null;
      const introduced = failed === null ? null : [...activities].slice(0, activities.indexOf(failed)).reverse().find((activity) => (
        activity.nodeId === producerNodeId
        && activity.transition.attempt?.id === failed.attemptId
        && activity.transition.attempt?.sequence === failed.sequence
      )) ?? null;
      if (
        record === null || failed === null || introduced === null || failed.failure === null
        || JSON.stringify(record.result) !== JSON.stringify(producer.result)
      ) return null;
      return Object.freeze({
        consumerAttempt,
        consumerNodeId: consumer,
        producerNodeId,
        producerAttempt: new CurrentAttempt({ ...introduced.transition.attempt, failure: failed.failure }),
        readiness,
      });
    };
    if ((consumerAttempt === null) !== (consumerNodeId === null)) return null;
    if (consumerAttempt !== null) {
      const consumerIndex = leaves.findIndex((node) => node.id === consumerNodeId);
      if (consumerIndex < 1) return null;
      const readinesses = producerArtifactReadinessesForConsumer({
        producerNodeIds: leaves.slice(0, consumerIndex).map((node) => node.id),
        consumerNodeId,
      });
      for (const readiness of [...readinesses].reverse()) {
        const candidate = candidateFor({ readiness, consumer: consumerNodeId });
        if (candidate !== null) return candidate;
      }
      return null;
    }
    for (let producerIndex = leaves.length - 1; producerIndex >= 0; producerIndex -= 1) {
      const producer = leaves[producerIndex];
      if (producer.status !== "failed"
        || leaves.slice(producerIndex + 1).some((node) => !["pending", "invalidated"].includes(node.status))) continue;
      const readinesses = producerArtifactReadinessesForProducer({ producerNodeId: producer.id });
      for (const readiness of readinesses) {
        const consumerIndex = leaves.findIndex((node) => node.id === readiness.consumerNodeId);
        if (consumerIndex <= producerIndex || leaves[consumerIndex]?.status !== "pending") continue;
        const candidate = candidateFor({ readiness, consumer: null });
        if (candidate !== null) return candidate;
      }
    }
    return null;
  }

  #consumerAdmission(state, consumerNodeId) {
    const leaves = state.definition.orderedLeaves(state.root);
    const index = leaves.findIndex((node) => node.id === consumerNodeId);
    if (index < 1) return null;
    const readinesses = producerArtifactReadinessesForConsumer({
      producerNodeIds: leaves.slice(0, index).map((node) => node.id),
      consumerNodeId,
    });
    return readinesses.length === 0 ? null : new ProducerArtifactReadinessAdmission({ readinesses });
  }

  // Replacement transitions may skip producers that a normal linear claim
  // would consume.  Only the two routes with an intact primary handoff are
  // admitted here; applying the generic predecessor scan to every recovery
  // would incorrectly require artifacts from explicitly skipped work.
  #replacementConsumerAdmission(state, { route, targetNodeId }) {
    const sourceNodeId = state.current?.at(-1) ?? null;
    const requiresAdmission = (
      route === "repair-plan-gate"
      && sourceNodeId === "spec-gate"
      && targetNodeId === "spec"
    ) || (
      route === "repair-acceptance-review"
      && sourceNodeId === "acceptance-review"
      && targetNodeId === "impl-triage"
    );
    return requiresAdmission ? this.#consumerAdmission(state, targetNodeId) : null;
  }

  #producerCompletionAdmission(producerNodeId, artifactWrites, { requireDraftCompletion = false } = {}) {
    this.#assertDraftPublication(producerNodeId, artifactWrites, {
      requireDraftCompletion,
      requireWriterCompletion: true,
    });
    const readinesses = producerArtifactReadinessesForProducer({ producerNodeId });
    return readinesses.length === 0
      ? null
      : new ProducerArtifactPublicationAdmission({ readinesses, artifactWrites });
  }

  /** The catalog publication boundary is the single writer gate for draft structure. */
  #assertDraftPublication(producerNodeId, artifactWrites, {
    requireDraftCompletion = false,
    requireWriterCompletion = false,
  } = {}) {
    if (!DRAFT_ARTIFACT_WRITER_STEPS.includes(producerNodeId)) return;
    if (!Array.isArray(artifactWrites)) {
      throw new CurrentFlowStateInvariantError("draft publication requires artifact writes");
    }
    const writes = artifactWrites.filter((entry) => entry?.logicalKey === "draft");
    if (writes.length > 1) {
      throw new CurrentFlowStateInvariantError("draft publication has duplicate draft writes");
    }
    const write = writes[0] ?? null;
    if (write === null) return;
    let lifecycle;
    try {
      lifecycle = new DraftLifecycle(JSON.parse(write.bytes.toString("utf8")));
    } catch (cause) {
      throw new CurrentFlowStateInvariantError(`draft publication is invalid: ${cause.message}`);
    }
    const issues = requireDraftCompletion
      ? lifecycle.validateForCompletion()
      : requireWriterCompletion ? lifecycle.validateForWriterCompletion() : lifecycle.validateForPublication();
    if (issues.length > 0) {
      throw new CurrentFlowStateInvariantError(`draft publication is incomplete: ${issues.join("; ")}`);
    }
  }

  /** Bind a synthetic connector to both sides of its source on one catalog snapshot. */
  #stepConnectionAdmission(state, sourceNodeId, artifactWrites) {
    const sourceConsumerAdmission = this.#consumerAdmission(state, sourceNodeId);
    if (sourceConsumerAdmission === null) {
      throw new CurrentFlowStateInvariantError(
        `Step connection source has no typed consumer readiness: ${sourceNodeId}`,
      );
    }
    return new StepConnectionAdmission({
      sourceConsumerAdmission,
      sourceProducerCompletionAdmission: this.#producerCompletionAdmission(sourceNodeId, artifactWrites, {
        requireDraftCompletion: true,
      }),
    });
  }

  #settlementAdmission(state, result) {
    const after = state.recordCurrentFailure({ result });
    const consumerNodeId = after.nextAction()?.nodeId ?? null;
    if (consumerNodeId === null) return null;
    return this.#consumerAdmission(after, consumerNodeId);
  }

  #attemptHistoryWrites({ specId, state, nodeId, commandResult, attemptSequence = state.attempt?.sequence }) {
    if (state.current?.at(-1) !== nodeId || state.attempt === null) {
      throw new CurrentFlowStateInvariantError("canonical command attempt history requires the active current Attempt");
    }
    const target = attemptHistoryTargetForNode(nodeId);
    if (target === null) return [];
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(target.logicalKey, target.parameters);
    const contract = artifact.contract;
    if (contract.contentContract === null) {
      throw new CurrentFlowStateInvariantError(`canonical attempt history contract is missing for ${target.logicalKey}`);
    }
    const updater = FlowArtifactUpdater.fromActivityNodeId(nodeId).toString();
    if (!contract.ownership.producers.includes(updater) && !contract.ownership.updaters.includes(updater)) {
      throw new CurrentFlowStateInvariantError(
        `canonical command Attempt producer is not authorized: ${updater}/${target.logicalKey}`,
      );
    }
    const previousBytes = this.#ownedArtifactBytes(specId, artifact);
    const previous = previousBytes === null
      ? new FlowArtifactAttemptHistory()
      : contract.contentContract.parse(previousBytes);
    if (!(previous instanceof FlowArtifactAttemptHistory)) {
      throw new CurrentFlowStateInvariantError(`canonical attempt history contract is invalid for ${target.logicalKey}`);
    }
    const payload = commandResultPayload(commandResult, nodeId, target.logicalKey);
    const attempt = attemptSequence;
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new CurrentFlowStateInvariantError("canonical command Attempt sequence is invalid");
    }
    const existing = previous.attempts.find((entry) => entry.attempt.value === attempt) ?? null;
    if (existing !== null) {
      if (JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
        throw new CurrentFlowStateInvariantError(
          `canonical attempt result already exists with different bytes: ${nodeId}/${attempt}`,
        );
      }
      return [];
    }
    const next = previous.append(new FlowArtifactAttemptRecord({ attempt, payload }));
    return [{
      logicalKey: target.logicalKey,
      parameters: target.parameters,
      mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(next.toJSON(), null, 2)}\n`, "utf8"),
    }];
  }

  #ownedArtifactBytes(specId, artifact) {
    const catalog = this.runtime.catalog(specId);
    const descriptor = catalog.artifacts.find((entry) => entry.relativePath === artifact.relativePath) ?? null;
    if (descriptor === null) return null;
    if (descriptor.logicalKey !== artifact.logicalKey) {
      throw new CurrentFlowStateInvariantError("canonical artifact catalog logical key conflicts with its resolved contract");
    }
    const location = this.location(specId);
    location.assertAuthority(artifact.relativePath, { mustExist: true });
    return Buffer.from(fs.readFileSync(location.resolve(artifact.relativePath)));
  }

  #commandPublicationWrites(commandResult) {
    return attachedCanonicalCommandResultPublications(commandResult)
      .map((publication) => publication.toArtifactWrite());
  }
}

export function canonicalFlowVersionLocation(store, specId) {
  if (!(store instanceof CanonicalFlowManagerStore)) {
    throw new CurrentFlowStateInvariantError("CanonicalFlowManagerStore is required");
  }
  const location = store.location(specId);
  if (location.version.value !== new FlowVersion(1).value) {
    throw new CurrentFlowStateInvariantError("canonical manager must resolve Flow Version 1");
  }
  return location;
}
