import { createHash } from "node:crypto";
import { DraftStepSettlementReceipt, settleSpecStepResult } from "../definition.js";
import { StepResult } from "../engine/step-result.js";

/** Verify the exact Spec Gate artifact and Activity selected by a durable settlement. */
export function assertGateSettlementPublication({ state, activity, descriptor, historyEntry, attempt, publicationBytes } = {}) {
  if (activity?.result?.draftSettlementReceipt == null
    && activity?.transition?.operation !== "record_draft_step_settlement") return null;
  const result = StepResult.fromStored("spec-gate", activity.result?.stepResult);
  const settlement = settleSpecStepResult("spec-gate", result);
  const receipt = DraftStepSettlementReceipt.assertStored(activity.result?.draftSettlementReceipt, {
    binding: { runId: state?.runId, specId: state?.specId, stepId: "spec-gate", attempt },
    result, settlement,
  });
  const expectedResult = result.kind.endsWith("-passed") ? "pass"
    : result.kind.endsWith("-recovered") ? "recovered" : "fail";
  if (activity.nodeId !== "spec-gate"
    || activity.attemptId !== attempt?.id
    || activity.sequence !== attempt?.sequence
    || descriptor?.logicalKey !== "spec.gate"
    || descriptor.activityId !== activity.id
    || !Buffer.isBuffer(publicationBytes)
    || descriptor.hash !== createHash("sha256").update(publicationBytes).digest("hex")
    || historyEntry?.attempt !== attempt.sequence
    || historyEntry.payload?.result !== expectedResult
    || !["spec", "task-spec"].includes(historyEntry.payload?.artifacts?.phase)
    || historyEntry.payload.artifacts.gateTransitionAttemptId !== attempt.id
    || historyEntry.payload.artifacts.gateTransitionAttemptSequence !== attempt.sequence) {
    throw new Error("Spec Gate settlement publication does not match its receipt, Attempt, catalog, and Activity");
  }
  return Object.freeze({ receipt, result, settlement });
}
