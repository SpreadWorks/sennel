import { Step } from "../../engine/step.js";
import {
  DraftRefineAwaitingAnswerResult,
  DraftRefineCompletedResult,
  DraftRefineWorkerRequiredResult,
  StepErrorResult,
} from "../../engine/step-result.js";
import { DraftService } from "../../services/draft-service.js";
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
  #selectedResult = null;

  constructor(draftService) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    this.#draftService = draftService;
  }

  prepareResult() {
    if (this.#selectedResult !== null) return this.#selectedResult;
    const input = this.#draftService.inspectDraftTransition();
    let result;
    try {
      result = createDraftRefineResult(input);
    } catch (error) {
      result = new StepErrorResult("draft-refine", error);
    }
    this.#selectedResult = result;
    return result;
  }

  async _execute() {
    const result = this.prepareResult();
    await result.persist(this.#draftService);
    return result;
  }
}
