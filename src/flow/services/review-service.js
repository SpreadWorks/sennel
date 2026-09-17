import { attachedCanonicalCommandResultArtifact } from "../lib/canonical-command-result.js";
import { DraftReviewArtifactDocument, DraftReviewEvidenceSet } from "../lib/draft-review-artifacts.js";
import { draftReviewRouteForStepId } from "../lib/draft-review-routes.js";
import { DraftReviewStepBinding } from "../engine/connectors/draft/draft-step-binding.js";

/** Validate and publish the bound Draft Review command result. */
export class ReviewService {
  constructor({ flowManager, binding }) {
    if (!flowManager || typeof flowManager.publishCurrentAttemptResult !== "function") {
      throw new TypeError("ReviewService requires canonical Review publication");
    }
    if (!(binding instanceof DraftReviewStepBinding)) {
      throw new TypeError("ReviewService requires a typed Draft review binding");
    }
    if (binding.flowManager !== flowManager) {
      throw new Error("ReviewService binding belongs to a different FlowManager");
    }
    const route = draftReviewRouteForStepId(binding.stepId);
    if (route === null) throw new Error(`ReviewService has no draft review route for ${binding.stepId}`);
    this.flowManager = flowManager;
    this.binding = binding;
    this.route = route;
    Object.freeze(this);
  }

  /** Validate the existing command result against its bound Draft revision. */
  inspectReviewResult(result) {
    const state = this.#assertCurrent(this.route.reviewStepId);
    const artifact = attachedCanonicalCommandResultArtifact(result);
    if (artifact?.logicalKey !== this.route.reviewLogicalKey) {
      throw new Error("draft review command result does not match the bound review route");
    }
    const document = DraftReviewArtifactDocument.fromStored(artifact.payload);
    if (!(this.binding instanceof DraftReviewStepBinding)
      || JSON.stringify(document.sourceDraftRevision) !== JSON.stringify(this.binding.revision)) {
      throw new Error("draft review command result does not match the bound canonical Draft revision");
    }
    this.#validate({ state, review: document });
    return document;
  }

  /** Publish the existing command result, retaining its attached evidence. */
  publishReviewResult(result) {
    const document = this.inspectReviewResult(result);
    this.flowManager.publishCurrentAttemptResult({ specId: this.binding.specId, commandResult: result });
    return document;
  }

  #assertCurrent(expectedStepId) {
    if (this.binding.stepId !== expectedStepId) {
      throw new Error(`ReviewService ${expectedStepId} operation requires its bound Step`);
    }
    return this.binding.assertCurrent();
  }

  #validate({ state, review }) {
    const evidence = new DraftReviewEvidenceSet({
      route: this.route,
      state,
      reviewFile: { document: review.toJSON() },
    });
    const issues = evidence.validateReview({ validateBinding: false });
    if (issues.length > 0) throw new Error(issues.join("; "));
  }
}
