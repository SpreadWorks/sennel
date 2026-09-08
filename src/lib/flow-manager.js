/**
 * src/lib/flow-manager.js
 *
 * Facade for Spec-Driven Development flow state management. Owns:
 *   - CanonicalFlowManagerStore : Version-1 flow.json I/O + typed Activities
 *   - ActiveFlowRegistry    : .sennel/.active-flow pointer
 *   - PreparingFlowStore    : .sennel/.active-flow.<runId> transient state
 *
 * Constructed once per CLI process by `container.js` with paths already
 * resolved by Container — no `workRoot` argument is needed on any method.
 */

import fs from "fs";
import path from "path";
import { managedDir } from "./config.js";
import { withSpecIdArgDefault, withSpecIdDefault } from "./flow-options.js";
import { ActiveFlowRegistry } from "./active-flow-registry.js";
import { PreparingFlowStore } from "./preparing-flow-store.js";
import { FlowTargetExpectation } from "./flow-target-guard.js";
import { findInProgressLeaf } from "../flow/lib/step-tree.js";
import { CurrentFlowTransitionSnapshot } from "../flow/lib/current-flow-state.js";
import { WorktreeFlowBindingStore } from "./worktree-flow-binding.js";
import { RepositoryFlowOperationLock } from "./repository-maintenance-lock.js";
import { bindFlowStateLocation, DEFAULT_FLOW_SPEC_DIR, FlowWorkspace } from "./flow-workspace.js";
import { FlowVersion } from "./flow-version.js";
import {
  CanonicalFlowCreateRequest,
  CanonicalFlowManagerStore,
  canonicalFlowVersionLocation,
} from "../flow/lib/canonical-flow-manager-store.js";
import {
  FlowTargetAuthorityError,
  FlowTargetIdentity,
  FlowTargetIdentityAuthority,
  FlowTargetRecoveryError,
} from "./flow-target-identity-authority.js";
import { FlowRecoveryTarget } from "./flow-recovery-target.js";

const ACTIVE_FLOW_MODES = new Set(["worktree", "branch", "direct"]);

export class ResolvedFlowTarget {
  constructor({ state, specId = null, worktreePath = null, mainRoot, authorityRoot, preparing = false }) {
    if (!state || typeof state !== "object") throw new Error("resolved flow target state is required");
    if (!state.runId) throw new Error("resolved flow target runId is required");
    if (!mainRoot) throw new Error("resolved flow target main root is required");
    if (!authorityRoot) throw new Error("resolved flow target authority root is required");
    this.state = state;
    this.specId = state.specId ?? specId;
    this.worktreePath = worktreePath;
    this.mainRoot = mainRoot;
    this.authorityRoot = authorityRoot;
    this.preparing = Boolean(preparing);
    if (this.preparing && this.specId != null) {
      throw new Error("preparing flow target must not have a spec");
    }
    if (!this.preparing && !this.specId) {
      throw new Error("active flow target spec is required");
    }
    Object.freeze(this);
  }

  matches(expectation) {
    if (!(expectation instanceof FlowTargetExpectation) || expectation.empty) return false;
    if (this.mismatchAgainst(expectation)) return false;
    return true;
  }

  mismatchAgainst(expectation) {
    if (!(expectation instanceof FlowTargetExpectation) || expectation.empty) return null;
    if (this.preparing && expectation.binding) {
      return expectation.mismatchAgainst(this.state) || {
        expectedSpec: expectation.binding.specId,
        activeSpec: null,
      };
    }
    if (expectation.binding) {
      try {
        expectation.binding.assertCurrent(this.bindingInput());
      } catch (error) {
        if (error?.code === "ACTIVE_FLOW_MISMATCH") return error.data;
        throw error;
      }
    }
    return expectation.mismatchAgainst(this.state);
  }

  bindingInput() {
    return {
      flowState: this.state,
      mainRoot: this.mainRoot,
      authorityRoot: this.authorityRoot,
      ...(this.worktreePath && { worktreePath: this.worktreePath }),
    };
  }
}

export class ActiveFlowIdentityEntry {
  constructor({ entry, identity } = {}) {
    if (!entry || typeof entry !== "object") throw new Error("active flow identity entry is required");
    if (typeof entry.specId !== "string" || entry.specId.trim() === "") {
      throw new Error("active flow identity specId is required");
    }
    if (!ACTIVE_FLOW_MODES.has(entry.mode)) throw new Error("active flow identity mode is invalid");
    if (!(identity instanceof FlowTargetIdentity) || identity.lifecycle !== "active") {
      throw new Error(`active flow identity authority is unavailable for ${entry.specId}`);
    }
    if (identity.specId !== entry.specId || identity.mode !== entry.mode) {
      throw new Error(`active flow identity specId mismatch for ${entry.specId}`);
    }
    this.runId = identity.runId;
    this.issue = identity.issue;
    this.specId = entry.specId;
    this.mode = entry.mode;
    Object.freeze(this);
  }

  get key() {
    return `${this.runId}\u0000${this.issue ?? "none"}\u0000${this.specId}\u0000${this.mode}`;
  }

  toJSON() {
    return {
      runId: this.runId,
      issue: this.issue,
      specId: this.specId,
      mode: this.mode,
    };
  }
}

export class ActiveFlowIdentitySnapshot {
  constructor({ entries, revision } = {}) {
    if (!Array.isArray(entries)) throw new Error("active flow identity snapshot entries are required");
    if (revision != null && typeof revision !== "string") {
      throw new Error("active flow identity snapshot revision is invalid");
    }
    this.entries = Object.freeze(entries.map((entry) => (
      entry instanceof ActiveFlowIdentityEntry ? entry : new ActiveFlowIdentityEntry(entry)
    )));
    this.revision = revision;
    Object.freeze(this);
  }

  toJSON() {
    return {
      entries: this.entries.map((entry) => entry.toJSON()),
      revision: this.revision,
    };
  }
}

export class FlowTargetNotFoundError extends Error {
  constructor(expectation, matchCount = 0) {
    super(`explicit flow target not found: ${flowTargetSummary(expectation)}`);
    this.code = "FLOW_TARGET_NOT_FOUND";
    this.data = flowTargetErrorData(expectation, matchCount);
  }
}

