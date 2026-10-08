import { StepBindingContinuation } from "../../step-binding.js";
import { AcceptedNonblockingDecision } from "../../../lib/accepted-nonblocking-decision.js";
import { stepResultDigest } from "../../step-result.js";

/** Source receipt proof for the next explicit decision Attempt. */
export class AcceptedNonblockingBindingContinuation extends StepBindingContinuation {
  constructor({ sourceBinding, attempt, continuation, sourceResult, sourceReceipt, confirmationOrder }) {
    super({ sourceBinding, attempt });
    if (!(continuation instanceof AcceptedNonblockingDecision)
      || sourceResult.stepId !== sourceBinding.stepId || sourceReceipt.id !== continuation.sourceReceiptId
      || stepResultDigest(sourceResult) !== continuation.sourceResultDigest
      || sourceReceipt.resultDigest !== continuation.sourceResultDigest
      || sourceReceipt.binding.attemptId !== sourceBinding.attempt.id
      || sourceReceipt.binding.attemptSequence !== sourceBinding.attempt.sequence
      || continuation.settlementAttempt.id !== this.attempt.id || continuation.settlementAttempt.sequence !== this.attempt.sequence
      || !Number.isSafeInteger(confirmationOrder) || confirmationOrder < 1) {
      throw new TypeError("Accepted decision requires its exact original Result, receipt and next Attempt");
    }
    Object.assign(this, { continuation, sourceResult, sourceReceipt, confirmationOrder });
    Object.freeze(this);
  }
  matchesState(state) {
    const source = this.sourceBinding;
    return state.runId === source.runId && state.specId === source.specId
      && (source.attempt.matches(state) || source.attempt.matchesFailed(state))
      && state.confirmationOrder === this.confirmationOrder;
  }
}
