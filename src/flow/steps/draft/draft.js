import { Step } from "../../engine/step.js";
import { DraftCreatedResult } from "../../engine/step-result.js";
import { DraftService, DraftWorkerCompletionFacts } from "../../services/draft-service.js";

/** Pure mapping from validated initial-Draft completion facts to its Result. */
export function draftResult(facts) {
  if (!(facts instanceof DraftWorkerCompletionFacts) || facts.stepId !== "draft") {
    throw new TypeError("initial Draft Result requires its typed completion facts");
  }
  return new DraftCreatedResult();
}

/** Create the initial Draft from facts prepared by the parent handoff. */
export class DraftStep extends Step {
  static dependencies = [DraftService];

  #draftService;

  constructor(draftService) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    this.#draftService = draftService;
  }

  async _execute() {
    const facts = this.#draftService.inspectWorkerCompletion();
    const result = draftResult(facts);
    await result.persist(this.#draftService);
    return result;
  }
}
