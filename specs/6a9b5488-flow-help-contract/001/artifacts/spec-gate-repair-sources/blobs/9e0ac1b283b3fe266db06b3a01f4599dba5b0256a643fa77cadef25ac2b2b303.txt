import { StepResult, stepResultDigest } from "../engine/step-result.js";
import { CurrentFlowStateConflictError } from "./current-flow-state-conflict-error.js";
import { SpecGateProspectiveFacts } from "./spec-gate-prospective-facts.js";

/** Step-selected Gate Result sealed to its pure prospective facts. */
export class SpecGateResultSelection {
  constructor({ facts, result } = {}) {
    if (!(facts instanceof SpecGateProspectiveFacts)
      || !(result instanceof StepResult) || result.stepId !== "spec-gate") {
      throw new TypeError("Spec Gate Result selection requires its prospective facts and Result");
    }
    this.facts = facts;
    this.result = result;
    this.resultKind = result.kind;
    this.resultDigest = stepResultDigest(result);
    Object.freeze(this);
  }

  assertResult(stepResult) {
    if (stepResult?.stepId !== "spec-gate" || stepResult?.kind !== this.resultKind
      || stepResultDigest(stepResult) !== this.resultDigest) {
      throw new CurrentFlowStateConflictError("Spec Gate Result differs from its sealed Step selection");
    }
  }
}
