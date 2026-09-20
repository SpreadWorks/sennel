import { Step } from "../../engine/step.js";
import {
  DraftQuestionsReviewFindingsResult,
  DraftQuestionsReviewPassedResult,
  DraftStepErrorResult,
} from "../../engine/step-result.js";
import { ReviewService } from "../../services/review-service.js";
import { isDraftStepPersistenceFailure } from "../../lib/definition-lifecycle-failure.js";

/**
 * Review unresolved decisions and candidate questions in the bound Draft.
 * The existing review command evaluates the bound Draft revision.
 */
export class DraftQuestionsReviewStep extends Step {
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
      const result = review.verdict === "PASS"
        ? new DraftQuestionsReviewPassedResult()
        : new DraftQuestionsReviewFindingsResult();
      await result.persist(this.#reviewService);
      return result;
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      const result = new DraftStepErrorResult("draft-questions-review", error);
      await result.persist(this.#reviewService);
      return result;
    }
  }
}
