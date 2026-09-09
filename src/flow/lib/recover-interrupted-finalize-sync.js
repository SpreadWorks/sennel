import { RepositoryFlowOperationLock } from "../../lib/repository-maintenance-lock.js";
import { runtimeLogFileForContext } from "../../lib/runtime-log.js";
import { FinalizeFlowStateOwner } from "./finalize-flow-state-owner.js";
import { FlowOutboxStore, finalizationOutboxIdentity } from "./flow-outbox.js";
import { resolveFinalizationOutboxRecovery } from "./finalization-outbox-recovery.js";
import { findStepById } from "./step-tree.js";

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
export function recoverInterruptedFinalizeSync(ctx) {
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
    stateOwner.flowManager.recoverInterruptedFinalizeSync({ specId: stateOwner.specId, runtimeLog, operationOwnerToken: token });
    return { recovered: true, busy: false, stateOwner, runtimeLog, decision: selected.decision };
  } finally {
    operation.release();
  }
}
