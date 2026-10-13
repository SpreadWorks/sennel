import crypto from "node:crypto";
import { FlowActivity, NodeResult } from "../../../src/flow/lib/current-flow-state.js";
import { DraftStepExecutionLifecycle, DraftStepSettlementReceipt, DraftStepSettlementPublication,
  settleDraftStepResult } from "../../../src/flow/definition.js";

export function receiptBinding(activity, state) {
  return { runId: state.runId, specId: state.specId, stepId: activity.nodeId,
    attempt: { id: activity.attemptId, sequence: activity.sequence } };
}

/** Re-sign a caller-owned captured value while preserving typed admission. */
export function changedResult(activity, state, mutate, binding = receiptBinding(activity, state)) {
  const result = structuredClone(activity.result.toJSON());
  mutate(result);
  const receipt = result.draftSettlementReceipt;
  DraftStepExecutionLifecycle.fromJSON(receipt.executionLifecycle);
  receipt.id = crypto.createHash("sha256")
    .update(JSON.stringify(DraftStepSettlementReceipt.identity(receipt))).digest("hex");
  const changed = new NodeResult(result);
  DraftStepSettlementReceipt.assertStored(changed.draftSettlementReceipt, { binding, result: changed.stepResult });
  return new FlowActivity({ ...activity.toJSON(), result: changed });
}

/** Keep a saved terminal intent while replacing its nominal Result/Settlement. */
export function replaceStoredResult(result, activity, state, replacement, settleFactory = settleDraftStepResult) {
  const old = result.draftSettlementReceipt;
  result.stepResult = replacement.toJSON();
  result.draftSettlementReceipt = new DraftStepSettlementReceipt({
    binding: { ...receiptBinding(activity, state), stepId: replacement.stepId }, result: replacement,
    settlement: settleFactory(replacement.stepId, replacement),
    publication: new DraftStepSettlementPublication({}),
    executionLifecycle: DraftStepExecutionLifecycle.fromJSON(old.executionLifecycle),
  }).toJSON();
  // The read-only projection does not reconstruct a terminal connector intent.
  result.draftSettlementReceipt.publicationDigest = old.publicationDigest;
}
