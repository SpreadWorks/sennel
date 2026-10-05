/** Apply a sealed final-regression Definition plan to the canonical store. */
import { applyNonGateTransitionDecision } from "./non-gate-transition-application.js";
import { attachedCanonicalCommandResultArtifact } from "./canonical-command-result.js";
import { validateFinalRegressionResult } from "./test-artifacts.js";
import {
  FinalRegressionArtifactDigest,
  FinalRegressionProceedEvidence,
} from "./final-regression-transition.js";

class FinalRegressionTransitionPersistenceAdapter {
  constructor({ flowManager, specId, commandResult, decision } = {}) {
    if (flowManager === null || typeof flowManager !== "object") {
      throw new Error("final-regression transition application requires FlowManager");
    }
    if (typeof specId !== "string" || specId.length === 0) {
      throw new Error("final-regression transition application requires specId");
    }
    this.flowManager = flowManager;
    this.specId = specId;
    this.commandResult = commandResult;
    this.decision = decision;
  }

  setStepStatus(update, plan) {
    const operation = plan.action.identity.operation;
    if (operation === "advance") {
      return this.flowManager.updateStepStatus({
        stepId: update.stepId,
        requestedStatus: update.status,
      }, { specId: this.specId });
    }
    if (operation === "record-and-proceed") {
      const attached = attachedCanonicalCommandResultArtifact(this.commandResult);
      if (attached?.logicalKey !== "final.regression") {
        throw new Error("final-regression acceptance command result is missing");
      }
      const artifact = validateFinalRegressionResult(attached.payload);
      const selectedFacts = this.decision.facts.stepFacts;
      if (FinalRegressionArtifactDigest.fromArtifact(artifact).value !== selectedFacts.artifactDigest.value
        || FinalRegressionProceedEvidence.fromRecord(artifact.recordAndProceed).digest !== selectedFacts.recordAndProceed.digest) {
        throw new Error("final-regression acceptance evidence does not match the sealed Definition decision");
      }
      return this.flowManager.acceptFinalRegressionFailure({
        specId: this.specId,
        commandResult: this.commandResult,
      });
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
