import { FinalizeSyncResultEvidence } from "../steps/finalize/finalization-values.js";

export class FinalizeSyncInput {
  constructor({ evidence = null, failure = null }) {
    if (failure === null ? !(evidence instanceof FinalizeSyncResultEvidence)
      : evidence !== null || !(failure instanceof Error)) {
      throw new TypeError("FinalizeSyncInput requires acquired typed evidence or an observed engineering failure");
    }
    this.evidence = evidence;
    this.failure = failure;
    this.stepId = "finalize-sync";
    Object.freeze(this);
  }
}
