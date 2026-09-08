import { projectAdvisorySummary } from "./advisory-summary.js";
/** Canonical Version-1 advisory handling. */

import crypto from "node:crypto";
import {
  NonBlockingDecisionOutcome,
  NONBLOCKING_SOURCE_STEPS,
  ObservedNonPassOutcome,
} from "./step-outcome.js";
import {
  FlowContinuation,
  UserActionChoice,
  UserActionImpact,
  UserActionPrompt,
} from "./user-action-prompt.js";
import { guardedCommand } from "./guarded-command.js";
import {
  fromAcceptanceResult,
  fromFinalRegressionResult,
  fromGateResult,
  fromReviewResult,
  fromVerificationResult,
} from "./nonblocking-evidence.js";
import { nonblockingRouteFor } from "./nonblocking-route.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { ActivityNonBlockingRecord } from "./current-flow-state.js";

const MAX_TEXT = 2_000;
const ACTIONS = Object.freeze(["repair", "retry", "continue"]);
const RESULT_KINDS = Object.freeze(["quality", "tooling", "unavailable"]);
const CANONICAL_EVIDENCE_KEYS = Object.freeze({
  "draft-questions-review": "draft.questions.review",
  "draft-coverage-review": "draft.coverage.review",
  "draft-gate": "draft.gate",
  "spec-gate": "spec.gate",
  "scenario-validity": "scenario.validity",
  "test-review": "test.review",
  "test-result-review": "test.result.review",
  "task-review": "task.review",
  "task-gate": "task.gate",
  "impl-review": "impl.review",
  "impl-gate": "impl.gate",
  retro: "retro",
  "acceptance-review": "acceptance.review",
  "final-regression": "final.regression",
});

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > MAX_TEXT) {
    throw new Error(`${field} must be a non-empty string no longer than ${MAX_TEXT} characters`);
  }
  return value.trim();
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function assertStep(value) {
  const step = text(value, "nonblocking step");
  if (!NONBLOCKING_SOURCE_STEPS.includes(step)) throw new Error(`nonblocking is not supported for step: ${step}`);
  return step;
}

function activeNodeId(state) { return state?.currentNodeId ?? null; }

/** Translate a materialized Task leaf back to its definition-owned advisory route. */
function activeStep(state) {
  const nodeId = activeNodeId(state);
  if (typeof nodeId !== "string") return null;
  if (state?.currentTaskId !== null && state?.currentTaskId !== undefined) {
    if (nodeId === `${state.currentTaskId}-review`) return "task-review";
    if (nodeId === `${state.currentTaskId}-gate`) return "task-gate";
  }
  return nodeId;
}

function activeNodeForStep(state, step) {
  const nodeId = activeNodeId(state);
  if (step === "task-review" || step === "task-gate") return nodeId;
  return step;
}

function assertCanonical(state, flowManager) {
  if (state?.schemaRevision !== 3 || !state?.policy || typeof flowManager?.readActiveProducerArtifact !== "function"
    || typeof flowManager?.activityLedger !== "function" || typeof flowManager?.recordNonblocking !== "function"
    || typeof flowManager?.applyNonblockingDecision !== "function") {
    throw new Error("nonblocking requires the canonical Flow Version-1 runtime");
  }
}

function routeEvidence(step, source) {
  const route = nonblockingRouteFor(step);
  if (route.kind === "review") return fromReviewResult(source);
  if (route.kind === "gate") return fromGateResult(source);
  if (route.kind === "verification") return fromVerificationResult(source, step);
  if (route.kind === "acceptance") return fromAcceptanceResult(source);
  if (route.kind === "regression") return fromFinalRegressionResult(source);
  return null;
}

