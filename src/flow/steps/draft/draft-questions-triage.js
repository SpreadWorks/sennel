import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import { executeDraftWorker } from "./draft.js";

/**
 * Classify question-review findings and produce the triage record.
 * The existing worker handoff records a decision for the selected Review.
 */
export class DraftQuestionsTriageStep extends Step {
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
