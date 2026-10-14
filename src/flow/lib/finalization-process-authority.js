import path from "node:path";
import fs from "node:fs";
import { finalizationStepRegistration } from "../engine/composition/finalization.js";
import { FinalizeFlowStateOwner } from "./finalize-flow-state-owner.js";
import { FlowProcessPhysicalAuthority, FlowProcessCheckoutRemoval } from "./flow-process-physical-authority.js";
import { FlowProcessExecutionBinding } from "./flow-process-execution-binding.js";
import { CurrentAttemptIdentity } from "./current-flow-state.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";

import { FinalizeCleanupEffectPreparation } from "./finalize-cleanup-journal.js";

/** Project the registered typed selection without executing a Step or its effects. */
export function projectFinalizationProcessAuthorityInput(input) {
  const registration = finalizationStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Finalization process authority requires its registered Step");
  const selection = registration.executionContract.select({ ...input, registration });
  return registration.executionContract.project(selection, { ...input, registration });
}

/** Acquire the existing registered selection before any finalization hook or process starts. */
export function captureFinalizationProcessAuthority(ctx, stepId) {
  const state = ctx.flowManager.canonicalState(ctx.specId ?? ctx.flowState.specId);
  const receipt = state.lifecycle.state === "finalized" ? ctx.flowManager.readCurrentStepSettlement({
    specId: state.specId, stepId, completed: true })?.receipt ?? null : null;
  let selected;
  try { selected = projectFinalizationProcessAuthorityInput({ ctx, stepId, command: stepId, receipt }); }
  catch (error) {
    if (error instanceof StepAdmissionRefusal) return null;
    throw error;
  }
  const owner = FinalizeFlowStateOwner.forMainContext(ctx);
  const sourceRoot = path.resolve(ctx.flowManager.executionRoot(state));
  let sourceRemoval = null;
  try { fs.lstatSync(sourceRoot); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (stepId === "finalize-cleanup") {
      if (selected.receipt !== null) {
        selected.receipt.assertCurrent();
        sourceRemoval = new FlowProcessCheckoutRemoval({ sourceRoot, cleanupReceiptId: receipt.id });
      } else {
        const preparation = FinalizeCleanupEffectPreparation.acquire(ctx);
        if (preparation?.journal.atLeast("worktree-removed")) {
          sourceRemoval = new FlowProcessCheckoutRemoval({ sourceRoot,
            cleanupReceiptId: preparation.journal.value.executionReceiptId });
        }
      }
    }
  }
  const attempt = state.attempt === null ? null : CurrentAttemptIdentity.from(state.attempt);
  return new FlowProcessPhysicalAuthority({
    mainRoot: owner.mainRepoPath,
    sourceRoot,
    sourceRemoval,
    executionRoot: owner.authorityRoot,
    contextRoot: path.resolve(ctx.executionRoot || ctx.root),
    runId: selected.runId,
    specId: selected.specId,
    selection: new FlowProcessExecutionBinding({ runId: selected.runId, specId: selected.specId,
      nodeId: selected.stepId, attemptId: attempt?.id ?? null, attemptSequence: attempt?.sequence ?? null,
      attempt: state.attempt?.toJSON() ?? null, nodeStatus: state.findNode(selected.stepId)?.status ?? null,
      current: state.current, receipt: receipt?.toJSON?.() ?? receipt }),
  });
}
