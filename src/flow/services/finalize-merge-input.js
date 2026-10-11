import { FinalizeMergeResultEvidence } from "../steps/finalize/finalization-values.js";

export class FinalizeMergeInput {
  constructor({ evidence = null, failure = null }) {
    if (failure === null ? !(evidence instanceof FinalizeMergeResultEvidence)
      : evidence !== null || !(failure instanceof Error)) {
      throw new TypeError("FinalizeMergeInput requires acquired typed evidence or an observed engineering failure");
    }
    this.evidence = evidence;
    this.failure = failure;
    this.stepId = "finalize-merge";
    Object.freeze(this);
  }
}
