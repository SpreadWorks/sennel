import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../../engine/step-output.js";
import { isDraftStepPersistenceFailure } from "../../lib/definition-lifecycle-failure.js";

/**
 * Apply coverage-triage decisions to the Draft and record the repair.
 * The existing worker handoff applies the selected coverage repair.
 */
export class DraftCoverageRepairStep extends Step {
  static dependencies = [DraftService];

  #draftService;

  constructor(draftService) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    this.#draftService = draftService;
  }

  async _execute() {
    let output;
    try {
      const facts = this.#draftService.inspectWorkerFacts();
      output = new StepOutput(facts.draftChanged
        ? STEP_OUTPUT_TYPE.LOOP_REQUIRED : STEP_OUTPUT_TYPE.COMPLETED);
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      return this.#draftService.commitWorkerError(new StepOutput(error));
    }
    return this.#draftService.commitWorker(output);
  }
}
