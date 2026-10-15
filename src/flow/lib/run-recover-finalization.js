import { Envelope } from "../../lib/flow-envelope.js";
import { RepositoryFlowOperationLock } from "../../lib/repository-maintenance-lock.js";
import { FlowCommand } from "./base-command.js";
import { FinalizeFlowStateOwner } from "./finalize-flow-state-owner.js";
import { FlowOutboxRecoveryClaim, finalizationOutboxIdentity } from "./flow-outbox.js";
import { resolveFinalizationOutboxRecovery } from "./finalization-outbox-recovery.js";
import {
  inspectInterruptedFinalizeSync,
  recoverInterruptedFinalizeSync,
} from "./recover-interrupted-finalize-sync.js";
import { TaskNode } from "./current-flow-state.js";
import { finalizationStepRegistration, prepareFinalizationExecution } from "../engine/composition/finalization.js";
import { flowStepExecutionRegistration } from "../engine/composition/registered-step-execution.js";
import { FinalizeCleanupEffectPreparation } from "./finalize-cleanup-journal.js";
import { AcceptanceReceiptReplay } from "./acceptance-receipt-replay.js";
import { RunFinalizeCleanupCommand } from "./run-finalize-cleanup.js";

function replayFinalizationReceipt(receipt) {
  if (!(receipt instanceof AcceptanceReceiptReplay)) throw new TypeError("Finalization replay requires its authenticated receipt");
  receipt.assertCurrent();
  return receipt.receipt;
}

export function executeFinalizationRecoveryInput(input) {
  const registration = finalizationStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Finalization recovery requires its registered Step");
  const selection = input.selection;
  if (selection.registration !== registration) throw new TypeError("Finalization recovery requires its exact registration");
  if (selection.receipt !== null) return replayFinalizationReceipt(selection.receipt);
  return registration.executionContract.execute(selection, { ...input, registration });
}

function targetFor(state, typedState) {
  const descriptor = typedState.nextAction();
  if (descriptor === null) return null;
  const task = descriptor.path
    .map((nodeId) => typedState.findNode(nodeId))
    .find((node) => node instanceof TaskNode) ?? null;
  if (task !== null) return null;
  return { scope: "flow", stepId: descriptor.nodeId };
}

/**
 * Consume a Definition-selected finalization recovery.  The command re-reads
 * canonical facts before taking the operation lock, then re-reads again
 * under the lock so stale directives cannot change an outbox or step.
 */
export default class RunRecoverFinalizationCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true });
  }

  async execute(ctx) {
    try {
      ctx.flowState = ctx.flowManager.loadReadOnly(ctx.specId);
      const typedState = ctx.flowManager.canonicalState(ctx.specId);
      const target = targetFor(ctx.flowState, typedState);
      if (target === null) throw new Error("finalization recovery requires a current flow-scoped finalization step");
      const interrupted = inspectInterruptedFinalizeSync(ctx);
      const planned = resolveFinalizationOutboxRecovery(ctx, ctx.flowState, target, null, interrupted);
      if (planned?.decision?.operation === "interrupted-sync-settlement") {
        const recovered = await recoverInterruptedFinalizeSync(ctx);
        if (!recovered.recovered) throw new Error(recovered.busy ? "finalization recovery operation lock is busy" : "interrupted finalize-sync recovery is no longer eligible");
        return Envelope.ok("run", "recover-finalization", { operation: "interrupted-sync-settlement", step: "finalize-cleanup" });
      }
      if (planned?.decision?.operation !== "exact-outbox-recovery") {
        throw new Error(`Definition did not select an applicable finalization recovery: ${planned?.decision?.operation ?? "none"}`);
      }
      const owner = FinalizeFlowStateOwner.fromContext(ctx);
      const operation = new RepositoryFlowOperationLock({
        mainRoot: owner.mainRepoPath,
      });
      const token = operation.acquire();
      try {
        const state = owner.loadReadOnly();
        const exactTarget = targetFor(state, owner.flowManager.canonicalState(owner.specId));
        const selected = exactTarget === null ? null : resolveFinalizationOutboxRecovery(
          owner.bindContext({ ...ctx, flowState: state }),
          state,
          exactTarget,
          null,
          null,
          token,
        );
        if (selected?.decision?.operation !== "exact-outbox-recovery") {
          throw new Error("Definition selection changed before finalization recovery could be applied");
        }
        const identity = finalizationOutboxIdentity(state, exactTarget.stepId);
        const entry = owner.outbox({ operationOwnerToken: token }).status(identity);
        const cleanupProof = exactTarget.stepId === "finalize-cleanup"
          ? FinalizeCleanupEffectPreparation.acquire(owner.bindContext({ ...ctx, flowState: state }), { failed: true }) : null;
        operation.assertOwned();
        owner.outbox({ operationOwnerToken: token }).reopenFailedExact(new FlowOutboxRecoveryClaim({
          identity,
          attempt: entry.attempt,
          failure: entry.failure,
          recoveryKey: entry.latestFailure?.recovery?.baseHead ?? null,
        }));
        const registration = flowStepExecutionRegistration(exactTarget.stepId);
        if (registration?.executionContract.selectorName === "selectFinalizationExecution") {
          const recoveryContext = owner.bindContext({ ...ctx, flowState: owner.loadReadOnly(), repositoryOperationOwnerToken: token });
          delete recoveryContext.finalizationExecution;
          if (cleanupProof !== null) {
            recoveryContext.finalizationEffectPreparation = FinalizeCleanupEffectPreparation.acquire(recoveryContext);
          }
          const preparation = prepareFinalizationExecution({ ctx: recoveryContext, stepId: exactTarget.stepId,
            recovery: selected.decision });
          const selection = registration.executionContract.select({ ctx: recoveryContext, stepId: exactTarget.stepId, preparation, registration });
          const outcome = await executeFinalizationRecoveryInput({ ctx: recoveryContext, flowManager: owner.flowManager,
            stepId: exactTarget.stepId, preparation, selection });
          const receipt = selection.receipt === null ? outcome.receipt : outcome;
          if (exactTarget.stepId === "finalize-cleanup" && receipt.settlementKind === "completion") {
            return new RunFinalizeCleanupCommand().projectCompletedReceipt(recoveryContext, receipt);
          }
        }
        return Envelope.ok("run", "recover-finalization", {
          operation: "exact-outbox-recovery",
          step: exactTarget.stepId,
          idempotencyKey: identity.idempotencyKey,
        });
      } finally {
        operation.release();
      }
    } catch (error) {
      return Envelope.fail("run", "recover-finalization", error.code || "FINALIZATION_RECOVERY_NOT_ADMITTED", error.message);
    }
  }
}
