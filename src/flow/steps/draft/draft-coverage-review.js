import { Step } from "../../engine/step.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../../engine/step-output.js";
import { ReviewService } from "../../services/review-service.js";
import { isDraftStepPersistenceFailure } from "../../lib/definition-lifecycle-failure.js";

/**
 * Review the bound Draft against the original request and decisions.
 * The existing review command evaluates the bound Draft revision.
 */
export class DraftCoverageReviewStep extends Step {
  static dependencies = [ReviewService];

  #reviewService;

  constructor(reviewService) {
    super();
    if (!(reviewService instanceof ReviewService)) throw new TypeError("ReviewService is required");
    this.#reviewService = reviewService;
  }

  async _execute() {
    try {
      const review = this.#reviewService.inspectReviewResult();
      const output = new StepOutput(review.verdict === "PASS"
        ? STEP_OUTPUT_TYPE.COMPLETED
        : STEP_OUTPUT_TYPE.BRANCH_REQUIRED);
      this.#reviewService.commitReviewResult(output, review);
      return output;
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      const output = new StepOutput(error);
      this.#reviewService.commitStepError(output);
      return output;
    }
  }
}
