import {
  DraftQuestionsReviewFindingsResult,
  DraftQuestionsReviewPassedResult,
  DraftCoverageReviewFindingsResult,
  DraftCoverageReviewPassedResult,
  StepErrorResult,
} from "../../engine/step-result.js";
import { DraftReviewArtifactDocument } from "../../lib/draft-review-artifacts.js";
import { draftReviewRouteForKey } from "../../lib/draft-review-routes.js";

function draftReviewResult(facts, route, PassedResult, FindingsResult) {
  if (facts instanceof Error) return new StepErrorResult(route.reviewStepId, facts);
  if (!(facts instanceof DraftReviewArtifactDocument) || facts.phase !== route.retryPhase) {
    throw new TypeError(`draft ${route.key} Review Result requires typed Review facts`);
  }
  return facts.verdict === "PASS" ? new PassedResult() : new FindingsResult();
}

/** Pure mapping from typed terminal Review facts to the questions Review Result. */
export function draftQuestionsReviewResult(facts) {
  return draftReviewResult(facts, draftReviewRouteForKey("questions"),
    DraftQuestionsReviewPassedResult, DraftQuestionsReviewFindingsResult);
}

/** Pure mapping from typed terminal Review facts to the coverage Review Result. */
export function draftCoverageReviewResult(facts) {
  return draftReviewResult(facts, draftReviewRouteForKey("coverage"),
    DraftCoverageReviewPassedResult, DraftCoverageReviewFindingsResult);
}
