import { Step } from "../../engine/step.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../../engine/step-output.js";
import { ReviewService } from "../../services/review-service.js";
import RunReviewCommand, { executeDraftReviewStep } from "../../lib/run-review.js";

/**
 * Review the bound Draft against the original request and decisions.
 * The existing review command evaluates the bound Draft revision.
 */
export class DraftCoverageReviewStep extends Step {
  static dependencies = [ReviewService, RunReviewCommand];

  #reviewService;
  #command;

  constructor(reviewService, command) {
    super();
    if (!(reviewService instanceof ReviewService)) throw new TypeError("ReviewService is required");
    if (!(command instanceof RunReviewCommand)) throw new TypeError("RunReviewCommand is required");
    this.#reviewService = reviewService;
    this.#command = command;
  }

  async _execute() {
    try {
      const { review } = await executeDraftReviewStep({ reviewService: this.#reviewService, command: this.#command });
      return new StepOutput(review.verdict === "PASS"
        ? STEP_OUTPUT_TYPE.COMPLETED
        : STEP_OUTPUT_TYPE.BRANCH_REQUIRED);
    } catch (error) {
      return new StepOutput(error);
    }
  }
}