function evidenceFor(ctx, state, step) {
  const logicalKey = CANONICAL_EVIDENCE_KEYS[step];
  if (!logicalKey) throw new Error(`canonical nonblocking evidence is unavailable for ${step}`);
  const resolved = ctx.flowManager.readActiveProducerArtifact({
    specId: state.specId,
    logicalKey,
    nodeId: activeNodeForStep(state, step),
    parameters: step === "task-review" || step === "task-gate"
      ? { taskId: state.currentTaskId }
      : {},
  });
  const current = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey, bytes: resolved.bytes }).current;
  const source = `${JSON.stringify(current.payload, null, 2)}\n`;
  const found = routeEvidence(step, { ref: resolved.relativePath, source });
  return found === null ? null : Object.freeze({
    ...found,
    sourceAttempt: current.attempt,
    evidenceDigest: sha256(source),
  });
}

function recordsFor(ctx, state, step) {
  return ctx.flowManager.activityLedger(state.specId)
    .filter((activity) => activity.nodeId === activeNodeForStep(state, step) && activity.transition?.nonblocking !== null)
    .map((activity) => activity.transition.nonblocking);
}

function allowedActions(resultKind) {
  return resultKind === "quality" ? ["repair", "continue"] : ["retry", "continue"];
}

function continuation(state, actionId, instruction, reason, binding = null) {
  return new FlowContinuation({
    actionId,
    nextAction: guardedCommand("sennel flow get next-action", state, binding),
    instruction,
    reason,
  });
}

export class NonBlockingPolicy {
  constructor({ enabled = true, activatedAt = new Date().toISOString(), activatedStep, reason } = {}) {
    if (enabled !== true) throw new Error("nonblocking policy is one-way and must be enabled");
    this.enabled = true;
    this.activatedAt = text(activatedAt, "nonblocking activatedAt");
    this.activatedStep = assertStep(activatedStep);
    this.reason = text(reason, "nonblocking reason");
    Object.freeze(this);
  }

  static fromStored(value) { return value instanceof NonBlockingPolicy ? value : new NonBlockingPolicy(value); }
  toJSON() { return { enabled: true, activatedAt: this.activatedAt, activatedStep: this.activatedStep, reason: this.reason }; }
}

export class NonBlockingDecisionIdentity {
  constructor({ sourceStep, sourceAttempt, evidenceRef, evidenceDigest } = {}) {
    this.sourceStep = assertStep(sourceStep);
    if (!Number.isSafeInteger(sourceAttempt) || sourceAttempt < 1) throw new Error("sourceAttempt must be a positive integer");
    this.sourceAttempt = sourceAttempt;
    this.evidenceRef = text(evidenceRef, "evidenceRef");
    if (!/^[a-f0-9]{64}$/.test(evidenceDigest || "")) throw new Error("evidenceDigest must be SHA-256");
    this.evidenceDigest = evidenceDigest;
    Object.freeze(this);
  }

  equals(value) {
    const other = value instanceof NonBlockingDecisionIdentity ? value : new NonBlockingDecisionIdentity(value);
    return JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }

  toJSON() { return { sourceStep: this.sourceStep, sourceAttempt: this.sourceAttempt, evidenceRef: this.evidenceRef, evidenceDigest: this.evidenceDigest }; }
}

export class NonBlockingRecoveryState {
  constructor({ status = "fresh" } = {}) {
    if (status !== "fresh") throw new Error("canonical nonblocking recovery is represented by the current Attempt lifecycle");
    this.status = "fresh";
    Object.freeze(this);
  }
  toJSON() { return { status: this.status }; }
}

export class NonBlockingDecisionContext {
  constructor({ sourceStep, sourceAttempt, evidenceRef, evidenceDigest, taskId = null, resultKind, allowedActions: choices } = {}) {
    const identity = new NonBlockingDecisionIdentity({ sourceStep, sourceAttempt, evidenceRef, evidenceDigest });
    this.sourceStep = identity.sourceStep;
    this.sourceAttempt = identity.sourceAttempt;
    this.evidenceRef = identity.evidenceRef;
    this.evidenceDigest = identity.evidenceDigest;
    this.taskId = taskId;
    if (!RESULT_KINDS.includes(resultKind)) throw new Error("invalid nonblocking resultKind");
    this.resultKind = resultKind;
    if (!Array.isArray(choices) || choices.some((choice) => !ACTIONS.includes(choice))) throw new Error("invalid nonblocking allowedActions");
    this.allowedActions = Object.freeze([...choices]);
    this.recoveryState = new NonBlockingRecoveryState();
    Object.freeze(this);
  }