export class FlowTargetAmbiguousError extends Error {
  constructor(expectation, matchCount) {
    super(`explicit flow target is ambiguous: ${flowTargetSummary(expectation)}`);
    this.code = "FLOW_TARGET_AMBIGUOUS";
    this.data = flowTargetErrorData(expectation, matchCount);
  }
}

function flowTargetSummary(expectation) {
  return [
    expectation.runId && `runId ${expectation.runId}`,
    expectation.issue && `Issue #${expectation.issue}`,
    expectation.issueAbsent && "no Issue",
    expectation.specId && `spec ${expectation.specId}`,
  ].filter(Boolean).join(", ");
}

function flowTargetErrorData(expectation, matchCount) {
  return {
    matchCount,
    ...(expectation.runId != null && { expectedRunId: expectation.runId }),
    ...((expectation.issue != null || expectation.issueAbsent) && {
      expectedIssue: expectation.issue,
    }),
    ...(expectation.specId != null && { expectedSpec: expectation.specId }),
  };
}

function resolveUniqueFlowTarget(expectation, targets) {
  if (targets.length === 0) throw new FlowTargetNotFoundError(expectation);
  if (targets.length > 1) throw new FlowTargetAmbiguousError(expectation, targets.length);
  return targets[0];
}

function activeFlowExpectation(opts) {
  const expectation = new FlowTargetExpectation({
    ...(opts.selectRunId != null && { expectRunId: opts.selectRunId }),
    ...(opts.selectSpecId != null && { expectSpec: opts.selectSpecId }),
    ...(opts.selectIssue != null && { expectIssue: opts.selectIssue }),
    ...(opts.selectNoIssue === true && { expectNoIssue: true }),
  });
  return expectation.empty ? null : expectation;
}

class ActiveFlowMismatchError extends Error {
  constructor(expectation, state, data = expectation.mismatchAgainst(state)) {
    super("managed worktree flow identity does not match the specified target");
    this.code = "ACTIVE_FLOW_MISMATCH";
    this.data = data;
  }
}

