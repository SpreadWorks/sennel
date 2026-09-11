/**
 * src/flow/definition.js
 *
 * Single source of truth for the Spec-Driven Development flow structure.
 *
 * Every node carries the attributes that other modules previously derived
 * from context-rules.json, registry hooks, hardcoded constants, or prompt
 * literals. Adding / reordering steps is done here; consumers derive
 * behaviour from this data structure instead of maintaining parallel maps.
 *
 * Max depth: 3 (root list → branch → leaf). Traversal helpers enforce this.
 */

import { createHash } from "node:crypto";
import { SourceHandoffFailureFacts } from "./lib/source-handoff-failure.js";

import {
  ActivityFailure,
  CurrentFlowDefinition,
  DefinitionDraftDisposition,
  DefinitionReviewDisposition,
  DefinitionFailurePolicy,
  FlowDefinitionNode as CurrentFlowDefinitionNode,
  NodeContract as CurrentFlowNodeContract,
} from "./lib/current-flow-state.js";
import { draftReviewRouteForKey, draftReviewRouteForRetryPhase } from "./lib/draft-review-routes.js";
import {
  flattenSteps,
  findFirstPendingLeaf,
} from "./lib/step-tree.js";
import { nonblockingRouteFor } from "./lib/nonblocking-route.js";
import { TaskStepIdentity } from "./lib/task-step-identity.js";
import { canonicalTaskContextKinds } from "./lib/task-context-kinds.js";
import { DefinitionFailureOwnership } from "./lib/definition-failure-ownership.js";
import { ReviewTransitionFacts } from "./lib/review-transition-facts.js";
import { DraftTransitionFacts } from "./lib/draft-transition-facts.js";
import {
  DraftCompletionFacts,
  DraftCompletionConnector,
  createDraftCompletionConnector,
} from "./lib/draft-completion-connector.js";
import {
  flowReviewRouteForPhase,
  reviewPhaseForFlowStepId,
} from "./lib/review-route.js";
import { sourceWorkerEffectSchemaRef } from "./lib/source-worker-effect-schema.js";
import {
  TaskExecutionBudget,
  TaskExecutionOverrunDecision,
  TaskExecutionOverrunFacts,
  TaskExecutionRoundPolicy,
  resolveTaskExecutionOverrun,
} from "./lib/task-execution-policy.js";
import {
  TaskNoChangeContinuationFacts,
  TaskNoChangeContinuationSelection,
  TaskReviewStageBinding,
  TaskReviewStageFacts,
  TaskReviewStageStepEffect,
  TaskReviewStageTransitionPlan,
  createTaskReviewStageTransitionPlan,
  taskReviewStageEffects,
} from "./lib/task-review-stage-transition.js";

import {
  GateAttemptIdentity,
  GateCatalogPublication,
  GateFailureCategory,
  GateLineage,
  GatePostPublicationState,
  GateRecoveryEvidence,
  GateReviewFindingReadiness,
  GateRetryMetrics,
  GateProducerOwnership,
  GateTargetBinding,
  GateTaskLifecycle,
  TaskGateSettlementProgress,
  GateTransitionFacts,
} from "./lib/gate-transition.js";
import {
  NonGateAttemptIdentity,
  NonGateCatalogPublication,
  NonGateCompletionFacts,
  NonGateLineage,
  NonGateProducerOwnership,
  NonGateRepairPublication,
  NonGateRecoveryEvidence,
  NonGateRetryMetrics,
  NonGateSourcePublication,
  NonGateStepFacts,
  NonGateTargetBinding,
  NonGateTransitionFacts,
} from "./lib/non-gate-transition.js";
import {
  FinalRegressionArtifactDigest,
  FinalRegressionChangedFileSnapshot,
  FinalRegressionFailureProfileFact,
  FinalRegressionNonblockingPolicy,
  FinalRegressionProceedEvidence,
  FINAL_REGRESSION_RECORD_AND_PROCEED_ACTION_ID,
  FinalRegressionRetryHistory,
  FinalRegressionStepFacts,
} from "./lib/final-regression-transition.js";

// Facts are read by a focused boundary, but every Gate policy value and the
// only resolver live in this definition module. Commands, registry hooks,
// persistence, and next-action must consume this API instead of selecting a
// route themselves.
export {
  GateAttemptIdentity,
  GateCatalogPublication,
  GateFailureCategory,
  GateLineage,
  GatePostPublicationState,
  GateRecoveryEvidence,
  GateReviewFindingReadiness,
  GateRetryMetrics,
  GateProducerOwnership,
  GateTargetBinding,
  GateTaskLifecycle,
  TaskGateSettlementProgress,
  GateTransitionFacts,
  NonGateAttemptIdentity,
  NonGateCatalogPublication,
  NonGateCompletionFacts,
  NonGateLineage,
  NonGateProducerOwnership,
  NonGateRepairPublication,
  NonGateRecoveryEvidence,
  NonGateRetryMetrics,
  NonGateSourcePublication,
  NonGateStepFacts,
  NonGateTargetBinding,
  NonGateTransitionFacts,
  FinalRegressionArtifactDigest,
  FinalRegressionChangedFileSnapshot,
  FinalRegressionFailureProfileFact,
  FinalRegressionNonblockingPolicy,
  FinalRegressionProceedEvidence,
  FinalRegressionRetryHistory,
  FinalRegressionStepFacts,
  TaskExecutionBudget,
  TaskExecutionOverrunDecision,
  TaskExecutionOverrunFacts,
  TaskExecutionRoundPolicy,
  TaskNoChangeContinuationFacts,
  TaskNoChangeContinuationSelection,
  TaskReviewStageBinding,
  TaskReviewStageFacts,
  TaskReviewStageStepEffect,
  TaskReviewStageTransitionPlan,
};
export { selectTaskNoChangeContinuation } from "./lib/task-review-stage-transition.js";
export { resolveTaskExecutionOverrun } from "./lib/task-execution-policy.js";

/** Definition-owned response to verified source handoff failure facts. */
export class SourceHandoffTransitionPlan {
  constructor({ facts, disposition }) {
    if (!(facts instanceof SourceHandoffFailureFacts)) throw new Error("source handoff plan requires typed failure facts");
    if (!["wait", "block", "rollback", "preserve", "quarantine"].includes(disposition)) {
      throw new Error("invalid source handoff disposition");
    }
    if (disposition === "rollback" && (facts.kind !== "rejected" || !facts.ownershipProven || !facts.workerStopped)) {
      throw new Error("source rollback requires proven ownership and a stopped worker");
    }
    if ((disposition === "preserve" && (facts.kind !== "rejected" || !facts.workerStopped))
      || (disposition === "wait" && facts.kind !== "temporary-unavailable")
      || (disposition === "quarantine" && facts.kind !== "authority-violation")) {
      throw new Error("source handoff disposition contradicts its failure facts");
    }
    this.facts = facts;
    this.disposition = disposition;
    this.retryAfterSettlement = disposition === "rollback" && facts.retryable;
    this.failure = disposition === "quarantine" ? new ActivityFailure({
      category: "source-integrity", code: facts.code, message: facts.message,
      retryable: false, retryKind: null,
    }) : null;
    Object.freeze(this);
  }

  toJSON() {
    return {
      disposition: this.disposition, retryAfterSettlement: this.retryAfterSettlement,
      failure: this.failure?.toJSON() ?? null, facts: this.facts.toJSON(),
    };
  }
}

export function resolveSourceHandoffTransitionPlan({ facts, policy }) {
  if (!(facts instanceof SourceHandoffFailureFacts)) throw new Error("source handoff resolution requires typed facts");
  if (policy?.kind !== "source" || typeof policy.preservesRejectedSource !== "boolean") {
    throw new Error("source handoff resolution requires its source policy");
  }
  let disposition = "block";
  if (facts.kind === "temporary-unavailable") disposition = "wait";
  else if (facts.kind === "authority-violation") disposition = "quarantine";
  else if (facts.kind === "rejected") {
    if (policy.preservesRejectedSource && facts.workerStopped) disposition = "preserve";
    else if (facts.ownershipProven && facts.workerStopped) disposition = "rollback";
  }
  return new SourceHandoffTransitionPlan({ facts, disposition });
}

/** Resolve the Task-local review funnel from canonical, binding-checked facts. */
export function resolveTaskReviewStageTransition(facts) {
  if (!(facts instanceof TaskReviewStageFacts)) {
    throw new Error("resolveTaskReviewStageTransition requires TaskReviewStageFacts");
  }
  const taskId = facts.binding.taskId;
  const reviewBudgetConsumed = facts.binding.stage === "review" ? 1 : 0;
  const plan = (operation, entries, targetRole = null, options = {}) => createTaskReviewStageTransitionPlan(facts, {
    operation,
    effects: taskReviewStageEffects(taskId, entries),
    targetStepId: targetRole === null ? null : `${taskId}-${targetRole}`,
    reviewBudgetConsumed,
    ...options,
  });
  if (facts.binding.stage === "review") {
    if (facts.verdict === "REJECTED") {
      return plan("review-to-triage", [["review", "done"]], "triage");
    }
    if (facts.sourceNoChange) {
      if (!facts.noChangeContinuation?.eligible) {
        throw new Error("Task no-change completion requires canonical continuation evidence");
      }
      const reason = facts.noChangeContinuation.reason;
      return plan("review-no-change-complete", [
        ["review", "done"], ["triage", "skipped", reason], ["repair", "skipped", reason], ["gate", "skipped", reason],
      ]);
    }
    return plan("review-to-gate", [
      ["review", "done"],
      ["triage", "skipped", "Task Review has no must-fix findings."],
      ["repair", "skipped", "Task Review has no must-fix findings."],
    ], "gate");
  }
  if (facts.binding.stage === "triage") {
    if (facts.triageDisposition === "all-reject") {
      if (facts.sourceNoChange) {
        if (!facts.noChangeContinuation?.eligible) {
          throw new Error("Task no-change completion requires canonical continuation evidence");
        }
        const reason = facts.noChangeContinuation.reason;
        return plan("triage-no-change-complete", [
          ["triage", "done"], ["repair", "skipped", reason], ["gate", "skipped", reason],
        ]);
      }
      return plan("triage-all-reject-to-gate", [
        ["triage", "done"], ["repair", "skipped", facts.reason],
      ], "gate");
    }
    if (facts.sourceNoChange) {
      if (facts.taskRound === 2) {
        return plan("task-rounds-exhausted", [], null, {
          terminalReason: "Task no-change correction exhausted the two-round execution budget.",
        });
      }
      return plan("triage-no-change-correction", [
        ["impl", "invalidated"], ["review", "invalidated"], ["triage", "invalidated"],
        ["repair", "invalidated"], ["gate", "invalidated"],
      ], "impl");
    }
    return plan("triage-to-repair", [["triage", "done"]], "repair");
  }
  if (facts.reviewResultCount < 4) {
    return plan("repair-to-review", [
      ["review", "invalidated"], ["triage", "invalidated"], ["repair", "invalidated"], ["gate", "invalidated"],
    ], "review");
  }
  if (!facts.acceptanceCarryForwardReady) {
    throw new Error("fourth Task repair requires the unreviewed Acceptance handoff");
  }
  return plan("repair-unreviewed-to-gate", [["repair", "done"]], "gate", {
    acceptanceUnreviewed: true,
  });
}

const MAX_DEPTH = 3;

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

class ScalarMaxAttempts {
  constructor(value) {
    if (!isPositiveInteger(value)) {
      throw new Error("invalid maxAttempts: expected a positive integer");
    }
    this.value = value;
    Object.freeze(this);
  }

  resolve() {
    return this.value;
  }
}

class ModeMaxAttempts {
  constructor(value) {
    if (!isPlainObject(value)) {
      throw new Error("invalid maxAttempts: expected exactly own auto/manual keys");
    }
    const keys = Object.keys(value);
    if (
      keys.length !== 2
      || !Object.hasOwn(value, "auto")
      || !Object.hasOwn(value, "manual")
    ) {
      throw new Error("invalid maxAttempts: expected exactly own auto/manual keys");
    }
    if (!isPositiveInteger(value.auto) || !isPositiveInteger(value.manual)) {
      throw new Error("invalid maxAttempts: auto/manual must be positive integers");
    }
    this.auto = value.auto;
    this.manual = value.manual;
    Object.freeze(this);
  }

  resolve(context = {}) {
    return context.autoApprove === true ? this.auto : this.manual;
  }
}

