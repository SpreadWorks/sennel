import { executeFinalizationCommand, finalizationStepRegistration } from "../engine/composition/finalization.js";
import path from "path";
import { runManagedCmdAsync } from "../../lib/process.js";
import { RuntimeChildExecution } from "../../lib/runtime-package.js";
import { PKG_DIR } from "../../lib/cli.js";
import { runGit } from "../../lib/git-helpers.js";
import { PRODUCT } from "../../lib/product.js";
import { FlowCommand } from "./base-command.js";
import { withFlowProcessRuntime } from "./process-runtime-admission.js";
import { captureFinalizationProcessAuthority } from "./finalization-process-authority.js";
import { hasOutboxCommit } from "./run-finalize.js";
import { FINALIZE_DOCUMENTATION_PATHS } from "./finalize-commit-paths.js";
import {
  FinalizeSyncDiagnostic,
  FinalizeSyncExecutionError,
} from "./finalize-sync-diagnostics.js";

export function executeFinalizeSyncInput(input) {
  const registration = finalizationStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Finalize sync execution requires its registered Step");
  const selection = registration.executionContract.select({ ...input, registration });
  return registration.executionContract.execute(selection, { ...input, registration });
}

export class RunFinalizeSyncCommand extends FlowCommand {
  constructor({
    runCommand = runManagedCmdAsync,
    git = runGit,
    hasCommit = hasOutboxCommit,
    packageDir = PKG_DIR,
  } = {}) {
    super();
    this.runCommand = runCommand;
    this.git = git;
    this.hasCommit = hasCommit;
    this.packageDir = packageDir;
  }

  async execute(ctx) {
    return withFlowProcessRuntime(ctx, () => executeFinalizationCommand({ ctx, command: this,
      stepId: "finalize-sync", executeInput: (input) => executeFinalizeSyncInput(input) }), { commandId: "finalize-sync",
      physicalAuthority: (context) => captureFinalizationProcessAuthority(context, "finalize-sync") });
  }

  async executeEffect(ctx) {
    const state = ctx.flowState;
    const { root } = ctx;
    const { mainRepoPath } = ctx.flowManager.resolveWorktreePaths(state);

    const syncCwd = (state.worktree && mainRepoPath) ? mainRepoPath : root;
    try {
      const diagnostics = [];
      const idempotencyKey = ctx.flowOutboxEntry?.idempotencyKey || null;
      if (this.hasCommit({ root: syncCwd, ref: "HEAD", idempotencyKey })) {
        return { status: "done", resumed: true };
      }
      const run = (phase, command) => {
        const result = command();
        diagnostics.push(new FinalizeSyncDiagnostic({ phase, result }));
        if (!result.ok) {
          throw new FinalizeSyncExecutionError({ phase, diagnostics });
        }
        return result;
      };
      const buildScript = path.join(this.packageDir, "docs.js");
      const buildResult = await RuntimeChildExecution.runAsync(buildScript, ["build"], {
        cwd: syncCwd,
        env: {
          ...process.env,
          [PRODUCT.env("WORK_ROOT")]: syncCwd,
          [PRODUCT.env("SOURCE_ROOT")]: syncCwd,
        },
      }, this.runCommand);
      run("docs-build", () => buildResult);
      const statRes = run("git-diff-stat", () => this.git(["diff", "--stat", "--", ...FINALIZE_DOCUMENTATION_PATHS], { cwd: syncCwd }));
      const nameRes = run("git-diff-name", () => this.git(["diff", "--name-only", "--", ...FINALIZE_DOCUMENTATION_PATHS], { cwd: syncCwd }));
      return {
        status: nameRes.stdout.trim() ? "done" : "skipped",
        ...(!nameRes.stdout.trim() && { message: "nothing to commit" }),
        ...(statRes.stdout.trim() && { diffStat: statRes.stdout.trim() }),
        ...(nameRes.stdout.trim() && { diffSummary: nameRes.stdout.trim() }),
        diagnostics: diagnostics.map((entry) => entry.toJSON()),
      };
    } catch (error) {
      if (error instanceof FinalizeSyncExecutionError) {
        const status = this.git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: syncCwd });
        error.data.diagnostics.push(new FinalizeSyncDiagnostic({ phase: "git-status-after-failure", result: status }).toJSON());
      }
      throw error;
    }
  }
}

export default RunFinalizeSyncCommand;
