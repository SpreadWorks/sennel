import { Agent } from "../../../lib/agent.js";
import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";

/**
 * Create the initial Draft from the bound request and project context.
 * Existing source: run-prepare-spec.js (Draft template); worker-artifact-handoff.js (Draft writer).
 * Boundary: Request and project-context injection is not designed yet.
 */
export class DraftStep extends Step {
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
    throw new Error("DraftStep._execute() is not implemented");
  }
}
