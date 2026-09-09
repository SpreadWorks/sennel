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

  execute(ctx) {
    try {
      ctx.flowState = ctx.flowManager.loadReadOnly(ctx.specId);
      const typedState = ctx.flowManager.canonicalState(ctx.specId);
      const target = targetFor(ctx.flowState, typedState);
      if (target === null) throw new Error("finalization recovery requires a current flow-scoped finalization step");
      const interrupted = inspectInterruptedFinalizeSync(ctx);
      const planned = resolveFinalizationOutboxRecovery(ctx, ctx.flowState, target, null, interrupted);
      if (planned?.decision?.operation === "interrupted-sync-settlement") {
        const recovered = recoverInterruptedFinalizeSync(ctx);
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
        operation.assertOwned();
        owner.outbox({ operationOwnerToken: token }).reopenFailedExact(new FlowOutboxRecoveryClaim({
          identity,
          attempt: entry.attempt,
          failure: entry.failure,
          recoveryKey: entry.latestFailure?.recovery?.baseHead ?? null,
        }));
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
