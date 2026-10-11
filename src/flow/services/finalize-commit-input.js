import { FinalizeCommitResultEvidence } from "../steps/finalize/finalization-values.js";

export class FinalizeCommitInput {
  constructor({ evidence = null, failure = null }) {
    if (failure === null ? !(evidence instanceof FinalizeCommitResultEvidence)
      : evidence !== null || !(failure instanceof Error)) {
      throw new TypeError("FinalizeCommitInput requires acquired typed evidence or an observed engineering failure");
    }
    this.evidence = evidence;
    this.failure = failure;
    this.stepId = "finalize-commit";
    Object.freeze(this);
  }
}
