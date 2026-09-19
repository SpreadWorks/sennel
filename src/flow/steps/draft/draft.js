import { Step } from "../../engine/step.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../../engine/step-output.js";
import { DraftService } from "../../services/draft-service.js";

/** Select and commit a completed Draft worker Step through its Service. */
export function executeDraftWorker(draftService) {
  return draftService.commitWorker(new StepOutput(STEP_OUTPUT_TYPE.COMPLETED));
}

/** Create the initial Draft from facts prepared by the parent handoff. */
export class DraftStep extends Step {
  static dependencies = [DraftService];

  #draftService;

  constructor(draftService) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    this.#draftService = draftService;
  }

  async _execute() {
    return executeDraftWorker(this.#draftService);
  }
}
