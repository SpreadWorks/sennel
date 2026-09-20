import { Step } from "../../engine/step.js";
import {
  DraftCoverageReviewFindingsResult,
  DraftCoverageReviewPassedResult,
  DraftCoverageReviewExecutionRequiredResult,
  DraftStepErrorResult,
} from "../../engine/step-result.js";
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
    if (this.#reviewService.requiresReviewExecution()) {
      const result = new DraftCoverageReviewExecutionRequiredResult();
      await result.persist(this.#reviewService);
      return result;
    }
    try {
      const review = this.#reviewService.inspectReviewResult();
      const result = review.verdict === "PASS"
        ? new DraftCoverageReviewPassedResult()
        : new DraftCoverageReviewFindingsResult();
      await result.persist(this.#reviewService);
      return result;
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      const result = new DraftStepErrorResult("draft-coverage-review", error);
      await result.persist(this.#reviewService);
      return result;
    }
  }
}
