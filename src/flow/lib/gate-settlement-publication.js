import { createHash } from "node:crypto";
import { DraftStepSettlementReceipt, settleDraftStepResult, settleSpecStepResult, settleImplStepResult, settleTaskStepResult } from "../definition.js";
import { StepResult } from "../engine/step-result.js";
import { TaskStepIdentity } from "./task-step-identity.js";

/** Verify the exact registered Gate artifact and Activity selected by a durable settlement. */
export function assertGateSettlementPublication({ state, activity, descriptor, historyEntry, attempt, publicationBytes } = {}) {
  if (activity?.result?.draftSettlementReceipt == null
    && activity?.transition?.operation !== "record_draft_step_settlement") return null;
  const taskIdentity = TaskStepIdentity.fromStateNode(state, activity?.nodeId);
  const stepId = taskIdentity?.definitionId ?? activity?.nodeId;
  if (!["draft-gate", "spec-gate", "impl-gate", "task-gate"].includes(stepId)) throw new Error("Gate settlement does not own a registered Gate");
  const storedResult = activity.result?.stepResult;
  const result = StepResult.fromStored(stepId, storedResult instanceof StepResult ? storedResult.toJSON() : storedResult);
  const settlement = stepId === "draft-gate" ? settleDraftStepResult(stepId, result)
    : stepId === "spec-gate" ? settleSpecStepResult(stepId, result)
    : stepId === "task-gate" ? settleTaskStepResult(stepId, result) : settleImplStepResult(stepId, result);
  const receipt = DraftStepSettlementReceipt.assertStored(activity.result?.draftSettlementReceipt, {
    binding: { runId: state?.runId, specId: state?.specId, stepId, nodeId: activity.nodeId, attempt },
    result, settlement,
  });
  const expectedResult = stepId === "draft-gate" || stepId === "spec-gate" ? result.kind.endsWith("-passed") ? "pass"
    : result.kind.endsWith("-recovered") ? "recovered" : "fail"
    : result.evidence?.result ?? result.error?.data?.evidence?.result;
  const logicalKey = stepId === "draft-gate" ? "draft.gate" : stepId === "spec-gate" ? "spec.gate" : stepId === "impl-gate" ? "impl.gate" : "task.gate";
  const phases = stepId === "draft-gate" ? ["draft"] : stepId === "spec-gate" ? ["spec", "task-spec"] : stepId === "impl-gate" ? ["integration"] : ["task-impl"];
  if (activity.nodeId !== (taskIdentity?.nodeId ?? stepId)
    || activity.attemptId !== attempt?.id
    || activity.sequence !== attempt?.sequence
    || descriptor?.logicalKey !== logicalKey
    || descriptor.activityId !== activity.id
    || !Buffer.isBuffer(publicationBytes)
    || descriptor.hash !== createHash("sha256").update(publicationBytes).digest("hex")
    || historyEntry?.attempt !== attempt.sequence
    || historyEntry.payload?.result !== expectedResult
    || !phases.includes(historyEntry.payload?.artifacts?.phase)
    || historyEntry.payload.artifacts.gateTransitionAttemptId !== attempt.id
    || historyEntry.payload.artifacts.gateTransitionAttemptSequence !== attempt.sequence) {
    throw new Error("Gate settlement publication does not match its receipt, Attempt, catalog, and Activity");
  }
  return Object.freeze({ receipt, result, settlement });
}
