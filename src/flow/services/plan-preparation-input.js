import { PreparationEvidence } from "../lib/preparation-evidence.js";

/** Immutable acquired evidence for one preparation leaf. */
export class PlanPreparationInput {
  constructor({ stepId, preparation }) {
    if (typeof stepId !== "string" || !(preparation instanceof PreparationEvidence)) {
      throw new TypeError("Preparation input requires its leaf and typed evidence");
    }
    this.stepId = stepId;
    this.preparation = preparation.assertStep(stepId);
    Object.freeze(this);
  }
}
