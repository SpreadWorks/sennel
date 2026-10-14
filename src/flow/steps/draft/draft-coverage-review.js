import { Step } from "../../engine/step.js";
import { DraftCoverageReviewExecutionRequiredResult } from "../../engine/step-result.js";
import { ReviewService } from "../../services/review-service.js";
import { draftCoverageReviewResult } from "./draft-review-result.js";

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
    const facts = this.#reviewService.inspectReviewResult();
    let result;
    try {
      result = draftCoverageReviewResult(facts);
    } catch (error) {
      result = draftCoverageReviewResult(error);
    }
    await result.persist(this.#reviewService);
    return result;
  }
}
