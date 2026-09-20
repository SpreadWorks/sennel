import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import { DraftCoverageTriageCompletedResult } from "../../engine/step-result.js";

/**
 * Classify coverage-review findings and produce the triage record.
 * The existing worker handoff records a decision for the selected Review.
 */
export class DraftCoverageTriageStep extends Step {
  static dependencies = [DraftService];

  #draftService;

  constructor(draftService) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    this.#draftService = draftService;
  }

  async _execute() {
    const result = new DraftCoverageTriageCompletedResult();
    await result.persist(this.#draftService);
    return result;
  }
}
