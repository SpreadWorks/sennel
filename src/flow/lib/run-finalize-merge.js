import { executeFinalizationCommand, finalizationStepRegistration } from "../engine/composition/finalization.js";
import { FlowCommand } from "./base-command.js";
import { finalizationOutboxIdentity } from "./flow-outbox.js";

/**
 * Spec 251 R19: the self-contained finalize step transitions and the
 * cleanup-side commit transaction target the squash-merge route only
 * (`commands.gh != enable` OR `gh` unavailable). The PR route returns
 * after PR creation and leaves the post-merge sub-steps (finalize-sync /
 * finalize-cleanup) for an out-of-process flow once the PR lands. The
 * registered Step records the command observation, and Definition selects
 * Await when the Result indicates a PR was opened.
 */
export function executeFinalizeMergeInput(input) {
  const registration = finalizationStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Finalize merge execution requires its registered Step");
  const selection = registration.executionContract.select({ ...input, registration });
  return registration.executionContract.execute(selection, { ...input, registration });
}

export class RunFinalizeMergeCommand extends FlowCommand {
  async execute(ctx) {
    return executeFinalizationCommand({ ctx, command: this, stepId: "finalize-merge", executeInput: (input) => executeFinalizeMergeInput(input) });
  }

  async prepareEffect(ctx) {
    const state = ctx.flowState;
    const executionRoot = ctx.flowManager.executionRoot(state);
    const { worktreePath, mainRepoPath } = ctx.flowManager.resolveWorktreePaths(state);

    const { prepareMergeEffect } = await import("../commands/merge.js");
    return prepareMergeEffect({
      root: ctx.root,
      executionRoot,
      flowState: state,
      flowManager: ctx.flowManager,
      worktreePath,
      mainRepoPath,
      idempotencyKey: ctx.flowOutboxEntry?.idempotencyKey
        || finalizationOutboxIdentity(state, "finalize-merge").idempotencyKey,
      repositoryOperationOwnerToken: ctx.repositoryOperationOwnerToken ?? null,
    });
  }

  async executeEffect(ctx, preparation = null) {
    const acquired = preparation ?? await this.prepareEffect(ctx);
    const { runMerge } = await import("../commands/merge.js");
    const mergeResult = runMerge({ ...ctx, executionRoot: ctx.flowManager.executionRoot(ctx.flowState) }, acquired);
    return {
      status: mergeResult.strategy === "skip" ? "skipped" : "done",
      strategy: mergeResult?.strategy || "squash",
      mergedFromSha: mergeResult?.mergedFromSha ?? null,
      ...(mergeResult?.resumed ? { resumed: true } : {}),
      ...(mergeResult?.prNumber != null ? { prNumber: mergeResult.prNumber } : {}),
      ...(mergeResult?.prUrl != null ? { prUrl: mergeResult.prUrl } : {}),
    };
  }
}

export default RunFinalizeMergeCommand;
