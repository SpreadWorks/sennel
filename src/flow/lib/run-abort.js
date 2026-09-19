import fs from "node:fs";
import path from "node:path";
import { AtomicJsonFile } from "../../lib/atomic-json-file.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { listUncommittedFiles, runGit } from "../../lib/git-helpers.js";
import { RepositoryFlowOperationLock } from "../../lib/repository-maintenance-lock.js";
import { WorktreeFlowIdentity } from "../../lib/worktree-flow-binding.js";
import { FlowCommand } from "./base-command.js";
import { PRODUCT } from "../../lib/product.js";
import {
  deleteFeatureBranchForCleanup,
  removeWorktreeForCleanup,
} from "./run-finalize-cleanup.js";

const ABORT_PHASES = Object.freeze([
  "prepared",
  "worktree-removed",
  "branch-deleted",
  "active-cleared",
  "spec-removed",
]);
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

class FlowAbortJournal {
  static pathFor(root, specId) {
    return path.join(root, PRODUCT.managedPath("recovery", "flow-abort", `${specId}.json`));
  }

  constructor({ root, state, worktreePath, featureSha }) {
    const directory = path.join(root, PRODUCT.managedPath("recovery", "flow-abort"));
    fs.mkdirSync(directory, { recursive: true });
    this.file = new AtomicJsonFile(FlowAbortJournal.pathFor(root, state.specId));
    this.value = this.file.read(null) || {
      version: 1,
      runId: state.runId,
      specId: state.specId,
      featureBranch: state.featureBranch,
      baseBranch: state.baseBranch,
      worktreePath: worktreePath || null,
      featureSha,
      phase: "prepared",
      updatedAt: new Date().toISOString(),
    };
    if (
      this.value.version !== 1
      || this.value.runId !== state.runId
      || this.value.specId !== state.specId
      || this.value.featureBranch !== state.featureBranch
      || this.value.baseBranch !== state.baseBranch
      || !ABORT_PHASES.includes(this.value.phase)
      || (
        state.featureBranch === null
          ? this.value.featureSha !== null
          : !GIT_OBJECT_ID.test(String(this.value.featureSha))
      )
    ) {
      throw new Error("flow abort journal does not match the selected flow");
    }
    this.file.write(this.value);
  }

  atLeast(phase) {
    return ABORT_PHASES.indexOf(this.value.phase) >= ABORT_PHASES.indexOf(phase);
  }

  advance(phase) {
    if (this.atLeast(phase)) return;
    if (ABORT_PHASES.indexOf(phase) !== ABORT_PHASES.indexOf(this.value.phase) + 1) {
      throw new Error(`invalid flow abort transition: ${this.value.phase} -> ${phase}`);
    }
    this.value = { ...this.value, phase, updatedAt: new Date().toISOString() };
    this.file.write(this.value);
  }
}

function branchSha(root, branch) {
  const result = runGit(["-C", root, "rev-parse", `refs/heads/${branch}`]);
  if (!result.ok || !GIT_OBJECT_ID.test(result.stdout.trim())) {
    throw new Error(`flow abort feature branch could not be resolved: ${branch}`);
  }
  return result.stdout.trim();
}

function outsideTargetSpec(filePath, relativeSpecDirectory) {
  return filePath !== relativeSpecDirectory && !filePath.startsWith(`${relativeSpecDirectory}/`);
}

export class RunAbortCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true, recoveryTargetResolution: true });
  }

  async execute(ctx) {
    const state = ctx.flowState;
    const specLocation = ctx.specLocation || ctx.flowManager.specLocation(state.specId);
    const repositoryRoot = specLocation.repositoryRoot;
    const { worktreePath } = ctx.flowManager.resolveWorktreePaths(state);
    const ownsFeatureBranch = state.featureBranch !== null && state.featureBranch !== state.baseBranch;
    const operation = new RepositoryFlowOperationLock({ mainRoot: repositoryRoot });
    const operationOwnerToken = operation.acquire();
    try {
      const journal = new FlowAbortJournal({
        root: repositoryRoot,
        state,
        worktreePath,
        featureSha: fs.existsSync(FlowAbortJournal.pathFor(repositoryRoot, state.specId))
          || state.featureBranch === null
          ? null
          : branchSha(repositoryRoot, state.featureBranch),
      });

      if (!journal.atLeast("worktree-removed")) {
        if (state.worktree && worktreePath && fs.existsSync(worktreePath)) {
          const worktreeManager = ctx.flowManager.forRoot(worktreePath, { specId: state.specId });
          const expectedBinding = worktreeManager.usesWorktreeFlowBinding()
            ? new WorktreeFlowIdentity({
                runId: state.runId,
                issue: state.issue ?? null,
                specId: state.specId,
                worktreePath,
              })
            : null;
          const removed = removeWorktreeForCleanup({
            mainRepoPath: repositoryRoot,
            worktreePath,
            featureBranch: state.featureBranch,
            force: ctx.force === true,
            expectedBinding,
          });
          if (!removed.ok) return removed.env;
        } else if (!state.worktree && ownsFeatureBranch) {
          const unrelatedDirty = listUncommittedFiles({ cwd: repositoryRoot })
            .filter((filePath) => outsideTargetSpec(filePath, specLocation.relativeDirectory));
          if (unrelatedDirty.length > 0) {
            return Envelope.fail(
              "run",
              "abort",
              "ABORT_UNRELATED_DIRTY",
              "Non-worktree abort stopped because unrelated dirty files are present.",
              { dirtyFiles: unrelatedDirty },
            );
          }
          const switched = runGit(["-C", repositoryRoot, "switch", state.baseBranch]);
          if (!switched.ok) {
            return Envelope.fail("run", "abort", "ABORT_BASE_SWITCH_FAILED", switched.stderr || switched.stdout);
          }
        }
        journal.advance("worktree-removed");
      }

      if (!journal.atLeast("branch-deleted")) {
        if (ownsFeatureBranch) {
          const branch = runGit(["-C", repositoryRoot, "rev-parse", "--verify", `refs/heads/${state.featureBranch}`]);
          if (branch.ok) {
            const deleted = deleteFeatureBranchForCleanup({
              mainRepoPath: repositoryRoot,
              featureBranch: state.featureBranch,
              expectedSha: journal.value.featureSha,
            });
            if (!deleted.ok) return deleted.env;
          }
        }
        journal.advance("branch-deleted");
      }

      if (!journal.atLeast("active-cleared")) {
        ctx.flowManager.removeActiveFlow(state.specId, { operationOwnerToken });
        journal.advance("active-cleared");
      }

      if (!journal.atLeast("spec-removed")) {
        fs.rmSync(specLocation.directory, { recursive: true });
        journal.advance("spec-removed");
      }

      return {
        status: "aborted",
        specId: state.specId,
        removed: {
          worktree: state.worktree ? worktreePath : null,
          branch: ownsFeatureBranch ? state.featureBranch : null,
          specDir: specLocation.relativeDirectory,
        },
      };
    } finally {
      operation.release();
    }
  }
}

export default RunAbortCommand;
