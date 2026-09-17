import { Step } from "../../engine/step.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../../engine/step-output.js";
import { DraftService } from "../../services/draft-service.js";
import RunGateCommand, { executeDraftGateStep } from "../../lib/run-gate.js";

/**
 * Evaluate the completed Draft and produce the Gate result.
 * The existing Gate command evaluates and publishes the bound Attempt.
 */
export class DraftGateStep extends Step {
  static dependencies = [DraftService, RunGateCommand];

  #draftService;
  #command;

  constructor(draftService, command) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    if (!(command instanceof RunGateCommand)) throw new TypeError("RunGateCommand is required");
    this.#draftService = draftService;
    this.#command = command;
  }

  async _execute() {
    try {
      const { result, decision } = await executeDraftGateStep({ binding: this.#draftService.binding, command: this.#command });
      return new StepOutput(result.result === "pass" || decision.disposition.operation === "defer"
        ? STEP_OUTPUT_TYPE.COMPLETED
        : STEP_OUTPUT_TYPE.LOOP_REQUIRED);
    } catch (error) {
      return new StepOutput(error);
    }
  }
}
