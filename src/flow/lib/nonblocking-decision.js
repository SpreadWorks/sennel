import { completeAcceptedNonblockingDecision } from "../engine/composition/nonblocking-implementation.js";
import { hasAcceptanceStepContract, hasImplementationStepContract } from "../engine/step-result.js";
import {
  activeNonblockingNodeForStep,
  activeNonblockingStep,
  assertCanonicalNonblockingFlow,
  decisionContextForActiveFlow,
  definitionNonblockingEligibilityForActiveFlow,
  NonBlockingDecisionConflictError,
  NonBlockingDecisionIdentity,
  NonBlockingEvidenceError,
  nonblockingContinuation,
  normalizeNonblockingText,
  readNonblockingActivitiesForActiveFlow,
} from "./nonblocking.js";
import { nonblockingRouteFor } from "./nonblocking-route.js";
import { NonBlockingDecisionOutcome } from "./step-outcome.js";

/** Apply the decision through its registered Step or the canonical Store. */
export function applyNonblockingDecision(flowManager, input) {
  if (input.record.action === "continue"
    && (hasImplementationStepContract(input.record.sourceStep)
      || hasAcceptanceStepContract(input.record.sourceStep))) {
    return completeAcceptedNonblockingDecision(flowManager, input).record;
  }
  return flowManager.applyNonblockingDecision(input);
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
  assertCanonicalNonblockingFlow(state, flowManager);
  if (state.policy.nonblocking?.enabled !== true) throw new Error("nonblocking policy is not enabled");
  const expected = expectIdentity === null ? null : new NonBlockingDecisionIdentity(expectIdentity);
  if (expected !== null && expected.evidenceDigest !== expectEvidenceDigest) {
    throw new Error("nonblocking expected identity and evidence digest disagree");
  }
  const requestedReason = normalizeNonblockingText(reason, "reason");
  const requestedRisk = remainingRisk == null ? null : normalizeNonblockingText(remainingRisk, "remainingRisk");
  if (choice === "continue" && requestedRisk === null) {
    throw new Error("nonblocking continue requires a concrete remainingRisk");
  }
  const decisionActivities = readNonblockingActivitiesForActiveFlow(flowManager, state)
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
  const step = activeNonblockingStep(state);
  const currentAttempt = typeof flowManager.canonicalState === "function"
    ? flowManager.canonicalState(state.specId).attempt
    : null;
  const hasCurrentObservation = step !== null && currentAttempt !== null
    ? readNonblockingActivitiesForActiveFlow(flowManager, state, step).some(({ transition: { nonblocking: record } }) => (
      record.kind === "observation" && record.sourceAttempt === currentAttempt.sequence
    ))
    : true;
  if (step !== null && nonblockingRouteFor(step) !== null && hasCurrentObservation) {
    try {
      context = decisionContextForActiveFlow(root, state, flowManager, binding);
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
  if (context === null) context = decisionContextForActiveFlow(root, state, flowManager, binding);
  if (expected !== null && !context.identity().equals(expected)) {
    const error = new Error("nonblocking decision identity changed; refresh the guarded next action");
    error.code = "NONBLOCKING_STALE_EVIDENCE";
    throw error;
  }
  if (expectEvidenceDigest !== context.evidenceDigest) {
    const error = new Error("nonblocking evidence changed; refresh the guarded next action");
    error.code = "NONBLOCKING_STALE_EVIDENCE";
    error.continuation = nonblockingContinuation(state, "REFRESH_NONBLOCKING_EVIDENCE", "Refresh the guarded next action and use its latest evidence digest.", "The evidence digest changed before the advisory decision could be recorded.", binding).toJSON();
    throw error;
  }
  if (!context.allowedActions.includes(choice)) throw new Error(`nonblocking choice ${choice} is not allowed for ${context.resultKind} evidence`);
  const duplicate = readNonblockingActivitiesForActiveFlow(flowManager, state, context.sourceStep)
    .map((activity) => activity.transition.nonblocking).find((record) => (
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
      applyNonblockingDecision(flowManager, {
        specId: state.specId,
        nodeId: activeNonblockingNodeForStep(state, context.sourceStep),
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
  applyNonblockingDecision(flowManager, {
    specId: state.specId,
    nodeId: activeNonblockingNodeForStep(state, context.sourceStep),
    record,
    eligibility,
  });
  return outcome.toJSON();
}
