import {
  SpecCreatedResult,
  StepErrorResult,
} from "../../engine/step-result.js";
import { SpecWorkerCompletionFacts } from "../../lib/spec-worker-completion-facts.js";

/** Select the meaning of one validated Spec worker candidate. */
export function specResult(facts) {
  if (facts instanceof Error) return new StepErrorResult("spec", facts);
  if (!(facts instanceof SpecWorkerCompletionFacts)) {
    throw new TypeError("Spec Result requires its typed completion facts");
  }
  return new SpecCreatedResult();
}
