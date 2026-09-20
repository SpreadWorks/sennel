import { Step } from "../../engine/step.js";
import {
  DraftCoverageReviewFindingsResult,
  DraftCoverageReviewPassedResult,
  DraftCoverageReviewExecutionRequiredResult,
  DraftStepErrorResult,
} from "../../engine/step-result.js";
import { ReviewService } from "../../services/review-service.js";
import { DraftReviewArtifactDocument } from "../../lib/draft-review-artifacts.js";
import { isDraftStepPersistenceFailure } from "../../lib/definition-lifecycle-failure.js";

/** Pure mapping from typed terminal Review facts to this Step's Result. */
export function draftCoverageReviewResult(facts) {
  if (facts instanceof Error) return new DraftStepErrorResult("draft-coverage-review", facts);
  if (!(facts instanceof DraftReviewArtifactDocument) || facts.phase !== "draft-coverage") {
    throw new TypeError("draft coverage Review Result requires typed Review facts");
  }
  return facts.verdict === "PASS"
    ? new DraftCoverageReviewPassedResult()
    : new DraftCoverageReviewFindingsResult();
}

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
    let result;
    try {
      result = draftCoverageReviewResult(this.#reviewService.inspectReviewResult());
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      result = draftCoverageReviewResult(error);
    }
    await result.persist(this.#reviewService);
    return result;
  }
}
