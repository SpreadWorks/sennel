import { SpecWorkerCompletionFacts } from "../lib/spec-worker-completion-facts.js";
import { SpecReviewWorkerFacts } from "../lib/spec-review-worker-facts.js";

/** Values observed before one Spec worker Step is constructed. */
export class SpecWorkerInput {
  constructor({ stepId, facts }) {
    if (!["spec", "spec-triage", "spec-repair"].includes(stepId)
      || !(facts instanceof SpecWorkerCompletionFacts || facts instanceof SpecReviewWorkerFacts)) {
      throw new TypeError("Spec worker input requires its typed completion and publication");
    }
    this.stepId = stepId;
    this.facts = facts;
    Object.freeze(this);
  }
}
