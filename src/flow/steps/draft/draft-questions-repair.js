import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import { DraftRepairCandidate } from "./draft-repair-candidate.js";
import { draftQuestionsRepairResult } from "./draft-repair-result.js";

/**
 * Apply question-triage decisions to the Draft and record the repair.
 * The Step selects the repaired candidate and its Result before publication.
 */
export class DraftQuestionsRepairStep extends Step {
  static dependencies = [DraftService];

  #draftService;

  constructor(draftService) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    this.#draftService = draftService;
  }

  async _execute() {
    const input = this.#draftService.inspectWorkerFacts().repairInput;
    let result;
    let candidate;
    try {
      candidate = new DraftRepairCandidate(input);
      result = candidate.result;
    } catch (error) {
      this.#draftService.rejectInvalidRepair(error);
      result = draftQuestionsRepairResult(error);
    }
    if (candidate !== undefined) this.#draftService.adoptRepairCandidate(candidate);
    await result.persist(this.#draftService);
    return result;
  }
}