  identity() { return new NonBlockingDecisionIdentity(this); }
  toJSON() {
    return { ...this.identity().toJSON(), taskId: this.taskId, resultKind: this.resultKind,
      recoveryState: this.recoveryState.toJSON(), allowedActions: this.allowedActions };
  }
}

export class NonBlockingActivationOffer {
  constructor({ sourceStep, resultKind, blocker } = {}) {
    this.sourceStep = assertStep(sourceStep);
    this.resultKind = resultKind;
    this.blocker = text(blocker, "nonblocking activation blocker");
    this.prompt = new UserActionPrompt({
      question: "Strict recovery is exhausted for an eligible acceptance-backed check. Continue with advisory handling?",
      choices: [
        new UserActionChoice({ actionId: "KEEP_STRICT_FLOW", label: "Keep strict recovery", stateTransition: "retain-strict-flow-block", impact: new UserActionImpact({ retains: ["strict quality gate"] }), reason: this.blocker }),
        new UserActionChoice({ actionId: "ENABLE_NONBLOCKING", label: "Enable advisory continuation", stateTransition: "activate-nonblocking-policy", impact: new UserActionImpact({ changes: ["eligible non-pass handling with acceptance disposition"] }), reason: "Normal Flow ownership and finalization remain unchanged." }),
      ],
      recommendedActionId: "KEEP_STRICT_FLOW",
      recommendationReason: "Keeping strict recovery preserves the original quality gate unless advisory continuation is explicitly needed.",
    });
    Object.freeze(this);
  }
  toJSON() { return { sourceStep: this.sourceStep, resultKind: this.resultKind, blocker: this.blocker, actionPrompt: this.prompt.toJSON() }; }
}

export class NonBlockingDecisionConflictError extends Error {
  constructor(existing, state, binding = null) {
    super("a different nonblocking decision already exists for this evidence");
    this.code = "NONBLOCKING_DECISION_CONFLICT";
    this.existingDecision = existing.toJSON();
    this.continuation = continuation(state, "REFRESH_NONBLOCKING_DECISION", "Refresh the guarded next action before making another advisory decision.", "The evidence already has a durable advisory decision.", binding).toJSON();
  }
}

export class NonBlockingEvidenceError extends Error {
  constructor({ code, message, state, binding = null, continuation: showContinuation = true } = {}) {
    super(message);
    this.code = code;
    if (showContinuation) this.continuation = continuation(state, "RECOVER_NONBLOCKING_EVIDENCE", "Recover or regenerate the authoritative check evidence, then refresh the guarded next action.", message, binding).toJSON();
  }
}

function decisionContext(ctx, state, binding = null) {
  assertCanonical(state, ctx.flowManager);
  const step = assertStep(activeStep(state));
  const evidence = evidenceFor(ctx, state, step);
  if (!evidence) throw new NonBlockingEvidenceError({ code: "NONBLOCKING_NO_ELIGIBLE_EVIDENCE", message: `no eligible non-pass evidence is available for ${step}`, state, binding, continuation: false });
  const observation = recordsFor(ctx, state, step).find((record) => (
    record.kind === "observation" && record.sourceAttempt === evidence.sourceAttempt
    && record.evidenceRef === evidence.ref && record.evidenceDigest === evidence.evidenceDigest
  ));
  if (!observation) throw new NonBlockingEvidenceError({ code: "NONBLOCKING_EVIDENCE_NOT_RECORDED", message: `eligible evidence for ${step} has not been durably recorded`, state, binding });
  return new NonBlockingDecisionContext({
    sourceStep: step, sourceAttempt: evidence.sourceAttempt, evidenceRef: evidence.ref,
    evidenceDigest: evidence.evidenceDigest, taskId: state.currentTaskId ?? null,
    resultKind: evidence.resultKind, allowedActions: allowedActions(evidence.resultKind),
  });
}

