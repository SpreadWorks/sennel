import { Step } from "../../engine/step.js";
import { DraftService, DraftWorkerCompletionFacts } from "../../services/draft-service.js";
import { DraftQuestionsTriageCompletedResult } from "../../engine/step-result.js";

/** Pure mapping from validated question-triage completion facts to its Result. */
export function draftQuestionsTriageResult(facts) {
  if (!(facts instanceof DraftWorkerCompletionFacts) || facts.stepId !== "draft-questions-triage") {
    throw new TypeError("draft questions Triage Result requires its typed completion facts");
  }
  return new DraftQuestionsTriageCompletedResult();
}

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
    const facts = this.#draftService.inspectWorkerCompletion();
    const result = draftQuestionsTriageResult(facts);
    await result.persist(this.#draftService);
    return result;
  }
}
