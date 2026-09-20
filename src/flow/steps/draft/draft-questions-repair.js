import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import {
  DraftQuestionsRepairChangedResult,
  DraftQuestionsRepairUnchangedResult,
  DraftStepErrorResult,
} from "../../engine/step-result.js";
import { DraftRepairResultFacts } from "../../lib/worker-artifact-handoff.js";
import { isDraftStepPersistenceFailure } from "../../lib/definition-lifecycle-failure.js";

/** Pure mapping from typed Repair facts to this Step's terminal Result. */
export function draftQuestionsRepairResult(facts) {
  if (facts instanceof Error) return new DraftStepErrorResult("draft-questions-repair", facts);
  if (!(facts instanceof DraftRepairResultFacts) || facts.stepId !== "draft-questions-repair") {
    throw new TypeError("draft questions Repair Result requires its typed worker facts");
  }
  return facts.draftChanged
    ? new DraftQuestionsRepairChangedResult()
    : new DraftQuestionsRepairUnchangedResult();
}

/**
 * Apply question-triage decisions to the Draft and record the repair.
 * The existing worker handoff applies the selected question repair.
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
    let result;
    try {
      result = draftQuestionsRepairResult(this.#draftService.inspectWorkerFacts().repairResult);
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      result = draftQuestionsRepairResult(error);
    }
    await result.persist(this.#draftService);
    return result;
  }
}
