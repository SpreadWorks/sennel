import { ReviewStepFailureObservation } from "../lib/review-step-failure-values.js";
import { ImplReviewResultEvidence } from "../lib/impl-review-values.js";
export class ImplReviewInput {
  constructor({ evidence = null, failure = null }) {
    if (failure === null ? !(evidence instanceof ImplReviewResultEvidence) : evidence !== null || !(failure instanceof ReviewStepFailureObservation) || failure.stepId !== "impl-review") throw new TypeError("Implementation Review input requires typed acquired evidence");
    this.failure = failure;
    this.evidence = evidence;
    this.stepId = "impl-review";
    Object.freeze(this);
  }
}
