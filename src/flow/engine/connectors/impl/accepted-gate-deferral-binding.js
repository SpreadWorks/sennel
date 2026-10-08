import { StepBindingContinuation } from "../../step-binding.js";
import { AcceptedGateDeferral } from "../../../lib/accepted-gate-deferral.js";
import { stepResultDigest } from "../../step-result.js";

/** Pure proof for the next decision Attempt of one authenticated failed Gate. */
export class AcceptedGateDeferralBindingContinuation extends StepBindingContinuation {
  constructor({ sourceBinding, attempt, continuation, sourceResult, sourceReceipt, confirmationOrder }) {
    super({ sourceBinding, attempt });
    if (!(continuation instanceof AcceptedGateDeferral) || sourceResult.evidence?.continuation !== null
      || sourceResult.stepId !== sourceBinding.stepId || sourceReceipt.id !== continuation.sourceReceiptId
      || stepResultDigest(sourceResult) !== continuation.sourceResultDigest
      || sourceReceipt.resultDigest !== continuation.sourceResultDigest
      || sourceReceipt.binding.attemptId !== sourceBinding.attempt.id
      || sourceReceipt.binding.attemptSequence !== sourceBinding.attempt.sequence
      || continuation.settlementAttempt.id !== this.attempt.id
      || continuation.settlementAttempt.sequence !== this.attempt.sequence
      || !Number.isSafeInteger(confirmationOrder) || confirmationOrder < 1) {
      throw new TypeError("accepted Gate binding requires its exact original Result and receipt");
    }
    continuation.assertEvaluation(sourceResult.evidence);
    this.continuation = continuation;
    this.sourceResult = sourceResult;
    this.sourceReceipt = sourceReceipt;
    this.confirmationOrder = confirmationOrder;
    Object.freeze(this);
  }
  matchesState(state) {
    const source = this.sourceBinding;
    return state.runId === source.runId && state.specId === source.specId
      && source.attempt.matchesFailed(state)
      && state.confirmationOrder === this.confirmationOrder;
  }
}
