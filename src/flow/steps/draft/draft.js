import { Agent } from "../../../lib/agent.js";
import { Step } from "../../engine/step.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../../engine/step-output.js";
import RunDispatchCommand from "../../lib/run-dispatch.js";
import { DraftService } from "../../services/draft-service.js";

/** Run one exact Draft worker request through the established handoff owner. */
export async function runBoundDraftWorker(draftService, agent, dispatch) {
  const outcome = await dispatch.runBoundDraftWorker(draftService.workerRequest(), agent);
  if (outcome.error !== null) throw outcome.error;
  return outcome;
}

export async function executeCompletedDraftWorker(draftService, agent, dispatch) {
  const output = await executeVariableDraftWorker(draftService, agent, dispatch);
  if (output.type !== STEP_OUTPUT_TYPE.COMPLETED && output.type !== STEP_OUTPUT_TYPE.ERROR) {
    return new StepOutput(new Error("Draft worker did not confirm a completed Step result"));
  }
  return output;
}

export async function executeVariableDraftWorker(draftService, agent, dispatch) {
  try {
    const outcome = await runBoundDraftWorker(draftService, agent, dispatch);
    if (!(outcome.stepOutput instanceof StepOutput)) throw new Error("Draft worker has no confirmed Step result");
    return outcome.stepOutput;
  } catch (error) {
    return new StepOutput(error);
  }
}

/**
 * Create the initial Draft from the bound request and project context.
 * The bound handoff carries the request and project context.
 */
export class DraftStep extends Step {
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
    return executeCompletedDraftWorker(this.#draftService, this.#agent, this.#dispatch);
  }
}
