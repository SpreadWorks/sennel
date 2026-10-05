import { DraftReviewExecutionBinding } from "../definition.js";
import { ReviewWorkUnitManifest } from "../lib/review-work-unit-values.js";
import { CanonicalSpecReview } from "../lib/spec-review-artifacts.js";

/** A prepared Spec Review work unit or accepted canonical review. */
export class SpecReviewInput {
  constructor({ review = null, executionBinding = null, manifest = null }) {
    if (executionBinding === null
      ? !(review instanceof CanonicalSpecReview) || manifest !== null
      : review !== null || !(executionBinding instanceof DraftReviewExecutionBinding)
        || !(manifest instanceof ReviewWorkUnitManifest)
        || manifest.digest !== executionBinding.manifestDigest
        || manifest.inputDigest !== executionBinding.inputDigest) {
      throw new TypeError("Spec Review input requires an accepted review or exact work unit");
    }
    this.review = review;
    this.executionBinding = executionBinding;
    this.manifest = manifest;
    this.stepId = "spec-review";
    Object.freeze(this);
  }
}
