import { runGit } from "../../lib/git-helpers.js";
import { FlowCommand } from "./base-command.js";
import {
  runFinalizePreflight,
  runPreflightChecks,
  commitOrSkip,
  hasOutboxCommit,
  outboxCommitMarker,
  runMigrationHook,
} from "./run-finalize.js";
import { FinalizeCommitPathSet } from "./finalize-commit-paths.js";

export class RunFinalizeCommitCommand extends FlowCommand {
  async execute(ctx) {
    const root = ctx.executionRoot || ctx.root;
    const artifactRoot = ctx.repositoryRoot || ctx.root;
    const state = ctx.flowState;
    const message = ctx.message || "";
    const idempotencyKey = ctx.flowOutboxEntry?.idempotencyKey || null;

    if (hasOutboxCommit({ root, ref: "HEAD", idempotencyKey })) {
      return {
        status: "done",
        message: message || `feat: ${state.featureBranch || "finalize"}`,
        resumed: true,
      };
    }

    await runFinalizePreflight(root);

    const preflight = runPreflightChecks({
      root,
      baseBranch: state.baseBranch,
      featureBranch: state.featureBranch,
      commitStepActive: true,
    });
    if (!preflight.ok) {
      return {
        result: "preflight_failed",
        status: "failed",
        reason: preflight.reason,
        ...(preflight.reason === "no-commits"
          ? {
              baseBranch: preflight.baseBranch,
              featureBranch: preflight.featureBranch,
              hasUncommitted: preflight.hasUncommitted,
            }
          : { uncommittedFiles: preflight.uncommittedFiles }),
        message:
          preflight.reason === "no-commits"
            ? `no commits on ${preflight.featureBranch} beyond ${preflight.baseBranch}` +
              (preflight.hasUncommitted ? " (uncommitted changes present)" : "")
            : `uncommitted changes in worktree: ${preflight.uncommittedFiles.join(", ")}`,
      };
    }

    runMigrationHook(artifactRoot, ctx.flowManager.specLocation(state.specId).relativeSpecFile, root);
    const specId = state.specId;

    const commitPaths = new FinalizeCommitPathSet({
      repositoryRoot: artifactRoot,
      specRoot: ctx.specRoot,
      specId,
    });
    const add = runGit(["add", "-A", "--", ".", ...commitPaths.implementationExclusions], { cwd: root });
    if (!add.ok) throw new Error(`failed to stage implementation paths: ${add.stderr || add.stdout}`);

    const msg = message || `feat: ${state.featureBranch || "finalize"}`;
    const markerArgs = idempotencyKey ? ["-m", outboxCommitMarker(idempotencyKey)] : [];
    const res = commitOrSkip(["-m", msg, ...markerArgs], { cwd: root });
    return { ...res, message: msg };
  }
}

export default RunFinalizeCommitCommand;
