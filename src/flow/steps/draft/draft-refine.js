import { Step } from "../../engine/step.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../../engine/step-output.js";
import { DraftService } from "../../services/draft-service.js";
import { isDraftStepPersistenceFailure } from "../../lib/definition-lifecycle-failure.js";

/**
 * Apply user answers and resolve remaining Draft questions.
 * The bound question determines whether this step waits or runs a worker.
 */
export class DraftRefineStep extends Step {
  static dependencies = [DraftService];

  #draftService;

  constructor(draftService) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    this.#draftService = draftService;
  }

  async _execute() {
    if (this.#draftService.awaitingUserInput()) {
      return new StepOutput(STEP_OUTPUT_TYPE.USER_INPUT_REQUIRED);
    }
    try {
      const facts = this.#draftService.inspectWorkerFacts();
      const output = new StepOutput(facts.hasCandidateQuestion
        ? (facts.autoApprove ? STEP_OUTPUT_TYPE.LOOP_REQUIRED : STEP_OUTPUT_TYPE.USER_INPUT_REQUIRED)
        : STEP_OUTPUT_TYPE.COMPLETED);
      return await this.#draftService.commitWorker(output);
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      return this.#draftService.commitWorkerError(new StepOutput(error));
    }
  }
}