function isPlainObject(value) {
  return (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function createMaxAttempts(value) {
  if (typeof value === "number") return new ScalarMaxAttempts(value);
  return new ModeMaxAttempts(value);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireStepList(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }
  return Object.freeze(value.map((step) => requireString(step, field)));
}

const GATE_DISPOSITIONS = new Set([
  "pass", "retry", "repair", "defer", "external-blocked", "blocked", "recovery", "reconcile", "nonblocking", "advance",
]);
const GATE_TRANSITION_TOKEN = Symbol("definition-gate-transition");
const DRAFT_COVERAGE_REPAIR_COMPLETION_TOKEN = Symbol("definition-draft-coverage-repair-completion");
export { DraftCompletionConnector } from "./lib/draft-completion-connector.js";

/** Definition is the sole selector; stores and handoffs receive only this plan. */
export function resolveDraftCompletionConnector(facts) {
  if (!(facts instanceof DraftCompletionFacts)) {
    throw new Error("resolveDraftCompletionConnector requires DraftCompletionFacts");
  }
  if (!facts.eligible) {
    throw new Error(`draft completion connector is unavailable: ${facts.eligibilityIssues.join("; ")}`);
  }
  return createDraftCompletionConnector(facts);
}

/** One sealed result for the shared draft-coverage-repair completion boundary. */
export class DraftCoverageRepairCompletionDecision {
  constructor(token, { facts, connector }) {
    if (token !== DRAFT_COVERAGE_REPAIR_COMPLETION_TOKEN || !(facts instanceof DraftCompletionFacts)) {
      throw new Error("Draft coverage repair completion is created only by the definition resolver");
    }
    if (!(connector instanceof DraftCompletionConnector)) {
      throw new Error("Draft coverage repair completion requires a DraftCompletionConnector");
    }
    this.facts = facts;
    this.connector = connector;
    this.kind = "draft-coverage-repair-completion";
    Object.freeze(this);
  }

  toJSON() {
    return {
      facts: this.facts.toJSON(),
      kind: this.kind,
      connector: this.connector?.toJSON() ?? null,
    };
  }
}

/** Definition selects the mandatory connector for the shared completion boundary. */
export function resolveDraftCoverageRepairCompletion(facts) {
  if (!(facts instanceof DraftCompletionFacts)) {
    throw new Error("resolveDraftCoverageRepairCompletion requires DraftCompletionFacts");
  }
  const connector = resolveDraftCompletionConnector(facts);
  return new DraftCoverageRepairCompletionDecision(
    DRAFT_COVERAGE_REPAIR_COMPLETION_TOKEN, { facts, connector },
  );
}

export class GateTransitionDisposition {
  constructor(token, { operation, reason = null } = {}) {
    if (token !== GATE_TRANSITION_TOKEN) {
      throw new Error("Gate dispositions are created only by the definition resolver");
    }
    this.operation = requireString(operation, "gate disposition operation");
    if (!GATE_DISPOSITIONS.has(this.operation)) throw new Error("gate disposition operation is invalid");
    this.reason = reason == null ? null : requireString(reason, "gate disposition reason");
    Object.freeze(this);
  }

  toJSON() { return { operation: this.operation, reason: this.reason }; }
}

class GateDisposition extends GateTransitionDisposition {
  constructor(token, operation, reason = null) { super(token, { operation, reason }); }
}

export class GatePassDisposition extends GateDisposition {
  constructor(token) { super(token, "pass"); }
}
export class GateRetryDisposition extends GateDisposition {
  constructor(token) { super(token, "retry"); }
}
export class GateRepairDisposition extends GateDisposition {
  constructor(token) { super(token, "repair"); }
}
export class GateDeferDisposition extends GateDisposition {
  constructor(token) { super(token, "defer"); }
}
export class GateExternalBlockedDisposition extends GateDisposition {
  constructor(token, reason) { super(token, "external-blocked", reason); }
}
export class GateBlockedDisposition extends GateDisposition {
  constructor(token, reason) { super(token, "blocked", reason); }
}
export class GateRecoveryDisposition extends GateDisposition {
  constructor(token) { super(token, "recovery"); }
}
export class GateReconcilePublicationDisposition extends GateDisposition {
  constructor(token) { super(token, "reconcile"); }
}
export class GateNonblockingDisposition extends GateDisposition {
  constructor(token) { super(token, "nonblocking"); }
}
export class GateAdvanceDisposition extends GateDisposition {
  constructor(token) { super(token, "advance"); }
}

export class GateStepUpdate {
  constructor({ stepId, status } = {}) {
    this.stepId = requireString(stepId, "gate step update stepId");
    this.status = requireString(status, "gate step update status");
    if (!["in_progress", "done"].includes(this.status)) {
      throw new Error("gate step update status is invalid");
    }
    Object.freeze(this);
  }

  toJSON() { return { stepId: this.stepId, status: this.status }; }
}

/** Definition-owned durable Gate retry metric mutation. */
export class GateRetryMetricEffect {
  constructor({ operation, phase } = {}) {
    this.operation = requireString(operation, "gate retry metric operation");
    this.phase = requireString(phase, "gate retry metric phase");
    if (!["increment", "reset"].includes(this.operation)) {
      throw new Error("gate retry metric operation is invalid");
    }
    if (!GATE_PHASE_DEFINITIONS.has(this.phase)) {
      throw new Error("gate retry metric phase is invalid");
    }
    Object.freeze(this);
  }
  toJSON() { return { operation: this.operation, phase: this.phase }; }
}

/** A sealed Task lifecycle consequence; adapters may apply but never select it. */
export class GateTaskLifecycleEffect {
  constructor({ operation, taskId, successorStepId, resetStepIds = [] } = {}) {
    this.operation = requireString(operation, "gate Task lifecycle operation");
    if (!new Set(["complete-and-advance", "repair-task-impl", "defer-and-advance"]).has(this.operation)) {
      throw new Error("gate Task lifecycle operation is invalid");
    }
    this.taskId = requireString(taskId, "gate Task lifecycle taskId");
    this.successorStepId = requireString(successorStepId, "gate Task lifecycle successorStepId");
    if (!Array.isArray(resetStepIds) || resetStepIds.some((stepId) => typeof stepId !== "string" || stepId === "")) {
      throw new Error("gate Task lifecycle reset Step ids are invalid");
    }
    this.resetStepIds = Object.freeze([...resetStepIds]);
    if (this.operation === "repair-task-impl" && JSON.stringify(this.resetStepIds) !== JSON.stringify([
      `${this.taskId}-impl`, `${this.taskId}-review`, `${this.taskId}-triage`, `${this.taskId}-repair`, `${this.taskId}-gate`,
    ])) throw new Error("gate Task repair lifecycle must reset only its materialized Task Steps");
    if (this.operation !== "repair-task-impl" && this.resetStepIds.length !== 0) {
      throw new Error("non-repair Task lifecycle must not reset Task Steps");
    }
    Object.freeze(this);
  }

  toJSON() {
    return { operation: this.operation, taskId: this.taskId, successorStepId: this.successorStepId, resetStepIds: [...this.resetStepIds] };
  }
}

/** Static report wording; transition routes are selected by Gate decisions. */
export class GatePhaseDefinition {
  constructor({ phase, passPrescription, failurePrescription } = {}) {
    this.phase = requireString(phase, "gate phase definition phase");
    this.passPrescription = requireString(passPrescription, "gate phase definition pass prescription");
    this.failurePrescription = requireString(failurePrescription, "gate phase definition failure prescription");
    Object.freeze(this);
  }
  toJSON() {
    return {
      phase: this.phase,
      passPrescription: this.passPrescription,
      failurePrescription: this.failurePrescription,
    };
  }
}

const GATE_PHASE_DEFINITIONS = new Map([
  ["draft", new GatePhaseDefinition({ phase: "draft", passPrescription: "Continue with the Definition-selected Gate action.", failurePrescription: "Repair the draft evidence selected by Definition." })],
  ["spec", new GatePhaseDefinition({ phase: "spec", passPrescription: "Continue with the Definition-selected Gate action.", failurePrescription: "Repair the specification evidence selected by Definition." })],
  // task-spec is a flow-level validation command. It cannot materialize or
  // enter a Task lifecycle; only the existing spec approval route may admit
  // Task impl/review/triage/repair/gate leaves.
  ["task-spec", new GatePhaseDefinition({ phase: "task-spec", passPrescription: "Continue with the Definition-selected Gate action.", failurePrescription: "Return to the flow-level specification approval path." })],
  ["task-impl", new GatePhaseDefinition({ phase: "task-impl", passPrescription: "Continue with the Definition-selected Gate action.", failurePrescription: "Repair the Task implementation selected by Definition." })],
  ["integration", new GatePhaseDefinition({ phase: "integration", passPrescription: "Continue with the Definition-selected Gate action.", failurePrescription: "Repair the integration evidence selected by Definition." })],
]);

function gatePhaseDefinition(phase) {
  const definition = GATE_PHASE_DEFINITIONS.get(phase);
  if (definition === undefined) throw new Error(`missing Gate phase definition: ${phase}`);
  return definition;
}

/** Return diagnostic wording only; callers receive no route identifier. */
export function gateReportPrescription(phase, result) {
  if (result !== "pass" && result !== "fail") throw new Error("gate report prescription requires pass or fail");
  const definition = gatePhaseDefinition(phase);
  return result === "pass" ? definition.passPrescription : definition.failurePrescription;
}

/** A sealed Definition-owned recovery route, never a runner-selected rewind. */
export class GateRecoveryEffect {
  constructor({ operation, sourceStepId, targetStepId } = {}) {
    this.operation = requireString(operation, "gate recovery operation");
    this.sourceStepId = requireString(sourceStepId, "gate recovery source Step");
    this.targetStepId = requireString(targetStepId, "gate recovery target Step");
    if (this.operation !== "rewind-test-evidence"
      || this.sourceStepId !== "impl-gate"
      || this.targetStepId !== "test-execute") {
      throw new Error("gate recovery effect is invalid");
    }
    Object.freeze(this);
  }
  toJSON() { return { operation: this.operation, sourceStepId: this.sourceStepId, targetStepId: this.targetStepId }; }
}

/** The exact acceptance-backed route selected for an advisory Gate result. */
export class GateNonblockingHandoff {
  constructor({ sourceStepId, targetStepId } = {}) {
    this.sourceStepId = requireString(sourceStepId, "gate nonblocking source Step");
    this.targetStepId = requireString(targetStepId, "gate nonblocking target Step");
    if (this.sourceStepId !== "impl-gate" || this.targetStepId !== "retro") {
      throw new Error("gate nonblocking handoff is invalid");
    }
    Object.freeze(this);
  }
  toJSON() { return { sourceStepId: this.sourceStepId, targetStepId: this.targetStepId }; }
}

export class GateStepUpdatePlan {
  constructor(token, { action, phaseDefinition, updates, taskLifecycle = null, recoveryEffect = null, nonblockingHandoff = null, retryMetric = null } = {}) {
    if (token !== GATE_TRANSITION_TOKEN) {
      throw new Error("Gate step update plans are created only by the definition resolver");
    }
    if (!(action instanceof GateTransitionAction)) throw new Error("gate step update plan requires a typed Action");
    if (!(phaseDefinition instanceof GatePhaseDefinition)) throw new Error("gate step update plan requires a typed phase definition");
    if (!Array.isArray(updates) || updates.some((entry) => !(entry instanceof GateStepUpdate))) {
      throw new Error("gate step update plan requires typed updates");
    }
    if (retryMetric !== null && !(retryMetric instanceof GateRetryMetricEffect)) throw new Error("gate step update retry metric must be typed");
    if (taskLifecycle !== null && !(taskLifecycle instanceof GateTaskLifecycleEffect)) {
      throw new Error("gate step update plan requires typed Task lifecycle effect");
    }
    if (recoveryEffect !== null && !(recoveryEffect instanceof GateRecoveryEffect)) {
      throw new Error("gate step update plan requires typed recovery effect");
    }
    if (nonblockingHandoff !== null && !(nonblockingHandoff instanceof GateNonblockingHandoff)) {
      throw new Error("gate step update plan requires typed nonblocking handoff");
    }
    this.action = action;
    this.phaseDefinition = phaseDefinition;
    this.updates = Object.freeze([...updates]);
    this.taskLifecycle = taskLifecycle;
    this.recoveryEffect = recoveryEffect;
    this.nonblockingHandoff = nonblockingHandoff;
    this.retryMetric = retryMetric;
    Object.freeze(this);
  }

  toJSON() {
    return {
      action: this.action.toJSON(),
      phaseDefinition: this.phaseDefinition.toJSON(),
      updates: this.updates.map((entry) => entry.toJSON()),
      taskLifecycle: this.taskLifecycle?.toJSON() ?? null,
      recoveryEffect: this.recoveryEffect?.toJSON() ?? null,
      nonblockingHandoff: this.nonblockingHandoff?.toJSON() ?? null,
      retryMetric: this.retryMetric?.toJSON() ?? null,
    };
  }
}

/** Stable, persisted-fact-only identity for a Definition-selected Gate route. */
export class GateActionIdentity {
  constructor(token, { runId, specId, taskId = null, stepId, attempt, catalogFingerprint, factsFingerprint, selectedFingerprint, operation } = {}) {
    if (token !== GATE_TRANSITION_TOKEN) throw new Error("Gate Action identities are created only by the definition resolver");
    this.runId = requireString(runId, "gate Action runId");
    this.specId = requireString(specId, "gate Action specId");
    this.taskId = taskId == null ? null : requireString(taskId, "gate Action taskId");
    this.stepId = requireString(stepId, "gate Action stepId");
    this.attempt = attempt instanceof GateAttemptIdentity ? attempt : new GateAttemptIdentity(attempt);
    this.catalogFingerprint = requireString(catalogFingerprint, "gate Action catalog fingerprint");
    this.factsFingerprint = requireString(factsFingerprint, "gate Action facts fingerprint");
    this.selectedFingerprint = requireString(selectedFingerprint, "gate Action selected fingerprint");
    this.operation = requireString(operation, "gate Action operation");
    if (!GATE_DISPOSITIONS.has(this.operation)) throw new Error("gate Action operation is invalid");
    Object.freeze(this);
  }

  matches(other) {
    return other instanceof GateActionIdentity
      && this.runId === other.runId
      && this.specId === other.specId
      && this.taskId === other.taskId
      && this.stepId === other.stepId
      && this.attempt.matches(other.attempt)
      && this.catalogFingerprint === other.catalogFingerprint
      && this.factsFingerprint === other.factsFingerprint
      && this.selectedFingerprint === other.selectedFingerprint
      && this.operation === other.operation;
  }

  toJSON() {
    return {
      runId: this.runId, specId: this.specId, ...(this.taskId === null ? {} : { taskId: this.taskId }), stepId: this.stepId, attempt: this.attempt.toJSON(),
      catalogFingerprint: this.catalogFingerprint, factsFingerprint: this.factsFingerprint,
      selectedFingerprint: this.selectedFingerprint, operation: this.operation,
    };
  }
}

export class GateTransitionAction {
  constructor(token, { identity } = {}) {
    if (token !== GATE_TRANSITION_TOKEN || !(identity instanceof GateActionIdentity)) {
      throw new Error("Gate Actions are created only by the definition resolver");
    }
    this.identity = identity;
    Object.freeze(this);
  }

  toJSON() { return { identity: this.identity.toJSON() }; }
}

export class GateTransitionDecision {
  constructor(token, { facts, disposition, advance = null, plan } = {}) {
    if (token !== GATE_TRANSITION_TOKEN) {
      throw new Error("Gate transition decisions are created only by definition resolver");
    }
    if (!(facts instanceof GateTransitionFacts)) throw new Error("gate decision requires typed facts");
    if (!(disposition instanceof GateTransitionDisposition)) throw new Error("gate decision requires typed disposition");
    if (advance !== null && !(advance instanceof GateAdvanceDisposition)) {
      throw new Error("gate decision advance must be typed");
    }
    if (!(plan instanceof GateStepUpdatePlan)) throw new Error("gate decision requires typed plan");
    if (plan.action.identity.operation !== disposition.operation) {
      throw new Error("gate decision plan Action does not match disposition");
    }
    this.facts = facts;
    this.disposition = disposition;
    this.advance = advance;
    this.plan = plan;
    Object.freeze(this);
  }

  toJSON() {
    return {
      facts: this.facts.toJSON(),
      disposition: this.disposition.toJSON(),
      advance: this.advance?.toJSON() ?? null,
      plan: this.plan.toJSON(),
    };
  }
}

/** Public command outcome derived from a sealed Gate decision, not runner policy. */
export class GatePublicOutcomeProjection {
  constructor({ failureCode = null, nextStepId = null } = {}) {
    this.failureCode = failureCode == null ? null : requireString(failureCode, "gate public failure code");
    this.nextStepId = nextStepId == null ? null : requireString(nextStepId, "gate public next Step");
    Object.freeze(this);
  }
  get failed() { return this.failureCode !== null; }
  toJSON() {
    return {
      failed: this.failed,
      failureCode: this.failureCode,
      nextStepId: this.nextStepId,
    };
  }
}

export function projectGatePublicOutcome(decision) {
  if (!(decision instanceof GateTransitionDecision)) throw new Error("gate public projection requires a definition decision");
  const recovery = decision.plan.recoveryEffect;
  if (recovery !== null) {
    return new GatePublicOutcomeProjection({ nextStepId: recovery.targetStepId });
  }
  if (!["external-blocked", "blocked"].includes(decision.disposition.operation)) {
    return new GatePublicOutcomeProjection();
  }
  const phase = decision.facts.phase;
  const sourceCode = decision.facts.failure?.code ?? "GATE_EXTERNAL_BLOCKED";
  if (decision.facts.failure?.category === "local") {
    return new GatePublicOutcomeProjection({ failureCode: "GATE_LOCAL_INPUT_INVALID" });
  }
  return new GatePublicOutcomeProjection({
    failureCode: ["draft", "spec", "task-spec"].includes(phase) || sourceCode === "GATE_EXTERNAL_BLOCKED"
      ? "STEP_EXTERNAL_BLOCKED"
      : sourceCode,
  });
}

function stableGateJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableGateJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableGateJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function taskLifecycleEffect(facts, disposition) {
  if (facts.taskLifecycle === null) return null;
  const lifecycle = facts.taskLifecycle;
  if (disposition.operation === "pass") return new GateTaskLifecycleEffect({
    operation: "complete-and-advance", taskId: lifecycle.taskId, successorStepId: lifecycle.successorStepId,
  });
  if (disposition.operation === "defer") return new GateTaskLifecycleEffect({
    operation: "defer-and-advance", taskId: lifecycle.taskId, successorStepId: lifecycle.successorStepId,
  });
  if (disposition.operation === "repair") return new GateTaskLifecycleEffect({
    operation: "repair-task-impl", taskId: lifecycle.taskId, successorStepId: lifecycle.implStepId,
    resetStepIds: [
      lifecycle.implStepId,
      lifecycle.reviewStepId,
      lifecycle.triageStepId,
      lifecycle.repairStepId,
      lifecycle.gateStepId,
    ],
  });
  return null;
}

function gatePlan(facts, disposition, { status = "in_progress", updates = null, recoveryEffect = null, nonblockingHandoff = null, retryMetric = null } = {}) {
  const phaseDefinition = gatePhaseDefinition(facts.phase);
  const selectedUpdates = updates ?? [new GateStepUpdate({ stepId: facts.target.stepId, status })];
  const lifecycle = taskLifecycleEffect(facts, disposition);
  const selectedFingerprint = createHash("sha256").update(stableGateJson({
    disposition: disposition.toJSON(), phaseDefinition: phaseDefinition.toJSON(), updates: selectedUpdates.map((entry) => entry.toJSON()), taskLifecycle: lifecycle?.toJSON() ?? null,
    recoveryEffect: recoveryEffect?.toJSON() ?? null, nonblockingHandoff: nonblockingHandoff?.toJSON() ?? null, retryMetric: retryMetric?.toJSON() ?? null,
  })).digest("hex");
  const identity = new GateActionIdentity(GATE_TRANSITION_TOKEN, {
    runId: facts.producer.runId,
    specId: facts.producer.specId,
    taskId: facts.target.taskId,
    stepId: facts.target.stepId,
    attempt: facts.currentAttempt,
    catalogFingerprint: facts.catalogPublication.fingerprint,
    factsFingerprint: createHash("sha256").update(stableGateJson(facts.toJSON())).digest("hex"),
    selectedFingerprint,
    operation: disposition.operation,
  });
  return new GateStepUpdatePlan(GATE_TRANSITION_TOKEN, {
    action: new GateTransitionAction(GATE_TRANSITION_TOKEN, { identity }), phaseDefinition, updates: selectedUpdates, taskLifecycle: lifecycle,
    recoveryEffect, nonblockingHandoff, retryMetric,
  });
}

function gateDecision(facts, disposition, options = {}) {
  const { advance = null } = options;
  return new GateTransitionDecision(GATE_TRANSITION_TOKEN, {
    facts, disposition, advance, plan: gatePlan(facts, disposition, options),
  });
}

/**
 * The definition's phase-neutral Gate policy. Phase migrations may add their
 * own facts, but execution and projection layers cannot choose a disposition.
 */
function resolveGateClassification(facts) {
  if (!(facts instanceof GateTransitionFacts)) {
    throw new Error("resolveGateTransition requires GateTransitionFacts");
  }
  if (facts.integrityFailure !== null) {
    return gateDecision(facts, new GateBlockedDisposition(GATE_TRANSITION_TOKEN, facts.integrityFailure));
  }
  // A PASS evaluator result cannot erase an unresolved implementation-review
  // obligation. The typed readiness reader binds review, triage and repair
  // lineage before Definition decides whether the integration Gate may pass.
  if (facts.phase === "integration" && facts.result === "pass" && !facts.reviewReadiness.allowsPass) {
    return gateDecision(facts, new GateBlockedDisposition(
      GATE_TRANSITION_TOKEN,
      "unresolved_review_findings",
    ));
  }
  if (facts.result === "pass") {
    return gateDecision(facts, new GatePassDisposition(GATE_TRANSITION_TOKEN), {
      advance: new GateAdvanceDisposition(GATE_TRANSITION_TOKEN), status: "done",
      retryMetric: new GateRetryMetricEffect({ operation: "reset", phase: facts.phase }),
    });
  }
  if (facts.result === "recovered" || facts.recoveryEvidence.kind === "recovered") {
    const recoveryEffect = facts.phase === "integration"
      ? new GateRecoveryEffect({ operation: "rewind-test-evidence", sourceStepId: facts.target.stepId, targetStepId: "test-execute" })
      : null;
    return gateDecision(facts, new GateRecoveryDisposition(GATE_TRANSITION_TOKEN), {
      updates: [], recoveryEffect,
    });
  }
  if (facts.phase === "integration" && facts.nonblocking) {
    const nonblockingHandoff = facts.phase === "integration"
      ? new GateNonblockingHandoff({ sourceStepId: facts.target.stepId, targetStepId: "retro" })
      : null;
    return gateDecision(facts, new GateNonblockingDisposition(GATE_TRANSITION_TOKEN), {
      nonblockingHandoff,
    });
  }
  if (facts.failure.category === "tooling") {
    return gateDecision(facts, new GateExternalBlockedDisposition(
      GATE_TRANSITION_TOKEN, facts.failure.code || "tooling_failure",
    ));
  }
  if (facts.failure.category === "local") {
    return gateDecision(facts, new GateBlockedDisposition(
      GATE_TRANSITION_TOKEN, facts.failure.code || "local_input_invalid",
    ));
  }
  // Task Gates consume their semantic retry budget before considering a
  // plan-repair receipt. A gate:post receipt is emitted after every failed
  // evaluation, so letting it win here would open an unbudgeted Task round.
  if (facts.scope === "task" && !facts.retry.exhausted) {
    return gateDecision(facts, new GateRetryDisposition(GATE_TRANSITION_TOKEN), {
      retryMetric: new GateRetryMetricEffect({ operation: "increment", phase: facts.phase }),
    });
  }
  // Other Gate scopes retain their sealed repair-receipt lifecycle. Their
  // repair route has no bounded Task execution-round transition to protect.
  if (facts.recoveryEvidence.kind === "repair" && !facts.retry.exhausted) {
    return gateDecision(facts, new GateRepairDisposition(GATE_TRANSITION_TOKEN));
  }
  if (!facts.retry.exhausted) {
    return gateDecision(facts, new GateRetryDisposition(GATE_TRANSITION_TOKEN), {
      retryMetric: new GateRetryMetricEffect({ operation: "increment", phase: facts.phase }),
    });
  }
  if (facts.scope === "task" && !facts.taskBudget.finalRound) {
    return gateDecision(facts, new GateRepairDisposition(GATE_TRANSITION_TOKEN));
  }
  // The failed Attempt remains current until the canonical settlement command
  // records its finding.  `defer` therefore has no premature status advance.
  return gateDecision(facts, new GateDeferDisposition(GATE_TRANSITION_TOKEN));
}

export function resolveGateTransition(facts) {
  if (!(facts instanceof GateTransitionFacts)) {
    throw new Error("resolveGateTransition requires GateTransitionFacts");
  }
  return resolveGateClassification(facts);
}

/**
 * Select the one recovery action that is available after result publication
 * and before the post hook has classified that result.  This is intentionally
 * separate from the semantic Gate decision: the post hook still receives the
 * same Definition-owned pass/fail plan it would have selected uninterrupted.
 */
export function resolveGatePublicationRecovery(facts) {
  if (!(facts instanceof GateTransitionFacts)) {
    throw new Error("resolveGatePublicationRecovery requires GateTransitionFacts");
  }
  if (facts.integrityFailure !== null) return null;
  // Non-Task Gates retain their original publication-only recovery path:
  // no classification is needed until the normal transition reducer runs.
  if (facts.scope !== "task") {
    return facts.postPublication.requiresReconciliation
      ? gateDecision(facts, new GateReconcilePublicationDisposition(GATE_TRANSITION_TOKEN), { updates: [] })
      : null;
  }
  const classified = resolveGateClassification(facts);
  const taskSettlementIncomplete = facts.taskSettlementProgress.requiresReconciliation({
    classificationRequired: facts.result === "fail",
    metricEffect: classified.plan.retryMetric,
    issueLogRequired: facts.result === "pass" || facts.result === "fail",
    terminalLifecycleRequired: classified.plan.updates.some((update) => update.status === "done"),
  });
  if (!facts.postPublication.requiresReconciliation && !taskSettlementIncomplete) return null;
  return gateDecision(facts, new GateReconcilePublicationDisposition(GATE_TRANSITION_TOKEN), {
    updates: [],
  });
}

/** Task Gate-only alias that keeps post-publication settlement policy in Definition. */
export function resolveTaskGateSettlementRecovery(facts) {
  if (!(facts instanceof GateTransitionFacts) || facts.scope !== "task") return null;
  return resolveGatePublicationRecovery(facts);
}

// Non-Gate transition policy is intentionally independent from the Gate
// transition policy above.  A Step contributes typed evidence, while this
// reducer alone selects the disposition, plan and stable Action identity.
/**
 * Finalization recovery is deliberately a Definition decision, not an
 * incidental side effect of the next-action reader.  The facts are small
 * value objects because this boundary crosses the canonical store, the main
 * repository and the runtime log.
 */
const FINALIZATION_RECOVERY_TOKEN = Symbol("definition-finalization-recovery");
const FINALIZATION_RECOVERY_OPERATIONS = new Set([
  "ordinary-execute", "exact-outbox-recovery", "interrupted-sync-settlement",
  "pre-sync-conflict-repair", "blocked", "exhausted",
]);

export class FinalizationRecoveryTargetFact {
  constructor({ scope, stepId } = {}) {
    if (scope !== "flow") throw new Error("finalization recovery target must be flow scoped");
    if (!new Set(["report", "finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup"]).has(stepId)) {
      throw new Error("finalization recovery target step is invalid");
    }
    this.scope = scope;
    this.stepId = stepId;
    Object.freeze(this);
  }
}

export class FinalizationOutboxFact {
  constructor({ idempotencyKey = null, status = "missing", attempt = 0, failure = null, recovery = null, exactRecoveryReceipt = null } = {}) {
    if (!new Set(["missing", "pending", "done", "failed"]).has(status)) throw new Error("finalization outbox status is invalid");
    if (idempotencyKey !== null) requireString(idempotencyKey, "finalization outbox idempotencyKey");
    if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("finalization outbox attempt is invalid");
    if (status === "missing" && (idempotencyKey !== null || attempt !== 0 || failure !== null)) {
      throw new Error("missing finalization outbox cannot carry persisted identity or outcome facts");
    }
    if (status !== "missing" && (idempotencyKey === null || attempt < 1)) {
      throw new Error("persisted finalization outbox requires identity and attempt facts");
    }
    if (status === "failed") requireString(failure, "finalization outbox failure");
    if (status !== "failed" && failure !== null) throw new Error("only failed finalization outbox may carry a failure");
    if (recovery !== null && (typeof recovery !== "object" || Array.isArray(recovery))) throw new Error("finalization outbox recovery is invalid");
    const receipt = exactRecoveryReceipt === null
      ? null
      : exactRecoveryReceipt instanceof FinalizationExactRecoveryReceiptFact
        ? exactRecoveryReceipt
        : new FinalizationExactRecoveryReceiptFact(exactRecoveryReceipt);
    if (receipt !== null && (receipt.idempotencyKey !== idempotencyKey || receipt.attempt !== attempt)) {
      throw new Error("finalization exact recovery receipt must bind its outbox identity and attempt");
    }
    this.idempotencyKey = idempotencyKey;
    this.status = status;
    this.attempt = attempt;
    this.failure = failure;
    this.recovery = recovery === null ? null : Object.freeze(structuredClone(recovery));
    this.exactRecoveryReceipt = receipt;
    Object.freeze(this);
  }
}

export class FinalizationExactRecoveryReceiptFact {
  constructor({ idempotencyKey, attempt, failure, recoveryKey = null } = {}) {
    this.idempotencyKey = requireString(idempotencyKey, "finalization exact recovery receipt idempotencyKey");
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("finalization exact recovery receipt attempt is invalid");
    this.attempt = attempt;
    this.failure = requireString(failure, "finalization exact recovery receipt failure");
    this.recoveryKey = recoveryKey === null ? null : requireString(recoveryKey, "finalization exact recovery receipt recoveryKey");
    Object.freeze(this);
  }
}

export class FinalizationDurableProofFact {
  constructor({ durable = false } = {}) {
    if (typeof durable !== "boolean") throw new Error("finalization durable proof must be boolean");
    this.durable = durable;
    Object.freeze(this);
  }
}

export class FinalizationOperationLockFact {
  constructor({ status = "not-acquired" } = {}) {
    if (!new Set(["not-acquired", "busy", "available"]).has(status)) throw new Error("finalization operation lock status is invalid");
    this.status = status;
    Object.freeze(this);
  }
}

export class FinalizationMainAuthorityFact {
  constructor({ mainRoot, authorityRoot } = {}) {
    this.mainRoot = requireString(mainRoot, "finalization main authority root");
    this.authorityRoot = requireString(authorityRoot, "finalization state authority root");
    Object.freeze(this);
  }

  ownsMainState() {
    return this.authorityRoot === this.mainRoot;
  }
}

export class FinalizationPreSyncFact {
  constructor({ state = null } = {}) {
    if (state !== null && !new Set(["rebased", "needs-repair", "unavailable"]).has(state)) {
      throw new Error("finalization pre-sync state is invalid");
    }
    this.state = state;
    Object.freeze(this);
  }
}

export class InterruptedFinalizeSyncRuntimeLogFact {
  constructor({ receipt = null } = {}) {
    if (receipt !== null && (typeof receipt !== "object" || Array.isArray(receipt))) throw new Error("interrupted finalize-sync runtime receipt is invalid");
    if (receipt !== null) {
      const fields = Object.keys(receipt).sort();
      if (JSON.stringify(fields) !== JSON.stringify(["command", "complete", "runId", "sequence", "startedAt"].sort())) {
        throw new Error("interrupted finalize-sync runtime receipt fields are invalid");
      }
      requireString(receipt.runId, "interrupted finalize-sync runtime receipt runId");
      if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) throw new Error("interrupted finalize-sync runtime receipt sequence is invalid");
      if (receipt.command !== "flow run finalize-sync") throw new Error("interrupted finalize-sync runtime receipt command is invalid");
      requireString(receipt.startedAt, "interrupted finalize-sync runtime receipt startedAt");
      if (Number.isNaN(Date.parse(receipt.startedAt))) throw new Error("interrupted finalize-sync runtime receipt startedAt is invalid");
      if (receipt.complete !== false) throw new Error("interrupted finalize-sync runtime receipt must be incomplete");
    }
    this.receipt = receipt === null ? null : Object.freeze(structuredClone(receipt));
    Object.freeze(this);
  }
}

export class FinalizationRecoveryFacts {
  constructor({ target, outbox, durableProof, operationLock, mainAuthority, interruptedRuntimeLog = new InterruptedFinalizeSyncRuntimeLogFact(), preSync = new FinalizationPreSyncFact() } = {}) {
    if (!(target instanceof FinalizationRecoveryTargetFact)) throw new Error("finalization recovery requires a typed target");
    if (!(outbox instanceof FinalizationOutboxFact)) throw new Error("finalization recovery requires typed outbox facts");
    if (!(durableProof instanceof FinalizationDurableProofFact)) throw new Error("finalization recovery requires durable proof facts");
    if (!(operationLock instanceof FinalizationOperationLockFact)) throw new Error("finalization recovery requires operation lock facts");
    if (!(mainAuthority instanceof FinalizationMainAuthorityFact)) throw new Error("finalization recovery requires main authority facts");
    if (!(interruptedRuntimeLog instanceof InterruptedFinalizeSyncRuntimeLogFact)) throw new Error("finalization recovery requires runtime log facts");
    if (!(preSync instanceof FinalizationPreSyncFact)) throw new Error("finalization recovery requires pre-sync facts");
    this.target = target;
    this.outbox = outbox;
    this.durableProof = durableProof;
    this.operationLock = operationLock;
    this.mainAuthority = mainAuthority;
    this.interruptedRuntimeLog = interruptedRuntimeLog;
    this.preSync = preSync;
    Object.freeze(this);
  }
}

export class FinalizationRecoveryDecision {
  constructor(token, { facts, operation, reason = null } = {}) {
    if (token !== FINALIZATION_RECOVERY_TOKEN) throw new Error("finalization recovery decisions are created only by Definition");
    if (!(facts instanceof FinalizationRecoveryFacts)) throw new Error("finalization recovery decision requires typed facts");
    if (!FINALIZATION_RECOVERY_OPERATIONS.has(operation)) throw new Error("finalization recovery operation is invalid");
    this.facts = facts;
    this.operation = operation;
    this.reason = reason === null ? null : requireString(reason, "finalization recovery reason");
    Object.freeze(this);
  }
}

/** Select exactly one finalization route from canonical, immutable facts. */
export function resolveFinalizationRecovery(facts) {
  if (!(facts instanceof FinalizationRecoveryFacts)) throw new Error("resolveFinalizationRecovery requires typed facts");
  const { target, outbox, operationLock, mainAuthority, interruptedRuntimeLog, preSync } = facts;
  const recoveryPending = (target.stepId === "finalize-sync" && outbox.status === "pending" && interruptedRuntimeLog.receipt !== null)
    || outbox.status === "failed";
  if (recoveryPending && operationLock.status === "busy") {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "blocked", reason: "operation_lock_busy" });
  }
  if (["finalize-sync", "finalize-cleanup"].includes(target.stepId) && recoveryPending && !mainAuthority.ownsMainState()) {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "blocked", reason: "main_authority_required" });
  }
  if (target.stepId === "finalize-sync" && outbox.status === "pending" && interruptedRuntimeLog.receipt !== null) {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "interrupted-sync-settlement" });
  }
  if (outbox.status !== "failed") {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "ordinary-execute" });
  }
  if (preSync.state === "needs-repair") {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "pre-sync-conflict-repair" });
  }
  if (preSync.state === "unavailable") {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "blocked", reason: "pre_sync_state_unavailable" });
  }
  const recoveryKey = outbox.recovery?.baseHead ?? null;
  if (outbox.exactRecoveryReceipt !== null && (recoveryKey === null || outbox.exactRecoveryReceipt.recoveryKey === recoveryKey)) {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "exhausted", reason: "exact_recovery_consumed" });
  }
  if (target.stepId !== "finalize-merge" && !facts.durableProof.durable) {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "blocked", reason: "durable_proof_unavailable" });
  }
  return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "exact-outbox-recovery" });
}

