import { Agent } from "../../../lib/agent.js";
import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import { ReviewService } from "../../services/review-service.js";

/**
 * Evaluate the completed Draft and produce the Gate result.
 * Existing source: run-gate.js; canonical-gate-artifacts.js.
 * Boundary: Reuse the existing Gate evaluator and canonical publication; Definition selects the next route.
 */
export class DraftGateStep extends Step {
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
    throw new Error("DraftGateStep._execute() is not implemented");
  }
}
