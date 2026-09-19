import { Step } from "../../engine/step.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../../engine/step-output.js";
import { GateService } from "../../services/review-service.js";
import { isDraftStepPersistenceFailure } from "../../lib/definition-lifecycle-failure.js";

/**
 * Evaluate the completed Draft and produce the Gate result.
 * The existing Gate command evaluates and publishes the bound Attempt.
 */
export class DraftGateStep extends Step {
  static dependencies = [GateService];

  #gateService;

  constructor(gateService) {
    super();
    if (!(gateService instanceof GateService)) throw new TypeError("GateService is required");
    this.#gateService = gateService;
  }

  async _execute() {
    try {
      const decision = await this.#gateService.prepareGateResult();
      let outputType;
      if (decision.disposition.operation === "pass" || decision.disposition.operation === "defer") {
        outputType = STEP_OUTPUT_TYPE.COMPLETED;
      } else if (decision.disposition.operation === "repair") {
        outputType = STEP_OUTPUT_TYPE.LOOP_REQUIRED;
      } else {
        throw new Error(`Draft Gate selected unsupported Step disposition: ${decision.disposition.operation}`);
      }
      const output = new StepOutput(outputType);
      await this.#gateService.commitGateResult({ decision, stepOutput: output });
      return output;
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      const output = new StepOutput(error);
      this.#gateService.commitStepError(output);
      return output;
    }
  }
}