function isManagedFlowWorktree(root, mainRoot, inWorktree) {
  if (!inWorktree || !root || !mainRoot) return false;
  const resolvedRoot = path.resolve(root);
  const resolvedMainRoot = path.resolve(mainRoot);
  const canonicalRoot = fs.realpathSync(resolvedRoot);
  const canonicalMainRoot = fs.realpathSync(resolvedMainRoot);
  if (canonicalRoot !== resolvedRoot || canonicalMainRoot !== resolvedMainRoot) {
    throw new Error("managed worktree roots must use canonical real paths");
  }
  const managedRootPath = path.resolve(managedDir(canonicalMainRoot), "worktree");
  let managedRoot;
  try {
    managedRoot = fs.realpathSync(managedRootPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (managedRoot !== managedRootPath) {
    throw new Error("managed worktree boundary must use a canonical real path");
  }
  const relative = path.relative(managedRoot, canonicalRoot);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export class FlowManager {
  /**
   * @param {Object} opts
   * @param {string}  opts.root        - work root (worktree path when in one)
   * @param {string}  opts.mainRoot    - main repo root
   * @param {boolean} opts.inWorktree
   * @param {string|null} [opts.specId]
   */
  constructor({
    root,
    mainRoot,
    inWorktree,
    specId = null,
    specRoot = DEFAULT_FLOW_SPEC_DIR,
    bindingFaultInjector = () => {},
    targetIdentityFaultInjector = () => {},
    versionStoreFaultInjector = null,
    processIdentitySource,
  }) {
    this._root = root;
    this._mainRoot = mainRoot;
    this._inWorktree = inWorktree;
    this._boundSpecId = specId;
    this._workspace = new FlowWorkspace({ repositoryRoot: mainRoot, executionRoot: root, specRoot });
    this._bindingFaultInjector = bindingFaultInjector;
    this._targetIdentityFaultInjector = targetIdentityFaultInjector;
    this._versionStoreFaultInjector = versionStoreFaultInjector;
    this._processIdentitySource = processIdentitySource;
    this._usesWorktreeFlowBinding = isManagedFlowWorktree(root, mainRoot, inWorktree);
    this._activeFlows = new ActiveFlowRegistry({
      mainRoot,
      specRoot: this._workspace.specRoot,
      ...(processIdentitySource && { processIdentitySource }),
    });
    this._preparing = new PreparingFlowStore({
      mainRoot,
      ...(processIdentitySource && { processIdentitySource }),
    });
    this._targetIdentities = new FlowTargetIdentityAuthority({
      mainRoot,
      specRoot: this._workspace.specRoot,
      faultInjector: targetIdentityFaultInjector,
      ...(processIdentitySource && { processIdentitySource }),
    });
    this._store = new CanonicalFlowManagerStore({
      root,
      mainRoot,
      specRoot: this._workspace.specRoot,
      activeFlowsProvider: () => this._activeFlows,
      versionStoreFaultInjector,
    });
    this._worktreeBinding = this._usesWorktreeFlowBinding
      ? new WorktreeFlowBindingStore({
          worktreePath: root,
          faultInjector: bindingFaultInjector,
          ...(processIdentitySource && { processIdentitySource }),
        })
      : null;
  }

  get specRoot() {
    return this._workspace.specRoot;
  }

  // ── canonical Version-1 flow.json ───────────────────────────────────────────

  load(specId) {
    const state = this._worktreeBinding
      ? this.#loadBoundWorktreeState(specId, false)
      : this._store.load(withSpecIdArgDefault(specId, this._boundSpecId));
    return this.#bindLoadedState(state);
  }
  loadReadOnly(specId) {
    const state = this._worktreeBinding
      ? this.#loadBoundWorktreeState(specId, true)
      : this._store.loadReadOnly(withSpecIdArgDefault(specId, this._boundSpecId));
    return this.#bindLoadedState(state);
  }
  /**
   * Create the one canonical Version-1 root.  Fresh runtime callers use this
   * explicit request rather than assembling a mutable flow.json document.
   */
  createFresh(request) {
    const created = this._store.createFresh(
      request instanceof CanonicalFlowCreateRequest
        ? request
        : new CanonicalFlowCreateRequest(request),
    );
    if (!this._worktreeBinding && this._boundSpecId == null) {
      this._boundSpecId = created.specId;
    }
    return this.#bindLoadedState(created);
  }
  #bindLoadedState(state) {
    if (state != null && this._boundSpecId == null) {
      this._boundSpecId = state.specId;
    }
    if (state != null) {
      bindFlowStateLocation(state, this.specLocation(state.specId));
    }
    return state;
  }
  pathFor(specId) { return this._store.pathFor(withSpecIdArgDefault(specId, this._boundSpecId)); }
  specLocation(specId) {
    return canonicalFlowVersionLocation(this._store, withSpecIdArgDefault(specId, this._boundSpecId));
  }
  canonicalVersionLocation(version, { specId } = {}) {
    return this._workspace.canonicalVersion(withSpecIdArgDefault(specId, this._boundSpecId), FlowVersion.from(version));
  }
  executionVersionLocation(version, { specId } = {}) {
    return this._workspace.executionVersion(withSpecIdArgDefault(specId, this._boundSpecId), FlowVersion.from(version));
  }
  pathForCurrent() { return this._store.pathForCurrent(); }
  executionRoot() { return this._root; }
  /** Alias for the canonical Version-1 flow.json path. */
  flowStatePath() { return this._store.pathForCurrent(); }
  resolveWorktreePaths(state) { return this._store.resolveWorktreePaths(state); }

  /**
   * Construct a FlowManager scoped to a different root (e.g. a freshly-created
   * worktree). The new instance owns its own paths — callers should not pass
   * paths to its methods. A specId option binds a default target for methods
   * that load, mutate, or locate flow.json; per-call opts.specId still wins.
   * @param {string} root
   * @param {{specId?: string|null}} [opts]
   */
  forRoot(root, opts = {}) {
    return new FlowManager({
      root,
      mainRoot: this._mainRoot,
      inWorktree: root !== this._mainRoot,
      specId: opts.specId,
      specRoot: this._workspace.specRoot,
      bindingFaultInjector: opts.bindingFaultInjector ?? this._bindingFaultInjector,
      targetIdentityFaultInjector: opts.targetIdentityFaultInjector ?? this._targetIdentityFaultInjector,
      versionStoreFaultInjector: opts.versionStoreFaultInjector ?? this._versionStoreFaultInjector,
      ...(this._processIdentitySource && { processIdentitySource: this._processIdentitySource }),
    });
  }

  resolveWorktreeBinding(expectation = null) {
    if (!this._worktreeBinding) {
      throw new Error("worktree flow binding is available only inside a worktree");
    }
    if (expectation instanceof FlowTargetExpectation && !expectation.empty) {
      return this.#resolveGuardedWorktreeBinding(expectation);
    }
    return this._worktreeBinding.load();
  }

  snapshotWorktreeBinding(expectation = null) {
    if (!this._worktreeBinding) {
      throw new Error("worktree flow binding is available only inside a worktree");
    }
    return this._worktreeBinding.withLock(() => {
      const snapshot = this._worktreeBinding.loadOwned();
      if (expectation instanceof FlowTargetExpectation && !expectation.empty) {
        const mismatch = expectation.mismatchAgainst(snapshot.identity.toJSON());
        if (mismatch) throw new ActiveFlowMismatchError(expectation, snapshot.identity.toJSON());
      }
      return Object.freeze({
        identity: Object.freeze(snapshot.identity.toJSON()),
        revision: snapshot.revision,
      });
    });
  }

  usesWorktreeFlowBinding() {
    return this._usesWorktreeFlowBinding;
  }

  updateStepStatus(transition, opts, commitIntent = null) {
    return this._store.updateStepStatus(transition, withSpecIdDefault(opts, this._boundSpecId), commitIntent);
  }
  updateStepStatuses(transitions, opts, commitIntent = null) {
    return this._store.updateStepStatuses(transitions, withSpecIdDefault(opts, this._boundSpecId), commitIntent);
  }
  finalizeDownstream(input = {}) {
    return this._store.finalizeDownstream({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  canonicalState(specId = this._boundSpecId) {
    return this._store.canonicalState(specId);
  }
  /** Re-read the one canonical source used by non-Gate Definition facts. */
  readCanonicalTransitionSnapshot(specId = this._boundSpecId) {
    const snapshot = this._store.transitionSnapshot(withSpecIdArgDefault(specId, this._boundSpecId));
    if (snapshot === null) return null;
    return new CurrentFlowTransitionSnapshot({
      state: snapshot.state,
      revision: snapshot.revision,
      activities: snapshot.activities,
      catalog: snapshot.catalog,
    });
  }
  /** Run a transition-facts adapter inside the authoritative catalog lock. */
  readCanonicalTransitionView({ specId = this._boundSpecId, read } = {}) {
    return this._store.readCanonicalTransitionView({
      specId: withSpecIdArgDefault(specId, this._boundSpecId),
      read,
    });
  }
  activityLedger(specId = this._boundSpecId) {
    return this._store.activityLedger(specId);
  }
  beginNextAction(specId = this._boundSpecId) {
    return this._store.beginNextAction(specId);
  }
  recoverMissingProducerArtifact(input = {}) {
    return this._store.recoverMissingProducerArtifact({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  missingProducerArtifactRoute(input = {}) {
    return this._store.missingProducerArtifactRoute({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  recoverInterruptedFinalizeSync(input = {}) {
    return this._store.recoverInterruptedFinalizeSync({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  confirmCurrentAttempt(input = {}) {
    return this._store.confirmCurrentAttempt({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  confirmDraftCoverageRepairCompletion(input = {}) {
    return this._store.confirmDraftCoverageRepairCompletion({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  completeAcceptanceDecisionNoOp(input = {}) {
    return this._store.completeAcceptanceDecisionNoOp({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  confirmSourceWorkerHandoff(input = {}) {
    return this._store.confirmSourceWorkerHandoff({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  repairAcceptanceReview(input = {}) {
    return this._store.repairAcceptanceReview({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  failCurrentAttempt(input = {}) {
    return this._store.failCurrentAttempt({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  settleCurrentFailure(input = {}) {
    return this._store.settleCurrentFailure({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  failCurrentAttemptIfCurrent(input = {}) {
    return this._store.failCurrentAttemptIfCurrent({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  publishCurrentAttemptResult(input = {}) {
    return this._store.publishCurrentAttemptResult({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  confirmTaskReviewResult(input = {}) {
    return this._store.confirmTaskReviewResult({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  /** Atomically apply one Definition-owned test-chain transition plan. */
  applyTestChainTransitionDecision(input = {}) {
    return this._store.applyTestChainTransitionDecision({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  publishArtifacts(input = {}) {
    return this._store.publishArtifacts({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  publishTaskSourceHandoffBaseline(input = {}) {
    return this._store.publishTaskSourceHandoffBaseline({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  promoteDraftQuestionAndKeepRefineActive(input = {}) {
    return this._store.promoteDraftQuestionAndKeepRefineActive({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  publishUpgradeResult(input = {}) {
    return this._store.publishUpgradeResult({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  publishPluginArtifacts(input = {}) {
    return this._store.publishPluginArtifacts({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  activateNonblockingPolicy(input = {}) {
    return this._store.activateNonblockingPolicy({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  recordNonblocking(input = {}) {
    return this._store.recordNonblocking({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  applyNonblockingDecision(input = {}) {
    return this._store.applyNonblockingDecision({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  /** Apply a typed Task overview contribution through the canonical Store. */
  updateTaskOverview(input = {}) {
    return this._store.updateTaskOverview({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  updateSpecApproval(input = {}) {
    return this._store.updateSpecApproval({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  approveSpecContinuation(input = {}) {
    return this._store.approveSpecContinuation({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  appendIssueLog(input = {}) {
    return this._store.appendIssueLog({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  updateFileMap(input = {}) {
    return this._store.updateFileMap({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  /** Resolve a durable consumer input through the canonical artifact catalog. */
  readArtifact(input = {}) {
    return this._store.readArtifact({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  /** Read the one current revision-scoped Spec review through the Store. */
  readCurrentSpecReview(input = {}) {
    return this._store.readCurrentSpecReview({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  /** Prepare the authoritative input for the first spec-review publication. */
  readCurrentSpecReviewInput(input = {}) {
    return this._store.readCurrentSpecReviewInput({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  readActiveProducerArtifact(input = {}) {
    return this._store.readActiveProducerArtifact({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  /** Read an artifact published by the active producer, including shared producer contracts. */
  readProducerArtifact(input = {}) {
    return this._store.readProducerArtifact({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  /** Resolve a producer-referenced catalog entry without reconstructing a path. */
  readCatalogArtifact(input = {}) {
    return this._store.readCatalogArtifact({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  recordDispatchApproval(input = {}) {
    return this._store.recordDispatchApproval({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  beginOutbox(input = {}) {
    return this._store.beginOutbox({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  completeOutbox(input = {}) {
    return this._store.completeOutbox({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  failOutbox(input = {}) {
    return this._store.failOutbox({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  reopenOutboxExact(input = {}) {
    return this._store.reopenOutboxExact({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  outboxStatus(input = {}) {
    return this._store.outboxStatus({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  setStepRuntimeLog(stepId, runtimeLog, opts) {
    return this._store.setStepRuntimeLog(stepId, runtimeLog, withSpecIdDefault(opts, this._boundSpecId));
  }
  writeRuntimeArtifact(input = {}) {
    return this._store.writeRuntimeArtifact({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  readRuntimeArtifact(input = {}) {
    return this._store.readRuntimeArtifact({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  /** Atomically persist cataloged gate evidence and rewind to its repair target. */
  repairPlanGate(input = {}) {
    return this._store.repairPlanGate({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  recordGateObservationDecision(input = {}) {
    return this._store.recordGateObservationDecision({ ...input, specId: input.specId ?? this._boundSpecId });
  }
  recoverTaskGateClassification(input = {}) {
    return this._store.recoverTaskGateClassification({ ...input, specId: input.specId ?? this._boundSpecId });
  }
  retryGateTransition(input = {}) {
    return this._store.retryGateTransition({ ...input, specId: input.specId ?? this._boundSpecId });
  }
  settleGateTransition(input = {}) {
    return this._store.settleGateTransition({ ...input, specId: input.specId ?? this._boundSpecId });
  }
  recoverTaskExecutionOverrun(input = {}) {
    return this._store.recoverTaskExecutionOverrun({ ...input, specId: input.specId ?? this._boundSpecId });
  }
  rewindTo(nodeId, opts) { return this._store.rewindTo(nodeId, withSpecIdDefault(opts, this._boundSpecId)); }
  rewindTestEvidence(input = {}) {
    return this._store.rewindTestEvidence({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  applyRetroStaleEvidenceRecoveryDecision(input = {}) {
    return this._store.applyRetroStaleEvidenceRecoveryDecision({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  repairTestReview(input = {}) {
    return this._store.repairTestReview({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  settleTimedOutTestReviewRepair(input = {}) {
    return this._store.settleTimedOutTestReviewRepair({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  preimplementationBootstrap(input = {}) {
    return this._store.preimplementationBootstrap({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  recoverExistingImplementation(input = {}) {
    return this._store.recoverExistingImplementation({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  reopenDraft(input = {}) {
    return this._store.reopenDraft({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  retryCurrentAttempt(opts) { return this._store.retryCurrentAttempt(withSpecIdDefault(opts, this._boundSpecId)); }
  beginFinalRegressionRepair(input = {}) {
    return this._store.beginFinalRegressionRepair({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  reconcileTaskReview(input = {}) {
    return this._store.reconcileTaskReview({ ...input, specId: input.specId ?? this._boundSpecId });
  }
  retryExhaustedAttempt(input = {}) {
    return this._store.retryExhaustedAttempt({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  acceptFinalRegressionFailure(input = {}) {
    return this._store.acceptFinalRegressionFailure({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  deferFailedReview(input = {}) {
    return this._store.deferFailedReview({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  setAutoApprove(autoApprove, opts) {
    return this._store.setAutoApprove(autoApprove, withSpecIdDefault(opts, this._boundSpecId));
  }
  addNote(text, opts) { return this._store.addNote(text, withSpecIdDefault(opts, this._boundSpecId)); }
  incrementMetric(phase, counter, opts) {
    return this._store.incrementMetric(phase, counter, withSpecIdDefault(opts, this._boundSpecId));
  }
  appendMetric(payload, opts) { return this._store.appendMetric(payload, withSpecIdDefault(opts, this._boundSpecId)); }
  recordTaskGateSettlementMetric(input = {}) {
    return this._store.recordTaskGateSettlementMetric({
      ...input,
      specId: input.specId ?? this._boundSpecId,
    });
  }
  /** @param {import("./flow-options.js").AgentMetricOptions} [options] */
  accumulateAgentMetrics(phase, options) {
    return this._store.accumulateAgentMetrics(phase, withSpecIdDefault(options, this._boundSpecId));
  }

  // ── task primitives (cac6/T2) ───────────────────────────────────────────────

  /** Add a canonical Task; current Task is derived from the active Attempt. */
  addTask(task, opts) { return this._store.addTask(task, withSpecIdDefault(opts, this._boundSpecId)); }

  /** Start the next definition-owned Step of one canonical Task. */
  startTask(taskId, opts) { return this._store.startTask(taskId, withSpecIdDefault(opts, this._boundSpecId)); }

  /** Replay one exact immutable ledger Activity; new mutations use typed methods. */
  applyActivity(activity, opts) {
    return this._store.applyActivity(activity, withSpecIdDefault(opts, this._boundSpecId));
  }

  parkFlow(specId = this._boundSpecId) { return this._store.park(specId); }
  resumeFlow(specId = this._boundSpecId) { return this._store.resume(specId); }
  finalizeFlow(specId = this._boundSpecId) { return this._store.finalize(specId); }
  restartFlow(specId = this._boundSpecId) { return this._store.restart(specId); }
  artifactCatalog(specId = this._boundSpecId) { return this._store.catalog(specId); }

  /** Mark a task done; clears currentTaskId if it pointed at this task. */
  completeTask(taskId, opts) {
    return this._store.completeTask(taskId, withSpecIdDefault(opts, this._boundSpecId));
  }

  /** Get the current task object or null. */
  getCurrentTask() {
    const state = this.load();
    if (!state || state.currentTaskId == null) return null;
    return (state.tasks || []).find((t) => t.id === state.currentTaskId) ?? null;
  }

  /** Get the in_progress step of the current task, or null. */
  getCurrentTaskStep() {
    const task = this.getCurrentTask();
    if (!task) return null;
    return (task.steps || []).find((s) => s.status === "in_progress") ?? null;
  }

  taskMutationLineages(options = {}) {
    return this._store.taskMutationLineages({ ...options, specId: options.specId ?? this._boundSpecId });
  }

  /**
   * Resolve the current flow context for logging / metric accumulation.
   * Returns { specId, flowPhase } derived from the active flow.json; both are
   * null when no active flow is present (expected outside Spec-Driven Development contexts).
   */
  resolveCurrentContext() {
    const state = this.load();
    if (!state) return { specId: null, flowPhase: null, taskId: null };
    const specId = state.specId ?? null;
    const inProgress = findInProgressLeaf(state.steps);
    const flowPhase = inProgress?.id ?? null;
    const taskId = state.currentTaskId ?? null;
    return { specId, flowPhase, taskId };
  }

  // ── .active-flow (ActiveFlowRegistry) ───────────────────────────────────────

  loadActiveFlows() { return this._activeFlows.load(); }
  snapshotActiveFlows(options) { return this._activeFlows.snapshot(options); }
  snapshotActiveFlowIdentities(options = {}) {
    return this.#withRepositoryOperation(options, (operationOwnerToken) => {
      const registrySnapshot = this.snapshotActiveFlows({ ...options, operationOwnerToken });
      const identitySnapshot = this._targetIdentities.snapshot();
      const activeIdentities = identitySnapshot.entries.filter((entry) => entry.lifecycle === "active");
      const entries = activeIdentities.map((identity) => {
        const entry = registrySnapshot.entries.find((candidate) => candidate.specId === identity.specId);
        if (!entry || entry.mode !== identity.mode) {
          throw new FlowTargetAuthorityError(
            `active target identity is inconsistent with the active-flow registry: ${identity.specId}`,
            { data: identity.toErrorData() },
          );
        }
        return new ActiveFlowIdentityEntry({ entry, identity });
      });
      return new ActiveFlowIdentitySnapshot({ entries, revision: registrySnapshot.revision });
    }, "active flow identity snapshot and repository lock release both failed");
  }
  addActiveFlow(specId, mode, options = {}) {
    return this.#withRepositoryOperation(options, (operationOwnerToken) => {
      const existing = this._activeFlows.load().find((entry) => entry.specId === specId) ?? null;
      this._activeFlows.add(specId, mode, { ...options, operationOwnerToken });
      let state;
      try {
        state = this._store.load(specId);
      } catch {
        // A pointer to invalid state remains an unindexed orphan. It is kept
        // diagnosable in the registry but never promoted into target identity
        // authority.
        return null;
      }
      // A pointer without state remains an unindexed orphan. Registry-only
      // callers can still diagnose or remove it.
      if (!state) return null;
      try {
        return this._targetIdentities.addActive(state, mode, { ...options, operationOwnerToken });
      } catch (authorityError) {
        if (!existing) {
          try {
            this._activeFlows.remove(specId, { ...options, operationOwnerToken });
          } catch (rollbackError) {
            throw new AggregateError(
              [authorityError, rollbackError],
              "active flow registration and identity rollback both failed",
              { cause: authorityError },
            );
          }
        }
        throw authorityError;
      }
    }, "active flow registration and repository lock release both failed");
  }
  assertCanAddActiveFlow(specId, mode, options) { return this._activeFlows.assertCanAdd(specId, mode, options); }
  removeActiveFlow(specId, options = {}) {
    return this.#withRepositoryOperation(options, (operationOwnerToken) => {
      const registryEntry = this._activeFlows.load().find((entry) => entry.specId === specId) ?? null;
      const identity = this._targetIdentities.snapshot().entries.find((entry) => (
        entry.lifecycle === "active" && entry.specId === specId
      )) ?? null;
      if (identity && (!registryEntry || registryEntry.mode !== identity.mode)) {
        throw new FlowTargetAuthorityError(
          `active target identity is inconsistent with the active-flow registry: ${specId}`,
          { data: identity.toErrorData() },
        );
      }
      this._activeFlows.remove(specId, { ...options, operationOwnerToken });
      try {
        return this._targetIdentities.removeActive(specId, { ...options, operationOwnerToken });
      } catch (authorityError) {
        if (registryEntry) {
          try {
            this._activeFlows.add(specId, registryEntry.mode, { ...options, operationOwnerToken });
          } catch (rollbackError) {
            throw new AggregateError(
              [authorityError, rollbackError],
              "active flow identity removal and registry rollback both failed",
              { cause: authorityError },
            );
          }
        }
        throw authorityError;
      }
    }, "active flow removal and repository lock release both failed");
  }
  assertFlowStateWritable(specId, options) { return this._store.assertWritable(specId, options); }
  cleanStaleFlows(options = {}) {
    return this.#withRepositoryOperation(options, (operationOwnerToken) => {
      const before = this._activeFlows.load();
      const identities = this._targetIdentities.snapshot().entries;
      const valid = this._activeFlows.cleanStale({ ...options, operationOwnerToken });
      const validSpecs = new Set(valid.map((entry) => entry.specId));
      const removedEntries = before.filter((entry) => !validSpecs.has(entry.specId));
      const removedIdentities = [];
      try {
        for (const entry of removedEntries) {
          const identity = identities.find((candidate) => (
            candidate.lifecycle === "active" && candidate.specId === entry.specId
          ));
          if (!identity) continue;
          this._targetIdentities.removeActive(entry.specId, { ...options, operationOwnerToken });
          removedIdentities.push(identity);
        }
      } catch (authorityError) {
        const rollbackErrors = [];
        for (const entry of removedEntries) {
          try {
            this._activeFlows.add(entry.specId, entry.mode, { ...options, operationOwnerToken });
          } catch (error) {
            rollbackErrors.push(error);
          }
        }
        for (const identity of removedIdentities) {
          try {
            this._targetIdentities.restore(identity, { ...options, operationOwnerToken });
          } catch (error) {
            rollbackErrors.push(error);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [authorityError, ...rollbackErrors],
            "stale flow identity cleanup and rollback both failed",
            { cause: authorityError },
          );
        }
        throw authorityError;
      }
      return valid;
    }, "stale flow cleanup and repository lock release both failed");
  }

  /**
   * Clear the active-flow entry for a spec. If specId is omitted,
   * resolves it from the current context.
   */
  clearFlowState(specId, options) {
    if (!specId) {
      const flows = this._activeFlows.load();
      if (flows.length === 0) return;
      if (flows.length !== 1) {
        throw new Error("multiple active Flows require an explicit specId for removal");
      }
      specId = flows[0].specId;
    }
    this.removeActiveFlow(specId, options);
  }

  // ── preparing flow (PreparingFlowStore) ─────────────────────────────────────

  generateRunId() { return this._preparing.generateRunId(); }
  createPreparingFlow(runId, extra = {}, options = {}) {
    return this.#withRepositoryOperation(options, (operationOwnerToken) => {
      const createdPath = this._preparing.create(runId, extra);
      const state = this._preparing.load(runId);
      try {
        this._targetIdentities.addPreparing(state, { ...options, operationOwnerToken });
      } catch (authorityError) {
        try {
          this._preparing.delete(runId);
        } catch (rollbackError) {
          throw new AggregateError(
            [authorityError, rollbackError],
            "preparing flow creation and identity rollback both failed",
            { cause: authorityError },
          );
        }
        throw authorityError;
      }
      return createdPath;
    }, "preparing flow creation and repository lock release both failed");
  }
  loadPreparingFlow(runId) { return this._preparing.load(runId); }
  resolvePreparingByRunId(runId) {
    const expectation = new FlowTargetExpectation({ expectRunId: runId });
    try {
      return this.#resolveExplicitIdentity(expectation, "preparing").state;
    } catch (error) {
      if (error.code === "FLOW_TARGET_NOT_FOUND") return null;
      throw error;
    }
  }
  mutatePreparingFlow(runId, mutator, options = {}) {
    return this.#withRepositoryOperation(options, (operationOwnerToken) => {
      const indexed = this._targetIdentities.snapshot().entries.find((entry) => (
        entry.lifecycle === "preparing" && entry.runId === runId
      ));
      if (!indexed) {
        throw new FlowTargetAuthorityError(`preparing flow identity is missing: ${runId}`);
      }
      let original;
      try {
        original = this._preparing.load(runId);
      } catch (cause) {
        throw new FlowTargetRecoveryError(
          indexed,
          `selected preparing flow state is corrupt or unreadable: ${runId}`,
          { cause },
        );
      }
      if (!original) {
        throw new FlowTargetRecoveryError(
          indexed,
          `selected preparing flow state is missing: ${runId}`,
          { reason: "PREPARING_FLOW_NOT_FOUND" },
        );
      }
      indexed.assertState(original);
      const updated = this._preparing.mutate(runId, (state) => {
        mutator(state);
        if (state.runId !== runId || state.lifecycle !== "preparing" || state.specId !== null) {
          throw new Error("preparing flow mutation must preserve runId, lifecycle, and null specId");
        }
      });
      try {
        this._targetIdentities.replacePreparing(updated, { ...options, operationOwnerToken });
      } catch (authorityError) {
        try {
          this._preparing.mutate(runId, (state) => {
            for (const key of Object.keys(state)) delete state[key];
            Object.assign(state, structuredClone(original));
          });
        } catch (rollbackError) {
          throw new AggregateError(
            [authorityError, rollbackError],
            "preparing flow identity update and state rollback both failed",
            { cause: authorityError },
          );
        }
        throw authorityError;
      }
      return updated;
    }, "preparing flow mutation and repository lock release both failed");
  }
  resolvePreparingInputs(runId, cliIssue, cliRequest) {
    return this._preparing.resolveInputs(runId, cliIssue, cliRequest);
  }
  deletePreparingFlow(runId, options = {}) {
    return this.#withRepositoryOperation(options, (operationOwnerToken) => {
      const identity = this._targetIdentities.snapshot().entries.find((entry) => (
        entry.lifecycle === "preparing" && entry.runId === runId
      )) ?? null;
      let state;
      try {
        state = this._preparing.load(runId);
      } catch (cause) {
        if (!identity) throw cause;
        throw new FlowTargetRecoveryError(
          identity,
          `selected preparing flow state is corrupt or unreadable: ${runId}`,
          { cause },
        );
      }
      if (identity) {
        if (!state) {
          throw new FlowTargetRecoveryError(
            identity,
            `selected preparing flow state is missing: ${runId}`,
            { reason: "PREPARING_FLOW_NOT_FOUND" },
          );
        }
        identity.assertState(state);
      }
      this._preparing.delete(runId);
      try {
        return this._targetIdentities.removePreparing(runId, { ...options, operationOwnerToken });
      } catch (authorityError) {
        if (state) {
          try {
            this._preparing.create(runId, state);
          } catch (rollbackError) {
            throw new AggregateError(
              [authorityError, rollbackError],
              "preparing flow identity removal and state rollback both failed",
              { cause: authorityError },
            );
          }
        }
        throw authorityError;
      }
    }, "preparing flow deletion and repository lock release both failed");
  }
  listPreparingFlows() {
    return this._targetIdentities.snapshot().entries
      .filter((entry) => entry.lifecycle === "preparing")
      .map((entry) => entry.runId);
  }

  resolveExplicitFlowTarget(expectation) {
    if (!(expectation instanceof FlowTargetExpectation) || expectation.empty) {
      throw new Error("explicit flow target expectation is required");
    }
    return this.#resolveExplicitIdentity(expectation);
  }

  resolveExplicitFlowTargetForRead(expectation) {
    if (!(expectation instanceof FlowTargetExpectation) || expectation.empty) {
      throw new Error("explicit flow target expectation is required");
    }
    const identities = this.#targetIdentityEntries();
    const exact = identities.filter((identity) => identity.matches(expectation));
    if (exact.length > 0) {
      return this.#loadTargetIdentity(resolveUniqueFlowTarget(expectation, exact));
    }

    // Read-only commands need the selected authority in order to return a
    // complete mismatch envelope.  A stable run/spec selector may identify
    // that authority even when a secondary Issue guard is intentionally
    // wrong.  Mutating resolution never uses this fallback.
    const runId = expectation.effectiveRunId;
    const specId = expectation.effectiveSpecId;
    const candidates = identities.filter((identity) => (
      (runId == null || identity.runId === runId)
      && (specId == null || identity.specId === specId)
    ));
    const target = this.#loadTargetIdentity(resolveUniqueFlowTarget(expectation, candidates));
    return target;
  }

  /** Resolve only the identity and management fields required for safe abort. */
  resolveFlowRecoveryTarget(expectation = new FlowTargetExpectation()) {
    if (!(expectation instanceof FlowTargetExpectation)) {
      throw new Error("Flow recovery target expectation is invalid");
    }
    const identities = this.#targetIdentityEntries("active");
    const matches = expectation.empty
      ? identities
      : identities.filter((identity) => identity.matches(expectation));
    const identity = resolveUniqueFlowTarget(expectation, matches);
    return FlowRecoveryTarget.load({ identity, mainRoot: this._mainRoot });
  }

  #resolveExplicitIdentity(expectation, lifecycle = null) {
    const identities = this.#targetIdentityEntries(lifecycle);
    const matches = identities.filter((identity) => identity.matches(expectation));
    const identity = resolveUniqueFlowTarget(expectation, matches);
    const target = this.#loadTargetIdentity(identity);
    if (!target.matches(expectation)) throw new FlowTargetNotFoundError(expectation);
    return target;
  }

  #targetIdentityEntries(lifecycle = null) {
    const identities = this._targetIdentities.snapshot().entries;
    let registry;
    try {
      registry = this._activeFlows.load();
    } catch (cause) {
      throw new FlowTargetAuthorityError("active-flow registry is invalid during target resolution", { cause });
    }
    const selectable = identities.filter((identity) => {
      if (identity.lifecycle !== "active") return true;
      const entry = registry.find((candidate) => candidate.specId === identity.specId);
      if (!entry) {
        throw new FlowTargetAuthorityError(
          `active target identity is missing from the active-flow registry: ${identity.specId}`,
          { data: identity.toErrorData() },
        );
      }
      if (entry.mode !== identity.mode) {
        throw new FlowTargetAuthorityError(
          `active target identity is inconsistent with the active-flow registry: ${identity.specId}`,
          { data: identity.toErrorData() },
        );
      }
      return true;
    });
    return lifecycle == null
      ? selectable
      : selectable.filter((identity) => identity.lifecycle === lifecycle);
  }

  #loadTargetIdentity(identity) {
    let state;
    let resolved = null;
    try {
      if (identity.preparing) {
        state = this._preparing.load(identity.runId);
      } else {
        resolved = this._loadActiveFlowState(identity.specId);
        state = resolved?.state ?? null;
      }
    } catch (cause) {
      throw new FlowTargetRecoveryError(
        identity,
        `selected flow target state is corrupt or unreadable: ${identity.runId}`,
        { cause },
      );
    }
    if (!state) {
      throw new FlowTargetRecoveryError(
        identity,
        `selected flow target state is missing: ${identity.runId}`,
        { reason: identity.preparing ? "PREPARING_FLOW_NOT_FOUND" : "ACTIVE_FLOW_STATE_AUTHORITY_MISSING" },
      );
    }
    identity.assertState(state);
    return new ResolvedFlowTarget({
      state,
      specId: identity.specId,
      worktreePath: resolved?.worktreePath ?? null,
      mainRoot: this._mainRoot,
      authorityRoot: resolved?.worktreePath || this._mainRoot,
      preparing: identity.preparing,
    });
  }

  /**
   * Resolve a registered active flow for normal flow execution and resume.
   *
   * @param {object|null} flowState - pre-loaded flow state (may be null)
   * @param {object} [opts]
   * @param {string} [opts.selectSpecId] - explicit spec to disambiguate when
   *   multiple flows are active concurrently
   * @param {string} [opts.selectRunId] - explicit runId to disambiguate when
   *   multiple flows are active concurrently
   * @param {string|number} [opts.selectIssue] - explicit Issue number to
   *   disambiguate when multiple flows are active concurrently
   * @param {boolean} [opts.selectNoIssue] - select the unique active flow
   *   whose Issue identity is absent
   * @returns {{ state: object, specId: string, worktreePath: string|null } | null}
   */
  resolveActiveFlow(flowState, opts = {}) {
    const expectation = activeFlowExpectation(opts);
    if (flowState) {
      const specId = flowState.specId;
      let worktreePath = null;
      if (flowState.worktree || flowState.execution?.mode === "worktree") {
        const candidate = this._store.resolveWorktreePaths(flowState).worktreePath;
        if (candidate && fs.existsSync(candidate)) worktreePath = candidate;
      }
      if (!expectation) {
        return { state: flowState, specId, worktreePath };
      }
      const target = new ResolvedFlowTarget({
        state: flowState,
        specId,
        worktreePath,
        mainRoot: this._mainRoot,
        authorityRoot: worktreePath || this._root,
      });
      const mismatch = expectation ? target.mismatchAgainst(expectation) : null;
      if (mismatch) {
        throw new ActiveFlowMismatchError(expectation, flowState, mismatch);
      }
      return { state: flowState, specId, worktreePath };
    }

    const activeFlows = this._activeFlows.load();
    if (expectation) {
      const target = this.#resolveExplicitIdentity(expectation, "active");
      return {
        state: target.state,
        specId: target.specId,
        worktreePath: target.worktreePath,
      };
    }

    if (activeFlows.length === 1) {
      const resolved = this._loadActiveFlowState(activeFlows[0].specId);
      if (resolved) return resolved;
    } else if (activeFlows.length > 1) {
      throw new Error(
        `multiple active flows: ${activeFlows.map((f) => `${f.specId} (${f.mode})`).join(", ")}. Pass --spec <specId> to select one.`,
      );
    }

    return null;
  }

  _resolveActiveFlowByState(activeFlows, predicate) {
    return this._resolveActiveFlowsByState(activeFlows, predicate)[0] ?? null;
  }

  _resolveActiveFlowsByState(activeFlows, predicate) {
    const matches = [];
    for (const entry of activeFlows) {
      const resolved = this._loadActiveFlowState(entry.specId);
      if (resolved?.state && predicate(resolved.state)) matches.push(resolved);
    }
    return matches;
  }

  /**
   * Load one active flow from the single base-side state authority. A managed
   * worktree is execution metadata only and is never a state fallback.
   *
   * @param {string} specId
   * @returns {{ state: object, specId: string, worktreePath: string|null } | null}
   */
  _loadActiveFlowState(specId) {
    const state = this.#bindLoadedState(this._store.load(specId));
    if (!state) {
      const statePath = this._store.pathFor(specId);
      const error = new Error(
        `active flow state is missing at the configured spec root: ${statePath}. `
        + "Restore flow.specDir or resolve the active flow explicitly before continuing.",
      );
      error.code = "ACTIVE_FLOW_STATE_AUTHORITY_MISSING";
      error.specId = specId;
      error.statePath = statePath;
      throw error;
    }
    let worktreePath = null;
    if (state.worktree) {
      const resolved = this._store.resolveWorktreePaths(state);
      const candidate = resolved.worktreePath;
      if (candidate && fs.existsSync(candidate)) worktreePath = candidate;
    }
    return { state, specId, worktreePath };
  }

  /**
   * Resolve flow state by runId.
   * @param {string} runId
   * @returns {object|null}
   */
  resolveByRunId(runId) {
    const expectation = new FlowTargetExpectation({ expectRunId: runId });
    const matches = this.#targetIdentityEntries().filter((identity) => identity.matches(expectation));
    if (matches.length === 0) return null;
    return this.#loadTargetIdentity(resolveUniqueFlowTarget(expectation, matches)).state;
  }

  #loadBoundWorktreeState(specId, readOnly) {
    return this._worktreeBinding.withLock(() => {
      const identity = this._worktreeBinding.loadOwned().identity;
      const requested = withSpecIdArgDefault(specId, this._boundSpecId);
      if (requested != null && requested !== identity.specId) {
        throw new Error(
          `worktree flow binding specId mismatch: ${requested} != ${identity.specId}`,
        );
      }
      const state = readOnly
        ? this._store.loadReadOnly(identity.specId)
        : this._store.load(identity.specId);
      return identity.assertFlowState(state);
    });
  }

  #resolveGuardedWorktreeBinding(expectation) {
    const operationLock = this.#repositoryOperationLock();
    const operationOwnerToken = operationLock.acquire();
    let result;
    let primary = null;
    try {
      result = this._worktreeBinding.withLock((bindingOwnerToken) => {
        const binding = this._worktreeBinding.loadOwned().identity;
        if (expectation.mismatchAgainst(binding.toJSON()) != null) {
          throw new ActiveFlowMismatchError(expectation, binding.toJSON());
        }
        const state = this._store.load(binding.specId);
        binding.assertFlowState(state);
        return binding;
      });
    } catch (error) {
      primary = error;
    }
    let releaseError = null;
    try {
      operationLock.release();
    } catch (error) {
      releaseError = error;
    }
    if (primary && releaseError) {
      throw new AggregateError(
        [primary, releaseError],
        "guarded worktree identity resolution and repository lock release both failed",
        { cause: primary },
      );
    }
    if (primary) throw primary;
    if (releaseError) throw releaseError;
    return result;
  }

  #withRepositoryOperation(options, body, aggregateMessage) {
    const operationLock = this.#repositoryOperationLock(options);
    const operationOwnerToken = operationLock.acquire();
    let result;
    let primary = null;
    try {
      result = body(operationOwnerToken);
    } catch (error) {
      primary = error;
    }
    let releaseError = null;
    try {
      operationLock.release();
    } catch (error) {
      releaseError = error;
    }
    if (primary && releaseError) {
      throw new AggregateError([primary, releaseError], aggregateMessage, { cause: primary });
    }
    if (primary) throw primary;
    if (releaseError) throw releaseError;
    return result;
  }

  #repositoryOperationLock(options = {}) {
    return new RepositoryFlowOperationLock({
      mainRoot: this._mainRoot,
      maintenanceOwnerToken: options.maintenanceOwnerToken,
      operationOwnerToken: options.operationOwnerToken,
      allowProcessOwnerBorrow: false,
      ...(this._processIdentitySource && { processIdentitySource: this._processIdentitySource }),
    });
  }
}
