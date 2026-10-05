/**
 * src/flow/lib/flow-context.js
 *
 * Pure function that assembles flow-specific context fields from the shared
 * dependency container. Replaces the former resolveCtx() in src/flow.js.
 *
 * Flow state and artifacts always live under the main repository's configured
 * spec root. `root`/`repositoryRoot` identify that artifact authority, while
 * `executionRoot` identifies the checkout where source commands run.
 */

import { FlowTargetExpectation } from "../../lib/flow-target-guard.js";
import { WorktreeFlowProvenance } from "../../lib/worktree-flow-binding.js";
import { FlowSpecLocation, flowSpecRootFromConfig } from "../../lib/flow-workspace.js";
import { FLOW_DISPATCH_INVOCATION_ID_ENV } from "./dispatch-invocation.js";

const MISSING_PREPARING_FLOW_STATE = Object.freeze({});
const DISPATCH_INVOCATION_ENV = FLOW_DISPATCH_INVOCATION_ID_ENV;

function dispatchInvocationIdFromEnvironment() {
  const value = process.env[DISPATCH_INVOCATION_ENV];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveTargetSelection(expectation) {
  const selectRunId = expectation.effectiveRunId;
  const selectSpecId = expectation.effectiveSpecId;
  const selectIssue = expectation.effectiveIssue;
  const selectNoIssue = expectation.expectsNoIssue;
  if (selectRunId == null && selectSpecId == null && selectIssue == null && !selectNoIssue) return null;
  return { selectRunId, selectSpecId, selectIssue, selectNoIssue };
}

function preparingRunIdSelection(input = {}) {
  const runId = input.runId ?? null;
  if (typeof runId !== "string") return null;
  const trimmed = runId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function targetExpectationInput(options = {}) {
  const input = options.input || {};
  if (
    options.positionalRunIdTarget === true
    && typeof input.runId === "string"
    && input.runId.trim() !== ""
  ) {
    return { expectRunId: input.runId };
  }
  return input;
}

export function flowTargetExpectation(options = {}) {
  return new FlowTargetExpectation(targetExpectationInput(options));
}

function preparingAuthorityForRunId(baseFlowManager, mainRoot, paths, runId) {
  if (!runId || typeof baseFlowManager.loadPreparingFlow !== "function") return null;
  const state = baseFlowManager.loadPreparingFlow(runId);
  const authorityRoot = paths.root || mainRoot;
  return {
    flowManager: baseFlowManager.forRoot(authorityRoot),
    flowState: null,
    preparingFlowState: state || MISSING_PREPARING_FLOW_STATE,
    authorityRoot,
    flowResolutionError: null,
  };
}

function boundWorktreeAuthority(container, baseFlowManager, mainRoot, paths, expectation) {
  if (!container.get("inWorktree")) return null;
  if (baseFlowManager.usesWorktreeFlowBinding() === false) return null;
  let identity;
  try {
    identity = baseFlowManager.resolveWorktreeBinding(expectation);
  } catch (error) {
    return {
      flowManager: baseFlowManager,
      flowState: null,
      preparingFlowState: null,
      authorityRoot: null,
      flowResolutionError: error,
    };
  }
  const flowManager = baseFlowManager.forRoot(paths.root, { specId: identity.specId });
  const flowState = flowManager.load(identity.specId);
  return {
    flowManager,
    flowState,
    preparingFlowState: null,
    authorityRoot: paths.root,
    flowResolutionError: null,
    worktreeFlowProvenance: new WorktreeFlowProvenance(identity, mainRoot),
  };
}

function recoveryTargetExpectation(container, baseFlowManager, expectation) {
  if (!container.get("inWorktree") || baseFlowManager.usesWorktreeFlowBinding() === false) {
    return expectation;
  }
  const identity = baseFlowManager.resolveWorktreeBinding(expectation);
  return new FlowTargetExpectation({
    expectRunId: identity.runId,
    expectSpec: identity.specId,
    ...(identity.issue === null ? { expectNoIssue: true } : { expectIssue: identity.issue }),
  });
}

function resolveRecoveryAuthorityFlowState(container, baseFlowManager, options = {}) {
  let expectation = options.targetExpectation;
  try {
    expectation = recoveryTargetExpectation(container, baseFlowManager, expectation);
    const target = baseFlowManager.resolveFlowRecoveryTarget(expectation);
    const flowManager = baseFlowManager.forRoot(target.authorityRoot, { specId: target.specId });
    return {
      flowManager,
      flowState: target.state,
      preparingFlowState: null,
      authorityRoot: target.authorityRoot,
      flowResolutionError: null,
    };
  } catch (error) {
    if (!options.allowMissingActive && !options.captureTargetResolutionError) throw error;
    return {
      flowManager: baseFlowManager,
      flowState: null,
      preparingFlowState: null,
      authorityRoot: null,
      flowResolutionError: error,
    };
  }
}

function resolveAuthorityFlowState(container, baseFlowManager, mainRoot, options = {}) {
  const paths = container.get("paths");
  const targetExpectation = options.targetExpectation instanceof FlowTargetExpectation
    ? options.targetExpectation
    : flowTargetExpectation(options);
  if (options.recoveryTargetResolution === true) {
    return resolveRecoveryAuthorityFlowState(
      container,
      baseFlowManager,
      { ...options, targetExpectation },
    );
  }
  const worktreeAuthority = boundWorktreeAuthority(
    container,
    baseFlowManager,
    mainRoot,
    paths,
    targetExpectation,
  );
  if (worktreeAuthority) return worktreeAuthority;
  const preparingAuthority = options.preparingRunIdSelection === false
    ? null
    : preparingAuthorityForRunId(
      baseFlowManager,
      mainRoot,
      paths,
      preparingRunIdSelection(options.input),
    );
  if (preparingAuthority) return preparingAuthority;

  const selection = resolveTargetSelection(targetExpectation);
  // Any parsed target guard is an exact authority selection, including
  // ordinary commands such as `set note`.  Resolving the unscoped active
  // manager first is invalid when concurrent Flows exist and lets hook setup
  // observe a different Flow than the command itself.
  if (selection) {
    let target;
    try {
      const resolver = options.mismatchTargetResolution === true
        ? baseFlowManager.resolveExplicitFlowTargetForRead.bind(baseFlowManager)
        : baseFlowManager.resolveExplicitFlowTarget.bind(baseFlowManager);
      target = resolver(targetExpectation);
    } catch (error) {
      if (!options.allowMissingActive && !options.captureTargetResolutionError) throw error;
      return {
        flowManager: baseFlowManager,
        flowState: null,
        preparingFlowState: null,
        authorityRoot: null,
        flowResolutionError: error,
      };
    }
    const flowManager = baseFlowManager.forRoot(
      target.authorityRoot,
      target.specId ? { specId: target.specId } : {},
    );
    return {
      flowManager,
      flowState: target.preparing ? null : target.state,
      preparingFlowState: target.preparing ? target.state : null,
      authorityRoot: target.authorityRoot,
      flowResolutionError: null,
    };
  }
  const cwdState = baseFlowManager.load();
  if (!cwdState) {
    let resolved = null;
    try {
      resolved = typeof baseFlowManager.resolveActiveFlow === "function"
        ? baseFlowManager.resolveActiveFlow(null, selection || {})
        : null;
    } catch (err) {
      if (!options.allowMissingActive) throw err;
      return { flowManager: baseFlowManager, flowState: null, authorityRoot: null, flowResolutionError: err };
    }
    if (resolved) {
      const activeRoot = resolved.worktreePath || paths.root;
      const activeFm = resolved.worktreePath
        ? baseFlowManager.forRoot(resolved.worktreePath, { specId: resolved.specId })
        : baseFlowManager.forRoot(paths.root, { specId: resolved.specId });
      return { flowManager: activeFm, flowState: resolved.state, authorityRoot: activeRoot };
    }
    return { flowManager: baseFlowManager, flowState: null, authorityRoot: null, flowResolutionError: null };
  }

  return { flowManager: baseFlowManager, flowState: cwdState, authorityRoot: paths.root, flowResolutionError: null };
}

export function resolveFlowContext(container, options = {}) {
  const paths = container.get("paths");
  const baseFlowManager = container.get("flowManager");
  const mainRoot = container.get("mainRoot");
  const targetExpectation = options.targetExpectation instanceof FlowTargetExpectation
    ? options.targetExpectation
    : flowTargetExpectation(options);
  const {
    flowManager,
    flowState,
    preparingFlowState = null,
    authorityRoot,
    flowResolutionError,
    worktreeFlowProvenance = null,
  } = resolveAuthorityFlowState(
    container,
    baseFlowManager,
    mainRoot,
    { ...options, targetExpectation },
  );
  const executionRoot = authorityRoot || paths.root;
  const config = container.get("config");
  const specRoot = container.has("flowSpecRoot")
    ? container.get("flowSpecRoot")
    : flowSpecRootFromConfig(config);
  const specLocation = flowState
    ? (typeof flowManager.specLocation === "function"
        ? flowManager.specLocation(flowState.specId)
        : new FlowSpecLocation({ repositoryRoot: mainRoot, specRoot, specId: flowState.specId }))
    : null;
  return {
    root: mainRoot,
    mainRoot,
    config,
    paths,
    flowManager,
    flowState,
    preparingFlowState,
    specId: flowState?.specId ?? null,
    specLocation,
    specRoot,
    repositoryRoot: mainRoot,
    artifactRoot: mainRoot,
    executionRoot,
    inWorktree: container.get("inWorktree"),
    authorityRoot,
    flowResolutionError,
    worktreeFlowProvenance,
    targetExpectation,
    dispatchInvocationId: dispatchInvocationIdFromEnvironment(),
  };
}

/**
 * Build the context consumed by the shared command dispatcher and registry
 * hooks.  Keeping this beside FlowCommand's resolver prevents in-process
 * dispatcher execution from drifting from the public `sennel flow` entrypoint.
 */
export function buildFlowCommandHookContext(container, entry, input = {}) {
  const targetInput = entry.specOptionAsTarget === true
    && input.expectSpec == null
    && input.spec != null
    ? { ...input, expectSpec: input.spec }
    : input;
  return resolveFlowContext(container, {
    allowMissingActive: entry.requiresFlow === false,
    captureTargetResolutionError: true,
    explicitTargetResolution: entry.explicitTargetResolution === true,
    mismatchTargetResolution: entry.mismatchTargetResolution === true,
    recoveryTargetResolution: entry.recoveryTargetResolution === true,
    positionalRunIdTarget: entry.positionalRunIdTarget === true,
    preparingRunIdSelection: entry.preparingRunIdSelection !== false,
    input: targetInput,
  });
}
