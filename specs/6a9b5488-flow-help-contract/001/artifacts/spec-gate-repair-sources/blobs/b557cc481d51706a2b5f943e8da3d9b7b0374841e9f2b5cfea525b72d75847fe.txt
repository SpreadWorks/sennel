import { DraftReviewArtifactDocument } from "../lib/draft-review-artifacts.js";
import { DraftReviewExecutionBinding } from "../definition.js";
import { DraftReviewRoute } from "../lib/draft-review-routes.js";
import { DraftCompletionFacts } from "../lib/draft-completion-connector.js";

/** Validated review observation for one exact Draft review Step. */
export class DraftReviewInput {
  constructor({ stepId, route, document = null, executionBinding = null,
    publicationPending = false, completionFacts = null }) {
    if (!(route instanceof DraftReviewRoute) || route.reviewStepId !== stepId
      || document !== null && !(document instanceof DraftReviewArtifactDocument)
      || executionBinding !== null && !(executionBinding instanceof DraftReviewExecutionBinding)
      || completionFacts !== null && !(completionFacts instanceof DraftCompletionFacts)
      || typeof publicationPending !== "boolean"
      || [document, executionBinding, publicationPending ? true : null]
        .filter((value) => value !== null).length !== 1) {
      throw new TypeError("Draft review input requires one typed terminal or execution observation");
    }
    this.stepId = stepId;
    this.route = route;
    this.document = document;
    this.executionBinding = executionBinding;
    this.publicationPending = publicationPending;
    this.completionFacts = completionFacts;
    Object.freeze(this);
  }
}