const NON_GATE_TRANSITION_TOKEN = Symbol("definition-non-gate-transition");
const NON_GATE_OPERATIONS = new Set([
  "advance", "keep-in-progress", "await-user-input", "retry", "repair",
  "record-and-proceed", "external-blocked", "blocked", "park",
]);

export class NonGateTransitionDisposition {
  constructor(token, { operation, reason = null } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN) {
      throw new Error("non-Gate dispositions are created only by the definition resolver");
    }
    this.operation = requireString(operation, "non-Gate disposition operation");
    if (!NON_GATE_OPERATIONS.has(this.operation)) throw new Error("non-Gate disposition operation is invalid");
    this.reason = reason == null ? null : requireString(reason, "non-Gate disposition reason");
    Object.freeze(this);
  }

  toJSON() { return { operation: this.operation, reason: this.reason }; }
}

class NonGateDisposition extends NonGateTransitionDisposition {
  constructor(token, operation, reason = null) { super(token, { operation, reason }); }
}

export class NonGateAdvanceDisposition extends NonGateDisposition { constructor(token) { super(token, "advance"); } }
export class NonGateKeepInProgressDisposition extends NonGateDisposition { constructor(token) { super(token, "keep-in-progress"); } }
export class NonGateAwaitUserInputDisposition extends NonGateDisposition { constructor(token, reason = null) { super(token, "await-user-input", reason); } }
export class NonGateRetryDisposition extends NonGateDisposition { constructor(token) { super(token, "retry"); } }
export class NonGateRepairDisposition extends NonGateDisposition { constructor(token) { super(token, "repair"); } }
export class NonGateRecordAndProceedDisposition extends NonGateDisposition { constructor(token) { super(token, "record-and-proceed"); } }
export class NonGateExternalBlockedDisposition extends NonGateDisposition { constructor(token, reason) { super(token, "external-blocked", reason); } }
export class NonGateBlockedDisposition extends NonGateDisposition { constructor(token, reason) { super(token, "blocked", reason); } }
export class NonGateParkDisposition extends NonGateDisposition { constructor(token, reason = null) { super(token, "park", reason); } }

/** A Definition-declared, guarded operator choice; it is not a route field. */
export class NonGateUserActionSelection {
  constructor({ actionId } = {}) {
    this.actionId = requireString(actionId, "non-Gate user action id");
    if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(this.actionId)) {
      throw new Error("non-Gate user action id is invalid");
    }
    Object.freeze(this);
  }

  toJSON() { return { actionId: this.actionId }; }
}

/**
 * A Step-specific Definition returns this declaration after interpreting its
 * own typed facts.  It is deliberately not a transition plan: only the
 * common Definition reducer below mints a sealed decision, plan and Action.
 */
export class NonGateTransitionSelection {
  constructor({ operation, reason = null, beforeActions = [], actions = [], exhaustedActions = [], userActions = [] } = {}) {
    this.operation = requireString(operation, "non-Gate selection operation");
    if (!NON_GATE_OPERATIONS.has(this.operation)) throw new Error("non-Gate selection operation is invalid");
    this.reason = reason == null ? null : requireString(reason, "non-Gate selection reason");
    for (const actionList of [beforeActions, actions, exhaustedActions]) {
      if (!Array.isArray(actionList) || actionList.some((action) => (
      !(action instanceof NonGateStepAction)
      || !Object.isFrozen(action)
      || action.apply === NonGateStepAction.prototype.apply
      || action.toJSON === NonGateStepAction.prototype.toJSON
      ))) throw new Error("non-Gate selection actions must be typed Step actions");
    }
    this.beforeActions = Object.freeze([...beforeActions]);
    this.actions = Object.freeze([...actions]);
    this.exhaustedActions = Object.freeze([...exhaustedActions]);
    if (!Array.isArray(userActions) || userActions.some((action) => !(action instanceof NonGateUserActionSelection))) {
      throw new Error("non-Gate selection user actions must be typed");
    }
    if (new Set(userActions.map((action) => action.actionId)).size !== userActions.length) {
      throw new Error("non-Gate selection user actions must be unique");
    }
    this.userActions = Object.freeze([...userActions]);
    Object.freeze(this);
  }
}

/** Extension base for Step-specific persistence actions selected by Definition. */
export class NonGateStepAction {
  constructor() {
    if (new.target === NonGateStepAction) throw new Error("non-Gate Step actions require a dedicated subclass");
  }

  apply() { throw new Error("non-Gate Step action subclasses must implement apply()"); }
  toJSON() { throw new Error("non-Gate Step action subclasses must implement toJSON()"); }
}

/**
 * Extension boundary for a non-Gate Step's Definition-owned policy.  A
 * producer supplies only its typed facts; this Definition selects a semantic
 * disposition, and the shared reducer remains the sole plan authority.
 */
export class NonGateStepDefinition {
  constructor({ stepId, factsType, select } = {}) {
    this.stepId = requireString(stepId, "non-Gate Step Definition stepId");
    if (typeof factsType !== "function" || !(factsType.prototype instanceof NonGateStepFacts)) {
      throw new Error("non-Gate Step Definition factsType must extend NonGateStepFacts");
    }
    if (typeof select !== "function") throw new Error("non-Gate Step Definition select must be a function");
    this.factsType = factsType;
    this.select = select;
    Object.freeze(this);
  }

  selectionFor(facts) {
    if (!(facts instanceof NonGateTransitionFacts) || facts.stepId !== this.stepId) {
      throw new Error("non-Gate Step Definition does not own these facts");
    }
    if (!(facts.stepFacts instanceof this.factsType)) {
      throw new Error("non-Gate Step Definition received incompatible typed Step facts");
    }
    const selection = this.select(facts.stepFacts, facts);
    if (!(selection instanceof NonGateTransitionSelection)) {
      throw new Error("non-Gate Step Definition must return NonGateTransitionSelection");
    }
    return selection;
  }
}

/**
 * Final regression owns its meaning here.  The runner supplies observations
 * and the registry applies this sealed result; neither is permitted to turn
 * a failure category into an independent route.
 */
function selectFinalRegressionTransition(stepFacts, facts = null) {
  if (!(stepFacts instanceof FinalRegressionStepFacts)) {
    throw new Error("final-regression Definition requires FinalRegressionStepFacts");
  }
  if (!stepFacts.changedFileSnapshot.current) {
    return new NonGateTransitionSelection({ operation: "blocked", reason: "stale_changed_file_snapshot" });
  }
  if (facts !== null && (
    stepFacts.retryHistory.used !== facts.retry.used
    || stepFacts.retryHistory.maximum !== facts.retry.maximum
  )) {
    return new NonGateTransitionSelection({ operation: "blocked", reason: "retry_history_mismatch" });
  }
  if (stepFacts.result === "pass" || stepFacts.result === "skipped") {
    return new NonGateTransitionSelection({ operation: "advance" });
  }
  if (stepFacts.recordAndProceed.accepted) {
    return new NonGateTransitionSelection({ operation: "record-and-proceed" });
  }
  if (stepFacts.failure.tooling) {
    return new NonGateTransitionSelection({
      operation: "external-blocked",
      reason: stepFacts.failure.kind || "tooling_failure",
      beforeActions: finalRegressionFailureActions(stepFacts),
    });
  }
  if (stepFacts.failure.currentChange) {
    if (stepFacts.retryHistory.exhausted) {
      return new NonGateTransitionSelection({
        operation: "await-user-input",
        reason: "retry_exhausted",
        beforeActions: finalRegressionFailureActions(stepFacts),
        userActions: [new NonGateUserActionSelection({ actionId: FINAL_REGRESSION_RECORD_AND_PROCEED_ACTION_ID })],
      });
    }
    return new NonGateTransitionSelection({
      operation: "repair",
      beforeActions: finalRegressionFailureActions(stepFacts, { retryable: true }),
    });
  }
  if (stepFacts.failure.existing) {
    return new NonGateTransitionSelection({
      operation: "await-user-input",
      beforeActions: finalRegressionFailureActions(stepFacts),
      userActions: [new NonGateUserActionSelection({ actionId: FINAL_REGRESSION_RECORD_AND_PROCEED_ACTION_ID })],
    });
  }
  return new NonGateTransitionSelection({
    operation: "blocked",
    reason: stepFacts.retryHistory.exhausted ? "retry_exhausted" : "unclassified_failure",
    beforeActions: finalRegressionFailureActions(stepFacts),
  });
}

/** The producer records the failure profile; Definition owns its settlement. */
function finalRegressionFailureAction(stepFacts, { retryable = false } = {}) {
  return new NonGateFailCurrentAttemptAction(NON_GATE_TRANSITION_TOKEN, {
    category: stepFacts.failure.category || "unknown",
    code: "FINAL_REGRESSION_FAILED",
    retryable,
    retryKind: retryable ? "semantic" : null,
    message: `final-regression failed (${stepFacts.failure.kind || "unknown"})`,
  });
}

function finalRegressionFailureActions(stepFacts, options = {}) {
  return stepFacts.failureRecorded ? [] : [finalRegressionFailureAction(stepFacts, options)];
}

export const FINAL_REGRESSION_STEP_DEFINITION = new NonGateStepDefinition({
  stepId: "final-regression",
  factsType: FinalRegressionStepFacts,
  select: selectFinalRegressionTransition,
});

/** Stable Action identity; it intentionally contains no clock or caller data. */
export class NonGateActionIdentity {
  constructor(token, { runId, specId, stepId, attempt, catalogFingerprint, factsFingerprint, selectedFingerprint, operation } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN) {
      throw new Error("non-Gate Action identities are created only by the definition resolver");
    }
    this.runId = requireString(runId, "non-Gate Action runId");
    this.specId = requireString(specId, "non-Gate Action specId");
    this.stepId = requireString(stepId, "non-Gate Action stepId");
    this.attempt = attempt instanceof NonGateAttemptIdentity ? attempt : new NonGateAttemptIdentity(attempt);
    this.catalogFingerprint = requireString(catalogFingerprint, "non-Gate Action catalog fingerprint");
    this.factsFingerprint = requireString(factsFingerprint, "non-Gate Action facts fingerprint");
    this.selectedFingerprint = requireString(selectedFingerprint, "non-Gate Action selected fingerprint");
    this.operation = requireString(operation, "non-Gate Action operation");
    if (!NON_GATE_OPERATIONS.has(this.operation)) throw new Error("non-Gate Action operation is invalid");
    Object.freeze(this);
  }

  matches(other) {
    return other instanceof NonGateActionIdentity
      && this.runId === other.runId
      && this.specId === other.specId
      && this.stepId === other.stepId
      && this.attempt.matches(other.attempt)
      && this.catalogFingerprint === other.catalogFingerprint
      && this.factsFingerprint === other.factsFingerprint
      && this.selectedFingerprint === other.selectedFingerprint
      && this.operation === other.operation;
  }

  toJSON() {
    return {
      runId: this.runId, specId: this.specId, stepId: this.stepId,
      attempt: this.attempt.toJSON(), catalogFingerprint: this.catalogFingerprint,
      factsFingerprint: this.factsFingerprint, operation: this.operation,
      selectedFingerprint: this.selectedFingerprint,
    };
  }
}

/** Stable identity for one Definition-selected guarded operator choice. */
export class NonGateUserActionIdentity {
  constructor(token, { transition, actionId } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN || !(transition instanceof NonGateActionIdentity)) {
      throw new Error("non-Gate user Action identities are created only by the definition resolver");
    }
    this.transition = transition;
    this.actionId = requireString(actionId, "non-Gate user Action id");
    if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(this.actionId)) {
      throw new Error("non-Gate user Action id is invalid");
    }
    Object.freeze(this);
  }

  matches(other) {
    return other instanceof NonGateUserActionIdentity
      && this.actionId === other.actionId
      && this.transition.matches(other.transition);
  }

  toJSON() { return { transition: this.transition.toJSON(), actionId: this.actionId }; }
}

export class NonGateTransitionAction {
  constructor(token, { identity } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN || !(identity instanceof NonGateActionIdentity)) {
      throw new Error("non-Gate Actions are created only by the definition resolver");
    }
    this.identity = identity;
    Object.freeze(this);
  }

  toJSON() { return { identity: this.identity.toJSON() }; }
}

/** A guarded user action bound to the same immutable transition identity. */
export class NonGateUserAction {
  constructor(token, { identity } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN || !(identity instanceof NonGateUserActionIdentity)) {
      throw new Error("non-Gate user Actions are created only by the definition resolver");
    }
    this.identity = identity;
    this.actionId = identity.actionId;
    Object.freeze(this);
  }

  toJSON() { return { identity: this.identity.toJSON() }; }
}

export class NonGateStepUpdate {
  constructor({ stepId, status } = {}) {
    this.stepId = requireString(stepId, "non-Gate step update stepId");
    this.status = requireString(status, "non-Gate step update status");
    if (!["in_progress", "done"].includes(this.status)) throw new Error("non-Gate step update status is invalid");
    Object.freeze(this);
  }

  toJSON() { return { stepId: this.stepId, status: this.status }; }
}

/** Typed plan effect; adapters apply it but cannot replace it with a route. */
export class NonGateSetStepStatusAction extends NonGateStepAction {
  constructor(token, { update } = {}) {
    super();
    if (token !== NON_GATE_TRANSITION_TOKEN || !(update instanceof NonGateStepUpdate)) throw new Error("non-Gate status action requires a definition update");
    this.update = update;
    Object.freeze(this);
  }
  apply(adapter, plan) { return adapter.setStepStatus(this.update, plan); }
  toJSON() { return { action: "set-step-status", update: this.update.toJSON() }; }
}

export class NonGateIncrementRetryAction extends NonGateStepAction {
  constructor(token, { stepId } = {}) {
    super();
    if (token !== NON_GATE_TRANSITION_TOKEN) throw new Error("non-Gate retry action requires the definition resolver");
    this.stepId = requireString(stepId, "non-Gate retry action stepId");
    Object.freeze(this);
  }
  apply(adapter, plan) { return adapter.incrementRetry(this.stepId, plan); }
  toJSON() { return { action: "increment-retry", stepId: this.stepId }; }
}

/** Definition-selected settlement; the registry adapter cannot invent it. */
export class NonGateFailCurrentAttemptAction extends NonGateStepAction {
  constructor(token, { category, code, retryable, retryKind = null, message } = {}) {
    super();
    if (token !== NON_GATE_TRANSITION_TOKEN) throw new Error("non-Gate failure action requires the definition resolver");
    this.category = requireString(category, "non-Gate failure category");
    this.code = requireString(code, "non-Gate failure code");
    if (typeof retryable !== "boolean") throw new Error("non-Gate failure retryable must be boolean");
    this.retryable = retryable;
    this.retryKind = retryKind == null ? null : requireString(retryKind, "non-Gate failure retry kind");
    this.message = requireString(message, "non-Gate failure message");
    Object.freeze(this);
  }
  apply(adapter, plan) { return adapter.failCurrentAttempt(this, plan); }
  toJSON() {
    return { action: "fail-current-attempt", category: this.category, code: this.code,
      retryable: this.retryable, retryKind: this.retryKind, message: this.message };
  }
}

/** Definition-selected advisory observation, applied while its Attempt is active. */
export class NonGateRecordNonblockingAction extends NonGateStepAction {
  constructor(token, { stepId } = {}) {
    super();
    if (token !== NON_GATE_TRANSITION_TOKEN) throw new Error("non-Gate nonblocking action requires the definition resolver");
    this.stepId = requireString(stepId, "non-Gate nonblocking stepId");
    Object.freeze(this);
  }
  apply(adapter, plan) { return adapter.recordNonblocking(this.stepId, plan); }
  toJSON() { return { action: "record-nonblocking", stepId: this.stepId }; }
}

function immutableTransitionEvidence(value) {
  if (value === null || typeof value !== "object") return value;
  for (const entry of Object.values(value)) immutableTransitionEvidence(entry);
  return Object.freeze(value);
}

/** Immutable repair evidence is appended only after Definition accepts it. */
export class NonGateAppendRepairEvidenceAction extends NonGateStepAction {
  constructor(token, { stepId, summary, testSourceRevision } = {}) {
    super();
    if (token !== NON_GATE_TRANSITION_TOKEN) throw new Error("non-Gate repair evidence action requires the definition resolver");
    this.stepId = requireString(stepId, "non-Gate repair evidence stepId");
    if (!Array.isArray(summary)) throw new Error("non-Gate repair evidence summary must be an array");
    this.summary = immutableTransitionEvidence(structuredClone(summary));
    this.testSourceRevision = requireString(testSourceRevision, "non-Gate repair evidence testSourceRevision");
    Object.freeze(this);
  }
  apply(adapter, plan) { return adapter.appendRepairEvidence(this, plan); }
  toJSON() { return { action: "append-repair-evidence", stepId: this.stepId, summary: structuredClone(this.summary), testSourceRevision: this.testSourceRevision }; }
}

/** Sealed typed authority consumed by persistence and command admission only. */
export class NonGateTransitionPlan {
  constructor(token, { action, actions, userActions = [] } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN) {
      throw new Error("non-Gate transition plans are created only by the definition resolver");
    }
    if (!(action instanceof NonGateTransitionAction)) throw new Error("non-Gate plan requires a typed Action");
    if (!Array.isArray(actions) || actions.some((entry) => !(entry instanceof NonGateStepAction))) {
      throw new Error("non-Gate plan requires typed actions");
    }
    if (!Array.isArray(userActions) || userActions.some((entry) => !(entry instanceof NonGateUserAction))) {
      throw new Error("non-Gate plan requires typed user actions");
    }
    if (new Set(userActions.map((entry) => entry.actionId)).size !== userActions.length) {
      throw new Error("non-Gate plan user actions must be unique");
    }
    this.action = action;
    this.actions = Object.freeze([...actions]);
    this.userActions = Object.freeze([...userActions]);
    Object.freeze(this);
  }

  userActionFor(actionId) {
    const id = requireString(actionId, "non-Gate user Action lookup id");
    return this.userActions.find((action) => action.actionId === id) ?? null;
  }

  toJSON() {
    return {
      action: this.action.toJSON(), actions: this.actions.map((entry) => entry.toJSON()),
      userActions: this.userActions.map((entry) => entry.toJSON()),
    };
  }
}

export class NonGateTransitionDecision {
  constructor(token, { facts, disposition, plan } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN) {
      throw new Error("non-Gate transition decisions are created only by the definition resolver");
    }
    if (!(facts instanceof NonGateTransitionFacts)) throw new Error("non-Gate decision requires typed facts");
    if (!(disposition instanceof NonGateTransitionDisposition)) throw new Error("non-Gate decision requires typed disposition");
    if (!(plan instanceof NonGateTransitionPlan)) throw new Error("non-Gate decision requires typed plan");
    if (plan.action.identity.operation !== disposition.operation) throw new Error("non-Gate plan Action does not match disposition");
    this.facts = facts;
    this.disposition = disposition;
    this.plan = plan;
    Object.freeze(this);
  }

  toJSON() { return { facts: this.facts.toJSON(), disposition: this.disposition.toJSON(), plan: this.plan.toJSON() }; }
}

