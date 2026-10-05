import { Envelope } from "../../lib/flow-envelope.js";
import { bindFlowStateLocation } from "../../lib/flow-workspace.js";
import { WorktreeFlowProvenance } from "../../lib/worktree-flow-binding.js";
import { FinalizeFlowStateOwner } from "./finalize-flow-state-owner.js";
import { findStepById } from "./step-tree.js";

class FinalizeFlowIdentity {
  constructor(state, label) {
    if (!state || typeof state !== "object") throw new Error(`${label} flow state is required`);
    if (typeof state.runId !== "string" || state.runId.trim() === "") {
      throw new Error(`${label} flow state requires runId`);
    }
    if (typeof state.specId !== "string" || state.specId.trim() === "") {
      throw new Error(`${label} flow state requires specId`);
    }
    this.runId = state.runId;
    this.specId = state.specId;
    this.issue = state.issue ?? null;
    this.featureBranch = state.featureBranch ?? null;
    this.baseBranch = state.baseBranch ?? null;
    this.worktree = state.worktree === true;
    Object.freeze(this);
  }

  equals(other) {
    return other instanceof FinalizeFlowIdentity
      && this.runId === other.runId
      && this.specId === other.specId
      && String(this.issue ?? "") === String(other.issue ?? "")
      && this.featureBranch === other.featureBranch
      && this.baseBranch === other.baseBranch
      && this.worktree === other.worktree;
  }

  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      issue: this.issue,
      featureBranch: this.featureBranch,
      baseBranch: this.baseBranch,
      worktree: this.worktree,
    };
  }
}

export class FinalizeCleanupStateResolution {
  constructor({
    state,
    stateOwner,
    worktreePath,
    mainRepoPath,
  }) {
    this.state = state;
    this.stateOwner = stateOwner;
    this.worktreePath = worktreePath;
    this.mainRepoPath = mainRepoPath;
    Object.freeze(this);
  }

  static resolve(ctx) {
    const selectedState = ctx.flowState;
    const specId = selectedState?.specId;
    if (!specId) {
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "FINALIZE_FLOW_STATE_MISMATCH",
        "The selected flow does not have a specId.",
      );
    }
    const stateOwner = FinalizeFlowStateOwner.forMainContext({ ...ctx, specId });
    const { mainRepoPath } = stateOwner;
    const mainState = stateOwner.loadReadOnly();
    if (!mainState) {
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "FINALIZE_MAIN_FLOW_MISSING",
        [
          `Main repository flow state is missing for ${specId}.`,
          "No finalize step, commit, active-flow, worktree, branch, or Git history cleanup was attempted.",
        ],
        { specId, mainRepoPath },
      );
    }

    const selectedIdentity = new FinalizeFlowIdentity(selectedState, "selected");
    const mainIdentity = new FinalizeFlowIdentity(mainState, "main");
    const selectedPaths = ctx.flowManager.resolveWorktreePaths(selectedState);
    const worktreePath = ctx.worktreeFlowProvenance instanceof WorktreeFlowProvenance
      ? ctx.worktreeFlowProvenance.identity.worktreePath
      : selectedPaths.worktreePath;
    if (!mainIdentity.equals(selectedIdentity)) {
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "FINALIZE_FLOW_STATE_MISMATCH",
        [
          "Main repository and active-flow state do not identify the same finalize run.",
          "No finalize step, commit, active-flow, worktree, branch, or Git history cleanup was attempted.",
        ],
        {
          selected: selectedIdentity.toJSON(),
          main: mainIdentity.toJSON(),
          active: selectedIdentity.toJSON(),
        },
      );
    }

    const mainCleanup = findStepById(mainState.steps || [], "finalize-cleanup");
    const cleanupStep = mainCleanup;
    if (!cleanupStep) {
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "FINALIZE_CLEANUP_STEP_MISSING",
        [
          "finalize-cleanup is registered in the current flow definition but is absent from the base-side flow state.",
          "No finalize step, commit, active-flow, worktree, branch, or Git history cleanup was attempted.",
        ],
        { specId, runId: mainIdentity.runId },
      );
    }

    return new FinalizeCleanupStateResolution({
      state: bindFlowStateLocation(
        structuredClone(mainState),
        stateOwner.flowManager.specLocation(specId),
      ),
      stateOwner,
      worktreePath,
      mainRepoPath,
    });
  }

  ensureCleanupStep() {}
}
