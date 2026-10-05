import { SpecWorkerCompletionFacts } from "./spec-worker-completion-facts.js";
import { SpecWorkerStepBinding } from "../engine/connectors/spec/spec-step-binding.js";

/** Exact publication and successor connection selected after Definition settles the Result. */
export class SpecReviewSettlementApplication {
  constructor({ binding, facts } = {}) {
    if (!(binding instanceof SpecWorkerStepBinding)
      || !(facts instanceof SpecWorkerCompletionFacts)) {
      throw new TypeError("Spec review connection requires its binding and completion facts");
    }
    binding.assertCurrent();
    this.runId = binding.runId;
    this.specId = binding.specId;
    this.sourceStepId = binding.stepId;
    this.sourceAttempt = binding.attempt;
    this.targetStepId = "spec-review";
    this.publication = facts.publication;
    this.baseline = facts.baseline;
    Object.freeze(this);
  }
}
