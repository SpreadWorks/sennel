import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import {
  DraftCoverageRepairChangedResult,
  DraftCoverageRepairUnchangedResult,
  DraftStepErrorResult,
} from "../../engine/step-result.js";
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
    let result;
    try {
      const facts = this.#draftService.inspectWorkerFacts();
      result = facts.draftChanged
        ? new DraftCoverageRepairChangedResult()
        : new DraftCoverageRepairUnchangedResult();
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      const failure = new DraftStepErrorResult("draft-coverage-repair", error);
      await failure.persist(this.#draftService);
      return failure;
    }
    await result.persist(this.#draftService);
    return result;
  }
}
