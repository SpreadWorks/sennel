import { AcceptanceDecisionResultEvidence } from "../steps/acceptance/acceptance-review-values.js";
export class AcceptanceDecisionInput {
  constructor({ evidence = null, failure = null }) {
    if (failure === null ? !(evidence instanceof AcceptanceDecisionResultEvidence) : evidence !== null || !(failure instanceof Error)) throw new TypeError("Acceptance decision requires acquired typed evidence or a boundary failure");
    this.evidence = evidence; this.failure = failure; this.stepId = "acceptance-decision";
    Object.freeze(this);
  }
}
