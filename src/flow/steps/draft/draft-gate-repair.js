import { Agent } from "../../../lib/agent.js";
import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";

/**
 * Apply the selected Gate repair request to the bound Draft.
 * Existing source: plan-gate-repair.js; draft-repair-operations.js; worker-artifact-handoff.js.
 * Boundary: Gate-result access needs a designed dependency; do not make this Step search for it.
 */
export class DraftGateRepairStep extends Step {
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
    throw new Error("DraftGateRepairStep._execute() is not implemented");
  }
}
