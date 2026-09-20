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
  NonblockingEvidenceClassificationError,
  NonblockingFailureClassification,
} from "./nonblocking-evidence.js";
import { nonblockingRouteFor } from "./nonblocking-route.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { ActivityNonBlockingRecord } from "./current-flow-state.js";
import {
  DefinitionNonblockingEligibility,
  resolveActiveNonblockingEligibility,
} from "../definition.js";
import { readCurrentGateTransitionFacts } from "./gate-transition-facts.js";
import { readCurrentTestChainTransitionFacts } from "./test-chain-transition-facts.js";
import {
  captureFinalRegressionChangedSnapshotDigest,
  readFinalRegressionTransitionFacts,
} from "./final-regression-transition-facts.js";
import { ReviewTransitionFacts } from "./review-transition-facts.js";
import { CanonicalTestArtifactStore } from "./canonical-test-artifacts.js";

const MAX_TEXT = 2_000;
const ACTIONS = Object.freeze(["repair", "retry", "continue"]);
const RESULT_KINDS = Object.freeze(["quality", "tooling", "unavailable"]);
const CANONICAL_EVIDENCE_KEYS = Object.freeze({
  "draft-gate": "draft.gate",
  "spec-gate": "spec.gate",
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

function routeEvidence(step, source, classification = null) {
  const route = nonblockingRouteFor(step);
  if (route.kind === "review") return fromReviewResult(source);
  if (route.kind === "gate") return fromGateResult(source);
  if (route.kind === "verification") return fromVerificationResult(source, step, classification);
  if (route.kind === "acceptance") return fromAcceptanceResult(source);
  if (route.kind === "regression") return fromFinalRegressionResult(source, classification);
  return null;
}

function evidenceFor(ctx, state, step, resultKind = null) {
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
  const classification = resultKind === null ? null : new NonblockingFailureClassification({ resultKind });
  const found = routeEvidence(step, { ref: resolved.relativePath, source }, classification);
  return found === null ? null : Object.freeze({
    ...found,
    sourceAttempt: current.attempt,
    evidenceDigest: sha256(source),
  });
}

function recordsFor(ctx, state, step) {
  return ctx.flowManager.activityLedger(state.specId)
    .filter((activity) => activity.transition?.nonblocking?.sourceStep === step)
    .map((activity) => activity.transition.nonblocking);
}

class CanonicalNonblockingFactsReader {
  constructor({ root, flowManager, flowState } = {}) {
    this.root = root;
    this.flowManager = flowManager;
    this.flowState = flowState;
    Object.freeze(this);
  }

  gateFacts(route) {
    return readCurrentGateTransitionFacts({
      flowManager: this.flowManager,
      flowState: this.flowState,
      phase: route.phase,
    });
  }

  reviewFacts(route) {
    if (route.phase === null || route.phase === "spec") return null;
    return ReviewTransitionFacts.forCurrentAttempt({
      flowManager: this.flowManager,
      flowState: this.flowState,
      scope: route.taskScoped ? "task" : "flow",
      phase: route.phase,
    });
  }

  testChainFacts() {
    return readCurrentTestChainTransitionFacts({
      flowManager: this.flowManager,
      specId: this.flowState.specId,
    });
  }

  finalRegressionFacts() {
    const store = new CanonicalTestArtifactStore({
      flowManager: this.flowManager,
      state: this.flowManager.canonicalState(this.flowState.specId),
    });
    return readFinalRegressionTransitionFacts({
      flowManager: this.flowManager,
      specId: this.flowState.specId,
      changedFileSnapshotDigest: () => captureFinalRegressionChangedSnapshotDigest({
        root: this.root,
        relativeSpecFile: store.location.relativeSpecFile,
      }),
    });
  }
}

export function definitionNonblockingEligibilityForActiveFlow(root, state, flowManager) {
  assertCanonical(state, flowManager);
  const step = activeStep(state);
  if (step === null || nonblockingRouteFor(step) === null) return null;
  let evidence;
  try {
    evidence = evidenceFor({ root, flowManager }, state, step);
  } catch (error) {
    if (/absent from catalog|no active producer artifact/.test(error.message)) return null;
    if (state.policy?.nonblocking?.enabled !== true
      && error instanceof NonblockingEvidenceClassificationError) return null;
    throw error;
  }
  if (evidence === null) return null;
  const strictState = state.policy?.nonblocking?.enabled === true
    ? { ...state, policy: { ...state.policy, nonblocking: null } }
    : state;
  try {
    return resolveActiveNonblockingEligibility({
      sourceStep: step,
      evidence,
      flowState: strictState,
      reader: new CanonicalNonblockingFactsReader({ root, flowManager, flowState: strictState }),
    });
  } catch (error) {
    if (state.policy?.nonblocking?.enabled !== true
      && error?.code === "CANONICAL_TEST_SOURCE_REVISION_UNAVAILABLE") return null;
    throw error;
  }
}

/** Re-read and validate the complete current advisory identity at a mutation boundary. */
export function validateNonblockingRecordForActiveFlow(root, state, flowManager, record) {
  assertCanonical(state, flowManager);
  const fact = record instanceof ActivityNonBlockingRecord
    ? record
    : new ActivityNonBlockingRecord(record);
  const step = assertStep(activeStep(state));
  const eligibility = definitionNonblockingEligibilityForActiveFlow(root, state, flowManager);
  const evidence = eligibility === null
    ? null
    : evidenceFor({ root, flowManager }, state, step, eligibility.resultKind);
  if (evidence === null
    || eligibility === null
    || fact.sourceStep !== step
    || fact.sourceStep !== eligibility.sourceStep
    || fact.sourceAttempt !== evidence.sourceAttempt
    || fact.evidenceRef !== evidence.ref
    || fact.evidenceDigest !== evidence.evidenceDigest
    || fact.resultKind !== evidence.resultKind
    || fact.resultKind !== eligibility.resultKind
    || fact.definitionDigest !== eligibility.definitionDigest) {
    throw new NonBlockingEvidenceError({
      code: "NONBLOCKING_STALE_EVIDENCE",
      message: "nonblocking mutation does not match the current Definition-selected evidence identity",
      state,
      continuation: false,
    });
  }
  return eligibility;
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
  constructor({
    sourceStep,
    sourceAttempt,
    evidenceRef,
    evidenceDigest,
    taskId = null,
    resultKind,
    allowedActions: choices,
    continueTargetStepId,
    skippedStepIds = [],
    acceptancePublication,
    definitionDigest,
  } = {}) {
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
    this.continueTargetStepId = text(continueTargetStepId, "nonblocking continuation target Step");
    if (!Array.isArray(skippedStepIds) || skippedStepIds.some((stepId) => typeof stepId !== "string" || stepId === "")) {
      throw new Error("invalid nonblocking skipped Step ids");
    }
    this.skippedStepIds = Object.freeze([...skippedStepIds]);
    if (!["semantic-findings", "nonblocking-handoff"].includes(acceptancePublication)) {
      throw new Error("invalid nonblocking acceptance publication");
    }
    this.acceptancePublication = acceptancePublication;
    if (!/^[a-f0-9]{64}$/.test(definitionDigest || "")) throw new Error("invalid nonblocking Definition digest");
    this.definitionDigest = definitionDigest;
    this.recoveryState = new NonBlockingRecoveryState();
    Object.freeze(this);
  }

  identity() { return new NonBlockingDecisionIdentity(this); }
  equals(value) {
    const other = NonBlockingDecisionContext.fromStored(value);
    return JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }
  static fromStored(value) {
    return value instanceof NonBlockingDecisionContext ? value : new NonBlockingDecisionContext(value);
  }
  toJSON() {
    return { ...this.identity().toJSON(), taskId: this.taskId, resultKind: this.resultKind,
      recoveryState: this.recoveryState.toJSON(), allowedActions: this.allowedActions,
      continueTargetStepId: this.continueTargetStepId,
      skippedStepIds: this.skippedStepIds,
      acceptancePublication: this.acceptancePublication,
      definitionDigest: this.definitionDigest };
  }
}

export class NonBlockingActivationOffer {
  constructor({ sourceStep, resultKind, blocker, state, binding = null } = {}) {
    this.sourceStep = assertStep(sourceStep);
    this.resultKind = resultKind;
    this.blocker = text(blocker, "nonblocking activation blocker");
    this.prompt = new UserActionPrompt({
      question: "Strict recovery is exhausted for an eligible acceptance-backed check. Continue with advisory handling?",
      choices: [
        new UserActionChoice({ actionId: "KEEP_STRICT_FLOW", label: "Keep strict recovery", stateTransition: "retain-strict-flow-block", impact: new UserActionImpact({ retains: ["strict quality gate"] }), reason: this.blocker }),
        new UserActionChoice({
          actionId: "ENABLE_NONBLOCKING",
          label: "Enable advisory continuation",
          nextAction: guardedCommand(
            `sennel flow set policy nonblocking --reason "${this.blocker.replaceAll('"', "'")}"`,
            state,
            binding,
          ),
          impact: new UserActionImpact({ changes: ["eligible non-pass handling with acceptance disposition"] }),
          reason: "Normal Flow ownership and finalization remain unchanged.",
        }),
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
  const eligibility = definitionNonblockingEligibilityForActiveFlow(ctx.root, state, ctx.flowManager);
  const evidence = eligibility === null ? null : evidenceFor(ctx, state, step, eligibility.resultKind);
  if (!evidence) throw new NonBlockingEvidenceError({ code: "NONBLOCKING_NO_ELIGIBLE_EVIDENCE", message: `no eligible non-pass evidence is available for ${step}`, state, binding, continuation: false });
  const observation = recordsFor(ctx, state, step).find((record) => (
    record.kind === "observation" && record.sourceAttempt === evidence.sourceAttempt
    && record.evidenceRef === evidence.ref && record.evidenceDigest === evidence.evidenceDigest
  ));
  if (!observation) throw new NonBlockingEvidenceError({ code: "NONBLOCKING_EVIDENCE_NOT_RECORDED", message: `eligible evidence for ${step} has not been durably recorded`, state, binding });
  if (eligibility === null
    || eligibility.sourceStep !== step
    || eligibility.resultKind !== evidence.resultKind
    || observation.definitionDigest !== eligibility.definitionDigest) {
    throw new NonBlockingEvidenceError({
      code: "NONBLOCKING_STALE_DEFINITION",
      message: `strict recovery facts changed before the nonblocking decision for ${step}`,
      state,
      binding,
    });
  }
  return new NonBlockingDecisionContext({
    sourceStep: step, sourceAttempt: evidence.sourceAttempt, evidenceRef: evidence.ref,
    evidenceDigest: evidence.evidenceDigest, taskId: state.currentTaskId ?? null,
    resultKind: evidence.resultKind,
    allowedActions: eligibility.allowedActions,
    continueTargetStepId: eligibility.continueTargetStepId,
    skippedStepIds: eligibility.skippedStepIds,
    acceptancePublication: eligibility.acceptancePublication,
    definitionDigest: eligibility.definitionDigest,
  });
}

export function decisionContextForActiveFlow(root, state, flowManager) {
  return decisionContext({ root, flowManager }, state);
}

/** Return the exact catalog bytes already bound into a projected context. */
export function decisionEvidenceForActiveFlow(root, state, flowManager, expectedContext) {
  const context = NonBlockingDecisionContext.fromStored(expectedContext);
  const current = decisionContext({ root, flowManager }, state);
  if (!current.equals(context)) {
    throw new NonBlockingEvidenceError({
      code: "NONBLOCKING_STALE_EVIDENCE",
      message: "nonblocking evidence changed before the agent decision",
      state,
    });
  }
  const evidence = evidenceFor({ root, flowManager }, state, context.sourceStep, context.resultKind);
  return evidence.source;
}

export function nonblockingActivationOfferForStrictStop({ state, eligibility, binding = null } = {}) {
  if (state?.policy?.nonblocking?.enabled === true || !(eligibility instanceof DefinitionNonblockingEligibility)) return null;
  return new NonBlockingActivationOffer({
    sourceStep: eligibility.sourceStep,
    resultKind: eligibility.resultKind,
    blocker: eligibility.blocker,
    state,
    binding,
  });
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
  const eligibility = definitionNonblockingEligibilityForActiveFlow(ctx.root, state, ctx.flowManager);
  const evidence = eligibility === null ? null : evidenceFor(ctx, state, step, eligibility.resultKind);
  if (evidence === null) return null;
  if (eligibility === null
    || eligibility.sourceStep !== step
    || eligibility.resultKind !== evidence.resultKind) return null;
  return new ActivityNonBlockingRecord({
    kind: "observation",
    sourceStep: step,
    sourceAttempt: evidence.sourceAttempt,
    evidenceRef: evidence.ref,
    evidenceDigest: evidence.evidenceDigest,
    definitionDigest: eligibility.definitionDigest,
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
  const observedEvidence = evidenceFor({ root, flowManager }, state, step);
  if (observedEvidence === null) throw new Error(`nonblocking requires eligible non-pass evidence for ${step}`);
  const eligibility = definitionNonblockingEligibilityForActiveFlow(root, state, flowManager);
  if (eligibility === null) {
    const error = new Error("nonblocking activation is not selected by the current Definition strict stop");
    error.code = "NONBLOCKING_NOT_DEFINITION_ELIGIBLE";
    throw error;
  }
  const evidence = eligibility === null
    ? null
    : evidenceFor({ root, flowManager }, state, step, eligibility.resultKind);
  if (evidence === null) throw new Error(`nonblocking requires eligible non-pass evidence for ${step}`);
  if (eligibility === null
    || eligibility.sourceStep !== step
    || eligibility.resultKind !== evidence.resultKind) {
    const error = new Error("nonblocking activation is not selected by the current Definition strict stop");
    error.code = "NONBLOCKING_NOT_DEFINITION_ELIGIBLE";
    throw error;
  }
  const policy = new NonBlockingPolicy({ activatedStep: step, reason });
  const observation = new ActivityNonBlockingRecord({
    kind: "observation",
    sourceStep: step,
    sourceAttempt: evidence.sourceAttempt,
    evidenceRef: evidence.ref,
    evidenceDigest: evidence.evidenceDigest,
    definitionDigest: eligibility.definitionDigest,
    resultKind: evidence.resultKind,
    action: null,
    rationale: null,
    remainingRisk: null,
  });
  const durable = flowManager.activateNonblockingPolicy({
    specId: state.specId,
    policy: policy.toJSON(),
    observation,
    eligibility,
  });
  return durable;
}

export function recordNonBlockingDecision({
  root,
  flowManager,
  choice,
  reason,
  expectEvidenceDigest,
  expectIdentity = null,
  remainingRisk = null,
  binding = null,
} = {}) {
  const state = flowManager.load();
  assertCanonical(state, flowManager);
  if (state.policy.nonblocking?.enabled !== true) throw new Error("nonblocking policy is not enabled");
  const expected = expectIdentity === null ? null : new NonBlockingDecisionIdentity(expectIdentity);
  if (expected !== null && expected.evidenceDigest !== expectEvidenceDigest) {
    throw new Error("nonblocking expected identity and evidence digest disagree");
  }
  const requestedReason = text(reason, "reason");
  const requestedRisk = remainingRisk == null ? null : text(remainingRisk, "remainingRisk");
  if (choice === "continue" && requestedRisk === null) {
    throw new Error("nonblocking continue requires a concrete remainingRisk");
  }
  const decisionActivities = flowManager.activityLedger(state.specId)
    .filter((activity) => activity.transition?.nonblocking?.kind === "decision");
  const ledgerDecisions = decisionActivities.map((activity) => activity.transition.nonblocking);
  const replayOutcome = (prior) => {
    const existing = new NonBlockingDecisionOutcome({
      action: prior.action, sourceStep: prior.sourceStep, sourceAttempt: prior.sourceAttempt,
      evidenceRef: prior.evidenceRef, evidenceDigest: prior.evidenceDigest,
      rationale: prior.rationale, remainingRisk: prior.remainingRisk,
      nextAction: prior.action === "continue" ? "refresh-next-action" : `run-${prior.sourceStep}`,
    });
    if (existing.action !== choice
      || existing.rationale !== requestedReason
      || existing.remainingRisk !== requestedRisk) {
      throw new NonBlockingDecisionConflictError(existing, state, binding);
    }
    return existing.toJSON();
  };
  // A guarded caller supplies the complete identity. Equal bytes at another
  // Step or Attempt can never select this replay.
  const exactPriorActivity = expected === null
    ? null
    : decisionActivities.find((activity) => expected.equals(activity.transition.nonblocking)) ?? null;
  const exactPrior = exactPriorActivity?.transition.nonblocking ?? null;
  if (exactPriorActivity !== null && state.confirmationOrder >= exactPriorActivity.confirmationOrder) {
    return replayOutcome(exactPrior);
  }

  let context = null;
  const step = activeStep(state);
  const currentAttempt = typeof flowManager.canonicalState === "function"
    ? flowManager.canonicalState(state.specId).attempt
    : null;
  const hasCurrentObservation = step !== null && currentAttempt !== null
    ? recordsFor({ flowManager }, state, step).some((record) => (
      record.kind === "observation" && record.sourceAttempt === currentAttempt.sequence
    ))
    : true;
  if (step !== null && nonblockingRouteFor(step) !== null && hasCurrentObservation) {
    try {
      context = decisionContext({ root, flowManager }, state, binding);
    } catch (error) {
      if (!(error instanceof NonBlockingEvidenceError)
        || !["NONBLOCKING_NO_ELIGIBLE_EVIDENCE", "NONBLOCKING_EVIDENCE_NOT_RECORDED"].includes(error.code)) {
        throw error;
      }
    }
  }
  // CLI replay can arrive after continuation has moved beyond the source.
  // A digest is accepted only when it resolves to one immutable identity.
  if (context === null && expected === null) {
    const candidates = ledgerDecisions.filter((record) => record.evidenceDigest === expectEvidenceDigest);
    const identities = new Map(candidates.map((record) => [
      JSON.stringify(new NonBlockingDecisionIdentity(record).toJSON()),
      record,
    ]));
    if (identities.size === 1) return replayOutcome([...identities.values()][0]);
    if (identities.size > 1) {
      const error = new Error("nonblocking evidence digest identifies multiple decisions; refresh with the full decision identity");
      error.code = "NONBLOCKING_AMBIGUOUS_REPLAY";
      throw error;
    }
  }
  if (context === null && exactPrior !== null) return replayOutcome(exactPrior);
  if (context === null) context = decisionContext({ root, flowManager }, state, binding);
  if (expected !== null && !context.identity().equals(expected)) {
    const error = new Error("nonblocking decision identity changed; refresh the guarded next action");
    error.code = "NONBLOCKING_STALE_EVIDENCE";
    throw error;
  }
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
    const activity = decisionActivities.find((entry) => context.identity().equals(entry.transition.nonblocking));
    if (activity !== undefined && state.confirmationOrder < activity.confirmationOrder) {
      const eligibility = definitionNonblockingEligibilityForActiveFlow(root, state, flowManager);
      if (eligibility === null) {
        throw new NonBlockingEvidenceError({
          code: "NONBLOCKING_STALE_DEFINITION",
          message: "strict recovery facts changed before the nonblocking decision could settle",
          state,
          binding,
        });
      }
      if (duplicate.definitionDigest !== eligibility.definitionDigest) {
        throw new NonBlockingEvidenceError({
          code: "NONBLOCKING_STALE_DEFINITION",
          message: "strict recovery facts changed before the nonblocking decision could settle",
          state,
          binding,
        });
      }
      flowManager.applyNonblockingDecision({
        specId: state.specId,
        nodeId: activeNodeForStep(state, context.sourceStep),
        record: duplicate,
        eligibility,
      });
    }
    return replayOutcome(duplicate);
  }
  const eligibility = definitionNonblockingEligibilityForActiveFlow(root, state, flowManager);
  if (eligibility === null) {
    throw new NonBlockingEvidenceError({
      code: "NONBLOCKING_STALE_DEFINITION",
      message: "strict recovery facts changed before the nonblocking decision",
      state,
      binding,
    });
  }
  const effect = eligibility.effectFor(choice);
  const outcome = new NonBlockingDecisionOutcome({ action: choice, ...context.identity().toJSON(), rationale: requestedReason,
    remainingRisk: requestedRisk,
    nextAction: effect.nextAction });
  const record = { kind: "decision",
    sourceStep: context.sourceStep, sourceAttempt: context.sourceAttempt, evidenceRef: context.evidenceRef,
    evidenceDigest: context.evidenceDigest, resultKind: context.resultKind, action: outcome.action,
    definitionDigest: context.definitionDigest,
    rationale: outcome.rationale, remainingRisk: outcome.remainingRisk };
  flowManager.applyNonblockingDecision({
    specId: state.specId,
    nodeId: activeNodeForStep(state, context.sourceStep),
    record,
    eligibility,
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