export function decisionContextForActiveFlow(root, state, flowManager) {
  return decisionContext({ root, flowManager }, state);
}

export function nonblockingActivationOfferForStrictStop(root, state, directive, flowManager = null) {
  if (state?.policy?.nonblocking?.enabled === true || directive?.kind !== "blocked" || flowManager === null) return null;
  try {
    const step = assertStep(activeStep(state));
    const evidence = evidenceFor({ root, flowManager }, state, step);
    return evidence === null ? null : new NonBlockingActivationOffer({ sourceStep: step, resultKind: evidence.resultKind, blocker: directive.reason });
  } catch { return null; }
}

export function recordEligibleNonblockingAttempt(ctx, stepId, result = null) {
  const state = ctx?.flowState ?? ctx?.flowManager?.load?.();
  const record = deriveEligibleNonblockingObservation(ctx, stepId, state);
  if (record === null) return null;
  const step = record.sourceStep;
  const evidence = {
    sourceAttempt: record.sourceAttempt,
    ref: record.evidenceRef,
    evidenceDigest: record.evidenceDigest,
    resultKind: record.resultKind,
  };
  const existing = recordsFor(ctx, state, step).find((record) => (
    record.kind === "observation" && record.sourceAttempt === evidence.sourceAttempt
    && record.evidenceRef === evidence.ref && record.evidenceDigest === evidence.evidenceDigest
  ));
  if (existing) return existing;
  ctx.flowManager.recordNonblocking({ specId: state.specId, nodeId: activeNodeForStep(state, step), record });
  if (result && typeof result === "object") {
    result.stepAttempt = { runId: state.runId, taskId: state.currentTaskId ?? null, stepId: step,
      attempt: evidence.sourceAttempt, outcome: new ObservedNonPassOutcome({ sourceStep: step, evidenceRef: evidence.ref,
        evidenceDigest: evidence.evidenceDigest, resultKind: evidence.resultKind }).toJSON() };
  }
  return record;
}

/**
 * Build, but do not persist, the one advisory observation selected by a
 * Definition plan. The atomic plan boundary owns its eventual Activity.
 */
export function deriveEligibleNonblockingObservation(ctx, stepId, state = ctx?.flowState ?? ctx?.flowManager?.load?.()) {
  assertCanonical(state, ctx?.flowManager);
  const step = assertStep(stepId);
  if (state.policy.nonblocking?.enabled !== true || activeStep(state) !== step) return null;
  const evidence = evidenceFor(ctx, state, step);
  if (evidence === null) return null;
  return new ActivityNonBlockingRecord({
    kind: "observation",
    sourceStep: step,
    sourceAttempt: evidence.sourceAttempt,
    evidenceRef: evidence.ref,
    evidenceDigest: evidence.evidenceDigest,
    resultKind: evidence.resultKind,
    action: null,
    rationale: null,
    remainingRisk: null,
  });
}

export function activateNonBlockingPolicy({ root, flowManager, reason } = {}) {
  const state = flowManager.load();
  assertCanonical(state, flowManager);
  if (state.policy.nonblocking !== null) return state.policy.nonblocking;
  const step = assertStep(activeStep(state));
  const evidence = evidenceFor({ root, flowManager }, state, step);
  if (evidence === null) throw new Error(`nonblocking requires eligible non-pass evidence for ${step}`);
  const policy = new NonBlockingPolicy({ activatedStep: step, reason });
  const durable = flowManager.activateNonblockingPolicy({ specId: state.specId, policy: policy.toJSON() });
  recordEligibleNonblockingAttempt({ root, flowManager, flowState: flowManager.load() }, step);
  return durable;
}

