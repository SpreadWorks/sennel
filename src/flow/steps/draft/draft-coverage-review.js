import { Agent } from "../../../lib/agent.js";
import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import { ReviewService } from "../../services/review-service.js";

/**
 * Review the bound Draft against the original request and decisions.
 * Existing source: run-review.js and commands/review.js: runDraftReview (coverage stage).
 * Boundary: Move prompt construction and finding interpretation here; keep artifact I/O in ReviewService.
 */
export class DraftCoverageReviewStep extends Step {
  static dependencies = [DraftService, ReviewService, Agent];

  #draftService;
  #reviewService;
  #agent;

  constructor(draftService, reviewService, agent) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    if (!(reviewService instanceof ReviewService)) throw new TypeError("ReviewService is required");
    if (!(agent instanceof Agent)) throw new TypeError("Agent is required");
    this.#draftService = draftService;
    this.#reviewService = reviewService;
    this.#agent = agent;
  }

  async _execute() {
    throw new Error("DraftCoverageReviewStep._execute() is not implemented");
  }
}
