import { Agent } from "../../../lib/agent.js";
import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import { ReviewService } from "../../services/review-service.js";

/**
 * Classify coverage-review findings and produce the triage record.
 * Existing source: worker-artifact-handoff.js (draft coverage triage); draft-review-artifacts.js.
 * Boundary: Read the selected Review through ReviewService; do not select the next route.
 */
export class DraftCoverageTriageStep extends Step {
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
    throw new Error("DraftCoverageTriageStep._execute() is not implemented");
  }
}
