import {
  DefinitionLifecyclePlan,
  SetStepStatus,
  getFlowDefinitionOrder,
} from "../definition.js";
import { planGateRepairRouteForTargetStep } from "./plan-gate-repair.js";

const TERMINAL_STATUSES = new Set(["done", "skipped"]);
const LIFECYCLE_STATUSES = new Set(["in_progress", "done", "skipped"]);
const REOPEN_DRAFT_ENTRYPOINT = "reopen-draft";
const RESET_SKIPPED_ENTRYPOINT = "reset-skipped-downstream";
export const PLAN_GATE_REPAIR_ENTRYPOINT = "plan-gate-repair";

export class StepTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = "StepTransitionError";
    this.code = "FLOW_STEP_TRANSITION_INVALID";
  }
}

export class StepTransitionCommitIntent {
  constructor() {
    if (new.target === StepTransitionCommitIntent) {
      throw new StepTransitionError("step transition commit intent must use a concrete type");
    }
  }

  assertBeforeTransition() {}

  applyTo() {
    throw new StepTransitionError("step transition commit intent must implement applyTo(state)");
  }

  completeIn() {
    throw new StepTransitionError("step transition commit intent does not support completion");
  }
}

function transitionError(message) {
  throw new StepTransitionError(message);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    transitionError(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredStatus(value, field) {
  return requiredString(value, field);
}

function validateReopenChanges({ entrypoint, recoveryChanges, currentStatus }) {
  if (recoveryChanges.length === 0) {
    transitionError(`${entrypoint} recovery requires step changes`);
  }
  const draftIndex = getFlowDefinitionOrder().indexOf("draft");
  const allowedSteps = new Set(getFlowDefinitionOrder().slice(draftIndex));
  const seen = new Set();
  for (const change of recoveryChanges) {
    if (seen.has(change.stepId)) {
      transitionError(`${entrypoint} recovery contains duplicate step ${change.stepId}`);
    }
    seen.add(change.stepId);
    if (!allowedSteps.has(change.stepId)) {
      transitionError(`${entrypoint} recovery cannot change ${change.stepId}`);
    }
    if (change.stepId === "draft") {
      if (change.currentStatus !== currentStatus || change.requestedStatus !== "in_progress") {
        transitionError(`${entrypoint} recovery draft change must match the terminal source and request in_progress`);
      }
    } else if (change.requestedStatus !== "pending") {
      transitionError(`${entrypoint} recovery may only reset downstream steps to pending`);
    }
  }
  if (!seen.has("draft")) {
    transitionError(`${entrypoint} recovery must include the draft transition`);
  }
  if (entrypoint === "reopen-spec-correction" && recoveryChanges.length !== 1) {
    transitionError("reopen-spec-correction step changes are represented by its replacement flow state");
  }
}

export class NormalStepTransition {
  constructor({
    stepId,
    currentStepId,
    currentStatus,
    requestedStatus,
    lifecycleOwned = false,
  }) {
    this.stepId = requiredString(stepId, "stepId");
    this.currentStepId = requiredString(currentStepId, "currentStepId");
    this.currentStatus = requiredStatus(currentStatus, "currentStatus");
    this.requestedStatus = requiredStatus(requestedStatus, "requestedStatus");
    if (lifecycleOwned === true) {
      transitionError(`${this.stepId} is owned by its definition lifecycle`);
    }
    if (this.stepId !== this.currentStepId) {
      transitionError(`normal transition target ${this.stepId} is not the current step ${this.currentStepId}`);
    }
    if (this.currentStatus !== "in_progress") {
      transitionError(`normal transition requires current status in_progress, got ${this.currentStatus}`);
    }
    if (!TERMINAL_STATUSES.has(this.requestedStatus)) {
      transitionError(`normal transition requires requested status done or skipped, got ${this.requestedStatus}`);
    }
    Object.freeze(this);
  }
}

export class DefinitionLifecycleTransition {
  constructor({
    action,
    plan,
    currentStatus,
  }) {
    if (!(action instanceof SetStepStatus)) {
      transitionError("definition lifecycle action must be a SetStepStatus");
    }
    if (!(plan instanceof DefinitionLifecyclePlan) || !plan.allows(action)) {
      transitionError("definition lifecycle action was not emitted by the current definition event");
    }
    this.action = action;
    this.stepId = action.step;
    this.currentStepId = requiredString(plan.currentStepId, "currentStepId");
    this.currentStatus = requiredStatus(currentStatus, "currentStatus");
    this.requestedStatus = requiredStatus(action.status, "requestedStatus");
    this.event = requiredString(plan.event, "event");
    this.hasExplicitInProgressTarget = plan.actions.some((candidate) => (
      candidate instanceof SetStepStatus
      && (candidate.status === "in_progress" || candidate.suppressAutoPromotion)
    ));
    if (!LIFECYCLE_STATUSES.has(this.requestedStatus)) {
      transitionError(`definition lifecycle requested status is invalid: ${this.requestedStatus}`);
    }
    if (!new Set(["pending", "in_progress", "invalidated"]).has(this.currentStatus)) {
      transitionError(`definition lifecycle source status is terminal: ${this.currentStatus}`);
    }
    Object.freeze(this);
  }
}

export class ExplicitRecoveryTransition {
  constructor({
    stepId,
    currentStatus,
    requestedStatus,
    entrypoint,
    request = null,
    evidence = [],
    changes = null,
    clearRuntimeLog = false,
    commitIntent = null,
    expectedOriginal = null,
    replacementState = null,
  }) {
    this.stepId = requiredString(stepId, "stepId");
    this.currentStatus = requiredStatus(currentStatus, "currentStatus");
    this.requestedStatus = requiredStatus(requestedStatus, "requestedStatus");
    this.entrypoint = requiredString(entrypoint, "entrypoint");
    if (changes != null && !Array.isArray(changes)) {
      transitionError("recovery changes must be an array");
    }
    if (commitIntent != null && !(commitIntent instanceof StepTransitionCommitIntent)) {
      transitionError("recovery commit intent must be a StepTransitionCommitIntent");
    }
    const recoveryChanges = changes == null
      ? [new RecoveryStepChange({ stepId: this.stepId, currentStatus: this.currentStatus, requestedStatus: this.requestedStatus })]
      : changes.map((change) => change instanceof RecoveryStepChange ? change : new RecoveryStepChange(change));
    if (this.entrypoint === REOPEN_DRAFT_ENTRYPOINT || this.entrypoint === "reopen-spec-correction") {
      if (this.stepId !== "draft" || this.requestedStatus !== "in_progress") {
        transitionError("reopen-draft recovery must target draft=in_progress");
      }
      if (!TERMINAL_STATUSES.has(this.currentStatus)) {
        transitionError(`reopen-draft recovery requires a terminal draft, got ${this.currentStatus}`);
      }
      validateReopenChanges({
        entrypoint: this.entrypoint,
        recoveryChanges,
        currentStatus: this.currentStatus,
      });
      if (this.entrypoint === "reopen-spec-correction" && (!expectedOriginal || !replacementState)) {
        transitionError("reopen-spec-correction requires expected and replacement flow states");
      }
    } else if (this.entrypoint === RESET_SKIPPED_ENTRYPOINT) {
      if (recoveryChanges.some((change) => change.currentStatus !== "skipped" || change.requestedStatus !== "pending")) {
        transitionError("reset-skipped-downstream recovery requires skipped to pending");
      }
    } else if (this.entrypoint === "impl-repair-invalidation") {
      if (recoveryChanges.length === 0) transitionError("impl-repair invalidation requires step changes");
      if (recoveryChanges.some((change) => !["pending", "in_progress"].includes(change.requestedStatus))) {
        transitionError("impl-repair invalidation may only reset steps to pending or in_progress");
      }
    } else if (this.entrypoint === "restore-branch-merge-post-state") {
      if (
        recoveryChanges.length !== 1
        || recoveryChanges[0].stepId !== "finalize-merge"
        || recoveryChanges[0].currentStatus !== "pending"
        || recoveryChanges[0].requestedStatus !== "in_progress"
      ) {
        transitionError("branch merge restore requires finalize-merge pending to in_progress");
      }
    } else if (this.entrypoint === PLAN_GATE_REPAIR_ENTRYPOINT) {
      const route = planGateRepairRouteForTargetStep(this.stepId);
      if (!route || this.requestedStatus !== "in_progress") {
        transitionError("plan gate repair must target its mapped worker handoff step");
      }
      const byStep = new Map(recoveryChanges.map((change) => [change.stepId, change]));
      if (byStep.size !== route.resetStepIds.length || recoveryChanges.length !== byStep.size) {
        transitionError("plan gate repair requires its complete unique reset sequence");
      }
      for (const stepId of route.resetStepIds) {
        const change = byStep.get(stepId);
        if (!change || change.requestedStatus !== route.requestedStatus(stepId)) {
          transitionError(`plan gate repair has invalid change for ${stepId}`);
        }
        if (stepId === route.gateStepId && change.currentStatus !== "in_progress") {
          transitionError("plan gate repair requires an active gate source");
        }
        const completedUpstream = change.currentStatus === "done"
          || (stepId === "draft-gate-repair" && change.currentStatus === "skipped");
        if (stepId !== route.gateStepId && !completedUpstream) {
          transitionError(`plan gate repair requires completed upstream step ${stepId}`);
        }
      }
    } else {
      transitionError(`unsupported recovery entrypoint: ${this.entrypoint}`);
    }
    if (!Array.isArray(evidence)) transitionError("recovery evidence must be an array");
    this.request = request;
    this.evidence = Object.freeze([...evidence]);
    this.changes = Object.freeze(recoveryChanges);
    this.clearRuntimeLog = clearRuntimeLog === true;
    this.commitIntent = commitIntent;
    this.expectedOriginal = expectedOriginal;
    this.replacementState = replacementState;
    Object.freeze(this);
  }
}

export class RecoveryStepChange {
  constructor({ stepId, currentStatus, requestedStatus }) {
    this.stepId = requiredString(stepId, "stepId");
    this.currentStatus = requiredStatus(currentStatus, "currentStatus");
    this.requestedStatus = requiredStatus(requestedStatus, "requestedStatus");
    Object.freeze(this);
  }
}

export function isStepTransition(value) {
  return value instanceof NormalStepTransition
    || value instanceof DefinitionLifecycleTransition
    || (
      value instanceof ExplicitRecoveryTransition
      && [
        RESET_SKIPPED_ENTRYPOINT,
        "impl-repair-invalidation",
        PLAN_GATE_REPAIR_ENTRYPOINT,
      ].includes(value.entrypoint)
    );
}
