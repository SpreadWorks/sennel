import { Step } from "../../engine/step.js";
import {
  DraftRefineAwaitingAnswerResult,
  DraftRefineCompletedResult,
  DraftRefineWorkerRequiredResult,
  DraftStepErrorResult,
} from "../../engine/step-result.js";
import { DraftService } from "../../services/draft-service.js";
import { isDraftStepPersistenceFailure } from "../../lib/definition-lifecycle-failure.js";
import { DraftTransitionFacts } from "../../lib/draft-transition-facts.js";

/** The sole draft-refine facts-to-Result decision. */
export function createDraftRefineResult({ facts, autoApprove } = {}) {
  if (!(facts instanceof DraftTransitionFacts)) {
    throw new TypeError("draft-refine Result selection requires typed transition facts");
  }
  if (typeof autoApprove !== "boolean") {
    throw new TypeError("draft-refine Result selection requires autoApprove");
  }
  if (facts.nextQuestion !== null && autoApprove !== true) {
    return new DraftRefineAwaitingAnswerResult();
  }
  if ((facts.candidateQuestion !== null && (autoApprove === true || facts.origin === "canonical"))
    || (autoApprove === true && facts.nextQuestion !== null)) {
    return new DraftRefineWorkerRequiredResult();
  }
  if (facts.candidateQuestion !== null) return new DraftRefineAwaitingAnswerResult();
  return new DraftRefineCompletedResult();
}

/**
 * Apply user answers and resolve remaining Draft questions.
 * Typed canonical or sealed-worker facts determine its concrete Result.
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
    try {
      const input = this.#draftService.inspectDraftTransition();
      const result = createDraftRefineResult(input);
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
