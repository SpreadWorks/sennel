import { Step } from "../../engine/step.js";
import { DraftQuestionsReviewExecutionRequiredResult } from "../../engine/step-result.js";
import { ReviewService } from "../../services/review-service.js";
import { draftQuestionsReviewResult } from "./draft-review-result.js";

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
    if (this.#reviewService.requiresReviewExecution()) {
      const result = new DraftQuestionsReviewExecutionRequiredResult();
      await result.persist(this.#reviewService);
      return result;
    }
    const facts = this.#reviewService.inspectReviewResult();
    let result;
    try {
      result = draftQuestionsReviewResult(facts);
    } catch (error) {
      result = draftQuestionsReviewResult(error);
    }
    await result.persist(this.#reviewService);
    return result;
  }
}
