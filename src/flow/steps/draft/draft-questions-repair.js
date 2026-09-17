import { Agent } from "../../../lib/agent.js";
import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import { ReviewService } from "../../services/review-service.js";

/**
 * Apply question-triage decisions to the Draft and record the repair.
 * Existing source: worker-artifact-handoff.js; draft-repair-operations.js (questions repair).
 * Boundary: DraftService applies Draft changes; ReviewService stores the linked repair record.
 */
export class DraftQuestionsRepairStep extends Step {
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
    throw new Error("DraftQuestionsRepairStep._execute() is not implemented");
  }
}
