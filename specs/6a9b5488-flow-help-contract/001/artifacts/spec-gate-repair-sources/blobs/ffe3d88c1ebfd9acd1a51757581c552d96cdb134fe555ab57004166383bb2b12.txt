import { Step } from "../../engine/step.js";
import { DraftService, DraftWorkerCompletionFacts } from "../../services/draft-service.js";
import { DraftCoverageTriageCompletedResult } from "../../engine/step-result.js";

/** Pure mapping from validated coverage-triage completion facts to its Result. */
export function draftCoverageTriageResult(facts) {
  if (!(facts instanceof DraftWorkerCompletionFacts) || facts.stepId !== "draft-coverage-triage") {
    throw new TypeError("draft coverage Triage Result requires its typed completion facts");
  }
  return new DraftCoverageTriageCompletedResult();
}

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
    const facts = this.#draftService.inspectWorkerCompletion();
    const result = draftCoverageTriageResult(facts);
    await result.persist(this.#draftService);
    return result;
  }
}
