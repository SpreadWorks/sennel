import { Agent } from "../../../lib/agent.js";
import { Step } from "../../engine/step.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../../engine/step-output.js";
import { DraftRefineAwaitBinding } from "../../engine/connectors/draft/draft-step-binding.js";
import RunDispatchCommand from "../../lib/run-dispatch.js";
import { DraftService } from "../../services/draft-service.js";
import { executeVariableDraftWorker } from "./draft.js";

/**
 * Apply user answers and resolve remaining Draft questions.
 * The bound question determines whether this step waits or runs a worker.
 */
export class DraftRefineStep extends Step {
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
    if (this.#draftService.binding instanceof DraftRefineAwaitBinding) {
      try {
        this.#draftService.binding.assertCurrent();
        return new StepOutput(STEP_OUTPUT_TYPE.USER_INPUT_REQUIRED);
      } catch (error) {
        return new StepOutput(error);
      }
    }
    return executeVariableDraftWorker(this.#draftService, this.#agent, this.#dispatch);
  }
}