/** Retrieve only a user action sealed into the selected Definition plan. */
export function selectedNonGateUserAction(decision, actionId) {
  if (!(decision instanceof NonGateTransitionDecision)) {
    throw new Error("non-Gate user action requires a Definition decision");
  }
  const action = decision.plan.userActionFor(actionId);
  if (action === null) {
    throw new Error("Definition does not select the requested non-Gate user action");
  }
  if (!action.identity.transition.matches(decision.plan.action.identity)) {
    throw new Error("non-Gate user action does not match the selected Definition Action");
  }
  return action;
}

function nonGatePlan(facts, disposition, { status = "in_progress", incrementRetry = false, beforeActions = [], stepActions = [], userActions = [], noEffects = false } = {}) {
  if (noEffects) {
    const identity = new NonGateActionIdentity(NON_GATE_TRANSITION_TOKEN, {
      runId: facts.runId, specId: facts.specId, stepId: facts.stepId, attempt: facts.currentAttempt,
      catalogFingerprint: facts.catalogPublication.fingerprint, factsFingerprint: nonGateFactsFingerprint(facts),
      selectedFingerprint: createHash("sha256").update(stableJson({ disposition: disposition.toJSON(), actions: [], userActions: userActions.map((entry) => entry.toJSON()) })).digest("hex"),
      operation: disposition.operation,
    });
    return new NonGateTransitionPlan(NON_GATE_TRANSITION_TOKEN, {
      action: new NonGateTransitionAction(NON_GATE_TRANSITION_TOKEN, { identity }), actions: [],
      userActions: userActions.map((entry) => new NonGateUserAction(NON_GATE_TRANSITION_TOKEN, {
        identity: new NonGateUserActionIdentity(NON_GATE_TRANSITION_TOKEN, { transition: identity, actionId: entry.actionId }),
      })),
    });
  }
  const update = new NonGateStepUpdate({ stepId: facts.stepId, status });
  const actions = [
    ...beforeActions,
    new NonGateSetStepStatusAction(NON_GATE_TRANSITION_TOKEN, { update }),
    ...(incrementRetry ? [new NonGateIncrementRetryAction(NON_GATE_TRANSITION_TOKEN, { stepId: facts.stepId })] : []),
    ...stepActions,
  ];
  const identity = new NonGateActionIdentity(NON_GATE_TRANSITION_TOKEN, {
    runId: facts.runId,
    specId: facts.specId,
    stepId: facts.stepId,
    attempt: facts.currentAttempt,
    catalogFingerprint: facts.catalogPublication.fingerprint,
    factsFingerprint: nonGateFactsFingerprint(facts),
    selectedFingerprint: createHash("sha256").update(stableJson({ disposition: disposition.toJSON(), actions: actions.map((entry) => entry.toJSON()), userActions: userActions.map((entry) => entry.toJSON()) })).digest("hex"),
    operation: disposition.operation,
  });
  return new NonGateTransitionPlan(NON_GATE_TRANSITION_TOKEN, {
    action: new NonGateTransitionAction(NON_GATE_TRANSITION_TOKEN, { identity }),
    actions,
    userActions: userActions.map((entry) => new NonGateUserAction(NON_GATE_TRANSITION_TOKEN, {
      identity: new NonGateUserActionIdentity(NON_GATE_TRANSITION_TOKEN, { transition: identity, actionId: entry.actionId }),
    })),
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function nonGateFactsFingerprint(facts) {
  return createHash("sha256").update(stableJson(facts.toJSON())).digest("hex");
}

function nonGateDecision(facts, disposition, options) {
  return new NonGateTransitionDecision(NON_GATE_TRANSITION_TOKEN, {
    facts,
    disposition,
    plan: nonGatePlan(facts, disposition, options),
  });
}

/** Deterministic, phase-neutral reducer for all non-Gate Step facts. */
export function resolveNonGateTransition(facts, stepDefinition) {
  if (!(facts instanceof NonGateTransitionFacts)) {
    throw new Error("resolveNonGateTransition requires NonGateTransitionFacts");
  }
  if (!(stepDefinition instanceof NonGateStepDefinition)) {
    throw new Error("resolveNonGateTransition requires a typed Step Definition");
  }
  if (facts.integrityFailure !== null) {
    return nonGateDecision(facts, new NonGateBlockedDisposition(NON_GATE_TRANSITION_TOKEN, facts.integrityFailure), { noEffects: true });
  }
  if (facts.completion.partial) {
    return nonGateDecision(facts, new NonGateBlockedDisposition(NON_GATE_TRANSITION_TOKEN, "partial_completion"), { noEffects: true });
  }
  const selection = stepDefinition.selectionFor(facts);
  const selectedDecision = (disposition, options = {}) => nonGateDecision(facts, disposition, {
    ...options,
    beforeActions: options.beforeActions ?? selection.beforeActions,
    stepActions: options.stepActions ?? selection.actions,
    userActions: options.userActions ?? selection.userActions,
  });
  if (selection.operation === "advance") {
    if (!facts.completion.completed) return selectedDecision(new NonGateBlockedDisposition(NON_GATE_TRANSITION_TOKEN, "completion_unconfirmed"));
    return selectedDecision(new NonGateAdvanceDisposition(NON_GATE_TRANSITION_TOKEN), { status: "done" });
  }
  if (selection.operation === "keep-in-progress") return selectedDecision(new NonGateKeepInProgressDisposition(NON_GATE_TRANSITION_TOKEN));
  if (selection.operation === "await-user-input") return selectedDecision(new NonGateAwaitUserInputDisposition(NON_GATE_TRANSITION_TOKEN, selection.reason));
  if (selection.operation === "retry") {
    if (facts.retry.exhausted) return selectedDecision(new NonGateBlockedDisposition(NON_GATE_TRANSITION_TOKEN, "retry_exhausted"), {
      stepActions: selection.exhaustedActions,
    });
    return selectedDecision(new NonGateRetryDisposition(NON_GATE_TRANSITION_TOKEN), { incrementRetry: true });
  }
  if (selection.operation === "repair") return selectedDecision(new NonGateRepairDisposition(NON_GATE_TRANSITION_TOKEN));
  if (selection.operation === "record-and-proceed") {
    return selectedDecision(new NonGateRecordAndProceedDisposition(NON_GATE_TRANSITION_TOKEN), { status: "done" });
  }
  if (selection.operation === "external-blocked") {
    return selectedDecision(new NonGateExternalBlockedDisposition(NON_GATE_TRANSITION_TOKEN, selection.reason || "external_blocked"));
  }
  if (selection.operation === "park") {
    return selectedDecision(new NonGateParkDisposition(NON_GATE_TRANSITION_TOKEN, selection.reason), { status: "done" });
  }
  return selectedDecision(new NonGateBlockedDisposition(NON_GATE_TRANSITION_TOKEN, selection.reason || "blocked"));
}

function requireDigest(value, field) {
  const digest = requireString(value, field);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}

/** One immutable catalog input consumed by the retro stale-evidence route. */
export class RetroStaleEvidencePublication {
  constructor({ logicalKey, relativePath, hash, activityId } = {}) {
    this.logicalKey = requireString(logicalKey, "retro stale evidence logicalKey");
    if (!new Set(["test.execute", "test.result.review"]).has(this.logicalKey)) {
      throw new Error("retro stale evidence logicalKey is invalid");
    }
    this.relativePath = requireString(relativePath, "retro stale evidence relativePath");
    this.hash = requireDigest(hash, "retro stale evidence hash");
    this.activityId = requireString(activityId, "retro stale evidence activityId");
    Object.freeze(this);
  }

  toJSON() {
    return {
      logicalKey: this.logicalKey,
      relativePath: this.relativePath,
      hash: this.hash,
      activityId: this.activityId,
    };
  }
}

/** Canonical facts for the fixed retro -> test-execute stale-evidence recovery. */
export class RetroStaleEvidenceRecoveryFacts {
  constructor({ runId, specId, stepId, attemptId, sequence, snapshotRevision, publications, artifactNames, previousFingerprint, currentFingerprint } = {}) {
    this.runId = requireString(runId, "retro stale evidence runId");
    this.specId = requireString(specId, "retro stale evidence specId");
    this.stepId = requireString(stepId, "retro stale evidence stepId");
    if (this.stepId !== "retro") throw new Error("retro stale evidence facts require the retro Step");
    this.attemptId = requireString(attemptId, "retro stale evidence Attempt id");
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("retro stale evidence Attempt sequence is invalid");
    this.sequence = sequence;
    this.snapshotRevision = requireString(snapshotRevision, "retro stale evidence snapshot revision");
    if (!Array.isArray(publications) || publications.length !== 2) {
      throw new Error("retro stale evidence facts require exactly two catalog publications");
    }
    this.publications = Object.freeze(publications.map((entry) => (
      entry instanceof RetroStaleEvidencePublication ? entry : new RetroStaleEvidencePublication(entry)
    )).sort((left, right) => left.logicalKey.localeCompare(right.logicalKey)));
    if (new Set(this.publications.map((entry) => entry.logicalKey)).size !== this.publications.length) {
      throw new Error("retro stale evidence catalog publications must be unique");
    }
    if (!Array.isArray(artifactNames) || artifactNames.length === 0
      || artifactNames.some((entry) => typeof entry !== "string" || entry === "")) {
      throw new Error("retro stale evidence artifact names are required");
    }
    this.artifactNames = Object.freeze([...new Set(artifactNames)].sort());
    this.previousFingerprint = requireDigest(previousFingerprint, "retro stale evidence previous fingerprint");
    this.currentFingerprint = requireDigest(currentFingerprint, "retro stale evidence current fingerprint");
    if (this.previousFingerprint === this.currentFingerprint) {
      throw new Error("retro stale evidence recovery requires mismatched fingerprints");
    }
    this.catalogFingerprint = createHash("sha256").update(stableJson(this.publications.map((entry) => entry.toJSON()))).digest("hex");
    Object.freeze(this);
  }

  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      stepId: this.stepId,
      attemptId: this.attemptId,
      sequence: this.sequence,
      snapshotRevision: this.snapshotRevision,
      publications: this.publications.map((entry) => entry.toJSON()),
      artifactNames: [...this.artifactNames],
      previousFingerprint: this.previousFingerprint,
      currentFingerprint: this.currentFingerprint,
      catalogFingerprint: this.catalogFingerprint,
    };
  }
}

export class RetroStaleEvidenceRecoveryEffect {
  constructor({ operation = "rewind-test-evidence", sourceStepId = "retro", targetStepId = "test-execute" } = {}) {
    this.operation = requireString(operation, "retro stale evidence recovery operation");
    this.sourceStepId = requireString(sourceStepId, "retro stale evidence recovery source Step");
    this.targetStepId = requireString(targetStepId, "retro stale evidence recovery target Step");
    if (this.operation !== "rewind-test-evidence" || this.sourceStepId !== "retro" || this.targetStepId !== "test-execute") {
      throw new Error("retro stale evidence recovery effect is invalid");
    }
    Object.freeze(this);
  }

  toJSON() { return { operation: this.operation, sourceStepId: this.sourceStepId, targetStepId: this.targetStepId }; }
}

export class RetroStaleEvidenceRecoveryActionIdentity {
  constructor(token, { facts, effect } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN || !(facts instanceof RetroStaleEvidenceRecoveryFacts)
      || !(effect instanceof RetroStaleEvidenceRecoveryEffect)) {
      throw new Error("retro stale evidence recovery Action identity requires Definition facts and effect");
    }
    this.runId = facts.runId;
    this.specId = facts.specId;
    this.stepId = facts.stepId;
    this.attemptId = facts.attemptId;
    this.sequence = facts.sequence;
    this.snapshotRevision = facts.snapshotRevision;
    this.catalogFingerprint = facts.catalogFingerprint;
    this.factsFingerprint = createHash("sha256").update(stableJson(facts.toJSON())).digest("hex");
    this.selectedFingerprint = createHash("sha256").update(stableJson(effect.toJSON())).digest("hex");
    Object.freeze(this);
  }

  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      stepId: this.stepId,
      attemptId: this.attemptId,
      sequence: this.sequence,
      snapshotRevision: this.snapshotRevision,
      catalogFingerprint: this.catalogFingerprint,
      factsFingerprint: this.factsFingerprint,
      selectedFingerprint: this.selectedFingerprint,
    };
  }
}

export class RetroStaleEvidenceRecoveryPlan {
  constructor(token, { facts, effect } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN || !(facts instanceof RetroStaleEvidenceRecoveryFacts)
      || !(effect instanceof RetroStaleEvidenceRecoveryEffect)) {
      throw new Error("retro stale evidence recovery plan requires Definition facts and effect");
    }
    this.effect = effect;
    this.action = new RetroStaleEvidenceRecoveryActionIdentity(token, { facts, effect });
    Object.freeze(this);
  }

  toJSON() { return { effect: this.effect.toJSON(), action: this.action.toJSON() }; }
}

/** Sealed non-Gate recovery plan: retro only reports stale facts; Definition selects the rewind. */
export class RetroStaleEvidenceRecoveryDecision {
  constructor(token, { facts, plan } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN || !(facts instanceof RetroStaleEvidenceRecoveryFacts)
      || !(plan instanceof RetroStaleEvidenceRecoveryPlan)) {
      throw new Error("retro stale evidence recovery decision requires a Definition plan");
    }
    this.facts = facts;
    this.plan = plan;
    Object.freeze(this);
  }

  toJSON() { return { facts: this.facts.toJSON(), plan: this.plan.toJSON() }; }
}

/** The sole selector for stale retro evidence; execution code cannot choose a rewind route. */
export function resolveRetroStaleEvidenceRecovery(facts) {
  if (!(facts instanceof RetroStaleEvidenceRecoveryFacts)) {
    throw new Error("resolveRetroStaleEvidenceRecovery requires typed retro stale evidence facts");
  }
  const effect = new RetroStaleEvidenceRecoveryEffect();
  return new RetroStaleEvidenceRecoveryDecision(NON_GATE_TRANSITION_TOKEN, {
    facts,
    plan: new RetroStaleEvidenceRecoveryPlan(NON_GATE_TRANSITION_TOKEN, { facts, effect }),
  });
}

// Approval and acceptance are deliberately not expressed as generic worker
// completion.  Their evidence is either a cataloged Spec publication or a
// canonical review/decision artifact, and their next route must remain owned
// by Definition even though the corresponding commands are setters.
const DEFINITION_ROUTE_TOKEN = Symbol("definition-route");

function digestText(value, field) {
  const text = requireString(value, field);
  if (!/^[a-f0-9]{64}$/i.test(text)) throw new Error(`${field} must be a SHA-256 digest`);
  return text;
}

