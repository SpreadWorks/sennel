import { StepResult, stepResultDigest } from "../engine/step-result.js";
import { CurrentFlowStateConflictError } from "./current-flow-state-conflict-error.js";
import { SpecWorkerCompletionFacts } from "./spec-worker-completion-facts.js";

/** Step-selected Result sealed to its exact validated Spec candidate. */
export class SpecWorkerResultSelection {
  constructor({ facts, result } = {}) {
    if (!(facts instanceof SpecWorkerCompletionFacts)
      || !(result instanceof StepResult) || result.stepId !== "spec") {
      throw new TypeError("Spec worker Result selection requires its typed candidate and Result");
    }
    this.facts = facts;
    this.result = result;
    this.resultDigest = stepResultDigest(result);
    Object.freeze(this);
  }

  assertResult(result) {
    if (result?.stepId !== "spec" || result?.kind !== this.result.kind
      || stepResultDigest(result) !== this.resultDigest) {
      throw new CurrentFlowStateConflictError("Spec Result differs from its selected worker candidate");
    }
  }

  assertCandidate({ result, application }) {
    this.assertResult(result);
    if (application !== null && application !== undefined
      && application.baseline !== this.facts.baseline) {
      throw new CurrentFlowStateConflictError("Spec publication differs from its selected worker candidate");
    }
    if (application !== null && application !== undefined) this.assertPublication(application.publication);
  }

  assertPublication(publication) {
    if (publication !== this.facts.publication) {
      throw new CurrentFlowStateConflictError("Spec publication differs from its selected worker candidate");
    }
  }
}
