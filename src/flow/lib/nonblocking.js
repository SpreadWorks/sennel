import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
import { projectAdvisorySummary } from "./advisory-summary.js";
/** Canonical Version-1 advisory handling. */

import crypto from "node:crypto";
import {
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
import { ActivityNonBlockingRecord } from "./current-flow-state.js";
import {
  DefinitionNonblockingEligibility,
  resolveActiveNonblockingEligibility,
  specGateNonblockingEligibilityForResult,
  implementationNonblockingEligibilityForResult,
} from "../definition.js";
import { readCurrentGateTransitionFacts } from "./gate-transition-facts.js";
import { resolveGateNextAction } from "./gate-transition-application.js";
import { readCurrentTestChainTransitionFacts } from "./test-chain-transition-facts.js";
import {
  captureFinalRegressionChangedSnapshotDigest,
  readFinalRegressionTransitionFacts,
} from "./final-regression-transition-facts.js";
import { ReviewTransitionFacts } from "./review-transition-facts.js";
import { TaskStepIdentity } from "./task-step-identity.js";
import { CanonicalTestArtifactStore } from "./canonical-test-artifacts.js";

const MAX_TEXT = 2_000;
const ACTIONS = Object.freeze(["repair", "retry", "continue"]);
const RESULT_KINDS = Object.freeze(["quality", "tooling", "unavailable"]);
const CANONICAL_EVIDENCE_KEYS = Object.freeze({
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

export function normalizeNonblockingText(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > MAX_TEXT) {
    throw new Error(`${field} must be a non-empty string no longer than ${MAX_TEXT} characters`);
  }
  return value.trim();
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function assertStep(value) {
  const step = normalizeNonblockingText(value, "nonblocking step");
  if (!NONBLOCKING_SOURCE_STEPS.includes(step)) throw new Error(`nonblocking is not supported for step: ${step}`);
  return step;
}

function activeNodeId(state) { return state?.currentNodeId ?? null; }

/** Translate a materialized Task leaf back to its definition-owned advisory route. */
export function activeNonblockingStep(state) {
  const nodeId = activeNodeId(state);
  if (typeof nodeId !== "string") return null;
  const identity = TaskStepIdentity.fromStateNode(state, nodeId);
  return identity?.definitionId ?? nodeId;
}

export function activeNonblockingNodeForStep(state, step) {
  const nodeId = activeNodeId(state);
  if (step === "task-review" || step === "task-gate") return nodeId;
  return step;
}

export function assertCanonicalNonblockingFlow(state, flowManager) {
  if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || !state?.policy || typeof flowManager?.readActiveProducerArtifact !== "function"
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
    nodeId: activeNonblockingNodeForStep(state, step),
    parameters: step === "task-review" || step === "task-gate"
      ? { taskId: state.currentTaskId }
      : {},
  });
  const source = `${JSON.stringify(resolved.observation.payload, null, 2)}\n`;
  const classification = resultKind === null ? null : new NonblockingFailureClassification({ resultKind });
  const found = routeEvidence(step, { ref: resolved.relativePath, source }, classification);
  return found === null ? null : Object.freeze({
    ...found,
    sourceAttempt: resolved.observation.sourceAttempt,
    evidenceDigest: sha256(source),
  });
}

export function readNonblockingActivitiesForActiveFlow(flowManager, state, step = null) {
  return flowManager.activityLedger(state.specId)
    .filter((activity) => activity.transition?.nonblocking != null
      && (step === null || activity.transition.nonblocking.sourceStep === step));
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
        repositoryRoot: store.location.repositoryRoot,
        specId: this.flowState.specId, runId: this.flowState.runId,
        root: this.root,
        relativeSpecFile: store.location.relativeSpecFile,
      }),
    });
  }
}

