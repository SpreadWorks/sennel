import { AcceptanceReviewResultEvidence } from "../steps/acceptance/acceptance-review-values.js";
export class AcceptanceReviewInput {
  constructor({ evidence = null, failure = null }) {
    if (failure === null ? !(evidence instanceof AcceptanceReviewResultEvidence) : evidence !== null || !(failure instanceof Error)) throw new TypeError("Acceptance Review requires acquired typed evidence or a boundary failure");
    this.evidence = evidence; this.failure = failure; this.stepId = "acceptance-review";
    Object.freeze(this);
  }
}
