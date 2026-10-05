import path from "node:path";

import { FlowManager } from "../../lib/flow-manager.js";
import { FlowOutboxStore } from "./flow-outbox.js";

/**
 * Owns every finalize lifecycle mutation against the single base-side
 * flow-state authority. Callers cannot independently choose a flow.json
 * writer based on the execution checkout.
 */
export class FinalizeFlowStateOwner {
  constructor({ flowManager, authorityRoot, mainRepoPath, specId }) {
    if (!flowManager || typeof flowManager !== "object") {
      throw new Error("finalize flow-state owner requires a FlowManager");
    }
    if (typeof mainRepoPath !== "string" || mainRepoPath.trim() === "") {
      throw new Error("finalize flow-state owner requires a main repository path");
    }
    if (typeof authorityRoot !== "string" || authorityRoot.trim() === "") {
      throw new Error("finalize flow-state owner requires an authority root");
    }
    if (typeof specId !== "string" || specId.trim() === "") {
      throw new Error("finalize flow-state owner requires a specId");
    }
    const ownerRoot = path.resolve(authorityRoot);
    if (
      typeof flowManager._root === "string"
      && path.resolve(flowManager._root) !== ownerRoot
    ) {
      throw new Error("finalize flow-state owner must use its selected authority FlowManager");
    }
    this.flowManager = flowManager;
    this.authorityRoot = ownerRoot;
    this.mainRepoPath = path.resolve(mainRepoPath);
    this.specId = specId;
    Object.freeze(this);
  }

  static fromContext(ctx) {
    if (!ctx?.flowManager) throw new Error("finalize flow-state owner requires a flow context");
    const specId = ctx.specId || ctx.flowState?.specId;
    const mainRepoPath = ctx.mainRoot || ctx.flowManager._mainRoot || ctx.root;
    const authorityRoot = ctx.root || ctx.flowManager._root;
    const flowManager = typeof ctx.flowManager._root !== "string"
      || path.resolve(ctx.flowManager._root) === path.resolve(authorityRoot)
      ? ctx.flowManager
      : ctx.flowManager.forRoot(authorityRoot, { specId });
    return new FinalizeFlowStateOwner({
      flowManager,
      authorityRoot,
      mainRepoPath,
      specId,
    });
  }

  static forMainContext(ctx) {
    if (!ctx?.flowManager) throw new Error("finalize main flow-state owner requires a flow context");
    const specId = ctx.specId || ctx.flowState?.specId;
    const existing = ctx.finalizeFlowStateOwner
      || ctx.finalizeCleanupStateResolution?.stateOwner;
    if (existing instanceof FinalizeFlowStateOwner) {
      if (existing.specId !== specId) {
        throw new Error("finalize flow-state owner targets a different spec");
      }
      const mainRepoPath = ctx.mainRoot || ctx.flowManager._mainRoot || ctx.root;
      if (existing.authorityRoot === path.resolve(mainRepoPath)) return existing;
    }
    const mainRepoPath = ctx.mainRoot || ctx.flowManager._mainRoot || ctx.root;
    return FinalizeFlowStateOwner.forMainRepository({
      sourceFlowManager: ctx.flowManager,
      mainRepoPath,
      specId,
    });
  }

  static forMainRepository({ sourceFlowManager = null, mainRepoPath, specId }) {
    const flowManager = sourceFlowManager
      ? (
          typeof sourceFlowManager._root === "string"
          && path.resolve(sourceFlowManager._root) === path.resolve(mainRepoPath)
            ? sourceFlowManager
            : sourceFlowManager.forRoot(mainRepoPath, { specId })
        )
      : new FlowManager({
          root: mainRepoPath,
          mainRoot: mainRepoPath,
          inWorktree: false,
          specId,
        });
    return new FinalizeFlowStateOwner({
      flowManager,
      authorityRoot: mainRepoPath,
      mainRepoPath,
      specId,
    });
  }

  bindContext(ctx) {
    ctx.finalizeFlowStateOwner = this;
    ctx.flowManager = this.flowManager;
    ctx.root = this.authorityRoot;
    ctx.specId = this.specId;
    return ctx;
  }

  loadReadOnly() {
    return this.flowManager.loadReadOnly(this.specId);
  }

  updateStepStatus(transition, {
    taskId = null,
    operationOwnerToken = null,
  } = {}) {
    return this.flowManager.updateStepStatus(transition, {
      specId: this.specId,
      taskId,
      operationOwnerToken,
    });
  }

  finalizeDownstream({ action, stepIds, operationOwnerToken = null } = {}) {
    return this.flowManager.finalizeDownstream({
      specId: this.specId,
      action,
      stepIds,
      operationOwnerToken,
    });
  }

  outbox({ operationOwnerToken = null } = {}) {
    return new FlowOutboxStore(this.flowManager, {
      specId: this.specId,
      operationOwnerToken,
    });
  }

  clearActiveFlow({ operationOwnerToken = null } = {}) {
    return this.flowManager.clearFlowState(this.specId, {
      operationOwnerToken,
    });
  }

  activeFlowIsCleared() {
    return !this.flowManager.loadActiveFlows()
      .some((entry) => entry.specId === this.specId);
  }

}