export function definitionNonblockingEligibilityForActiveFlow(root, state, flowManager) {
  assertCanonicalNonblockingFlow(state, flowManager);
  const step = activeNonblockingStep(state);
  if (step === null || nonblockingRouteFor(step) === null) return null;
  if (step === "task-gate" || step === "impl-gate") {
    const selected = resolveGateNextAction({ flowManager, flowState: state,
      phase: nonblockingRouteFor(step).phase, root });
    return selected === null ? null : implementationNonblockingEligibilityForResult(selected.result);
  }
  if (["impl-review", "task-review", "test-result-review", "spec-gate", "retro"].includes(step)) {
    const saved = flowManager.readCurrentStepSettlement({ specId: state.specId, stepId: step });
    if (saved === null) return null;
    return step === "spec-gate"
      ? specGateNonblockingEligibilityForResult(saved.result)
      : implementationNonblockingEligibilityForResult(saved.result);
  }
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
  assertCanonicalNonblockingFlow(state, flowManager);
  const fact = record instanceof ActivityNonBlockingRecord
    ? record
    : new ActivityNonBlockingRecord(record);
  const step = assertStep(activeNonblockingStep(state));
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

export function nonblockingContinuation(state, actionId, instruction, reason, binding = null) {
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
    this.activatedAt = normalizeNonblockingText(activatedAt, "nonblocking activatedAt");
    this.activatedStep = assertStep(activatedStep);
    this.reason = normalizeNonblockingText(reason, "nonblocking reason");
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
    this.evidenceRef = normalizeNonblockingText(evidenceRef, "evidenceRef");
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
    this.continueTargetStepId = normalizeNonblockingText(continueTargetStepId, "nonblocking continuation target Step");
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
  constructor({ sourceStep, resultKind, blocker, strictStopKind, state, binding = null } = {}) {
    this.sourceStep = assertStep(sourceStep);
    this.resultKind = resultKind;
    this.blocker = normalizeNonblockingText(blocker, "nonblocking activation blocker");
    this.strictStopKind = strictStopKind;
    this.activationCommand = guardedCommand(
      `sennel flow set policy nonblocking --reason "${this.blocker.replaceAll('"', "'")}"`,
      state,
      binding,
    );
    this.prompt = new UserActionPrompt({
      question: "Strict recovery is exhausted for an eligible acceptance-backed check. Continue with advisory handling?",
      choices: [
        new UserActionChoice({ actionId: "KEEP_STRICT_FLOW", label: "Keep strict recovery", stateTransition: "retain-strict-flow-block", impact: new UserActionImpact({ retains: ["strict quality gate"] }), reason: this.blocker }),
        new UserActionChoice({
          actionId: "ENABLE_NONBLOCKING",
          label: "Enable advisory continuation",
          nextAction: this.activationCommand,
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
    this.continuation = nonblockingContinuation(state, "REFRESH_NONBLOCKING_DECISION", "Refresh the guarded next action before making another advisory decision.", "The evidence already has a durable advisory decision.", binding).toJSON();
  }
}

export class NonBlockingEvidenceError extends Error {
  constructor({ code, message, state, binding = null, continuation: showContinuation = true } = {}) {
    super(message);
    this.code = code;
    if (showContinuation) this.continuation = nonblockingContinuation(state, "RECOVER_NONBLOCKING_EVIDENCE", "Recover or regenerate the authoritative check evidence, then refresh the guarded next action.", message, binding).toJSON();
  }
}

function decisionContext(ctx, state, binding = null) {
  assertCanonicalNonblockingFlow(state, ctx.flowManager);
  const step = assertStep(activeNonblockingStep(state));
  const eligibility = definitionNonblockingEligibilityForActiveFlow(ctx.root, state, ctx.flowManager);
  const evidence = eligibility === null ? null : evidenceFor(ctx, state, step, eligibility.resultKind);
  if (!evidence) throw new NonBlockingEvidenceError({ code: "NONBLOCKING_NO_ELIGIBLE_EVIDENCE", message: `no eligible non-pass evidence is available for ${step}`, state, binding, continuation: false });
  const observation = readNonblockingActivitiesForActiveFlow(ctx.flowManager, state, step)
    .map((activity) => activity.transition.nonblocking).find((record) => (
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

export function decisionContextForActiveFlow(root, state, flowManager, binding = null) {
  return decisionContext({ root, flowManager }, state, binding);
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
    strictStopKind: eligibility.strictStopKind,
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
  const existing = readNonblockingActivitiesForActiveFlow(ctx.flowManager, state, step)
    .map((activity) => activity.transition.nonblocking).find((record) => (
    record.kind === "observation" && record.sourceAttempt === evidence.sourceAttempt
    && record.evidenceRef === evidence.ref && record.evidenceDigest === evidence.evidenceDigest
  ));
  if (existing) return existing;
  ctx.flowManager.recordNonblocking({ specId: state.specId, nodeId: activeNonblockingNodeForStep(state, step), record });
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
  assertCanonicalNonblockingFlow(state, ctx?.flowManager);
  const step = assertStep(stepId);
  if (state.policy.nonblocking?.enabled !== true || activeNonblockingStep(state) !== step) return null;
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
  assertCanonicalNonblockingFlow(state, flowManager);
  if (state.policy.nonblocking !== null) return state.policy.nonblocking;
  const step = assertStep(activeNonblockingStep(state));
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

export function reconcileNonblockingAcceptanceContinuation() { return false; }

export function advisorySummary(state, flowManager = null) {
  if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof state?.specId !== "string") return [];
  if (Array.isArray(state.advisorySummary)) return state.advisorySummary;
  if (typeof flowManager?.activityLedger !== "function") return [];
  return projectAdvisorySummary(flowManager.activityLedger(state.specId));
}