function frozenStrings(value, field) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${field} must not contain duplicates`);
  return Object.freeze([...value]);
}

/** A target is never inferred from the caller; it is bound to the active Attempt. */
export class DefinitionRouteTarget {
  constructor({ runId, specId, stepId, attemptId, sequence } = {}) {
    this.runId = requireString(runId, "definition route target runId");
    this.specId = requireString(specId, "definition route target specId");
    this.stepId = requireString(stepId, "definition route target stepId");
    this.attemptId = requireString(attemptId, "definition route target attemptId");
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("definition route target sequence must be positive");
    this.sequence = sequence;
    Object.freeze(this);
  }

  toJSON() { return { runId: this.runId, specId: this.specId, stepId: this.stepId, attemptId: this.attemptId, sequence: this.sequence }; }
}

export class ApprovalRouteFacts {
  constructor({ target, specPublicationDigest, approvalRecord = null, requestedApproval = false, autoApprove = false } = {}) {
    this.target = target instanceof DefinitionRouteTarget ? target : new DefinitionRouteTarget(target);
    if (this.target.stepId !== "approval") throw new Error("approval facts require the approval target");
    this.specPublicationDigest = digestText(specPublicationDigest, "approval spec publication digest");
    if (approvalRecord !== null && (approvalRecord?.approved !== true || typeof approvalRecord.confirmed_at !== "string")) {
      throw new Error("approval record must be a canonical approved record");
    }
    if (typeof requestedApproval !== "boolean" || typeof autoApprove !== "boolean") throw new Error("approval route flags must be boolean");
    this.approvalRecord = approvalRecord === null ? null : Object.freeze(structuredClone(approvalRecord));
    this.requestedApproval = requestedApproval;
    this.autoApprove = autoApprove;
    Object.freeze(this);
  }

  get integrityFailure() {
    if (this.approvalRecord !== null && this.requestedApproval) return "approval_already_recorded";
    return null;
  }

  toJSON() { return { target: this.target.toJSON(), specPublicationDigest: this.specPublicationDigest, approvalRecord: this.approvalRecord, requestedApproval: this.requestedApproval, autoApprove: this.autoApprove }; }
}

export class AcceptanceReviewRouteFacts {
  constructor({ target, reviewArtifactDigest, requirementIds, findingDispositions, verdict, completed = true } = {}) {
    this.target = target instanceof DefinitionRouteTarget ? target : new DefinitionRouteTarget(target);
    if (this.target.stepId !== "acceptance-review") throw new Error("acceptance review facts require the acceptance-review target");
    this.reviewArtifactDigest = digestText(reviewArtifactDigest, "acceptance review artifact digest");
    this.requirementIds = frozenStrings(requirementIds, "acceptance requirement IDs");
    this.findingDispositions = frozenStrings(findingDispositions, "acceptance finding dispositions");
    this.verdict = requireString(verdict, "acceptance review verdict");
    if (!["pass", "repair_required", "user_decision_required", "blocked"].includes(this.verdict)) throw new Error("acceptance review verdict is invalid");
    if (typeof completed !== "boolean") throw new Error("acceptance review completed must be boolean");
    this.completed = completed;
    Object.freeze(this);
  }

  toJSON() { return { target: this.target.toJSON(), reviewArtifactDigest: this.reviewArtifactDigest, requirementIds: [...this.requirementIds], findingDispositions: [...this.findingDispositions], verdict: this.verdict, completed: this.completed }; }
}

export class AcceptanceDecisionRouteFacts {
  constructor({ target, reviewArtifactDigest, requirementIds, findingDispositions, decisionRecord = null, choice = null } = {}) {
    this.target = target instanceof DefinitionRouteTarget ? target : new DefinitionRouteTarget(target);
    if (this.target.stepId !== "acceptance-decision") throw new Error("acceptance decision facts require the acceptance-decision target");
    this.reviewArtifactDigest = digestText(reviewArtifactDigest, "acceptance decision review digest");
    this.requirementIds = frozenStrings(requirementIds, "acceptance decision requirement IDs");
    this.findingDispositions = frozenStrings(findingDispositions, "acceptance decision finding dispositions");
    if (choice !== null && !["accept_risk_and_continue", "abort"].includes(choice)) throw new Error("acceptance decision choice is invalid");
    if (decisionRecord !== null && (decisionRecord?.choice !== choice || decisionRecord?.reviewArtifactDigest !== this.reviewArtifactDigest)) {
      throw new Error("acceptance decision record is not bound to canonical review evidence");
    }
    this.choice = choice;
    this.decisionRecord = decisionRecord === null ? null : Object.freeze(structuredClone(decisionRecord));
    Object.freeze(this);
  }

  get integrityFailure() {
    if (this.choice === null && this.decisionRecord !== null) return "decision_record_without_choice";
    return null;
  }

  toJSON() { return { target: this.target.toJSON(), reviewArtifactDigest: this.reviewArtifactDigest, requirementIds: [...this.requirementIds], findingDispositions: [...this.findingDispositions], decisionRecord: this.decisionRecord, choice: this.choice }; }
}

export class DefinitionRoutePlan {
  constructor(token, { facts, route, reason = null } = {}) {
    if (token !== DEFINITION_ROUTE_TOKEN) throw new Error("Definition route plans are created only by the Definition resolver");
    this.facts = facts;
    this.route = requireString(route, "definition route");
    this.reason = reason === null ? null : requireString(reason, "definition blocked reason");
    Object.freeze(this);
  }
  toJSON() { return { route: this.route, facts: this.facts.toJSON(), ...(this.reason === null ? {} : { reason: this.reason }) }; }
}

export class AwaitApproval extends DefinitionRoutePlan { constructor(token, facts) { super(token, { facts, route: "await-approval" }); } apply(adapter) { return adapter.awaitApproval(this); } }
export class ConfirmAndAdvance extends DefinitionRoutePlan { constructor(token, facts) { super(token, { facts, route: "confirm-and-advance" }); } apply(adapter) { return adapter.confirmAndAdvance(this); } }
export class RepairAcceptanceToImplTriage extends DefinitionRoutePlan { constructor(token, facts) { super(token, { facts, route: "repair-acceptance-to-impl-triage" }); } apply(adapter) { return adapter.repairAcceptanceToImplTriage(this); } }
export class AwaitAcceptanceDecision extends DefinitionRoutePlan { constructor(token, facts) { super(token, { facts, route: "await-acceptance-decision" }); } apply(adapter) { return adapter.awaitAcceptanceDecision(this); } }
export class AdvanceFinalRegression extends DefinitionRoutePlan { constructor(token, facts) { super(token, { facts, route: "advance-final-regression" }); } apply(adapter) { return adapter.advanceFinalRegression(this); } }
export class Park extends DefinitionRoutePlan { constructor(token, facts) { super(token, { facts, route: "park" }); } apply(adapter) { return adapter.park(this); } }
export class Blocked extends DefinitionRoutePlan { constructor(token, facts, reason) { super(token, { facts, route: "blocked", reason }); } apply(adapter) { return adapter.blocked(this); } }

/**
 * Sole policy owner for the approval / acceptance boundary.  Setters and
 * registry post hooks may construct facts and apply this plan, but may not
 * branch on verdict, choice, or auto policy.
 */
export function resolveDefinitionRoute(facts) {
  if (facts instanceof ApprovalRouteFacts) {
    if (facts.integrityFailure !== null) return new Blocked(DEFINITION_ROUTE_TOKEN, facts, facts.integrityFailure);
    if (facts.approvalRecord !== null) return new ConfirmAndAdvance(DEFINITION_ROUTE_TOKEN, facts);
    // autoApprove is an approval policy fact; it never authorizes an
    // acceptance decision and never bypasses a stale/missing Spec binding.
    return facts.requestedApproval || facts.autoApprove
      ? new ConfirmAndAdvance(DEFINITION_ROUTE_TOKEN, facts)
      : new AwaitApproval(DEFINITION_ROUTE_TOKEN, facts);
  }
  if (facts instanceof AcceptanceReviewRouteFacts) {
    if (!facts.completed || facts.verdict === "blocked") return new Blocked(DEFINITION_ROUTE_TOKEN, facts, facts.completed ? "acceptance_blocked" : "partial_completion");
    if (facts.verdict === "repair_required") return new RepairAcceptanceToImplTriage(DEFINITION_ROUTE_TOKEN, facts);
    if (facts.verdict === "user_decision_required") return new AwaitAcceptanceDecision(DEFINITION_ROUTE_TOKEN, facts);
    return new AdvanceFinalRegression(DEFINITION_ROUTE_TOKEN, facts);
  }
  if (facts instanceof AcceptanceDecisionRouteFacts) {
    if (facts.integrityFailure !== null) return new Blocked(DEFINITION_ROUTE_TOKEN, facts, facts.integrityFailure);
    // This is intentionally tokenless and ignores autoApprove.
    if (facts.choice === null) return new AwaitAcceptanceDecision(DEFINITION_ROUTE_TOKEN, facts);
    return facts.choice === "accept_risk_and_continue"
      ? new AdvanceFinalRegression(DEFINITION_ROUTE_TOKEN, facts)
      : new Park(DEFINITION_ROUTE_TOKEN, facts);
  }
  throw new Error("Definition route facts are unsupported");
}

/**
 * The three test-chain leaves expose observations only.  Their route policy
 * is deliberately kept beside the common reducer so a registry hook cannot
 * reinterpret a result after it has been cataloged.
 */
export class TestChainProcessFacts {
  constructor({ started, exitCode, signal, timedOut, spawnError } = {}) {
    if (typeof started !== "boolean") throw new Error("test-chain process.started must be boolean");
    if (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < 0)) {
      throw new Error("test-chain process.exitCode must be a non-negative integer or null");
    }
    if (signal !== null && (typeof signal !== "string" || signal === "")) throw new Error("test-chain process.signal must be a non-empty string or null");
    if (typeof timedOut !== "boolean") throw new Error("test-chain process.timedOut must be boolean");
    if (spawnError !== null && (typeof spawnError !== "string" || spawnError === "")) throw new Error("test-chain process.spawnError must be a non-empty string or null");
    this.started = started;
    this.exitCode = exitCode;
    this.signal = signal;
    this.timedOut = timedOut;
    this.spawnError = spawnError;
    Object.freeze(this);
  }

  static from(value) {
    if (value instanceof TestChainProcessFacts) return value;
    return new TestChainProcessFacts(value ?? { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null });
  }

  // A cataloged process record is an external observation. Incomplete
  // combinations cannot prove a semantic test outcome, so keep the Flow
  // externally blocked rather than allowing a producer to advance.
  get toolingFailure() {
    return !this.started
      || this.spawnError !== null
      || this.signal !== null
      || this.timedOut
      || this.exitCode === null;
  }
  toJSON() { return { started: this.started, exitCode: this.exitCode, signal: this.signal, timedOut: this.timedOut, spawnError: this.spawnError }; }
}

export class ScenarioValidityStepFacts extends NonGateStepFacts {
  constructor({ result, summary = [], rawAvailable = false, blockingEvidence = [], testSourceRevision = "unavailable", catalogDigest = "unavailable", repairFingerprint = "unavailable", process = null } = {}) {
    if (!["pass", "block"].includes(result)) throw new Error("scenario-validity result is invalid");
    if (!Array.isArray(summary) || !Array.isArray(blockingEvidence)) throw new Error("scenario-validity observations require arrays");
    const hasBlockingObservation = blockingEvidence.some((entry) => entry?.classification !== "expected_fail");
    if ((result === "block") !== hasBlockingObservation) {
      throw new Error("scenario-validity result must match its blocking observations");
    }
    for (const [value, field] of [[testSourceRevision, "test source revision"], [catalogDigest, "catalog digest"], [repairFingerprint, "repair fingerprint"]]) {
      if (typeof value !== "string" || value === "") throw new Error(`scenario-validity ${field} is required`);
    }
    if (typeof rawAvailable !== "boolean") throw new Error("scenario-validity rawAvailable must be boolean");
    const processFacts = TestChainProcessFacts.from(process);
    const invalidTest = blockingEvidence.some((entry) => entry?.classification === "invalid_test");
    super({ kind: "scenario-validity", values: { result, summary, rawAvailable, blockingEvidence, testSourceRevision, catalogDigest, repairFingerprint, process: processFacts.toJSON(), toolingFailure: processFacts.toolingFailure, invalidTest } });
  }

  get result() { return this.value("result"); }
  get toolingFailure() { return this.value("toolingFailure"); }
  get invalidTest() { return this.value("invalidTest"); }
  get summary() { return this.value("summary"); }
  get rawAvailable() { return this.value("rawAvailable"); }
  get testSourceRevision() { return this.value("testSourceRevision"); }
  get process() { return TestChainProcessFacts.from(this.value("process")); }
}

export class TestExecuteStepFacts extends NonGateStepFacts {
  constructor({ summary = [], regression = {}, rawAvailable = false, testSourceRevision = "unavailable", repairFingerprint = "unavailable", rawEvidenceFingerprint = "unavailable", catalogDigest = "unavailable", process = null } = {}) {
    if (!Array.isArray(summary) || regression === null || typeof regression !== "object" || Array.isArray(regression)) throw new Error("test-execute observations are invalid");
    if (typeof rawAvailable !== "boolean" || typeof testSourceRevision !== "string" || testSourceRevision === "" || typeof repairFingerprint !== "string" || repairFingerprint === "" || typeof rawEvidenceFingerprint !== "string" || rawEvidenceFingerprint === "" || typeof catalogDigest !== "string" || catalogDigest === "") {
      throw new Error("test-execute immutable evidence is required");
    }
    const processFacts = TestChainProcessFacts.from(process);
    const regressionProcess = regression.process == null ? null : TestChainProcessFacts.from(regression.process);
    super({ kind: "test-execute", values: { summary, regression, rawAvailable, testSourceRevision, repairFingerprint, rawEvidenceFingerprint, catalogDigest, process: processFacts.toJSON(), regressionProcess: regressionProcess?.toJSON() ?? null, toolingFailure: processFacts.toolingFailure || regressionProcess?.toolingFailure === true } });
  }

  get toolingFailure() { return this.value("toolingFailure"); }
  get rawAvailable() { return this.value("rawAvailable"); }
  get process() { return TestChainProcessFacts.from(this.value("process")); }
  get regressionProcess() { return this.value("regressionProcess") === null ? null : TestChainProcessFacts.from(this.value("regressionProcess")); }
}

export class TestResultReviewStepFacts extends NonGateStepFacts {
  constructor({ verdict, checkedItems = [], rawAvailable = false, testSourceRevision = "unavailable", sourceRepairFingerprint = "unavailable", sourceRawEvidenceFingerprint = "unavailable", repairFingerprint = "unavailable", rawEvidenceFingerprint = "unavailable", catalogDigest = "unavailable", toolingFailure = false } = {}) {
    if (!["pass", "fail"].includes(verdict)) throw new Error("test-result-review verdict is invalid");
    if (typeof toolingFailure !== "boolean") throw new Error("test-result-review toolingFailure must be boolean");
    if (!Array.isArray(checkedItems) || typeof rawAvailable !== "boolean") throw new Error("test-result-review observations are invalid");
    if (checkedItems.length === 0 || checkedItems.some((item) => item?.result !== "pass" && item?.result !== "fail")) {
      throw new Error("test-result-review requires pass/fail checked observations");
    }
    if ((verdict === "fail") !== checkedItems.some((item) => item.result === "fail")) {
      throw new Error("test-result-review verdict must match its checked observations");
    }
    for (const [value, field] of [[testSourceRevision, "test source revision"], [sourceRepairFingerprint, "source repair fingerprint"], [sourceRawEvidenceFingerprint, "source raw evidence fingerprint"], [repairFingerprint, "repair fingerprint"], [rawEvidenceFingerprint, "raw evidence fingerprint"], [catalogDigest, "catalog digest"]]) {
      if (typeof value !== "string" || value === "") throw new Error(`test-result-review ${field} is required`);
    }
    super({ kind: "test-result-review", values: { verdict, checkedItems, rawAvailable, testSourceRevision, sourceRepairFingerprint, sourceRawEvidenceFingerprint, repairFingerprint, rawEvidenceFingerprint, catalogDigest, toolingFailure } });
  }

  get verdict() { return this.value("verdict"); }
  get toolingFailure() { return this.value("toolingFailure"); }
  get rawAvailable() { return this.value("rawAvailable"); }
}

function failureAction({ category, code, retryable, retryKind = null, message }) {
  return new NonGateFailCurrentAttemptAction(NON_GATE_TRANSITION_TOKEN, { category, code, retryable, retryKind, message });
}

function testChainSelection({ stepId, failed, toolingFailure, invalidTest = false, nonblocking, summary = [], testSourceRevision = "unavailable" }) {
  if (toolingFailure) return new NonGateTransitionSelection({
    operation: "external-blocked",
    reason: "tooling_failure",
    actions: [failureAction({ category: "tooling", code: "TEST_CHAIN_TOOLING_FAILURE", retryable: false, message: "Test-chain tooling failed." })],
  });
  if (!failed) return new NonGateTransitionSelection({ operation: "advance" });
  if (nonblocking) return new NonGateTransitionSelection({
    // Advisory mode records the immutable observation, but its acceptance
    // disposition remains an explicit nonblocking decision.  It must not
    // complete the active producer or auto-advance the Flow.
    operation: "await-user-input",
    beforeActions: [new NonGateRecordNonblockingAction(NON_GATE_TRANSITION_TOKEN, { stepId })],
  });
  if (stepId === "scenario-validity") return new NonGateTransitionSelection({
    operation: "repair", reason: invalidTest ? "invalid_test" : "test_design_block",
    actions: [
      new NonGateAppendRepairEvidenceAction(NON_GATE_TRANSITION_TOKEN, {
        stepId, summary, testSourceRevision,
      }),
      failureAction({ category: "semantic", code: "SCENARIO_VALIDITY_REJECTED", retryable: false, message: "Scenario validity rejected the current test evidence." }),
    ],
  });
  return new NonGateTransitionSelection({
    operation: "retry", reason: "semantic_test_failure",
    actions: [failureAction({ category: "semantic", code: "TEST_CHAIN_REJECTED", retryable: true, retryKind: "semantic", message: "Test-chain evidence was rejected." })],
    exhaustedActions: [failureAction({ category: "semantic", code: "TEST_CHAIN_RETRY_EXHAUSTED", retryable: false, message: "Test-chain semantic retry budget is exhausted." })],
  });
}

export const scenarioValidityTransitionDefinition = new NonGateStepDefinition({
  stepId: "scenario-validity",
  factsType: ScenarioValidityStepFacts,
  select(stepFacts, facts) {
    return testChainSelection({
      stepId: "scenario-validity",
      failed: stepFacts.result === "block",
      toolingFailure: stepFacts.toolingFailure,
      invalidTest: stepFacts.invalidTest,
      nonblocking: facts.nonblocking,
      summary: stepFacts.summary,
      testSourceRevision: stepFacts.testSourceRevision,
    });
  },
});

export const testExecuteTransitionDefinition = new NonGateStepDefinition({
  stepId: "test-execute",
  factsType: TestExecuteStepFacts,
  select(stepFacts) {
    // A completed execution always hands its immutable observation to the
    // result reviewer. Regression semantics are owned by that reviewer and
    // later gates, not by the executor.
    return testChainSelection({ stepId: "test-execute", failed: false, toolingFailure: stepFacts.toolingFailure, nonblocking: false });
  },
});

export const testResultReviewTransitionDefinition = new NonGateStepDefinition({
  stepId: "test-result-review",
  factsType: TestResultReviewStepFacts,
  select(stepFacts, facts) {
    return testChainSelection({
      stepId: "test-result-review",
      failed: stepFacts.verdict === "fail",
      toolingFailure: stepFacts.toolingFailure,
      nonblocking: facts.nonblocking,
    });
  },
});

const STEP_STATUSES = new Set(["pending", "in_progress", "done", "skipped"]);

export class SetStepStatus {
  constructor({ step, status, suppressAutoPromotion = false, taskSourceFingerprint = null }) {
    this.step = requireString(step, "step");
    this.status = requireString(status, "status");
    if (!STEP_STATUSES.has(this.status)) throw new Error(`invalid status: ${this.status}`);
    if (typeof suppressAutoPromotion !== "boolean") {
      throw new Error("suppressAutoPromotion must be boolean");
    }
    this.suppressAutoPromotion = suppressAutoPromotion;
    if (taskSourceFingerprint !== null && (this.status !== "skipped" || !/^[a-f0-9]{64}$/.test(taskSourceFingerprint))) {
      throw new Error("Task source fingerprint is valid only for a skipped lifecycle action");
    }
    this.taskSourceFingerprint = taskSourceFingerprint;
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.setStepStatus(this.step, this.status, this);
  }

  forStep(step) {
    const scopedStep = requireString(step, "step");
    if (scopedStep === this.step) return this;
    return new SetStepStatus({
      step: scopedStep,
      status: this.status,
      suppressAutoPromotion: this.suppressAutoPromotion,
      taskSourceFingerprint: this.taskSourceFingerprint,
    });
  }
}

/** Definition-selected post-confirmation mutation; adapters may only apply it. */
export class PromoteDraftQuestionAndKeepRefineActive {
  constructor({ questionId, questionRevision, digest, byteLength }) {
    this.questionId = requireString(questionId, "draft promotion questionId");
    if (!Number.isSafeInteger(questionRevision) || questionRevision < 0) throw new Error("draft promotion questionRevision is invalid");
    this.questionRevision = questionRevision;
    this.digest = requireString(digest, "draft promotion digest");
    if (!/^[a-f0-9]{64}$/.test(this.digest)) throw new Error("draft promotion digest is invalid");
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error("draft promotion byteLength is invalid");
    this.byteLength = byteLength;
    Object.freeze(this);
  }
  apply(adapter) { return adapter.promoteDraftQuestionAndKeepRefineActive(this); }
}

const DEFINITION_LIFECYCLE_PLAN_TOKEN = Symbol("definition-lifecycle-plan");

export class DefinitionLifecyclePlan {
  constructor(token, { event, currentStepId, actions }) {
    if (token !== DEFINITION_LIFECYCLE_PLAN_TOKEN) {
      throw new Error("DefinitionLifecyclePlan is created only by the definition resolver");
    }
    if (!Array.isArray(actions)) throw new Error("actions must be an array");
    const lifecycleActions = [...actions];
    const hasStepTransition = lifecycleActions.some((action) => action instanceof SetStepStatus);
    this.event = requireString(event, "event");
    this.currentStepId = currentStepId == null && !hasStepTransition
      ? null
      : requireString(currentStepId, "currentStepId");
    this.actions = Object.freeze(lifecycleActions);
    Object.freeze(this);
  }

  allows(action) {
    return this.actions.includes(action);
  }

  forStepAlias({ sourceStep, targetStep }) {
    const source = requireString(sourceStep, "sourceStep");
    const target = requireString(targetStep, "targetStep");
    if (source === target) return this;
    const actions = this.actions.map((action) => (
      action instanceof SetStepStatus && action.step === source
        ? action.forStep(target)
        : action
    ));
    const currentStepId = this.currentStepId === source ? target : this.currentStepId;
    if (currentStepId === this.currentStepId && actions.every((action, index) => action === this.actions[index])) {
      return this;
    }
    return new DefinitionLifecyclePlan(DEFINITION_LIFECYCLE_PLAN_TOKEN, {
      event: this.event,
      currentStepId,
      actions,
    });
  }
}

export class KeepInProgress {
  constructor({ step }) {
    this.step = requireString(step, "step");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.keepInProgress(this.step);
  }
}

export class IncrementMetric {
  constructor({ phase, counter }) {
    this.phase = requireString(phase, "phase");
    this.counter = requireString(counter, "counter");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.incrementMetric(this.phase, this.counter);
  }
}

/** Persist a non-terminal current Review result selected by definition lifecycle. */
export class PersistReviewResult {
  constructor() {
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.persistReviewResult();
  }
}

/**
 * Definition-selected opportunity to apply the shared coverage-repair to
 * draft-gate completion boundary. The adapter reads canonical facts, then the
 * Definition selects one sealed completion decision for the Store to apply
 * without re-selection.
 */
export class CompleteDraftCoverageRepair {
  constructor() {
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.completeDraftCoverageRepair(this);
  }
}

export class AppendIssueLog {
  constructor({ source }) {
    this.source = requireString(source, "source");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.appendIssueLog(this.source);
  }
}

export class SkipSteps {
  constructor({ steps }) {
    this.steps = requireStepList(steps, "steps");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.skipSteps([...this.steps]);
  }
}

export class ResetSteps {
  constructor({ steps }) {
    this.steps = requireStepList(steps, "steps");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.resetSteps([...this.steps]);
  }
}

export class RunLifecycleHook {
  constructor({ module, handler, args = null }) {
    this.module = requireString(module, "module");
    this.handler = requireString(handler, "handler");
    this.args = args == null ? null : Object.freeze({ ...args });
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.runLifecycleHook(this.module, this.handler, this.args);
  }
}

export class BeginOutboxEffect {
  constructor({ step }) {
    this.step = requireString(step, "step");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.beginOutboxEffect(this.step);
  }
}

export class CompleteOutboxEffect {
  constructor({ step }) {
    this.step = requireString(step, "step");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.completeOutboxEffect(this.step);
  }
}

export class FailOutboxEffect {
  constructor({ step }) {
    this.step = requireString(step, "step");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.failOutboxEffect(this.step);
  }
}

export function applyLifecycleActions(adapter, actions) {
  for (const action of actions) action.apply(adapter);
}

const FINALIZE_SUCCESS_STATUSES = new Set(["done", "completed", "skipped"]);
const IMPL_REVIEW_RESET_RANGE = Object.freeze([
  "test-execute",
  "test-result-review",
  "impl-review",
  "impl-triage",
  "impl-repair",
  "impl-gate",
  "retro",
  "acceptance-review",
  "acceptance-decision",
  "final-regression",
  "report",
  "finalize-commit",
  "finalize-merge",
  "finalize-sync",
  "finalize-cleanup",
]);
const REJECTED_IMPL_REVIEW_RESET_STEPS = Object.freeze([
  "impl-repair",
  "impl-gate",
]);

export function countReviewAttempts(metrics, phase) {
  if (!Array.isArray(metrics)) return 0;
  let count = 0;
  for (const entry of metrics) {
    if (entry?.phase !== phase || entry?.counter !== "reviewRetry" || entry?.taskId != null) continue;
    count = entry.reset === true ? 0 : count + (entry.delta ?? 1);
  }
  return count;
}

/**
 * The definition owns the only policy that turns persisted review facts into
 * a recovery route. Readers may establish whether canonical evidence exists;
 * they must not choose between repair and an exhausted retry disposition.
 */
export function resolveReviewTransition({
  stepId,
  flowState,
  facts,
} = {}) {
  const phase = stepId === "task-review" ? "impl" : reviewPhaseForFlowStepId(stepId);
  if (phase === null || !(facts instanceof ReviewTransitionFacts)) return null;
  if (facts.phase !== phase) throw new Error("review transition facts phase does not match step");
  // The Spec funnel is deliberately not a semantic retry/recovery loop. Its
  // three workers always advance the same revision-scoped review in order;
  // transport recovery remains at the execution boundary.
  if (phase === "spec") return null;
  if (flowState?.policy?.nonblocking?.enabled === true) return null;
  if (facts.toolingOutcome) {
    return new DefinitionReviewDisposition({ operation: "external-blocked", phase });
  }
  if (facts.verdict !== "REJECTED") {
    return null;
  }
  // Task-local REJECTED results are consumed only by the five-stage Task
  // review connector. The flow-scoped review recovery policy has no Task
  // compatibility route.
  if (facts.scope === "task") return null;
  const maxAttempts = resolveMaxAttempts({ scope: facts.scope, stepId, context: flowState }) ?? 1;
  const attempts = facts.scope === "task"
    ? facts.attemptCount
    : countReviewAttempts(flowState?.metrics, phase);
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new Error("review transition facts have no usable attempt count");
  }
  if (attempts < maxAttempts) {
    if (facts.scope === "flow" && phase === "test") {
      return new DefinitionReviewDisposition({
        operation: facts.repairEvidence.available ? "repair-test-review" : "repair-evidence-blocked",
        phase,
      });
    }
    return new DefinitionReviewDisposition({ operation: "retry", phase });
  }
  if (facts.deferralEvidence.available) {
    return new DefinitionReviewDisposition({
      operation: "defer",
      phase,
      attempts,
      maxAttempts,
      sourceFingerprints: facts.deferralEvidence.sourceFingerprints,
    });
  }
  if (attempts >= maxAttempts) {
    return new DefinitionReviewDisposition({ operation: "blocked", phase, attempts, maxAttempts });
  }
  return null;
}

/**
 * Decide whether draft refinement may execute or must yield one canonical
 * user-decision question. Artifact reading and directive rendering live in
 * other layers; this is the sole transition-policy owner.
 */
export class DraftQuestionPromotionPlan {
  constructor({ questionId, questionRevision } = {}) {
    this.questionId = requireString(questionId, "draft question promotion questionId");
    if (!Number.isSafeInteger(questionRevision) || questionRevision < 0) {
      throw new Error("draft question promotion questionRevision is invalid");
    }
    this.questionRevision = questionRevision;
    Object.freeze(this);
  }
  toJSON() { return { operation: "promote-candidate", questionId: this.questionId, questionRevision: this.questionRevision }; }
  apply(ledger) { return ledger.transitionCandidate(this.questionId, this.questionRevision); }
}

class ResolveDraftQuestionPlan {
  constructor({ questionId, questionRevision } = {}) {
    this.questionId = requireString(questionId, "draft question resolution questionId");
    if (!Number.isSafeInteger(questionRevision) || questionRevision < 0) throw new Error("draft question resolution questionRevision is invalid");
    this.questionRevision = questionRevision;
  }
}

export class AnswerDraftQuestionPlan extends ResolveDraftQuestionPlan {
  constructor({ questionId, questionRevision, answer, why, considered = "" } = {}) {
    super({ questionId, questionRevision });
    this.answer = answer;
    this.why = why;
    this.considered = considered;
    Object.freeze(this);
  }

  apply(ledger) {
    return ledger.answer(this.questionId, this.questionRevision, {
      answer: this.answer,
      why: this.why,
      considered: this.considered,
    });
  }
}

export class DiscardDraftQuestionPlan extends ResolveDraftQuestionPlan {
  constructor({ questionId, questionRevision, reason } = {}) {
    super({ questionId, questionRevision });
    this.reason = reason;
    Object.freeze(this);
  }

  apply(ledger) {
    return ledger.discard(this.questionId, this.questionRevision, this.reason);
  }
}

/** Definition owns admission and action selection for direct draft answers. */
export function resolveDraftQuestionResolution({ intent, questionId, questionRevision, facts, flowState, answer = null, why = null, considered = "", reason = null } = {}) {
  if (!(facts instanceof DraftTransitionFacts)) return null;
  const disposition = resolveDraftTransition({ stepId: "draft-refine", flowState, facts });
  if (disposition?.operation !== "await-user-answer" || disposition.questionId !== questionId || disposition.questionRevision !== questionRevision) return null;
  return intent === "answer"
    ? new AnswerDraftQuestionPlan({ questionId, questionRevision, answer, why, considered })
    : intent === "discard"
      ? new DiscardDraftQuestionPlan({ questionId, questionRevision, reason })
      : null;
}

/** The only creator of a candidate-to-user-boundary transition plan. */
export function resolveDraftQuestionPromotion({ facts } = {}) {
  if (!(facts instanceof DraftTransitionFacts) || facts.candidateQuestion === null) return null;
  return new DraftQuestionPromotionPlan({
    questionId: facts.candidateQuestion.id,
    questionRevision: facts.candidateQuestion.revision,
  });
}

export function resolveDraftTransition({ stepId, flowState, facts } = {}) {
  if (stepId !== "draft-refine" || !(facts instanceof DraftTransitionFacts)) return null;
  if (flowState?.autoApprove === true || facts.nextQuestion === null) {
    return new DefinitionDraftDisposition({ operation: "execute-refine" });
  }
  return new DefinitionDraftDisposition({
    operation: "await-user-answer",
    questionId: facts.nextQuestion.id,
    question: facts.nextQuestion.question,
    questionRevision: facts.nextQuestion.revision,
  });
}

/** Definition-owned completion statuses for an exhausted deferred Review. */
export function resolveReviewDeferralLifecycle({ scope, stepId, disposition } = {}) {
  if (!(disposition instanceof DefinitionReviewDisposition) || disposition.operation !== "defer") return [];
  if (scope === "task") return [];
  if (scope !== "flow") throw new Error("review deferral lifecycle scope is invalid");
  const phase = reviewPhaseForFlowStepId(stepId);
  if (phase === null || phase !== disposition.phase) {
    throw new Error("review deferral lifecycle does not match the definition disposition");
  }
  const actions = [new SetStepStatus({ step: stepId, status: "done" })];
  if (phase === "impl") {
    actions.push(
      new SetStepStatus({ step: "impl-triage", status: "done" }),
      new SetStepStatus({ step: "impl-repair", status: "done" }),
    );
  }
  return actions;
}

function isFinalizeSuccess(result) {
  return FINALIZE_SUCCESS_STATUSES.has(String(result?.status || result?.data?.status || ""));
}

function gateStepIdForPhase(phase) {
  return Object.fromEntries(collectGatePhaseEntries())[phase] || "spec-gate";
}

function draftReviewRouteForInput(input = {}) {
  const retryPhase = input.result?.artifacts?.retryPhase
    || (String(input.phase || "").startsWith("draft-") ? input.phase : null);
  return draftReviewRouteForRetryPhase(retryPhase || "draft-questions");
}

/**
 * Review result persistence records the current result before lifecycle
 * actions run. Definition therefore projects this result as the next metric
 * entry and retains an exhausted rejected flow Review for guarded settlement.
 */
function rejectedFlowReviewReachesExhaustion(input, phase, stepId) {
  if (input.result?.artifacts?.verdict !== "REJECTED") return false;
  if (input.result?.artifacts?.taskId != null) return false;
  const maxAttempts = resolveMaxAttempts({ scope: "flow", stepId, context: input.flowState }) ?? 1;
  return countReviewAttempts(input.flowState?.metrics, phase) + 1 >= maxAttempts;
}

function reviewStepIdForInput(input = {}) {
  const phase = input.result?.artifacts?.phase || input.phase;
  if (phase === "draft" || phase === "draft-questions" || phase === "draft-coverage") {
    return draftReviewRouteForInput(input).reviewStepId;
  }
  return flowReviewRouteForPhase(phase)?.reviewStepId || input.currentStepId || null;
}

export function resolveRuntimeStep(input = {}) {
  const command = input.command || input.action;
  if (command === "run-review") return reviewStepIdForInput(input);
  if (command === "run-gate") return gateStepIdForPhase(input.phase || input.result?.artifacts?.phase);
  if (command === "report") return "report";
  if (String(command || "").startsWith("finalize-")) return command;
  return input.currentStepId || null;
}

function resolveDraftReviewLifecycle(input) {
  const route = draftReviewRouteForInput(input);
  const verdict = input.result?.artifacts?.verdict;
  const actions = [new IncrementMetric({ phase: route.retryPhase, counter: "reviewRetry" })];
  if (!["PASS", "ADVISORY", "REJECTED"].includes(verdict)) return actions;
  if (rejectedFlowReviewReachesExhaustion(input, route.retryPhase, route.reviewStepId)) {
    return [new PersistReviewResult(), ...actions];
  }
  actions.push(new SetStepStatus({ step: route.reviewStepId, status: "done" }));
  if (verdict === "PASS") {
    actions.push(new SetStepStatus({ step: route.triageStepId, status: "done" }));
    if (route.retryPhase === "draft-coverage") {
      actions.push(new CompleteDraftCoverageRepair());
    } else {
      actions.push(new SetStepStatus({ step: route.repairStepId, status: "done" }));
    }
  }
  return actions;
}

function resolvePlanReviewLifecycle(input) {
  const phase = input.result?.artifacts?.phase || input.phase;
  const verdict = input.result?.artifacts?.verdict;
  const toolingOutcome = input.result?.artifacts?.toolingOutcome;
  if (phase === "draft" || phase === "draft-questions" || phase === "draft-coverage") {
    const route = nonblockingRouteFor(draftReviewRouteForInput(input).reviewStepId);
    if (input.flowState?.policy?.nonblocking?.enabled === true && route && (verdict === "REJECTED" || toolingOutcome)) {
      return [];
    }
    return resolveDraftReviewLifecycle(input);
  }
  const actions = [];
  // Tooling observations also need their typed ExternalBlocked persistence;
  // the persistence adapter deliberately does not consume semantic budget.
  const recordRetry = true;
  if (phase === "spec") {
    if (["PASS", "ADVISORY", "REJECTED"].includes(verdict)) {
      actions.push(new SetStepStatus({ step: "spec-review", status: "done" }));
    }
    return actions;
  }
  if (phase === "test") {
    if (input.flowState?.policy?.nonblocking?.enabled === true && (verdict === "REJECTED" || toolingOutcome)) {
      // A test-review advisory decision must create the same durable
      // acceptance handoff as retry exhaustion before it can advance.
      return actions;
    }
    if (verdict === "PASS" || verdict === "ADVISORY") {
      actions.push(new SetStepStatus({ step: "test-review", status: "done" }));
    } else if (toolingOutcome) {
      actions.push(new AppendIssueLog({ source: "test-review-tooling-failure" }));
    }
    if (recordRetry) actions.unshift(new IncrementMetric({ phase, counter: "reviewRetry" }));
    return actions;
  }
  if (recordRetry) actions.push(new IncrementMetric({ phase, counter: "reviewRetry" }));
  return actions;
}

function resolveImplReviewLifecycle(input) {
  const artifacts = input.result?.artifacts;
  const flowScoped = artifacts?.phase === "impl" && artifacts?.taskId == null;
  if (input.result?.artifacts?.deferred === true) {
    if (!flowScoped) return [];
    return [
      new SetStepStatus({ step: "impl-triage", status: "done" }),
      new SetStepStatus({ step: "impl-repair", status: "done" }),
    ];
  }
  const verdict = input.result?.artifacts?.verdict;
  const toolingOutcome = input.result?.artifacts?.toolingOutcome;
  const proposalCount = input.result?.artifacts?.proposalCount ?? 0;
  const actions = [];
  if (input.flowState?.policy?.nonblocking?.enabled === true && input.result?.artifacts?.phase === "impl" && (
    verdict === "REJECTED" || toolingOutcome
  )) {
    // Evidence stays authoritative; the agent records repair/retry/continue
    // through the guarded nonblocking decision command.
    return actions;
  }
  if (input.result?.artifacts?.phase === "impl") {
    if (toolingOutcome) {
      actions.push(new IncrementMetric({ phase: "impl", counter: "reviewRetry" }));
      return actions;
    }
    // Task-local review publication is settled by the typed review-funnel
    // connector. The generic lifecycle hook must not invent a parallel route.
    if (!flowScoped) return actions;
    if (flowScoped && rejectedFlowReviewReachesExhaustion(
      input,
      "impl",
      input.currentStepId || "impl-review",
    )) {
      return [
        new PersistReviewResult(),
        new IncrementMetric({ phase: "impl", counter: "reviewRetry" }),
      ];
    }
    if (verdict === "PASS" || verdict === "ADVISORY") {
      actions.push(
        new SetStepStatus({ step: input.currentStepId || "impl-review", status: "done" }),
        new SetStepStatus({ step: "impl-triage", status: "done" }),
        new SetStepStatus({ step: "impl-repair", status: "done" }),
        new SetStepStatus({ step: "impl-gate", status: "in_progress" }),
      );
    } else if (flowScoped && verdict === "REJECTED") {
      actions.push(
        new ResetSteps({ steps: REJECTED_IMPL_REVIEW_RESET_STEPS }),
        new SetStepStatus({ step: input.currentStepId || "impl-review", status: "done" }),
        new SetStepStatus({ step: "impl-triage", status: "in_progress" }),
      );
    }
    actions.unshift(new IncrementMetric({ phase: "impl", counter: "reviewRetry" }));
    return actions;
  }
  if (!input.dryRun && proposalCount > 0) {
    actions.push(new ResetSteps({ steps: IMPL_REVIEW_RESET_RANGE }));
    return actions;
  }
  actions.push(new SetStepStatus({ step: input.currentStepId || "impl-review", status: "done" }));
  return actions;
}

function resolveReviewLifecycle(input) {
  if (input.result?.artifacts?.deferred === true) return [];
  if (input.phase === "draft" || input.phase === "spec" || input.phase === "test") {
    return resolvePlanReviewLifecycle(input);
  }
  return resolveImplReviewLifecycle(input);
}

function resolveGateLifecycle(input) {
  if (input.event === "gate:pre") {
    const active = findActiveNode(input.flowState || {});
    const taskStep = TaskStepIdentity.fromStateNode(input.flowState, active?.stepId);
    const step = input.phase === "task-impl" && taskStep?.definitionId === "task-gate"
      ? taskStep.nodeId
      : gateStepIdForPhase(input.phase);
    return [new SetStepStatus({ step, status: "in_progress" })];
  }

  // Gate execution errors are observations, not a second transition policy.
  // A post lifecycle must receive the sealed Decision made after the canonical
  // result was published; every other event leaves state untouched here.
  if (input.event !== "gate:post") return [];
  if (!(input.gateTransitionDecision instanceof GateTransitionDecision)) {
    throw new Error("gate post lifecycle requires a Definition-selected GateTransitionDecision");
  }

  const decision = input.gateTransitionDecision;
  if (decision.facts.scope === "task") {
    const progress = decision.facts.taskSettlementProgress;
    if (decision.plan.retryMetric !== null && !progress.hasMetric(decision.plan.retryMetric)) {
      return [new IncrementMetric({
        phase: decision.plan.retryMetric.phase,
        counter: "gateRetry",
      })];
    }
    if ((decision.facts.result === "pass" || decision.facts.result === "fail") && !progress.issueLogRecorded) {
      return [new AppendIssueLog({ source: "gate-result" })];
    }
    return decision.plan.updates.map((update) => new SetStepStatus({
      step: update.stepId,
      status: update.status,
    }));
  }
  const actions = decision.plan.updates.map((update) => new SetStepStatus({
    step: update.stepId,
    status: update.status,
  }));
  if (decision.plan.retryMetric !== null) {
    actions.push(new IncrementMetric({
      phase: decision.plan.retryMetric.phase,
      counter: "gateRetry",
    }));
  }
  if (decision.facts.result === "fail") actions.push(new AppendIssueLog({ source: "gate-result" }));
  return actions;
}

function finalizeMergeMetadataPreflightAction() {
  return new RunLifecycleHook({
    module: "finalize",
    handler: "assertFinalizeMergeMetadataMutationSafe",
  });
}

function resolveFinalizeLifecycle(input) {
  const command = input.command || input.currentStepId || input.targetStepId;
  if (input.event === "finalize:interrupted" && command === "finalize-sync") {
    return [new SetStepStatus({ step: command, status: "skipped" })];
  }
  if (input.event === "finalize:pre") {
    const actions = [];
    if (command === "finalize-merge") {
      actions.push(finalizeMergeMetadataPreflightAction());
    } else if (command === "finalize-sync") {
      actions.push(new RunLifecycleHook({ module: "finalize", handler: "resolveMainRepoFlowManager" }));
    }
    if (command === "finalize-merge") {
      actions.push(new RunLifecycleHook({
        module: "finalize",
        handler: "prepareFinalizeMerge",
        args: { steps: ["finalize-sync", "finalize-cleanup"] },
      }));
      // Record the idempotency key before RunFinalizeMergeCommand can start
      // the merge. The post lifecycle begins the same identity again after
      // authority switches to main, which is how the pending entry is carried
      // into main's flow state without a clean-path metadata-only commit.
      actions.push(new BeginOutboxEffect({ step: command }));
    } else {
      actions.push(new BeginOutboxEffect({ step: command }));
    }
    return actions;
  }
  if (input.event === "finalize:onError") {
    const actions = [];
    if (command === "finalize-merge") {
      actions.push(finalizeMergeMetadataPreflightAction());
    } else if (command === "finalize-sync") {
      actions.push(new RunLifecycleHook({ module: "finalize", handler: "resolveMainRepoFlowManager" }));
    } else if (command === "finalize-cleanup") {
      actions.push(new RunLifecycleHook({ module: "finalize", handler: "resolveCleanupOutboxFlowManager" }));
    }
    if (command === "finalize-merge") {
      actions.push(new FailOutboxEffect({ step: command }));
      actions.push(new SkipSteps({ steps: ["finalize-sync", "finalize-cleanup"] }));
    } else {
      actions.push(new FailOutboxEffect({ step: command }));
      if (command === "finalize-sync") {
        actions.push(new SetStepStatus({ step: command, status: "skipped" }));
      }
    }
    actions.push(new RunLifecycleHook({ module: "finalize", handler: "finalizeOnError", args: { command } }));
    if (command === "finalize-merge") {
      actions.push(new RunLifecycleHook({
        module: "finalize",
        handler: "commitFinalizeMergeConflictMetadata",
      }));
    }
    return actions;
  }
  if (!isFinalizeSuccess(input.result)) return [new FailOutboxEffect({ step: command })];
  const actions = [];
  if (command === "finalize-merge" || command === "finalize-sync" || command === "finalize-cleanup") {
    actions.push(new RunLifecycleHook({
      module: "finalize",
      handler: "resolveMainRepoFlowManager",
      args: command === "finalize-merge" ? { unlessPr: true } : null,
    }));
  }
  if (command === "finalize-merge") {
    actions.push(
      new BeginOutboxEffect({ step: command }),
      new RunLifecycleHook({ module: "finalize", handler: "ensureFinalizeMergeInProgress" }),
      new RunLifecycleHook({ module: "finalize", handler: "recordMergeOutcome" }),
      new RunLifecycleHook({
        module: "finalize",
        handler: "resetSkippedDownstreamSteps",
        args: { steps: ["finalize-sync", "finalize-cleanup"] },
      }),
    );
  }
  actions.push(new SetStepStatus({
    step: command,
    status: "done",
    // A retried merge restores its downstream leaves for the next normal
    // command; it does not begin finalize-sync as part of merge completion.
    suppressAutoPromotion: command === "finalize-merge",
  }));
  actions.push(new CompleteOutboxEffect({ step: command }));
  return actions;
}

function resolveReportLifecycle(input) {
  if (input.event === "report:pre") return [new BeginOutboxEffect({ step: "report" })];
  if (input.event === "report:onError") return [new FailOutboxEffect({ step: "report" })];
  if (input.result?.result !== "ok") return [new FailOutboxEffect({ step: "report" })];
  return [
    new SetStepStatus({ step: "report", status: "done" }),
    new CompleteOutboxEffect({ step: "report" }),
  ];
}

function resolveAcceptanceReviewLifecycle(input) {
  if (input.event !== "acceptance-review:post") return [];
  // A mechanically blocked review deliberately retains its active Attempt:
  // it is evidence for a later retry/recovery, not a completed acceptance.
  if (input.result?.verdict === "blocked") return [];
  return [new SetStepStatus({ step: "acceptance-review", status: "done" })];
}

function resolveLifecycleForNode(node, input = {}) {
  if (input.event === "acceptance-review:post" || node.id === "acceptance-review") {
    return resolveAcceptanceReviewLifecycle(input);
  }
  if (input.event === "review:post" || node.action === "run-review") return resolveReviewLifecycle(input);
  if (input.event === "gate:post" || node.action === "run-gate") return resolveGateLifecycle(input);
  if (String(input.event || "").startsWith("report:") || node.action === "run-report") {
    return resolveReportLifecycle(input);
  }
  if (String(input.event || "").startsWith("finalize:") || String(node.action || "").startsWith("run-finalize-")) {
    return resolveFinalizeLifecycle(input);
  }
  return [];
}

export function resolveLifecycle(input = {}) {
  if (input.event === "review:task-gate-handoff") {
    const step = input.currentStepId || input.targetStepId;
    if (typeof step !== "string" || step === "") throw new Error("Task Review Gate handoff lifecycle requires its current Task Review step");
    return [new SetStepStatus({ step, status: "done" })];
  }
  if (input.event === "set-step:impl-triage") {
    return [
      new SetStepStatus({ step: "impl-repair", status: "done" }),
      new SetStepStatus({ step: "impl-gate", status: "in_progress" }),
    ];
  }
  if ([
    "gate:defer",
    "gate:phase-inference",
    "review:defer",
    "finalize-cleanup:complete",
    "definition:keep-in-progress",
    "definition:skip-steps",
    "test-execute:post",
    "scenario-validity:post",
    "test-result-review:post",
    "retro:post",
    "final-regression:post",
  ].includes(input.event)) {
    return [new SetStepStatus({ step: input.targetStepId, status: input.status })];
  }
  const stepId = input.currentStepId || resolveRuntimeStep(input);
  const taskStep = TaskStepIdentity.fromStateNode(input.flowState, stepId);
  const definitionStepId = taskStep?.definitionId ?? stepId;
  const node = definitionStepId ? (getFlowNode(definitionStepId) || getTaskNode(definitionStepId)) : null;
  if (!node) return [];
  const actions = node.resolveLifecycle({
    ...input,
    currentStepId: definitionStepId,
  });
  if (taskStep === null) return actions;
  return actions.map((action) => (
    action instanceof SetStepStatus && new Set(["task-impl", "task-review", "task-triage", "task-repair", "task-gate"]).has(action.step)
      ? action.forStep(`${taskStep.taskId}-${action.step.slice("task-".length)}`)
      : action
  ));
}

export function resolveLifecyclePlan(input = {}) {
  let actions = resolveLifecycle(input);
  const currentStepId = input.currentStepId || resolveRuntimeStep(input) || input.targetStepId || null;
  if (
    input.event === "draft-refine:confirm"
    && input.flowState?.autoApprove !== true
    && input.draftTransitionFacts instanceof DraftTransitionFacts
    && input.draftTransitionFacts.candidateQuestion !== null
    && input.draftTransitionFacts.nextQuestion === null
  ) {
    const candidate = input.draftTransitionFacts.candidateQuestion;
    const baseline = input.draftCatalogBaseline;
    if (!baseline || typeof baseline.digest !== "string" || !Number.isSafeInteger(baseline.byteLength)) {
      throw new Error("draft-refine promotion requires a catalog baseline");
    }
    actions = [new PromoteDraftQuestionAndKeepRefineActive({
      questionId: candidate.id,
      questionRevision: candidate.revision,
      digest: baseline.digest,
      byteLength: baseline.byteLength,
    })];
  }
  if (input.settleInProgressAsDone === true) {
    actions = actions.map((action) => (
      action instanceof SetStepStatus
        && action.step === currentStepId
        && action.status === "in_progress"
        ? new SetStepStatus({ step: action.step, status: "done" })
        : action
    ));
  }
  return new DefinitionLifecyclePlan(DEFINITION_LIFECYCLE_PLAN_TOKEN, {
    event: input.event,
    currentStepId,
    actions,
  });
}

export class FlowExecutionCommand {
  constructor(subcommand, ...args) {
    const tokens = [subcommand, ...args];
    if (tokens.some((token) => (
      typeof token !== "string" || token.trim() === "" || /\s/.test(token)
    ))) {
      throw new Error("flow execution command tokens must be non-empty strings without whitespace");
    }
    this.subcommand = subcommand;
    this.args = Object.freeze([...args]);
    this.tokens = Object.freeze(["sennel", "flow", "run", ...tokens]);
    Object.freeze(this);
  }

  toString() {
    return this.tokens.join(" ");
  }

  runArguments() {
    return [...this.tokens.slice(3)];
  }
}

/** The one authority permitted to terminally handle a parent command failure. */
export const DEFINITION_FAILURE_OWNERS = Object.freeze([
  DefinitionFailureOwnership.dispatcherPrimary(),
  DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
  DefinitionFailureOwnership.commandExclusive(),
  DefinitionFailureOwnership.lifecycleOutbox(),
]);

class FlowNode {
  constructor({
    id,
    label,
    action,
    instructionsKey,
    contextKinds = [],
    outputSchemaRef = null,
    requiresApproval = false,
    autoApproveChoiceId = null,
    skippable = false,
    maxAttempts = 1,
    toolingMaxAttempts = null,
    fallbacks = null,
    children = null,
    sideEffects = null,
    gatePhase = null,
    failurePolicy = null,
    failureTargetId = null,
    definitionLifecycleOwned = false,
    executionCommand = null,
    failureOwnership = null,
  }) {
    this.id = id;
    this.label = label;
    this.action = action;
    this.instructionsKey = instructionsKey;
    this.contextKinds = Object.freeze([...contextKinds]);
    this.outputSchemaRef = outputSchemaRef;
    this.requiresApproval = requiresApproval;
    if (autoApproveChoiceId !== null && (requiresApproval !== true || autoApproveChoiceId !== "1")) {
      throw new Error("autoApproveChoiceId must be choice id=1 on an approval-required step");
    }
    this.autoApproveChoiceId = autoApproveChoiceId;
    this.skippable = skippable;
    this.maxAttempts = createMaxAttempts(maxAttempts);
    this.toolingMaxAttempts = toolingMaxAttempts == null ? null : createMaxAttempts(toolingMaxAttempts);
    this.fallbacks = fallbacks ? Object.freeze([...fallbacks]) : null;
    this.children = children ? Object.freeze(children.map((c) => Object.freeze(c))) : null;
    this.sideEffects = sideEffects ? Object.freeze([...sideEffects]) : null;
    this.gatePhase = gatePhase ? Object.freeze([...gatePhase]) : null;
    this.definitionLifecycleOwned = definitionLifecycleOwned === true;
    if (this.definitionLifecycleOwned && !this.action.startsWith("run-")) {
      throw new Error(`definition lifecycle-owned action must start with run-: ${this.action}`);
    }
    if (
      this.definitionLifecycleOwned
      && !(executionCommand instanceof FlowExecutionCommand)
    ) {
      throw new Error(`definition lifecycle-owned step must declare executionCommand: ${this.id}`);
    }
    if (!this.definitionLifecycleOwned && executionCommand !== null) {
      throw new Error(`only definition lifecycle-owned steps may declare executionCommand: ${this.id}`);
    }
    this.executionCommand = executionCommand;
    this.failureOwnership = failureOwnership === null
      ? null
      : DefinitionFailureOwnership.from(failureOwnership);
    if (this.definitionLifecycleOwned && !(this.failureOwnership instanceof DefinitionFailureOwnership)) {
      throw new Error(`definition lifecycle-owned step must declare failureOwnership: ${this.id}`);
    }
    if (!this.definitionLifecycleOwned && this.failureOwnership !== null) {
      throw new Error(`only definition lifecycle-owned steps may declare failureOwnership: ${this.id}`);
    }
    if (failurePolicy === null && failureTargetId !== null) {
      throw new Error(`failureTargetId requires a failurePolicy: ${this.id}`);
    }
    const parsedFailurePolicy = failurePolicy === null
      ? null
      : new DefinitionFailurePolicy(failurePolicy, { targetNodeId: failureTargetId });
    this.failurePolicy = parsedFailurePolicy?.value ?? null;
    this.failureTargetId = parsedFailurePolicy?.targetNodeId ?? null;
  }

  get isBranch() { return this.children != null; }
  get isLeaf() { return this.children == null; }

  resolveMaxAttempts(context = {}) {
    return this.maxAttempts.resolve(context);
  }

  resolveToolingMaxAttempts(context = {}) {
    return this.toolingMaxAttempts?.resolve(context) ?? null;
  }

  resolveLifecycle(input = {}) {
    return resolveLifecycleForNode(this, input);
  }
}

const DRAFT_QUESTIONS_ROUTE = draftReviewRouteForKey("questions");
const DRAFT_COVERAGE_ROUTE = draftReviewRouteForKey("coverage");
const DRAFT_REVIEW_ROUTE_EXPECTATIONS = Object.freeze([
  Object.freeze({
    route: DRAFT_QUESTIONS_ROUTE,
    triageStepId: "draft-questions-triage",
    repairStepId: "draft-questions-repair",
  }),
  Object.freeze({
    route: DRAFT_COVERAGE_ROUTE,
    triageStepId: "draft-coverage-triage",
    repairStepId: "draft-coverage-repair",
  }),
]);
for (const expectation of DRAFT_REVIEW_ROUTE_EXPECTATIONS) {
  if (
    expectation.route.triageStepId !== expectation.triageStepId
    || expectation.route.repairStepId !== expectation.repairStepId
  ) {
    throw new Error(`draft review route mismatch: ${expectation.triageStepId}`);
  }
}
const PLAN_REVIEW_MAX_ATTEMPTS_BY_ID = Object.freeze({
  "draft-questions-review": Object.freeze({ auto: 1, manual: 1 }),
  "draft-coverage-review": Object.freeze({ auto: 1, manual: 1 }),
  "spec-review": Object.freeze({ auto: 4, manual: 4 }),
  "test-review": Object.freeze({ auto: 5, manual: 5 }),
});

function createPlanReviewNode({ id, label, contextKinds, executionCommand }) {
  const maxAttempts = PLAN_REVIEW_MAX_ATTEMPTS_BY_ID[id];
  return new FlowNode({
    id,
    label,
    action: "run-review",
    instructionsKey: `plan.${id}`,
    contextKinds,
    outputSchemaRef: "next-action/review.schema.json",
    maxAttempts,
    toolingMaxAttempts: 1,
    failurePolicy: "retry",
    definitionLifecycleOwned: true,
    executionCommand,
    failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
  });
}

function createDraftReviewLeafNode({ id, label }) {
  return new FlowNode({
    id,
    label,
    action: "write-draft",
    instructionsKey: `plan.${id}`,
    contextKinds: ["draft", "issue", "guardrail"],
    outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
    maxAttempts: 1,
  });
}

function createDraftReviewRouteNodes(route) {
  return [
    createDraftReviewLeafNode({
      id: route.triageStepId,
      label: `${route.label} triage`,
    }),
    createDraftReviewLeafNode({
      id: route.repairStepId,
      label: `${route.label} repair`,
    }),
  ];
}

// ── FLOW_DEFINITION ─────────────────────────────────────────────────────────

const FLOW_DEFINITION = Object.freeze([
  new FlowNode({
    id: "plan",
    label: "Plan",
    children: [
      new FlowNode({
        id: "branch",
        label: "Branch",
        action: "create-branch",
        instructionsKey: "plan.branch",
        contextKinds: [],
        skippable: true,
      }),
      new FlowNode({
        id: "prepare-spec",
        label: "Prepare spec",
        action: "prepare-spec",
        instructionsKey: "plan.prepare-spec",
        contextKinds: [],
      }),
      new FlowNode({
        id: "draft",
        label: "Draft",
        action: "write-draft",
        instructionsKey: "plan.draft",
        contextKinds: ["issue", "guardrail", "project_overview"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
        maxAttempts: 1,
      }),
      createPlanReviewNode({
        id: "draft-questions-review",
        label: "Review (draft questions)",
        contextKinds: ["draft", "issue"],
        executionCommand: new FlowExecutionCommand("review", "--phase", "draft"),
      }),
      ...createDraftReviewRouteNodes(DRAFT_QUESTIONS_ROUTE),
      new FlowNode({
        id: "draft-refine",
        label: "Draft refine",
        action: "write-draft",
        instructionsKey: "plan.draft-refine",
        contextKinds: ["draft", "issue", "guardrail", "project_overview"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
        maxAttempts: 1,
      }),
      createPlanReviewNode({
        id: "draft-coverage-review",
        label: "Review (draft coverage)",
        contextKinds: ["draft", "issue"],
        executionCommand: new FlowExecutionCommand("review", "--phase", "draft"),
      }),
      ...createDraftReviewRouteNodes(DRAFT_COVERAGE_ROUTE),
      new FlowNode({
        id: "draft-gate",
        label: "Gate (draft)",
        action: "run-gate",
        instructionsKey: "plan.draft-gate",
        contextKinds: ["draft", "guardrail"],
        outputSchemaRef: "next-action/gate.schema.json",
        maxAttempts: 5,
        gatePhase: ["draft"],
        failurePolicy: "step-definition",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("gate"),
        failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      }),
      new FlowNode({
        id: "spec",
        label: "Spec",
        action: "write-spec",
        instructionsKey: "plan.spec",
        contextKinds: ["draft", "guardrail"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
      }),
      createPlanReviewNode({
        id: "spec-review",
        label: "Review (spec)",
        contextKinds: ["spec", "guardrail"],
        executionCommand: new FlowExecutionCommand("review", "--phase", "spec"),
      }),
      new FlowNode({
        id: "spec-triage",
        label: "Spec review triage",
        action: "write-spec",
        instructionsKey: "plan.spec-triage",
        contextKinds: ["spec", "guardrail"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
        maxAttempts: 1,
      }),
      new FlowNode({
        id: "spec-repair",
        label: "Spec repair",
        action: "write-spec",
        instructionsKey: "plan.spec-repair",
        contextKinds: ["spec", "guardrail"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
        maxAttempts: 1,
      }),
      new FlowNode({
        id: "spec-gate",
        label: "Gate (spec)",
        action: "run-gate",
        instructionsKey: "plan.spec-gate",
        contextKinds: ["spec", "guardrail"],
        outputSchemaRef: "next-action/gate.schema.json",
        maxAttempts: 5,
        gatePhase: ["spec", "task-spec"],
        failurePolicy: "step-definition",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("gate"),
        failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      }),
      new FlowNode({
        id: "approval",
        label: "Approval",
        action: "await-approval",
        instructionsKey: "plan.approval",
        contextKinds: ["spec"],
        outputSchemaRef: "next-action/approval.schema.json",
        requiresApproval: true,
        autoApproveChoiceId: "1",
        sideEffects: ["syncSpecTasks"],
      }),
      new FlowNode({
        id: "test",
        label: "Test",
        action: "write-tests",
        instructionsKey: "plan.test",
        contextKinds: ["spec", "guardrail"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
      }),
      new FlowNode({
        id: "scenario-validity",
        label: "Scenario Validity",
        action: "run-scenario-validity",
        instructionsKey: "plan.scenario-validity",
        contextKinds: ["spec", "test"],
        outputSchemaRef: "next-action/scenario-validity.schema.json",
        maxAttempts: 3,
        failurePolicy: "test-chain-repair",
        failureTargetId: "test",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("scenario-validity"),
        failureOwnership: DefinitionFailureOwnership.dispatcherPrimary(),
      }),
      createPlanReviewNode({
        id: "test-review",
        label: "Review (test)",
        contextKinds: ["spec", "guardrail"],
        executionCommand: new FlowExecutionCommand("review", "--phase", "test"),
      }),
    ],
  }),

  new FlowNode({
    id: "impl",
    label: "Implementation",
    children: [
      new FlowNode({
        id: "implement",
        label: "Implement",
        action: "run-impl",
        instructionsKey: "impl.implement",
        contextKinds: ["spec", "test", "overview"],
        outputSchemaRef: sourceWorkerEffectSchemaRef("implement"),
        maxAttempts: 3,
      }),
      new FlowNode({
        id: "test-execute",
        label: "Test Execute",
        action: "run-test-execute",
        instructionsKey: "impl.test-execute",
        contextKinds: ["spec", "test"],
        outputSchemaRef: "next-action/test-execute.schema.json",
        maxAttempts: 3,
        failurePolicy: "test-chain-retry",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("test-execute"),
        failureOwnership: DefinitionFailureOwnership.dispatcherPrimary(),
      }),
      new FlowNode({
        id: "test-result-review",
        label: "Test Result Review",
        action: "run-test-result-review",
        instructionsKey: "impl.test-result-review",
        contextKinds: ["spec", "test"],
        outputSchemaRef: "next-action/test-result-review.schema.json",
        maxAttempts: 3,
        failurePolicy: "test-chain-retry",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("test-result-review"),
        failureOwnership: DefinitionFailureOwnership.dispatcherPrimary(),
      }),
      new FlowNode({
        id: "impl-review",
        label: "Review",
        action: "run-review",
        instructionsKey: "impl.impl-review",
        contextKinds: ["spec", "diff", "testlog"],
        outputSchemaRef: "next-action/review.schema.json",
        maxAttempts: 4,
        toolingMaxAttempts: 1,
        failurePolicy: "retry",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("review", "--phase", "impl"),
        failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      }),
      new FlowNode({
        id: "impl-triage",
        label: "Implementation review triage",
        action: "write-impl-triage",
        instructionsKey: "impl.impl-triage",
        contextKinds: ["spec", "diff"],
        outputSchemaRef: sourceWorkerEffectSchemaRef("impl-triage"),
        maxAttempts: 1,
      }),
      new FlowNode({
        id: "impl-repair",
        label: "Implementation repair",
        action: "run-impl-repair",
        instructionsKey: "impl.impl-repair",
        contextKinds: ["spec", "diff"],
        outputSchemaRef: sourceWorkerEffectSchemaRef("impl-repair"),
        maxAttempts: 3,
      }),
      new FlowNode({
        id: "impl-gate",
        label: "Gate (impl)",
        action: "run-gate",
        instructionsKey: "impl.impl-gate",
        contextKinds: ["spec", "diff", "testlog"],
        outputSchemaRef: "next-action/gate.schema.json",
        maxAttempts: 5,
        gatePhase: ["integration", "task-impl"],
        failurePolicy: "block",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("gate"),
        failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      }),
      new FlowNode({
        id: "retro",
        label: "Retrospective",
        action: "run-retro",
        instructionsKey: "impl.retro",
        contextKinds: ["spec", "test"],
        outputSchemaRef: "next-action/retro.schema.json",
        maxAttempts: 2,
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("retro"),
        failureOwnership: DefinitionFailureOwnership.dispatcherPrimary(),
      }),
      new FlowNode({
        id: "acceptance-review",
        label: "Acceptance Review",
        action: "run-acceptance-review",
        instructionsKey: "impl.acceptance-review",
        contextKinds: ["spec", "diff", "test", "issue-log", "retro", "report"],
        outputSchemaRef: "next-action/acceptance-review.schema.json",
        maxAttempts: 1,
        sideEffects: ["promoteFinalRegression"],
        failurePolicy: "amend-spec",
        failureTargetId: "spec",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("acceptance-review"),
        failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      }),
      new FlowNode({
        id: "acceptance-decision",
        label: "Acceptance decision",
        action: "set-acceptance-decision",
        instructionsKey: "impl.acceptance-decision",
        contextKinds: ["spec", "diff", "test"],
        outputSchemaRef: "next-action/acceptance-review.schema.json",
        // This is a guarded, tokenless user-decision scene.  Its typed
        // await_user_decision directive is assembled by get-next-action;
        // it must never receive an approval token or autoApprove treatment.
        maxAttempts: 1,
      }),
      new FlowNode({
        id: "final-regression",
        label: "Final Regression",
        action: "run-final-regression",
        instructionsKey: "impl.final-regression",
        contextKinds: ["spec", "test"],
        outputSchemaRef: "next-action/final-regression.schema.json",
        maxAttempts: 2,
        // CurrentFlowState has no cataloged artifact facts.  It exposes a
        // route-neutral cursor only; FINAL_REGRESSION_STEP_DEFINITION owns
        // every failed route once the canonical facts boundary is available.
        failurePolicy: "step-definition",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("final-regression"),
        failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      }),
      new FlowNode({
        id: "report",
        label: "Report",
        action: "run-report",
        instructionsKey: "impl.report",
        contextKinds: ["spec", "diff", "test", "issue-log", "retro"],
        outputSchemaRef: "next-action/report.schema.json",
        maxAttempts: 2,
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("report"),
        failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
      }),
      new FlowNode({
        id: "finalize",
        label: "Finalize",
        children: [
          new FlowNode({
            id: "finalize-commit",
            label: "Commit",
            action: "run-finalize-commit",
            instructionsKey: "impl.finalize-commit",
            contextKinds: ["spec", "diff"],
            outputSchemaRef: "next-action/finalize.schema.json",
            requiresApproval: true,
            autoApproveChoiceId: "1",
            definitionLifecycleOwned: true,
            executionCommand: new FlowExecutionCommand("finalize-commit"),
            failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
          }),
          new FlowNode({
            id: "finalize-merge",
            label: "Merge",
            action: "run-finalize-merge",
            instructionsKey: "impl.finalize-merge",
            contextKinds: ["spec", "diff"],
            outputSchemaRef: "next-action/finalize.schema.json",
            definitionLifecycleOwned: true,
            executionCommand: new FlowExecutionCommand("finalize-merge"),
            failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
          }),
          new FlowNode({
            id: "finalize-sync",
            label: "Sync",
            action: "run-finalize-sync",
            instructionsKey: "impl.finalize-sync",
            contextKinds: ["spec"],
            outputSchemaRef: "next-action/finalize.schema.json",
            // An interrupted sync has no durable worker result to retry. The
            // recovery path records its failed outbox Activity, then skips
            // this leaf so cleanup can retain the persisted evidence.
            skippable: true,
            definitionLifecycleOwned: true,
            executionCommand: new FlowExecutionCommand("finalize-sync"),
            failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
          }),
          new FlowNode({
            id: "finalize-cleanup",
            label: "Cleanup",
            action: "run-finalize-cleanup",
            instructionsKey: "impl.finalize-cleanup",
            contextKinds: ["spec"],
            outputSchemaRef: "next-action/finalize.schema.json",
            definitionLifecycleOwned: true,
            executionCommand: new FlowExecutionCommand("finalize-cleanup"),
            failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
          }),
        ],
      }),
    ],
  }),
]);

// ── TASK_DEFINITION ─────────────────────────────────────────────────────────

const TASK_DEFINITION = Object.freeze([
  new FlowNode({
    id: "task-impl",
    label: "Task impl",
    action: "run-impl",
    instructionsKey: "task.task-impl",
    contextKinds: canonicalTaskContextKinds("task-impl"),
    outputSchemaRef: sourceWorkerEffectSchemaRef("task-impl"),
    maxAttempts: 2,
  }),
  new FlowNode({
    id: "task-review",
    label: "Task review",
    action: "run-review",
    instructionsKey: "task.task-review",
    contextKinds: canonicalTaskContextKinds("task-review"),
    outputSchemaRef: "next-action/review.schema.json",
    maxAttempts: 4,
    toolingMaxAttempts: 1,
    failurePolicy: "retry",
    definitionLifecycleOwned: true,
    executionCommand: new FlowExecutionCommand("review", "--phase", "impl"),
    failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
  }),
  new FlowNode({
    id: "task-triage",
    label: "Task triage",
    action: "write-task-triage",
    instructionsKey: "task.task-triage",
    contextKinds: canonicalTaskContextKinds("task-triage"),
    outputSchemaRef: sourceWorkerEffectSchemaRef("task-triage"),
    skippable: true,
    maxAttempts: 1,
  }),
  new FlowNode({
    id: "task-repair",
    label: "Task repair",
    action: "run-task-repair",
    instructionsKey: "task.task-repair",
    contextKinds: canonicalTaskContextKinds("task-repair"),
    outputSchemaRef: sourceWorkerEffectSchemaRef("task-repair"),
    skippable: true,
    maxAttempts: 3,
    toolingMaxAttempts: 1,
    failurePolicy: "retry-block",
  }),
  new FlowNode({
    id: "task-gate",
    label: "Task gate",
    action: "run-gate",
    instructionsKey: "impl.impl-gate",
    contextKinds: canonicalTaskContextKinds("task-gate"),
    outputSchemaRef: "next-action/gate.schema.json",
    skippable: true,
    maxAttempts: 5,
    failurePolicy: "block",
    definitionLifecycleOwned: true,
    executionCommand: new FlowExecutionCommand("gate"),
    failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
  }),
]);

// ── Gate-phase collection ───────────────────────────────────────────────────

/**
 * Collect [phase, stepId] pairs from all gate nodes across FLOW_DEFINITION
 * and TASK_DEFINITION. Order follows definition order.
 */
export function collectGatePhaseEntries() {
  const entries = [];
  function walk(nodes, depth) {
    assertDepth(depth);
    for (const node of nodes) {
      if (node.children) {
        walk(node.children, depth + 1);
      } else if (node.gatePhase) {
        for (const phase of node.gatePhase) {
          entries.push([phase, node.id]);
        }
      }
    }
  }
  walk(FLOW_DEFINITION, 1);
  walk(TASK_DEFINITION, 1);
  return entries;
}

export function collectFlowLeafIds() {
  return collectLeafIds(FLOW_DEFINITION);
}

export function flowLeafIdsBetween(startId, endId) {
  const ids = collectFlowLeafIds();
  const start = ids.indexOf(startId);
  const end = ids.indexOf(endId);
  if (start < 0 || end < start) throw new Error(`flow definition range not found: ${startId}..${endId}`);
  return ids.slice(start, end + 1);
}

export function collectTaskLeafIds() {
  return collectLeafIds(TASK_DEFINITION);
}

export function deriveFlowPhaseMap() {
  return derivePhaseMap(FLOW_DEFINITION);
}

export function getFlowDefinitionOrder() {
  return collectFlowLeafIds();
}

export function getTaskDefinitionOrder() {
  return collectTaskLeafIds();
}

export function collectFlowNodes() {
  return [...FLOW_DEFINITION];
}

export function collectTaskNodes() {
  return [...TASK_DEFINITION];
}

const ADVISORY_SKIPPABLE_LEAF_IDS = new Set([
  "branch",
  "draft-questions-triage", "draft-questions-repair",
  "draft-coverage-triage", "draft-coverage-repair",
  "impl-triage", "impl-repair",
  "acceptance-decision",
]);

function definitionLeafIds(scope) {
  return scope === "task" ? collectTaskLeafIds() : collectFlowLeafIds();
}

function definitionNodeIsSkippable(scope, stepId) {
  const node = scope === "task" ? getTaskNode(stepId) : getFlowNode(stepId);
  return node?.skippable === true || ADVISORY_SKIPPABLE_LEAF_IDS.has(stepId);
}

/**
 * Produce the explicit input contract for the next-generation state model.
 *
 * This is intentionally an adapter, not a converter: it reads the production
 * definition only and never reads or rewrites the currently deployed
 * flow.json.  The migration work can therefore select this contract without a
 * legacy-schema fallback or a double-write bridge.
 */
export function buildCurrentFlowDefinition() {
  // These two leaves may be bypassed only by the fixed,
  // evidence-consuming preimplementation bootstrap Activity.  The reachable
  // states remain part of the definition so journal replay can validate that
  // Activity without accepting an unmodelled persistence exception.
  const preimplementationBootstrapSkippable = new Set(["scenario-validity", "test-review"]);
  const existingImplementationCompletion = new Set(["implement"]);
  const finalizationRouteLeaves = new Set(["finalize-sync", "finalize-cleanup"]);
  const taskOverrunRecoveryLeaves = new Set(["task-review", "task-triage", "task-repair"]);
  const taskStageBypassLeaves = new Set(["task-triage", "task-repair", "task-gate"]);
  const transitionsFor = ({ skippable = false, triageNoRepair = false, taskStageBypass = false, preimplementationBootstrap = false, existingImplementation = false, finalizationRoute = false, taskOverrunRecovery = false, failurePolicy = null } = {}) => [
    "pending:in_progress",
    "in_progress:done",
    ...(skippable ? ["in_progress:skipped"] : []),
    // The impl-repair leaf may be skipped only by the typed all-reject
    // implementation-triage Activity. It can be pending on the normal
    // review route or invalidated on the acceptance-repair route.
    ...(triageNoRepair ? ["pending:skipped", "invalidated:skipped"] : []),
    ...(taskStageBypass ? ["pending:skipped", "invalidated:skipped"] : []),
    ...(preimplementationBootstrap ? ["pending:skipped", "in_progress:skipped"] : []),
    // This is consumed only by the Definition-selected stale Task-overrun
    // recovery Activity, which closes an accidentally opened extra round.
    ...(taskOverrunRecovery ? ["invalidated:done"] : []),
    ...(existingImplementation ? ["pending:done"] : []),
    // These suffix leaves are skipped/reset only by the typed
    // finalization-downstream Activity while finalize-merge is active.  The
    // definition still declares their reachable states so replay validation
    // remains an authority check rather than a persistence exception.
    ...(finalizationRoute ? ["pending:skipped", "skipped:pending"] : []),
    ...(["retry", "record", "step-definition"].includes(failurePolicy)
      ? ["in_progress:failed", "failed:in_progress", "failed:invalidated"]
      : []),
    "done:in_progress",
    "skipped:in_progress",
    "invalidated:in_progress",
    "pending:invalidated",
    "in_progress:invalidated",
    "done:invalidated",
    "skipped:invalidated",
  ];
  const transitionContract = (node, scope) => new CurrentFlowNodeContract({
    // Existing maxAttempts counts the initial Attempt.  The next-generation
    // contract keeps only retry budgets, so it subtracts that initial work.
    semanticRetryLimit: node.resolveMaxAttempts({ autoApprove: false }) - 1,
    // null remains an explicit zero-budget tooling policy in NodeContract.
    toolingRetryLimit: node.resolveToolingMaxAttempts({ autoApprove: false }),
    transitions: transitionsFor({
      ...node,
      triageNoRepair: node.id === "impl-repair",
      skippable: definitionNodeIsSkippable(scope, node.id),
      preimplementationBootstrap: preimplementationBootstrapSkippable.has(node.id),
      existingImplementation: existingImplementationCompletion.has(node.id),
      finalizationRoute: finalizationRouteLeaves.has(node.id),
      taskOverrunRecovery: scope === "task" && taskOverrunRecoveryLeaves.has(node.id),
      taskStageBypass: scope === "task" && taskStageBypassLeaves.has(node.id),
    }),
    // Context requirements stay definition-owned. Current Attempt claims may
    // cover them as completed operations or typed incomplete operations, but
    // never copy the contract into flow.json.
    resourceContract: { required: node.contextKinds, authority: "definition" },
  });
  const actionMetadata = (node, sourceScopes) => ({
    action: node.action ?? null,
    instructionsKey: node.instructionsKey ?? null,
    contextKinds: [...node.contextKinds],
    outputSchemaRef: node.outputSchemaRef ?? null,
    requiresApproval: node.requiresApproval === true,
    autoApproveChoiceId: node.autoApproveChoiceId ?? null,
    maxAttempts: node.resolveMaxAttempts({ autoApprove: false }),
    sideEffects: node.sideEffects ? [...node.sideEffects] : null,
    failurePolicy: new DefinitionFailurePolicy(node.failurePolicy ?? "block", {
      targetNodeId: node.failureTargetId ?? null,
    }),
    executionCommand: node.executionCommand?.toString() ?? null,
    failureOwnership: node.failureOwnership,
    artifactAuthority: { sourceScopes },
  });
  const adapt = (node, kind = "step", sourceScopes = ["all_tasks", "flow"], scope = "flow") => new CurrentFlowDefinitionNode({
    kind,
    id: node.id,
    key: node.instructionsKey || node.id,
    contract: transitionContract(node, scope),
    steps: (node.children || []).map((child) => adapt(child, "step", sourceScopes, scope)),
    action: node.children ? null : actionMetadata(node, sourceScopes),
  });
  return new CurrentFlowDefinition({
    root: new CurrentFlowDefinitionNode({
      kind: "flow",
      id: "flow",
      key: "flow",
      contract: new CurrentFlowNodeContract({
        semanticRetryLimit: 0,
        toolingRetryLimit: null,
        resourceContract: { required: [], authority: "definition" },
        transitions: transitionsFor(),
      }),
      steps: FLOW_DEFINITION.map((node) => adapt(node, "step", ["all_tasks", "flow"], "flow")),
    }),
    taskTemplate: new CurrentFlowDefinitionNode({
      kind: "task",
      id: "task",
      key: "task",
      contract: new CurrentFlowNodeContract({
        semanticRetryLimit: 0,
        toolingRetryLimit: null,
        resourceContract: { required: [], authority: "definition" },
        transitions: transitionsFor(),
      }),
      steps: TASK_DEFINITION.map((node) => adapt(node, "step", ["same_task", "flow"], "task")),
    }),
    dynamicTaskContainerId: "impl",
    dynamicTaskInsertionAfterId: "implement",
  });
}

export function getFlowNode(id) {
  return resolveNodeFor(FLOW_DEFINITION, id);
}

export function getTaskNode(id) {
  return resolveNodeFor(TASK_DEFINITION, id);
}

/**
 * A straight-line source producer may carry an advisory only when Definition
 * guarantees a later, non-skippable quality checkpoint. Cyclic Task repair
 * uses the selected Task Review funnel plan below instead of this static map.
 */
export class SourceQualityIssueRecoveryRoute {
  constructor({ sourceStep, recoveryStep, scope } = {}) {
    this.sourceStep = requireString(sourceStep, "source quality issue source Step");
    this.recoveryStep = requireString(recoveryStep, "source quality issue recovery Step");
    if (!new Set(["flow", "task"]).has(scope)) throw new Error("source quality issue recovery scope is invalid");
    this.scope = scope;
    const source = scope === "task" ? getTaskNode(sourceStep) : getFlowNode(sourceStep);
    const recovery = scope === "task" ? getTaskNode(recoveryStep) : getFlowNode(recoveryStep);
    if (source === null || recovery === null) throw new Error("source quality issue recovery route is absent from the Definition");
    const leaves = definitionLeafIds(scope);
    if (leaves.indexOf(sourceStep) < 0 || leaves.indexOf(recoveryStep) <= leaves.indexOf(sourceStep)) {
      throw new Error("source quality issue recovery Step must be a forward Definition leaf");
    }
    if (definitionNodeIsSkippable(scope, recoveryStep)) throw new Error("source quality issue recovery Step must not be skippable");
    Object.freeze(this);
  }
  toJSON() { return { sourceStep: this.sourceStep, recoveryStep: this.recoveryStep, scope: this.scope }; }
}

const SOURCE_QUALITY_ISSUE_RECOVERY_PLAN_TOKEN = Symbol("source-quality-issue-recovery-plan");

/** A concrete quality checkpoint selected by Definition for one source result. */
export class SourceQualityIssueRecoveryPlan {
  constructor(token, { sourceStep, recoveryStep, scope, taskReviewStagePlan = null } = {}) {
    if (token !== SOURCE_QUALITY_ISSUE_RECOVERY_PLAN_TOKEN) {
      throw new Error("source quality issue recovery plans are created only by Definition");
    }
    this.sourceStep = requireString(sourceStep, "source quality issue source Step");
    this.recoveryStep = requireString(recoveryStep, "source quality issue recovery Step");
    if (!new Set(["flow", "task"]).has(scope)) throw new Error("source quality issue recovery scope is invalid");
    this.scope = scope;
    this.taskReviewStagePlan = taskReviewStagePlan;
    if (sourceStep === "task-repair") {
      if (!(taskReviewStagePlan instanceof TaskReviewStageTransitionPlan)
        || taskReviewStagePlan.facts.binding.stage !== "repair"
        || taskReviewStagePlan.facts.binding.sourceStepId !== `${taskReviewStagePlan.facts.binding.taskId}-repair`
        || taskReviewStagePlan.targetStepId !== recoveryStep
        || !new Set(["repair-to-review", "repair-unreviewed-to-gate"]).has(taskReviewStagePlan.operation)) {
        throw new Error("Task repair quality recovery must use its selected Task Review funnel plan");
      }
    } else if (taskReviewStagePlan !== null) {
      throw new Error("only Task repair quality recovery may carry a Task Review funnel plan");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      sourceStep: this.sourceStep,
      recoveryStep: this.recoveryStep,
      scope: this.scope,
      taskReviewStagePlan: this.taskReviewStagePlan?.toJSON() ?? null,
    };
  }
}

const SOURCE_QUALITY_ISSUE_RECOVERY_ROUTES = new Map([
  ["implement", new SourceQualityIssueRecoveryRoute({ sourceStep: "implement", recoveryStep: "impl-review", scope: "flow" })],
  ["impl-repair", new SourceQualityIssueRecoveryRoute({ sourceStep: "impl-repair", recoveryStep: "impl-gate", scope: "flow" })],
  ["task-impl", new SourceQualityIssueRecoveryRoute({ sourceStep: "task-impl", recoveryStep: "task-review", scope: "task" })],
]);

export function sourceQualityIssueRecoveryForStep(stepId) {
  if (typeof stepId !== "string") return null;
  return SOURCE_QUALITY_ISSUE_RECOVERY_ROUTES.get(stepId) ?? null;
}

export function resolveSourceQualityIssueRecoveryPlan({ sourceStep, taskId = null, taskReviewStagePlan = null } = {}) {
  if (sourceStep === "task-repair") {
    if (!(taskReviewStagePlan instanceof TaskReviewStageTransitionPlan)) {
      throw new Error("Task repair quality recovery requires its selected Task Review funnel plan");
    }
    return new SourceQualityIssueRecoveryPlan(SOURCE_QUALITY_ISSUE_RECOVERY_PLAN_TOKEN, {
      sourceStep,
      recoveryStep: taskReviewStagePlan.targetStepId,
      scope: "task",
      taskReviewStagePlan,
    });
  }
  const route = sourceQualityIssueRecoveryForStep(sourceStep);
  if (route === null) return null;
  const recoveryStep = route.scope === "task"
    ? `${requireString(taskId, "source quality issue Task")}-${route.recoveryStep.slice("task-".length)}`
    : route.recoveryStep;
  return new SourceQualityIssueRecoveryPlan(SOURCE_QUALITY_ISSUE_RECOVERY_PLAN_TOKEN, {
    sourceStep,
    recoveryStep,
    scope: route.scope,
  });
}

const TASK_REVIEW_STAGE_COMPLETION_PLAN_TOKEN = Symbol("task-review-stage-completion-plan");

/** One Definition decision binds Task stage advancement and any quality checkpoint. */
export class TaskReviewStageCompletionPlan {
  constructor(token, { transition, qualityRecovery = null, sourceQualityIssueCount = 0 } = {}) {
    if (token !== TASK_REVIEW_STAGE_COMPLETION_PLAN_TOKEN
      || !(transition instanceof TaskReviewStageTransitionPlan)) {
      throw new Error("Task Review stage completion plans are created only by Definition");
    }
    if (!Number.isSafeInteger(sourceQualityIssueCount) || sourceQualityIssueCount < 0) {
      throw new Error("Task Review stage source quality issue count is invalid");
    }
    if ((sourceQualityIssueCount > 0) !== (qualityRecovery instanceof SourceQualityIssueRecoveryPlan)) {
      throw new Error("Task Review stage quality issues require exactly one selected recovery plan");
    }
    if (qualityRecovery !== null && qualityRecovery.taskReviewStagePlan !== transition) {
      throw new Error("Task Review stage quality recovery must share its transition decision");
    }
    this.transition = transition;
    this.qualityRecovery = qualityRecovery;
    this.sourceQualityIssueCount = sourceQualityIssueCount;
    Object.freeze(this);
  }

  toJSON() {
    return {
      transition: this.transition.toJSON(),
      qualityRecovery: this.qualityRecovery?.toJSON() ?? null,
      sourceQualityIssueCount: this.sourceQualityIssueCount,
    };
  }
}

export function resolveTaskReviewStageCompletion({ facts, sourceQualityIssueCount = 0 } = {}) {
  const transition = resolveTaskReviewStageTransition(facts);
  const sourceStep = `task-${facts.binding.stage}`;
  const qualityRecovery = sourceQualityIssueCount === 0
    ? null
    : resolveSourceQualityIssueRecoveryPlan({ sourceStep, taskReviewStagePlan: transition });
  return new TaskReviewStageCompletionPlan(TASK_REVIEW_STAGE_COMPLETION_PLAN_TOKEN, {
    transition,
    qualityRecovery,
    sourceQualityIssueCount,
  });
}

export function resolveMaxAttempts({ scope = "flow", stepId, context = {} }) {
  const node = scope === "task" ? getTaskNode(stepId) : getFlowNode(stepId);
  return node?.resolveMaxAttempts(context) ?? null;
}

export function resolveToolingMaxAttempts({ scope = "flow", stepId, context = {} }) {
  const node = scope === "task" ? getTaskNode(stepId) : getFlowNode(stepId);
  return node?.resolveToolingMaxAttempts(context) ?? null;
}

export function resolveSideEffects({ scope = "flow", stepId }) {
  const node = scope === "task" ? getTaskNode(stepId) : getFlowNode(stepId);
  return node?.sideEffects ? [...node.sideEffects] : null;
}

export function isDefinitionLifecycleOwnedStep({ scope = "flow", stepId }) {
  const node = scope === "task" ? getTaskNode(stepId) : getFlowNode(stepId);
  return node?.definitionLifecycleOwned === true;
}

/**
 * Resolve the definition-owned command for a leaf that mutates canonical Flow
 * state.  The returned value keeps argv tokenized; callers must never recover
 * a command by parsing a human-readable instruction string.
 */
export function resolveDispatcherOwnedFlowAction({ scope = "flow", stepId }) {
  const node = scope === "task" ? getTaskNode(stepId) : getFlowNode(stepId);
  if (node?.definitionLifecycleOwned !== true) return null;
  return Object.freeze({
    action: node.action,
    executionCommand: node.executionCommand,
  });
}

export function deriveFlowPrereqs(targetId) {
  return derivePrereqs(FLOW_DEFINITION, targetId);
}

export function getFlowBranchLeafIds(parentId) {
  const parent = getFlowNode(parentId);
  if (!parent?.children) return [];
  return flattenSteps(parent.children).map((step) => step.id);
}

// ── Traversal helpers ───────────────────────────────────────────────────────

function assertDepth(depth) {
  if (depth > MAX_DEPTH) {
    throw new Error(`definition depth exceeds maximum (${MAX_DEPTH})`);
  }
}

/**
 * Collect all leaf node IDs from a definition tree in document order.
 */
export function collectLeafIds(definition) {
  const ids = [];
  function walk(nodes, depth) {
    assertDepth(depth);
    for (const node of nodes) {
      if (node.children) {
        walk(node.children, depth + 1);
      } else {
        ids.push(node.id);
      }
    }
  }
  walk(definition, 1);
  return ids;
}

/**
 * Derive a phase map (leaf id → branch id) from a definition tree.
 */
export function derivePhaseMap(definition) {
  const map = {};
  function walk(nodes, parentId, depth) {
    assertDepth(depth);
    for (const node of nodes) {
      if (node.children) {
        walk(node.children, node.id, depth + 1);
      } else {
        map[node.id] = parentId;
      }
    }
  }
  walk(definition, null, 1);
  return map;
}

/**
 * Look up a node by id (any depth) in the definition tree.
 */
export function resolveNodeFor(definition, id) {
  function walk(nodes, depth) {
    assertDepth(depth);
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children) {
        const found = walk(node.children, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(definition, 1);
}

/**
 * Find the currently active (in_progress) leaf in a nested steps structure,
 * matching against the definition tree for navigation.
 *
 * Returns `{ scope: "flow"|"task", taskId, stepId }` or null.
 */
export function findActiveNode({ steps, tasks, currentTaskId }) {
  if (currentTaskId != null && Array.isArray(tasks)) {
    const task = tasks.find((t) => t.id === currentTaskId);
    if (task && Array.isArray(task.steps)) {
      const step = findLatestInProgressLeaf(task.steps, TASK_DEFINITION);
      if (step) return { scope: "task", taskId: currentTaskId, stepId: step.id };
    }
  }
  const step = findLatestInProgressLeaf(steps, FLOW_DEFINITION);
  if (step) return { scope: "flow", taskId: null, stepId: step.id };
  return null;
}

export function taskIdForResolvedStep(activeNode, targetStepId) {
  return activeNode?.stepId === targetStepId ? activeNode.taskId : null;
}

const MAX_IN_PROGRESS_STEP_SCAN = 500;
const DEFINITION_ORDER_CACHE = new WeakMap();

function scanLatestInProgressLeaf(steps, order, state, depth = 1) {
  assertDepth(depth);
  if (!Array.isArray(steps)) return state;
  for (const s of steps) {
    state.scanned += 1;
    if (state.scanned > MAX_IN_PROGRESS_STEP_SCAN) {
      throw new Error(`too many flow steps while resolving active step (max ${MAX_IN_PROGRESS_STEP_SCAN})`);
    }
    if (s.children) {
      scanLatestInProgressLeaf(s.children, order, state, depth + 1);
      continue;
    }
    if (s.status === "in_progress") {
      if (!order.has(s.id)) {
        if (!state.unknownStep) state.unknownStep = s;
        continue;
      }
      const index = order.get(s.id);
      if (!state.step || index >= state.index) {
        state.step = s;
        state.index = index;
      }
    }
  }
  return state;
}

function orderMapForDefinition(definition) {
  let order = DEFINITION_ORDER_CACHE.get(definition);
  if (!order) {
    order = new Map(collectLeafIds(definition).map((id, idx) => [id, idx]));
    DEFINITION_ORDER_CACHE.set(definition, order);
  }
  return order;
}

export function findLatestInProgressLeaf(steps, definition = FLOW_DEFINITION) {
  const order = orderMapForDefinition(definition);
  const selected = scanLatestInProgressLeaf(
    steps,
    order,
    { step: null, unknownStep: null, index: -1, scanned: 0 },
  );
  return selected.unknownStep || selected.step;
}

/**
 * Derive the next action envelope fields from the definition for a given step.
 *
 * Returns definition-owned action metadata, including the declared executionCommand,
 * for the step identified by `scope` ("flow" or "task") and `stepId`.
 */
export function deriveNextAction({ scope = "flow", stepId, context = {} }) {
  const def = scope === "task" ? TASK_DEFINITION : FLOW_DEFINITION;
  const node = resolveNodeFor(def, stepId);
  if (!node) return null;
  return {
    action: node.action,
    instructionsKey: node.instructionsKey,
    contextKinds: [...node.contextKinds],
    outputSchemaRef: node.outputSchemaRef,
    requiresApproval: node.requiresApproval,
    autoApproveChoiceId: node.autoApproveChoiceId,
    maxAttempts: node.resolveMaxAttempts(context),
    sideEffects: node.sideEffects ? [...node.sideEffects] : null,
    failurePolicy: node.failurePolicy,
    executionCommand: node.executionCommand?.toString() ?? null,
  };
}

/**
 * Build initial nested steps from the definition tree.
 * Branch nodes get `{ id, status: "pending", children: [...] }`;
 * leaf nodes get `{ id, status: "pending" }`.
 *
 * The first leaf is promoted to "in_progress".
 */
export function buildInitialNestedSteps(definition = FLOW_DEFINITION) {
  function buildNode(node) {
    if (node.children) {
      return { id: node.id, status: "pending", children: node.children.map(buildNode) };
    }
    return { id: node.id, status: "pending" };
  }
  const steps = definition.map(buildNode);
  const firstLeaf = findFirstPendingLeaf(steps);
  if (firstLeaf) firstLeaf.status = "in_progress";
  return steps;
}

/**
 * Build initial task-level steps from TASK_DEFINITION.
 */
export function buildInitialTaskSteps() {
  return TASK_DEFINITION.map((node) => ({ id: node.id, status: "pending" }));
}

/**
 * Derive prerequisite step ids for a given target step from the definition.
 * Prerequisites are all leaf steps in branches that appear before the target's
 * branch in the definition.
 */
export function derivePrereqs(definition, targetId) {
  const targetBranchIdx = findBranchIndexForLeaf(definition, targetId);
  if (targetBranchIdx < 0) return [];

  const prereqs = [];
  for (let i = 0; i < targetBranchIdx; i++) {
    const branch = definition[i];
    if (branch.children) {
      const lastLeaf = getLastLeaf(branch.children);
      if (lastLeaf) prereqs.push(lastLeaf.id);
    }
  }
  return prereqs;
}

function findBranchIndexForLeaf(definition, leafId) {
  for (let i = 0; i < definition.length; i++) {
    const branch = definition[i];
    if (branch.id === leafId) return i;
    if (branch.children && resolveNodeFor([branch], leafId)) return i;
  }
  return -1;
}

function getLastLeaf(nodes) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.children) {
      const found = getLastLeaf(n.children);
      if (found) return found;
    } else {
      return n;
    }
  }
  return null;
}

/**
 * Check if a step is a branch containing a leaf with the given id.
 * Returns the branch node or null.
 */
export function findBranchForLeaf(definition, leafId) {
  for (const branch of definition) {
    if (branch.children && resolveNodeFor([branch], leafId)) return branch;
  }
  return null;
}

export { FlowNode };

/** Explicit orphan reconciliation is not an automatic retry or semantic acceptance. */
export class TaskReviewReconciliationDecision {
  constructor({ state, catalog, activities }) {
    const nodeId = state.current?.at(-1);
    const node = nodeId ? state.findNode(nodeId) : null;
    const attempt = state.attempt;
    if (node?.key !== "task.task-review" || node.status !== "in_progress" || !attempt?.failure
      || !["tooling", "provider"].includes(attempt.failure.category)
      || state.failureDisposition()?.operation !== "record") {
      throw new Error("Definition does not authorize orphaned Task Review reconciliation");
    }
    const taskId = nodeId.slice(0, -"-review".length);
    const introduction = activities.find(a => a.nodeId === nodeId && a.transition.attempt?.id === attempt.id);
    const failure = activities.find(a => a.nodeId === nodeId && a.attemptId === attempt.id && a.transition.operation === "fail_attempt");
    if (!introduction || !["recover_attempt", "rewind"].includes(introduction.transition.operation) || !failure
      || catalog.artifacts.some(a => (["retry.recovery.baseline", "retry.recovery.receipt"].includes(a.logicalKey) && a.relativePath.endsWith(`/${attempt.id}.json`))
        || (a.logicalKey === "task.review" && a.relativePath === `steps/impl/${taskId}/review/result.json`)
        || (a.logicalKey === "task.review.reconciliation" && a.relativePath.startsWith(`steps/impl/${taskId}/review/recovery/reconciliations/`)))) {
      throw new Error("Task Review reconciliation requires an unpublished recovered Attempt without a baseline or prior reconciliation");
    }
    this.taskId = taskId;
    this.nodeId = nodeId;
    this.operation = "reconcile-task-review";
    Object.freeze(this);
  }
}

export function resolveTaskReviewReconciliation(facts) {
  return new TaskReviewReconciliationDecision(facts);
}
