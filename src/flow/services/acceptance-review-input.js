import { AcceptanceReviewResultEvidence, AcceptanceExecutionContinuationEvidence } from "../steps/acceptance/acceptance-review-values.js";
export class AcceptanceReviewInput {
  constructor({ evidence = null, failure = null, continuation = null }) {
    if (failure === null ? !(evidence instanceof AcceptanceReviewResultEvidence) : evidence !== null || !(failure instanceof Error)) throw new TypeError("Acceptance Review requires acquired typed evidence or a boundary failure");
    if (continuation !== null) {
      if (!(continuation instanceof AcceptanceExecutionContinuationEvidence) || failure !== null) {
        throw new TypeError("Acceptance continuation requires acquired typed execution evidence");
      }
      continuation.assertEvidence(evidence);
    }
    this.evidence = evidence; this.failure = failure; this.continuation = continuation; this.stepId = "acceptance-review";
    Object.freeze(this);
  }
}
