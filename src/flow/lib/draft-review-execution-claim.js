import { DraftStepExecutionLifecycle } from "../definition.js";
import { recoverStepSettlementReceipt } from "./definition-lifecycle-failure.js";

/** Save one exact Review claim, recovering only its durable receipt. */
export function claimDraftReviewExecution({ flowManager, binding, stepResult,
  settlement, executionBinding, executionClaim, executionContract }) {
  const input = { binding, stepResult, settlement,
    executionLifecycle: DraftStepExecutionLifecycle.checkpoint(executionBinding).claimed(executionClaim) };
  try {
    return flowManager.claimDraftStepExecution({ binding, stepResult, settlement,
      executionBinding, executionClaim, executionContract });
  } catch (error) {
    const receipt = recoverStepSettlementReceipt(flowManager, input, error);
    flowManager.readExecutionContract({ executionContract });
    return { state: flowManager.canonicalState(binding.specId), receipt };
  }
}
