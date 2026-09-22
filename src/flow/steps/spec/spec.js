import { Step } from "../../engine/step.js";
import { SpecCreatedResult, StepErrorResult } from "../../engine/step-result.js";
import { SpecService } from "../../services/spec-service.js";
import { SpecWorkerCompletionFacts } from "../../lib/spec-step-connection.js";

/** Pure mapping from validated initial-Spec completion facts to its Result. */
export function specResult(facts) {
  if (facts instanceof Error) return new StepErrorResult("spec", facts);
  if (!(facts instanceof SpecWorkerCompletionFacts)) {
    throw new TypeError("initial Spec Result requires its typed completion facts");
  }
  return new SpecCreatedResult();
}

/** Publish the initial Spec and connect it to the first Spec Review. */
export class SpecStep extends Step {
  static dependencies = [SpecService];

  #specService;

  constructor(specService) {
    super();
    if (!(specService instanceof SpecService)) throw new TypeError("SpecService is required");
    this.#specService = specService;
  }

  async _execute() {
    const facts = this.#specService.inspectWorkerCompletion();
    const result = specResult(facts);
    this.#specService.adoptWorkerCandidate(facts, result);
    await result.persist(this.#specService);
    return result;
  }
}