export function recordNonBlockingDecision({ root, flowManager, choice, reason, expectEvidenceDigest, remainingRisk = null, binding = null } = {}) {
  const state = flowManager.load();
  assertCanonical(state, flowManager);
  if (state.policy.nonblocking?.enabled !== true) throw new Error("nonblocking policy is not enabled");
  // A completed continue leaves no active Attempt. Resolve an exact replay
  // from its immutable Activity before attempting to derive a new context.
  const prior = flowManager.activityLedger(state.specId)
    .map((activity) => activity.transition?.nonblocking)
    .find((record) => record?.kind === "decision" && record.evidenceDigest === expectEvidenceDigest);
  if (prior) {
    const existing = new NonBlockingDecisionOutcome({
      action: prior.action, sourceStep: prior.sourceStep, sourceAttempt: prior.sourceAttempt,
      evidenceRef: prior.evidenceRef, evidenceDigest: prior.evidenceDigest,
      rationale: prior.rationale, remainingRisk: prior.remainingRisk,
      nextAction: prior.action === "continue" ? nonblockingRouteFor(prior.sourceStep).continueAction : `run-${prior.sourceStep}`,
    });
    if (existing.action !== choice) throw new NonBlockingDecisionConflictError(existing, state, binding);
    return existing.toJSON();
  }
  const context = decisionContext({ root, flowManager }, state, binding);
  if (expectEvidenceDigest !== context.evidenceDigest) {
    const error = new Error("nonblocking evidence changed; refresh the guarded next action");
    error.code = "NONBLOCKING_STALE_EVIDENCE";
    error.continuation = continuation(state, "REFRESH_NONBLOCKING_EVIDENCE", "Refresh the guarded next action and use its latest evidence digest.", "The evidence digest changed before the advisory decision could be recorded.", binding).toJSON();
    throw error;
  }
  if (!context.allowedActions.includes(choice)) throw new Error(`nonblocking choice ${choice} is not allowed for ${context.resultKind} evidence`);
  const duplicate = recordsFor({ flowManager }, state, context.sourceStep).find((record) => (
    record.kind === "decision" && record.sourceAttempt === context.sourceAttempt
    && record.evidenceRef === context.evidenceRef && record.evidenceDigest === context.evidenceDigest
  ));
  if (duplicate) {
    const existing = new NonBlockingDecisionOutcome({ action: duplicate.action, ...context.identity().toJSON(), rationale: duplicate.rationale,
      remainingRisk: duplicate.remainingRisk, nextAction: duplicate.action === "continue" ? nonblockingRouteFor(context.sourceStep).continueAction : `run-${context.sourceStep}` });
    if (existing.action !== choice) throw new NonBlockingDecisionConflictError(existing, state, binding);
    return existing.toJSON();
  }
  const outcome = new NonBlockingDecisionOutcome({ action: choice, ...context.identity().toJSON(), rationale: text(reason, "reason"),
    remainingRisk: remainingRisk == null ? null : text(remainingRisk, "remainingRisk"),
    nextAction: choice === "continue" ? nonblockingRouteFor(context.sourceStep).continueAction : `run-${context.sourceStep}` });
  const record = { kind: "decision",
    sourceStep: context.sourceStep, sourceAttempt: context.sourceAttempt, evidenceRef: context.evidenceRef,
    evidenceDigest: context.evidenceDigest, resultKind: context.resultKind, action: outcome.action,
    rationale: outcome.rationale, remainingRisk: outcome.remainingRisk };
  flowManager.applyNonblockingDecision({
    specId: state.specId,
    nodeId: activeNodeForStep(state, context.sourceStep),
    sourceStep: context.sourceStep,
    record,
  });
  return outcome.toJSON();
}

export function reconcileNonblockingAcceptanceContinuation() { return false; }

export function advisorySummary(state, flowManager = null) {
  if (state?.schemaRevision !== 3 || typeof state?.specId !== "string") return [];
  if (Array.isArray(state.advisorySummary)) return state.advisorySummary;
  if (typeof flowManager?.activityLedger !== "function") return [];
  return projectAdvisorySummary(flowManager.activityLedger(state.specId));
}
