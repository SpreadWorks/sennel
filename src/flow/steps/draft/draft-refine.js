import { Step } from "../../engine/step.js";
import {
  DraftRefineAwaitingAnswerResult,
  DraftRefineCompletedResult,
  DraftRefineWorkerRequiredResult,
  DraftStepErrorResult,
} from "../../engine/step-result.js";
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
      const result = new DraftRefineAwaitingAnswerResult();
      await result.persist(this.#draftService);
      return result;
    }
    try {
      const facts = this.#draftService.inspectWorkerFacts();
      const result = facts.hasCandidateQuestion
        ? (facts.autoApprove ? new DraftRefineWorkerRequiredResult() : new DraftRefineAwaitingAnswerResult())
        : new DraftRefineCompletedResult();
      await result.persist(this.#draftService);
      return result;
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      const result = new DraftStepErrorResult("draft-refine", error);
      await result.persist(this.#draftService);
      return result;
    }
  }
}
