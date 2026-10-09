/** Apply a sealed final-regression Definition plan to the canonical store. */
import { applyNonGateTransitionDecision } from "./non-gate-transition-application.js";
import { attachedCanonicalCommandResultArtifact } from "./canonical-command-result.js";
import { FinalRegressionArtifactDigest } from "./final-regression-transition.js";
class FinalRegressionTransitionPersistenceAdapter {
  constructor({ flowManager, specId } = {}) {
    if (flowManager === null || typeof flowManager !== "object") {
      throw new Error("final-regression transition application requires FlowManager");
    }
    if (typeof specId !== "string" || specId.length === 0) {
      throw new Error("final-regression transition application requires specId");
    }
    this.flowManager = flowManager;
    this.specId = specId;
  }

  setStepStatus(update, plan) {
    const operation = plan.action.identity.operation;
    if (operation === "advance") {
      return this.flowManager.updateStepStatus({
        stepId: update.stepId,
        requestedStatus: update.status,
      }, { specId: this.specId });
    }
    // Repair, user-decision and blocked dispositions retain the immutable
    // failed Attempt until their separately admitted transition is applied.
    return null;
  }

  failCurrentAttempt(action) {
    return this.flowManager.failCurrentAttempt({
      specId: this.specId,
      failure: {
        category: action.category,
        code: action.code,
        message: action.message,
        retryable: action.retryable,
        retryKind: action.retryKind,
      },
      result: {
        outcome: "failed",
        summary: action.message,
        confirmedAt: new Date().toISOString(),
        artifactRefs: [],
      },
    });
  }

  incrementRetry() {
    throw new Error("final-regression retry requires a Definition-selected retry episode");
  }
}

export function applyFinalRegressionTransition(input = {}) {
  const attached = attachedCanonicalCommandResultArtifact(input.commandResult);
  if (attached !== null && (attached.logicalKey !== "final.regression"
    || FinalRegressionArtifactDigest.fromArtifact(attached.payload).value !== input.decision.facts.stepFacts.artifactDigest.value)) {
    throw new Error("final-regression acceptance evidence does not match the sealed Definition decision");
  }
  const adapter = new FinalRegressionTransitionPersistenceAdapter(input);
  applyNonGateTransitionDecision(adapter, input.decision);
}

/** Claim the Definition-selected bounded repair as a new Attempt episode. */
export function beginFinalRegressionRepairTransition({ flowManager, specId, decision } = {}) {
  if (flowManager === null || typeof flowManager !== "object") {
    throw new Error("final-regression repair transition requires FlowManager");
  }
  return flowManager.beginFinalRegressionRepair({ specId, decision });
}
