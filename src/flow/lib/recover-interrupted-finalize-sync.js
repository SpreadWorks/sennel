import { RepositoryFlowOperationLock } from "../../lib/repository-maintenance-lock.js";
import { runtimeLogFileForContext } from "../../lib/runtime-log.js";
import { FinalizeFlowStateOwner } from "./finalize-flow-state-owner.js";
import { FlowOutboxStore, finalizationOutboxIdentity } from "./flow-outbox.js";
import { resolveFinalizationOutboxRecovery } from "./finalization-outbox-recovery.js";
import { findStepById } from "./step-tree.js";
import { FinalizeSyncInterruptedError } from "./finalize-sync-diagnostics.js";
import { finalizationStepRegistration, prepareFinalizationExecution } from "../engine/composition/finalization.js";
import { flowStepExecutionRegistration } from "../engine/composition/registered-step-execution.js";
import { AcceptanceReceiptReplay } from "./acceptance-receipt-replay.js";

function replayInterruptedFinalizeSyncReceipt(receipt) {
  if (!(receipt instanceof AcceptanceReceiptReplay)) throw new TypeError("Interrupted sync replay requires its authenticated receipt");
  receipt.assertCurrent();
  return receipt.receipt;
}

export function executeInterruptedFinalizeSyncRecoveryInput(input) {
  const registration = finalizationStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Interrupted sync recovery requires its registered Step");
  const selection = input.selection;
  if (selection.registration !== registration) throw new TypeError("Interrupted sync recovery requires its exact registration");
  if (selection.receipt !== null) return replayInterruptedFinalizeSyncReceipt(selection.receipt);
  return registration.executionContract.execute(selection, { ...input, registration });
}

function incompleteRuntimeLog(root, state) {
  const file = runtimeLogFileForContext({
    root,
    specId: state.specId,
  });
  const block = file.blocks()
    .filter((candidate) => (
      candidate.runId === state.runId
      && candidate.command === "flow run finalize-sync"
    ))
    .at(-1) || null;
  if (!block || block.complete) return null;
  return {
    runId: block.runId,
    sequence: block.sequence,
    command: block.command,
    startedAt: block.startedAt,
    complete: false,
  };
}

/**
 * Read the exact interruption receipt without claiming a lock or changing
 * state.  `get next-action` may use this fact, but only the recovery command
 * is allowed to settle it.
 */
export function inspectInterruptedFinalizeSync(ctx) {
  const localState = ctx.flowState;
  const localSyncStep = findStepById(localState?.steps || [], "finalize-sync");
  if (localSyncStep?.status !== "in_progress" || typeof ctx.flowManager?.forRoot !== "function") return null;
  const stateOwner = FinalizeFlowStateOwner.forMainContext(ctx);
  const state = stateOwner.loadReadOnly();
  if (!state || findStepById(state.steps || [], "finalize-sync")?.status !== "in_progress") return null;
  const identity = finalizationOutboxIdentity(state, "finalize-sync");
  if (stateOwner.outbox().status(identity)?.status !== "pending") return null;
  return incompleteRuntimeLog(stateOwner.mainRepoPath, state);
}

/**
 * Settle a stale, pre-return finalize-sync attempt. The repository operation
 * lock proves that no sync process currently owns the side-effect boundary;
 * only then can its pending outbox be converted into an auditable skip.
 */
export async function recoverInterruptedFinalizeSync(ctx) {
  const localState = ctx.flowState;
  const localSyncStep = findStepById(localState?.steps || [], "finalize-sync");
  if (localSyncStep?.status !== "in_progress") return { recovered: false, busy: false };
  if (typeof ctx.flowManager?.forRoot !== "function") return { recovered: false, busy: false };
  const localIdentity = finalizationOutboxIdentity(localState, "finalize-sync");
  const localEntry = new FlowOutboxStore(ctx.flowManager, { specId: localState.specId }).status(localIdentity);
  if (localEntry?.status !== "pending") return { recovered: false, busy: false };

  const stateOwner = FinalizeFlowStateOwner.forMainContext(ctx);
  const state = stateOwner.loadReadOnly();
  if (!state) return { recovered: false, busy: false };
  const syncStep = findStepById(state.steps || [], "finalize-sync");
  if (syncStep?.status !== "in_progress") return { recovered: false, busy: false };
  const identity = finalizationOutboxIdentity(state, "finalize-sync");
  const entry = stateOwner.outbox().status(identity);
  if (entry?.status !== "pending") return { recovered: false, busy: false };

  const operation = new RepositoryFlowOperationLock({
    mainRoot: stateOwner.mainRepoPath,
  });
  let token;
  try {
    token = operation.acquire();
  } catch (error) {
    if (["REPOSITORY_FLOW_OPERATION_BUSY", "REPOSITORY_MAINTENANCE_BUSY"].includes(error.code)) {
      return { recovered: false, busy: true };
    }
    throw error;
  }

  try {
    const lockedState = stateOwner.loadReadOnly();
    const runtimeLog = incompleteRuntimeLog(stateOwner.mainRepoPath, lockedState);
    const lockedContext = stateOwner.bindContext({ ...ctx, flowState: lockedState });
    const selected = resolveFinalizationOutboxRecovery(
      lockedContext,
      lockedState,
      { scope: "flow", stepId: "finalize-sync" },
      null,
      runtimeLog,
      token,
    );
    if (selected?.decision?.operation !== "interrupted-sync-settlement") {
      return { recovered: false, busy: false };
    }
    operation.assertOwned();
    const interruption = new FinalizeSyncInterruptedError({ runtimeLog });
    const recoveryContext = { ...lockedContext, repositoryOperationOwnerToken: token };
    const previous = stateOwner.flowManager.readCurrentStepSettlement({ specId: stateOwner.specId, stepId: "finalize-sync" });
    const commandResult = { status: "skipped", warning: true, runtimeLog,
      failure: { code: interruption.code, message: interruption.message, data: interruption.data } };
    const preparation = prepareFinalizationExecution({ ctx: recoveryContext, stepId: "finalize-sync", commandResult,
      execution: previous?.result.execution ?? null });
    const registration = flowStepExecutionRegistration("finalize-sync");
    const selection = registration.executionContract.select({ ctx: recoveryContext, stepId: "finalize-sync",
      preparation, registration });
    const outcome = await executeInterruptedFinalizeSyncRecoveryInput({ ctx: recoveryContext,
      flowManager: stateOwner.flowManager, stepId: "finalize-sync", preparation, selection, commandResult });
    return { recovered: true, busy: false, stateOwner, runtimeLog, decision: selected.decision, receipt: outcome.receipt };
  } finally {
    operation.release();
  }
}
