import { Agent } from "../../../lib/agent.js";
import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";

/**
 * Apply user answers and resolve remaining Draft questions.
 * Existing source: set-draft-answer.js; draft-transition-facts.js; worker-artifact-handoff.js.
 * Boundary: DraftService owns question updates; Definition decides whether to wait or continue.
 */
export class DraftRefineStep extends Step {
  static dependencies = [DraftService, Agent];

  #draftService;
  #agent;

  constructor(draftService, agent) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    if (!(agent instanceof Agent)) throw new TypeError("Agent is required");
    this.#draftService = draftService;
    this.#agent = agent;
  }

  async _execute() {
    throw new Error("DraftRefineStep._execute() is not implemented");
  }
}
