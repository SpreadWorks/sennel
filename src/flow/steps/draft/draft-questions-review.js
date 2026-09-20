import { Step } from "../../engine/step.js";
import {
  DraftQuestionsReviewFindingsResult,
  DraftQuestionsReviewPassedResult,
  DraftQuestionsReviewExecutionRequiredResult,
  DraftStepErrorResult,
} from "../../engine/step-result.js";
import { ReviewService } from "../../services/review-service.js";
import { DraftReviewArtifactDocument } from "../../lib/draft-review-artifacts.js";
import { isDraftStepPersistenceFailure } from "../../lib/definition-lifecycle-failure.js";

/** Pure mapping from typed terminal Review facts to this Step's Result. */
export function draftQuestionsReviewResult(facts) {
  if (facts instanceof Error) return new DraftStepErrorResult("draft-questions-review", facts);
  if (!(facts instanceof DraftReviewArtifactDocument) || facts.phase !== "draft-questions") {
    throw new TypeError("draft questions Review Result requires typed Review facts");
  }
  return facts.verdict === "PASS"
    ? new DraftQuestionsReviewPassedResult()
    : new DraftQuestionsReviewFindingsResult();
}

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
    let result;
    try {
      result = draftQuestionsReviewResult(this.#reviewService.inspectReviewResult());
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      result = draftQuestionsReviewResult(error);
    }
    await result.persist(this.#reviewService);
    return result;
  }
}
