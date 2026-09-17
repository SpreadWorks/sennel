import { Agent } from "../../../lib/agent.js";
import { Step } from "../../engine/step.js";
import RunDispatchCommand from "../../lib/run-dispatch.js";
import { DraftService } from "../../services/draft-service.js";
import { executeVariableDraftWorker } from "./draft.js";

/**
 * Apply question-triage decisions to the Draft and record the repair.
 * The existing worker handoff applies the selected question repair.
 */
export class DraftQuestionsRepairStep extends Step {
  static dependencies = [DraftService, Agent, RunDispatchCommand];

  #draftService;
  #agent;
  #dispatch;

  constructor(draftService, agent, dispatch) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    if (!(agent instanceof Agent)) throw new TypeError("Agent is required");
    if (!(dispatch instanceof RunDispatchCommand)) throw new TypeError("RunDispatchCommand is required");
    this.#draftService = draftService;
    this.#agent = agent;
    this.#dispatch = dispatch;
  }

  async _execute() {
    return executeVariableDraftWorker(this.#draftService, this.#agent, this.#dispatch);
  }
}
