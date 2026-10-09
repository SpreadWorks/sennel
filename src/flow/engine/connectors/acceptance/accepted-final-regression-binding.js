import { StepBindingContinuation } from "../../step-binding.js";
import { stepResultDigest } from "../../step-result.js";

/** Exact failed producer proof for its separately published acceptance Attempt. */
export class AcceptedFinalRegressionBindingContinuation extends StepBindingContinuation {
  constructor({ sourceBinding, attempt, sourceResult, sourceReceipt, confirmationOrder }) {
    super({ sourceBinding, attempt });
    if (sourceBinding.stepId !== "final-regression" || sourceResult.kind !== "final-regression-failed"
      || sourceReceipt.resultDigest !== stepResultDigest(sourceResult)
      || sourceReceipt.binding.runId !== sourceBinding.runId || sourceReceipt.binding.specId !== sourceBinding.specId
      || sourceReceipt.binding.stepId !== sourceBinding.stepId
      || sourceReceipt.binding.attemptId !== sourceBinding.attempt.id
      || sourceReceipt.binding.attemptSequence !== sourceBinding.attempt.sequence
      || !Number.isSafeInteger(confirmationOrder) || confirmationOrder < 1) {
      throw new TypeError("accepted regression binding requires its exact failed Result and receipt");
    }
    this.sourceResult = sourceResult;
    this.sourceReceipt = sourceReceipt;
    this.confirmationOrder = confirmationOrder;
    Object.freeze(this);
  }
  matchesState(state) {
    const source = this.sourceBinding;
    return state.runId === source.runId && state.specId === source.specId
      && source.attempt.matchesFailed(state) && state.confirmationOrder === this.confirmationOrder;
  }
}
