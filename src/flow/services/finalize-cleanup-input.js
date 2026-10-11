import { FinalizeCleanupResultEvidence } from "../steps/finalize/finalization-values.js";

export class FinalizeCleanupInput {
  constructor({ evidence = null, failure = null }) {
    if (failure === null ? !(evidence instanceof FinalizeCleanupResultEvidence)
      : evidence !== null || !(failure instanceof Error)) {
      throw new TypeError("FinalizeCleanupInput requires acquired typed evidence or an observed engineering failure");
    }
    this.evidence = evidence;
    this.failure = failure;
    this.stepId = "finalize-cleanup";
    Object.freeze(this);
  }
}
