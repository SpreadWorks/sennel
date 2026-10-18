import { ReviewStepFailureObservation } from "../lib/review-step-failure-values.js";
import { ImplReviewResultEvidence } from "../lib/impl-review-values.js";
import { ReviewDeferralEvidence } from "../lib/review-transition-facts.js";
export class ImplReviewInput {
  constructor({ evidence = null, failure = null, deferralEvidence = null }) {
    if (failure === null ? !(evidence instanceof ImplReviewResultEvidence) : evidence !== null || !(failure instanceof ReviewStepFailureObservation) || failure.stepId !== "impl-review") throw new TypeError("Implementation Review input requires typed acquired evidence");
    this.failure = failure;
    this.evidence = evidence;
    if (deferralEvidence !== null && (!(deferralEvidence instanceof ReviewDeferralEvidence)
      || evidence?.review === null)) throw new TypeError("Review deferral facts require a semantic observation");
    this.deferralEvidence = deferralEvidence;
    this.stepId = "impl-review";
    Object.freeze(this);
  }
}
