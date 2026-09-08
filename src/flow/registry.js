/**
 * src/flow/registry.js
 *
 * Single source of truth for flow subcommand metadata.
 * Each command is defined declaratively with help, command (lazy import),
 * args definition, and optional pre/post/onError/finally hooks.
 *
 * Used by flow.js dispatcher and help.js.
 */

import { derivePhase } from "../lib/flow-helpers.js";
import { Envelope } from "../lib/flow-envelope.js";
import { hasExplicitOption } from "../lib/flow-options.js";
import fs from "fs";
import path from "path";
import {
  VALID_PHASES,
  VALID_METRIC_COUNTERS,
  VALID_GATE_PHASES,
  VALID_REVIEW_PHASES,
  VALID_GUARDRAIL_PHASES,
} from "../lib/constants.js";
import { resolveGatePhaseFromState, resolveScopedGateStepId } from "./lib/gate-step.js";
import {
  findActiveNode,
  resolveLifecyclePlan,
  resolveRuntimeStep,
  resolveGateTransition,
  GateTransitionDecision,
  projectGatePublicOutcome,
  resolveNonGateTransition,
  NonGateRecordNonblockingAction,
  scenarioValidityTransitionDefinition,
  testExecuteTransitionDefinition,
  testResultReviewTransitionDefinition,
  CompleteDraftCoverageRepair,
  resolveDraftCoverageRepairCompletion,
  SetStepStatus,
  taskIdForResolvedStep,
} from "./definition.js";
import { readCurrentGateTransitionFacts } from "./lib/gate-transition-facts.js";
import { applyGatePublicOutcomeProjection } from "./lib/gate-transition-application.js";
import { findStepById, flattenSteps } from "./lib/step-tree.js";
import { DRAFT_REVIEW_ROUTES, draftReviewRouteForRetryPhase } from "./lib/draft-review-routes.js";
import { discoverFlowCommandHooks, runFlowCommandHooks } from "../lib/plugin-registry.js";
import {
  DecisionOutcome,
  DeferOutcome,
  StepAttempt,
} from "./lib/step-outcome.js";
import {
  finalizationOutboxIdentity,
} from "./lib/flow-outbox.js";
import {
  DefinitionLifecycleTransition,
  ExplicitRecoveryTransition,
} from "./lib/step-transition-policy.js";
import { nonblockingRouteFor } from "./lib/nonblocking-route.js";
import { FinalizeFlowStateOwner } from "./lib/finalize-flow-state-owner.js";
import {
  attachedCanonicalCommandResultArtifact,
  attachedCanonicalCommandResultPublications,
} from "./lib/canonical-command-result.js";
import { CanonicalFlowArtifactWrite } from "./lib/current-flow-state.js";
import { TaskStepIdentity } from "./lib/task-step-identity.js";
import { DefinitionFailureOwnership } from "./lib/definition-failure-ownership.js";
import { RepositoryFlowOperationLock } from "../lib/repository-maintenance-lock.js";
import { readCurrentNonGateTransitionFacts } from "./lib/non-gate-transition-facts.js";
import { readCurrentTestChainTransitionFacts } from "./lib/test-chain-transition-facts.js";
import {
  validateScenarioValidityArtifactShape,
  validateScenarioValidityObservationCoherence,
} from "./lib/test-artifacts.js";
import { CurrentTaskSourceSnapshot, TaskMutationLineageSet } from "./lib/task-mutation-lineage.js";

/**
 * Successful command-result statuses that map to a flow step status of 'done'.
 * 'skipped' is normalized to 'done' so the step ledger does not mix done/skipped
 * for finalize leaves (per spec 251 design principle).
 */
const FLOW_RUN_RUNTIME_OPTIONS = ["--agent-work-dir"];
const FLOW_TARGET_GUARD_FLAGS = ["--expect-no-issue"];
const FLOW_TARGET_GUARD_OPTIONS = ["--expect-issue", "--expect-spec", "--expect-run-id", "--expect-binding"];
const FLOW_TARGET_GUARD_USAGE = "[--expect-binding <token> | [--expect-issue <number> | --expect-no-issue] [--expect-spec <spec>] [--expect-run-id <runId>]]";
const FLOW_TARGET_GUARD_HELP_LINES = [
  "  --expect-binding <token>  Require the selected flow and execution authority to match this CLI-generated binding.",
  "  --expect-issue <number>  Require the selected flow to belong to this Issue.",
  "  --expect-no-issue        Require the selected flow to have no Issue.",
  "  --expect-spec <spec>     Require the selected flow to match this spec.",
  "  --expect-run-id <runId>  Require the selected flow to match this runId.",
];
const FLOW_RUN_OPTIONS = [...FLOW_RUN_RUNTIME_OPTIONS, ...FLOW_TARGET_GUARD_OPTIONS];
function withTargetGuardOptions(options = []) {
  return [...options, ...FLOW_TARGET_GUARD_OPTIONS];
}
function withTargetGuardFlags(flags = []) {
  return [...flags, ...FLOW_TARGET_GUARD_FLAGS];
}
const RETRY_HELP_GATE_PHASES = Object.freeze(["task-impl", "integration"]);
const RETRY_HELP_REVIEW_PHASES = Object.freeze(["draft", "draft-questions", "draft-coverage", "spec", "test", "impl"]);
export const DRAFT_REVIEW_REGISTRY_RESPONSIBILITY_BOUNDARY = Object.freeze({
  review: "detection",
  triage: "disposition",
  repair: "mutation/audit",
  gate: "mechanical validation",
  summary: "review as detection, triage as disposition, repair as mutation/audit, gate as mechanical validation",
});

const DRAFT_REVIEW_REVIEW_RESPONSIBILITIES = Object.freeze([
  "record detection artifacts only",
  "delegate accept/reject disposition to triage steps",
  "delegate mutation/audit output to repair steps",
  "leave mechanical validation to gate steps",
]);

const DRAFT_REVIEW_GATE_RESPONSIBILITIES = Object.freeze([
  "mechanically validate readiness artifacts, schemas, links, unresolved decisions, approval, tests, and guardrail compliance as mechanical validation",
  "do not perform review detection, triage disposition, or repair mutation/audit",
]);

export function assertDraftReviewRegistryHookBoundary() {
  const expected = "review as detection, triage as disposition, repair as mutation/audit, gate as mechanical validation";
  if (DRAFT_REVIEW_REGISTRY_RESPONSIBILITY_BOUNDARY.summary !== expected) {
    throw new Error(`invalid draft review registry hook boundary: ${DRAFT_REVIEW_REGISTRY_RESPONSIBILITY_BOUNDARY.summary}`);
  }
}

/**
 * Resolve the FlowManager scoped to the main repo for merge-onward post hooks.
 * Flow state remains under the main repo's configured spec root throughout.
 * (squash-merged from the worktree). Post hooks must update that file — not
 * the now-stale worktree copy — so authority is switched via forRoot().
 */
function switchToMainRepoFlowAuthority(ctx) {
  FinalizeFlowStateOwner.forMainContext(ctx).bindContext(ctx);
}

function acquireFinalizeSyncOperation(ctx) {
  const owner = FinalizeFlowStateOwner.forMainContext(ctx);
  const operation = new RepositoryFlowOperationLock({
    mainRoot: owner.mainRepoPath,
    allowProcessOwnerBorrow: false,
  });
  operation.acquire();
  ctx.finalizeSyncOperation = operation;
}

function releaseFinalizeSyncOperation(ctx) {
  const operation = ctx.finalizeSyncOperation;
  if (!(operation instanceof RepositoryFlowOperationLock)) return;
  operation.assertOwned();
  operation.release();
  delete ctx.finalizeSyncOperation;
}

/**
 * Reset finalize-sync / finalize-cleanup status back to 'pending' on the given
 * flow manager when they are currently 'skipped'. The skipped status is set by
 * the finalize-merge onError hook on a prior failed merge; on retry success we
 * need promoteNextPendingLeaf to advance to finalize-sync, which it cannot do
 * while those steps are skipped.
 */
/**
 * @returns {boolean} true when at least one leaf was reset, false when no-op.
 */
function resetSkippedDownstreamSteps(stateOwner, stepIds = []) {
  const state = stateOwner.loadReadOnly();
  if (!state) return false;
  const flat = flattenSteps(state.steps || []);
  const resetIds = stepIds.filter((id) => flat.find((step) => step.id === id)?.status === "skipped");
  if (resetIds.length === 0) return false;
  stateOwner.finalizeDownstream({ action: "reset", stepIds: resetIds });
  return true;
}

/**
 * Load flow state and derive the current phase.
 */
function deriveActivePhase(ctx) {
  const state = ctx.flowManager.load();
  return derivePhase(state);
}

/**
 * A Version-1 command result is owned by one producing Attempt. Lifecycle
 * plans may subsequently settle no-op triage/repair leaves, but those leaves
 * must never republish the producer's history or immutable evidence.
 */
function canonicalResultProducerStep(provenance, result) {
  const event = provenance?.event || "";
  const phase = result?.artifacts?.phase;
  if (event === "review:post") {
    if (phase === "draft" || phase === "draft-questions" || phase === "draft-coverage") {
      return draftReviewRouteForRetryPhase(result?.artifacts?.retryPhase || phase)?.reviewStepId ?? null;
    }
    if (phase === "spec") return "spec-review";
    if (phase === "test") return "test-review";
    if (phase === "impl") {
      return result?.artifacts?.taskId == null ? "impl-review" : `${result.artifacts.taskId}-review`;
    }
    return null;
  }
  if (event === "gate:post") {
    if (phase === "draft") return "draft-gate";
    if (phase === "spec" || phase === "task-spec") return "spec-gate";
    if (phase === "integration") return "impl-gate";
    if (phase === "task-impl") {
      return result?.artifacts?.taskId == null ? "impl-gate" : `${result.artifacts.taskId}-gate`;
    }
  }
  if (event === "test-execute:post") return "test-execute";
  if (event === "scenario-validity:post") return "scenario-validity";
  if (event === "test-result-review:post") return "test-result-review";
  if (event === "final-regression:post") return "final-regression";
  if (event === "retro:post") return "retro";
  if (String(event).startsWith("report:")) return "report";
  return null;
}

/**
 * Persist non-terminal review results before their sealed work unit is
 * cleaned up.  A flow-scoped rejected test review remains active so the
 * definition-owned repair transition can consume its cataloged evidence.
 * Task-scoped implementation reviews use the dedicated review-funnel
 * publication connector before this helper is reached.
 */
async function persistNonTerminalReviewResult(ctx, result) {
  const artifacts = result?.artifacts;
  const rejectedTestReview = artifacts?.phase === "test"
    && artifacts?.taskId == null
    && artifacts?.verdict === "REJECTED";
  const toolingReview = artifacts?.toolingOutcome != null;
  if (!rejectedTestReview && !toolingReview) return;

  const { attachedCanonicalCommandResultArtifact } = await import("./lib/canonical-command-result.js");
  if (attachedCanonicalCommandResultArtifact(result) === null) return;

  const specId = ctx.specId ?? ctx.flowState.specId;
  if (rejectedTestReview || toolingReview || ctx.flowState?.policy?.nonblocking?.enabled === true) {
    ctx.flowManager.publishCurrentAttemptResult({ specId, commandResult: result });
  } else {
    ctx.flowManager.failCurrentAttempt({
      specId,
      failure: {
        category: "semantic",
        code: "REVIEW_REJECTED",
        message: "Task review rejected the current implementation Attempt.",
        retryable: true,
        retryKind: "semantic",
      },
      result: {
        outcome: "failed",
        summary: "Task review rejected the current implementation Attempt.",
        confirmedAt: new Date().toISOString(),
        artifactRefs: [],
      },
      commandResult: result,
    });
  }
  ctx.flowState = ctx.flowManager.loadReadOnly(specId);
}

/** Re-admit Task Review source immediately before any Store publication. */
function assertCurrentTaskReviewSource(ctx, result) {
  const artifacts = result?.artifacts;
  if (artifacts?.phase !== "impl" || artifacts?.taskId == null) return;
  const expected = artifacts.sourceFingerprint;
  if (typeof expected !== "string") {
    throw new Error("Task Review publication requires its source fingerprint");
  }
  const specId = ctx.specId ?? ctx.flowState.specId;
  const state = ctx.flowManager.loadReadOnly(specId);
  if (state.currentTaskId !== artifacts.taskId) {
    throw new Error("Task Review publication no longer belongs to the current Task");
  }
  const lineageSet = new TaskMutationLineageSet({
    runId: state.runId,
    specId,
    taskId: artifacts.taskId,
    lineages: ctx.flowManager.taskMutationLineages({ specId, taskId: artifacts.taskId }),
  });
  const current = CurrentTaskSourceSnapshot.capture({
    root: ctx.executionRoot || ctx.root,
    lineageSet,
  });
  if (current.fingerprint !== expected) {
    const error = new Error("Task Review source changed before canonical publication; reload the current Task context");
    error.code = "STALE_REVIEW_TARGET";
    throw error;
  }
}

/** A spec review owns a revision-scoped publication rather than generic
 * Attempt history. All other review phases retain their Attempt artifact. */
function hasRevisionScopedSpecReviewPublication(result) {
  return result?.artifacts?.phase === "spec"
    && attachedCanonicalCommandResultPublications(result).some((publication) => (
      publication.logicalKey === "spec.review"
      && typeof publication.parameters?.revision === "string"
    ));
}

/**
 * Best-effort step status update. Hooks may fire after `cleanup` removes
 * flow.json (and during early init before it exists), so a missing-file
 * error is the expected non-failure mode. Any other error is operationally
 * meaningful and is re-thrown so the dispatcher can surface it as a
 * post-hook warning in the envelope.
 *
 * The first argument may be a hook ctx (uses ctx.flowManager) or a
 * FlowManager directly — the latter form is used by merge-onward finalize
 * hooks which target the main-repository canonical Version Store via forRoot().
 */
function tryUpdateStepStatus(target, stepId, status, opts, provenance = {}) {
  const isFinalizeStateOwner = target instanceof FinalizeFlowStateOwner;
  const isHookContext = !isFinalizeStateOwner
    && Boolean(target && typeof target === "object" && target.flowManager);
  const fm = isHookContext
    ? target.flowManager
    : (isFinalizeStateOwner ? target.flowManager : target);
  let mutationOpts = opts;
  if (isHookContext) {
    mutationOpts = { ...(opts || {}) };
    if (!hasExplicitOption(mutationOpts, "specId") && target.specId) {
      mutationOpts.specId = target.specId;
    }
    if (!hasExplicitOption(mutationOpts, "taskId")) {
      const activeNode = target.flowState ? findActiveNode(target.flowState) : null;
      mutationOpts.taskId = taskIdForResolvedStep(activeNode, stepId);
    }
  }
  try {
    let state;
    if (typeof fm.loadReadOnly === "function") {
      state = mutationOpts?.specId ? fm.loadReadOnly(mutationOpts.specId) : fm.loadReadOnly();
    } else if (typeof fm.load === "function") {
      state = mutationOpts?.specId ? fm.load(mutationOpts.specId) : fm.load();
    } else if (isHookContext) {
      state = target.flowState;
    }
    if (state?.schemaRevision !== 3) {
      throw new Error("flow lifecycle hooks require an active canonical Flow state");
    }
    const scope = mutationOpts?.taskId == null
      ? state
      : state?.tasks?.find((task) => task.id === mutationOpts.taskId);
    const targetStep = findStepById(scope?.steps || [], stepId);
    if (!targetStep) throw new Error(`unknown step: ${stepId}`);
    if (targetStep.status === status) return;
    const currentStepId = provenance.currentStepId
      || findActiveNode(state)?.stepId
      || stepId;
    if (!provenance.plan && !provenance.event) {
      throw new Error(`definition lifecycle event is required for ${stepId}=${status}`);
    }
    const plan = provenance.plan || resolveLifecyclePlan({
      event: provenance.event,
      currentStepId,
      targetStepId: stepId,
      status,
    });
    const action = provenance.action
      || plan.actions.find((candidate) => candidate.step === stepId && candidate.status === status);
    if (!action) throw new Error(`definition lifecycle did not emit ${stepId}=${status}`);
    const transition = new DefinitionLifecycleTransition({
      action,
      plan,
      currentStatus: targetStep.status,
    });
    // V1 result histories are committed by the Version Store while the
    // producing Attempt is still current.  The lifecycle adapter supplies
    // the parsed command result here; it never writes a second state field.
    if (
      provenance.result !== undefined
      && (
        state.currentNodeId === stepId
        || (stepId === "spec-review" && hasRevisionScopedSpecReviewPublication(provenance.result))
        || canonicalResultProducerStep(provenance, provenance.result) === stepId
      )
    ) {
      mutationOpts.canonicalCommandResult = provenance.result;
    }
    if (isFinalizeStateOwner) {
      target.updateStepStatus(transition, {
        taskId: mutationOpts?.taskId ?? null,
        operationOwnerToken: mutationOpts?.operationOwnerToken ?? null,
      });
    } else {
      fm.updateStepStatus(transition, mutationOpts, provenance.commitIntent || null);
    }
  } catch (err) {
    if (err?.code === "ERR_MISSING_FILE") {
      process.stderr.write(`[sennel] step-status update skipped (${stepId}=${status}): ${err.message}\n`);
      return;
    }
    if (err.message === "no active flow (flow.json not found)") {
      process.stderr.write(`[sennel] step-status update skipped (${stepId}=${status}): no active flow\n`);
      return;
    }
    throw err;
  }
}

/**
 * Wrap an issue-log append. Same expected-error contract as
 * tryUpdateStepStatus: only swallow `ERR_MISSING_FILE` (no flow.json yet
 * or post-cleanup), re-throw the rest so the dispatcher can warn.
 */
function tryAppendIssueLog(fn) {
  try {
    fn();
  } catch (err) {
    if (err?.code === "ERR_MISSING_FILE") {
      process.stderr.write(`[sennel] issue-log append skipped: ${err.message}\n`);
      return;
    }
    throw err;
  }
}

const TEST_CHAIN_DEFINITIONS = Object.freeze({
  "scenario-validity": scenarioValidityTransitionDefinition,
  "test-execute": testExecuteTransitionDefinition,
  "test-result-review": testResultReviewTransitionDefinition,
});

/**
 * The post hook does not classify test evidence. It first makes the producer
 * observation durable, then asks Definition to select the sealed plan and
 * applies only the typed plan effects. In particular, an integrity decision
 * has an empty plan, so stale/partial observations cannot settle an Attempt.
 */
async function applyTestChainTransition(ctx, result, stepId) {
  const specId = ctx.specId ?? ctx.flowState.specId;
  const definition = TEST_CHAIN_DEFINITIONS[stepId];
  if (!definition) throw new Error(`unknown test-chain Definition: ${stepId}`);
  ctx.flowManager.publishCurrentAttemptResult({ specId, commandResult: result });
  const facts = readCurrentNonGateTransitionFacts({
    flowManager: ctx.flowManager,
    specId,
    readFacts: () => readCurrentTestChainTransitionFacts({ flowManager: ctx.flowManager, specId }),
  });
  const decision = resolveNonGateTransition(facts, definition);
  const recordAction = decision.plan.actions.find((action) => action instanceof NonGateRecordNonblockingAction) ?? null;
  let nonblockingRecord = null;
  if (recordAction !== null) {
    const { deriveEligibleNonblockingObservation } = await import("./lib/nonblocking.js");
    nonblockingRecord = deriveEligibleNonblockingObservation(
      { ...ctx, flowState: ctx.flowManager.loadReadOnly(specId) },
      recordAction.stepId,
    );
  }
  ctx.flowManager.applyTestChainTransitionDecision({ specId, decision, nonblockingRecord });
  ctx.flowState = ctx.flowManager.loadReadOnly(specId);
  return decision;
}

/**
 * The registry persists the observation, then asks Definition for its one
 * Gate plan.  It intentionally has no phase route table or retry arithmetic.
 */
function resolvePersistedPlanGateDecision(ctx, result) {
  const phase = result?.artifacts?.phase || ctx.phase;
  const facts = readCurrentGateTransitionFacts({
    flowManager: ctx.flowManager,
    flowState: ctx.flowState,
    phase,
  });
  if (facts === null) throw new Error("Definition-owned Gate result was not published for the current Attempt");
  return resolveGateTransition(facts);
}

function gateRuntimeLogStepId(ctx) {
  if (!ctx.flowState) return null;
  const phase = ctx.phase || resolveGatePhaseFromState(ctx.flowState)?.phase;
  return resolveScopedGateStepId(ctx.flowState, phase);
}

function setStepRuntimeLogStepId(ctx) {
  if (!ctx.flowState || typeof ctx.id !== "string") return null;
  const activeNode = findActiveNode(ctx.flowState);
  const taskStep = TaskStepIdentity.fromStateNode(ctx.flowState, activeNode?.stepId);
  if (taskStep?.definitionId === ctx.id) return taskStep.nodeId;
  return findStepById(ctx.flowState.steps || [], ctx.id) ? ctx.id : null;
}

function terminalGateRevalidation(ctx) {
  if (ctx.phase == null || !ctx.flowState) return false;
  const stepId = resolveScopedGateStepId(ctx.flowState, ctx.phase);
  const step = findStepById(ctx.flowState.steps || [], stepId)
    || ctx.flowState.tasks?.flatMap((task) => task.steps || []).find((entry) => entry.id === stepId);
  const activeNode = findActiveNode(ctx.flowState);
  return ["done", "skipped"].includes(step?.status) && activeNode?.stepId !== stepId;
}

function activeStepId(flowState, stepIds) {
  const steps = Array.isArray(flowState?.steps) ? flattenSteps(flowState.steps) : [];
  const allowed = new Set(stepIds);
  return steps.find((step) => allowed.has(step.id) && step.status === "in_progress")?.id || null;
}

// Resolve which materialized review node the impl-phase post-hook owns. Task
// lifecycle nodes use stable IDs such as T-1-review; the definition alias
// task-review is only a public command/action name.
function activeImplReviewStepId(flowState) {
  const active = findActiveNode(flowState || {});
  if (active?.stepId === "impl-review") return active.stepId;
  const taskStep = TaskStepIdentity.fromStateNode(flowState, active?.stepId);
  if (taskStep?.definitionId === "task-review") return taskStep.nodeId;
  return "impl-review";
}

function draftReviewRuntimeLogStepId(ctx, result) {
  const retryPhase = result?.artifacts?.retryPhase || (String(ctx.phase || "").startsWith("draft-") ? ctx.phase : null);
  const route = draftReviewRouteForRetryPhase(retryPhase);
  if (route) return route.reviewStepId;
  return activeStepId(ctx.flowState, DRAFT_REVIEW_ROUTES.map((candidate) => candidate.reviewStepId))
    || draftReviewRouteForRetryPhase("draft-questions").reviewStepId;
}

function reviewRuntimeLogStepId(ctx, result) {
  return resolveRuntimeStep({
    command: "run-review",
    phase: ctx.phase,
    result,
    flowState: ctx.flowState,
    currentStepId: activeStepId(ctx.flowState, DRAFT_REVIEW_ROUTES.map((candidate) => candidate.reviewStepId)),
  });
}

function finalizeCommand(suffix) {
  return `finalize-${suffix}`;
}

class RegistryLifecycleAdapter {
  constructor(ctx, result, err, { plan, input }) {
    this.ctx = ctx;
    this.result = result;
    this.err = err;
    // Post-Gate persistence is driven by the sealed Definition Decision.
    // The runner's artifact phase remains an observation input only for
    // pre-lifecycle and non-Gate command handling.
    this.phase = ctx.gateTransitionDecision?.facts.phase || result?.artifacts?.phase || ctx.phase;
    const activeNode = this.ctx.flowState ? findActiveNode(this.ctx.flowState) : null;
    const activeTaskStep = TaskStepIdentity.fromStateNode(this.ctx.flowState, activeNode?.stepId);
    this.gateStepId = this.phase === "task-impl"
      && activeTaskStep?.definitionId === "task-gate"
      ? activeTaskStep.nodeId
      : "impl-gate";
    this.gateTaskId = activeTaskStep?.definitionId === "task-gate" ? activeTaskStep.taskId : null;
    this.plan = this.phase === "task-impl"
      ? plan.forStepAlias({ sourceStep: "impl-gate", targetStep: this.gateStepId })
      : plan;
    this.actions = this.plan.actions;
    this.input = input;
  }

  mutationOpts(step, extras = {}) {
    const activeNode = this.ctx.flowState ? findActiveNode(this.ctx.flowState) : null;
    return {
      ...extras,
      taskId: step === this.gateStepId
        ? this.gateTaskId
        : taskIdForResolvedStep(activeNode, step),
    };
  }

  finalizeStateOwner() {
    if (!this.ctx.finalizeFlowStateOwner) {
      FinalizeFlowStateOwner.fromContext(this.ctx).bindContext(this.ctx);
    }
    return this.ctx.finalizeFlowStateOwner;
  }

  setStepStatus(step, status, action) {
    const attempt = this.result?.stepAttempt
      ? StepAttempt.fromStored(this.result.stepAttempt)
      : null;
    if (status === "in_progress" && attempt?.outcome instanceof DeferOutcome) return;
    const settledStatus = status;
    const lifecycleResult = this.ctx.gateTransitionDecision?.facts?.result === "pass"
      ? undefined
      : this.result;
    if (step.startsWith("finalize-")) {
      const stateOwner = this.finalizeStateOwner();
      const current = stateOwner.loadReadOnly();
      const currentStep = findStepById(current?.steps || [], step);
      if (currentStep?.status === settledStatus) return;
      tryUpdateStepStatus(
        stateOwner,
        step,
        settledStatus,
        this.mutationOpts(step, { specId: this.ctx.specId }),
        {
          action,
          plan: this.plan,
          currentStepId: this.input.currentStepId || resolveRuntimeStep(this.input),
          event: this.input.event,
          result: lifecycleResult,
        },
      );
      return;
    }
    const gateTransitionDecision = step === this.gateStepId && status === "done"
      ? this.ctx.gateTransitionDecision ?? null
      : null;
    tryUpdateStepStatus(
      { ...this.ctx, phase: this.phase },
      step,
      settledStatus,
      this.mutationOpts(step, { gateTransitionDecision }),
      {
        action,
        plan: this.plan,
        currentStepId: this.input.currentStepId || resolveRuntimeStep(this.input),
        event: this.input.event,
        result: lifecycleResult,
      },
    );
  }

  refreshFlowState() {
    let state = null;
    if (typeof this.ctx.flowManager.loadReadOnly === "function") {
      state = this.ctx.specId
        ? this.ctx.flowManager.loadReadOnly(this.ctx.specId)
        : this.ctx.flowManager.loadReadOnly();
    } else if (typeof this.ctx.flowManager.load === "function") {
      state = this.ctx.specId
        ? this.ctx.flowManager.load(this.ctx.specId)
        : this.ctx.flowManager.load();
    }
    if (state) this.ctx.flowState = state;
  }

  keepInProgress(step) {
    tryUpdateStepStatus(
      this.ctx,
      step,
      "in_progress",
      this.mutationOpts(step),
      { event: "definition:keep-in-progress" },
    );
  }

  async incrementMetric(phase, counter) {
    if (counter === "reviewRetry") {
      const reviewTransition = await import("./lib/review-transition-persistence.js");
      reviewTransition.persistReviewTransitionFacts(this.ctx, this.result);
      return;
    }
    if (counter === "gateRetry") {
      const decision = this.ctx.gateTransitionDecision;
      const effect = decision?.plan.retryMetric;
      if (effect === null || effect === undefined || effect.phase !== phase) {
        throw new Error("gate retry metric requires the Definition-selected Gate retry plan");
      }
      if (decision.facts.scope === "task") {
        this.ctx.flowManager.recordTaskGateSettlementMetric({
          specId: this.ctx.specId ?? this.ctx.flowState.specId,
          decision,
        });
        return;
      }
      this.ctx.flowManager.appendMetric({
        phase,
        counter: "gateRetry",
        delta: effect.operation === "increment" ? 1 : 0,
        ...(effect.operation === "reset" ? { reset: true } : {}),
      }, this.mutationOpts(this.gateStepId));
    }
  }

  async persistReviewResult() {
    if (hasRevisionScopedSpecReviewPublication(this.result)) {
      // The version-scoped review is accepted only by confirm_attempt. Its
      // lifecycle confirmation below owns that one transaction; publishing
      // here would create an unrelated Activity before the confirmation.
      return;
    }
    const { attachedCanonicalCommandResultArtifact } = await import("./lib/canonical-command-result.js");
    if (attachedCanonicalCommandResultArtifact(this.result) === null) {
      throw new Error("definition-selected Review result persistence requires a canonical command result");
    }
    this.ctx.flowManager.publishCurrentAttemptResult({
      specId: this.ctx.specId ?? this.ctx.flowState.specId,
      commandResult: this.result,
    });
    this.refreshFlowState();
  }

  async completeDraftCoverageRepair(action) {
    if (!(action instanceof CompleteDraftCoverageRepair)) {
      throw new Error("draft coverage repair requires the Definition-selected action");
    }
    const { readCoveragePassDraftCompletionFacts } = await import("./lib/draft-completion-connector.js");
    const specId = this.ctx.specId ?? this.ctx.flowState.specId;
    const facts = readCoveragePassDraftCompletionFacts({
      flowManager: this.ctx.flowManager,
      specId,
    });
    const decision = resolveDraftCoverageRepairCompletion(facts);
    this.ctx.flowManager.confirmDraftCoverageRepairCompletion({
      specId,
      decision,
      draft: facts.draft,
    });
    this.refreshFlowState();
  }

  async appendIssueLog(source) {
    if (source === "gate-result") {
      if (this.result?.artifacts?.deferred === true) return;
      const gateMod = await import("./lib/run-gate.js");
      tryAppendIssueLog(() => gateMod.appendIssueLogFromGateResult(this.ctx, this.result));
      return;
    }
    if (source === "test-review-tooling-failure") {
      const reviewMod = await import("./lib/run-review.js");
      tryAppendIssueLog(() => reviewMod.appendIssueLogFromTestReviewToolingFailure(this.ctx, this.result));
    }
  }

  outboxStore() {
    return this.finalizeStateOwner().outbox();
  }

  outboxIdentity(step) {
    return finalizationOutboxIdentity(this.ctx.flowState, step);
  }

  beginOutboxEffect(step) {
    if (this.ctx.dryRun) return null;
    const outbox = this.outboxStore();
    const identity = this.outboxIdentity(step);
    const owner = this.finalizeStateOwner();
    const current = owner.loadReadOnly();
    const active = findActiveNode(current);
    if (active?.stepId !== step || findStepById(current?.steps || [], step)?.status !== "in_progress") {
      const error = new Error(`finalization ${step} must be claimed by the current canonical Attempt before its outbox can begin`);
      error.code = "FINALIZATION_ACTION_CLAIM_REQUIRED";
      throw error;
    }
    const existing = outbox.status(identity);
    if (["pending", "done"].includes(existing?.status)) {
      this.ctx.flowOutboxEntry = existing;
      return existing;
    }
    this.ctx.flowOutboxEntry = outbox.beginCommand(identity);
    return this.ctx.flowOutboxEntry;
  }

  completeOutboxEffect(step) {
    if (this.ctx.dryRun) return null;
    this.ctx.flowOutboxEntry = this.outboxStore().complete(this.outboxIdentity(step), this.result);
    return this.ctx.flowOutboxEntry;
  }

  failOutboxEffect(step) {
    if (this.ctx.dryRun) return null;
    const reason = this.err
      || new Error(this.result?.reason || this.result?.message || `${step} side effect failed`);
    const identity = this.outboxIdentity(step);
    const outbox = this.outboxStore();
    try {
      this.ctx.flowOutboxEntry = outbox.fail(identity, reason);
    } catch (error) {
      if (!String(error.message).startsWith("outbox entry not found:")) throw error;
      outbox.begin(identity);
      this.ctx.flowOutboxEntry = outbox.fail(identity, reason);
    }
    return this.ctx.flowOutboxEntry;
  }

  skipSteps(steps) {
    const stateOwner = this.finalizeStateOwner();
    stateOwner.finalizeDownstream({ action: "skip", stepIds: steps });
  }

  async runLifecycleHook(module, handler, args) {
    if (module === "finalize") {
      await this.runFinalizeHook(handler, args);
      return;
    }
    throw new Error(`unknown lifecycle hook module: ${module}`);
  }

  async runFinalizeHook(handler, args) {
    const finalize = await import("./lib/run-finalize.js");
    if (handler === "assertFinalizeMergeMetadataMutationSafe") {
      this.ctx.finalizeMergeMetadataPreflight = finalize.assertFinalizeMergeMetadataMutationSafe({
        root: this.ctx.root,
        specId: this.ctx.specId,
        specRoot: this.ctx.specRoot?.toString(),
      });
      return;
    }
    if (handler === "prepareFinalizeMerge") {
      const metadataPreflight = finalize.readFinalizeMergeMetadataPreflight({
        root: this.ctx.root,
        specId: this.ctx.specId,
        specRoot: this.ctx.specRoot?.toString(),
      });
      if (finalize.hasFinalizeMergeTargetExternalDirty({
        root: this.ctx.root,
        specId: this.ctx.specId,
        specRoot: this.ctx.specRoot?.toString(),
        preflight: metadataPreflight,
      })) {
        return;
      }
      const mutated = resetSkippedDownstreamSteps(
        this.finalizeStateOwner(),
        args?.steps || [],
      );
      if (mutated) {
        finalize.commitFinalizeMergeMetadataIfSafe({
          root: this.ctx.root,
          specId: this.ctx.specId,
          specRoot: this.ctx.specRoot?.toString(),
          preflight: metadataPreflight,
          includeFlowJson: true,
          message: "chore: reset downstream finalize steps for retry",
        });
      }
      return;
    }
    if (handler === "resolveMainRepoFlowManager") {
      if (args?.unlessPr && this.result?.strategy === "pr") return;
      switchToMainRepoFlowAuthority(this.ctx);
      return;
    }
    if (handler === "resolveCleanupOutboxFlowManager") {
      const { worktreePath } = this.ctx.flowManager.resolveWorktreePaths(this.ctx.flowState);
      if (!worktreePath || !fs.existsSync(worktreePath)) switchToMainRepoFlowAuthority(this.ctx);
      return;
    }
    if (handler === "commitFinalizeCompletion") {
      finalize.commitFinalizeCompletion({
        root: this.ctx.root,
        specId: this.ctx.specId,
        specRoot: this.ctx.specRoot?.toString(),
        idempotencyKey: this.ctx.flowOutboxEntry?.idempotencyKey,
      });
      return;
    }
    if (handler === "recordMergeOutcome") {
      // The finalize producer artifact is the durable merge outcome.  The
      // exact V1 state intentionally has no second mutable projection.
      return;
    }
    if (handler === "ensureFinalizeMergeInProgress") {
      const stateOwner = this.finalizeStateOwner();
      const current = stateOwner.loadReadOnly();
      if (current?.schemaRevision !== 3) {
        throw new Error("finalize lifecycle hooks require an active canonical Flow state");
      }
      return;
    }
    if (handler === "resetSkippedDownstreamSteps") {
      resetSkippedDownstreamSteps(this.finalizeStateOwner(), args?.steps || []);
      return;
    }
    if (handler === "commitFinalizeMergeConflictMetadata") {
      finalize.commitFinalizeMergeConflictMetadata({
        root: this.ctx.root,
        specId: this.ctx.specId,
        preflight: this.ctx.finalizeMergeMetadataPreflight,
      });
      return;
    }
    if (handler === "finalizeOnError") {
      finalize.finalizeOnError(args?.command)(this.ctx, this.err);
    }
  }
}

/** Applies one Definition-selected Task Gate settlement effect per canonical iteration. */
export class TaskGateSettlementCoordinator {
  constructor({ ctx, input, result, err } = {}) {
    if (ctx?.gateTransitionDecision?.facts.scope !== "task") {
      throw new Error("Task Gate settlement coordinator requires a Task Gate decision");
    }
    this.ctx = ctx;
    this.input = input;
    this.result = result;
    this.err = err;
    Object.freeze(this);
  }

  async apply() {
    // Every effect is a separate canonical mutation.  Refresh facts and the
    // Definition decision after each one so a reload/fault resumes at the
    // first missing effect without repeating prior metrics or issue records.
    for (;;) {
      this.ctx.flowState = this.ctx.flowManager.loadReadOnly(this.ctx.specId ?? this.ctx.flowState.specId);
      const facts = readCurrentGateTransitionFacts({
        flowManager: this.ctx.flowManager,
        flowState: this.ctx.flowState,
        phase: this.ctx.gateTransitionDecision.facts.phase,
      });
      if (facts === null) return;
      this.ctx.gateTransitionDecision = resolveGateTransition(facts);
      if (facts.taskSettlementProgress.classificationRecovery.required) {
        this.ctx.flowManager.recoverTaskGateClassification({
          specId: this.ctx.specId ?? this.ctx.flowState.specId,
          decision: this.ctx.gateTransitionDecision,
        });
        continue;
      }
      if (facts.result === "fail" && !facts.taskSettlementProgress.classificationRecorded) {
        const stepAttempt = this.ctx.flowManager.recordGateObservationDecision({
          specId: this.ctx.specId ?? this.ctx.flowState.specId,
          decision: this.ctx.gateTransitionDecision,
        });
        if (stepAttempt !== null) this.result.stepAttempt = stepAttempt.toJSON();
        continue;
      }
      const plan = resolveLifecyclePlan({
        ...this.input,
        gateTransitionDecision: this.ctx.gateTransitionDecision,
        result: this.result,
        error: this.err,
        flowState: this.ctx.flowState,
      });
      const adapter = new RegistryLifecycleAdapter(this.ctx, this.result, this.err, { plan, input: this.input });
      const action = adapter.actions[0] ?? null;
      if (action === null) return;
      // Retry/repair/defer routing remains owned by the ordinary Definition
      // continuation after post effects are durable.  The coordinator only
      // performs the terminal PASS lifecycle transition here.
      if (action instanceof SetStepStatus && action.status !== "done") return;
      await action.apply(adapter);
      adapter.refreshFlowState();
      if (action instanceof SetStepStatus && action.status === "done") return;
    }
  }
}

async function applyLifecycleActionsFromRegistry(ctx, input, result = null, err = null) {
  if (err?.code === "FINALIZATION_OUTBOX_RECOVERY_REQUIRED") return;
  const attempt = result?.stepAttempt ? StepAttempt.fromStored(result.stepAttempt) : null;
  if (input?.event === "gate:post" && ctx.gateTransitionDecision?.facts.scope === "task") {
    await new TaskGateSettlementCoordinator({ ctx, input, result, err }).apply();
  } else {
  const plan = resolveLifecyclePlan({
    ...input,
    result,
    error: err,
    flowState: ctx.flowState,
    settleInProgressAsDone: attempt?.outcome instanceof DecisionOutcome,
  });
  const adapter = new RegistryLifecycleAdapter(ctx, result, err, { plan, input });
    for (const action of adapter.actions) {
      await action.apply(adapter);
      if (action instanceof SetStepStatus) adapter.refreshFlowState();
    }
  }
  if (input?.pluginLifecycleHandled === true) return;
  const command = input?.command || input?.runtimeCommand || input?.key || result?.artifacts?.command;
  if (!command) return;
  const hooks = await discoverFlowCommandHooks(ctx.executionRoot || ctx.root);
  if (hooks.length === 0) return;
  const hook = pluginHookForLifecycle(input?.event, err);
  const hookResult = await runFlowCommandHooks(ctx.executionRoot || ctx.root, hooks, {
    command: pluginCommandName(command),
    hook,
    flow: {
      specId: ctx.flowState?.specId,
      specRoot: ctx.specRoot?.toString(),
      issue: ctx.flowState?.issue,
      runId: ctx.flowState?.runId,
      plugins: { flowCommandHooks: hooks },
    },
    result: result || { ok: false, error: err?.message },
    artifactRepositoryRoot: ctx.repositoryRoot || ctx.root,
    artifactReader: ctx.flowState?.schemaRevision === 3
      ? (request) => ctx.flowManager.readArtifact({
          specId: ctx.flowState.specId,
          consumerNodeId: "flow",
          ...request,
        })
      : null,
  });
  if (hookResult.artifactWrites.length > 0) {
    if (ctx.flowState?.schemaRevision !== 3) {
      throw new Error("plugin hook artifact publication requires an active canonical Flow state");
    }
    ctx.flowManager.publishPluginArtifacts({
      specId: ctx.flowState.specId,
      artifactWrites: hookResult.artifactWrites.map((write) => new CanonicalFlowArtifactWrite(write)),
    });
  }
  if (hookResult.issueLogEntries.length && ctx.flowState?.specId) {
    for (const entry of hookResult.issueLogEntries) {
      tryAppendIssueLog(() => {
        const issueEntry = {
          step: "plugin-hook",
          reason: entry.reason,
          trigger: `${command}.${hook}`,
          resolution: "non-blocking plugin hook warning recorded",
          guardrailCandidate: "plugin hook run failures should be warning envelopes and issue-log candidates",
          pluginId: entry.pluginId,
          timestamp: new Date().toISOString(),
        };
        if (ctx.flowState.schemaRevision !== 3) {
          throw new Error("plugin hook diagnostics require an active canonical Flow state");
        }
        ctx.flowManager.appendIssueLog({
          specId: ctx.flowState.specId,
          entry: issueEntry,
          idempotencyKey: `plugin-hook-${entry.pluginId}-${command}-${hook}-${entry.reason}`,
        });
      });
    }
  }
}

function pluginHookForLifecycle(event, err) {
  if (err) return "onError";
  if (typeof event === "string") {
    const suffix = event.split(":").pop();
    if (suffix === "pre" || suffix === "post" || suffix === "finally") return suffix;
  }
  return "post";
}

function pluginCommandName(command) {
  return String(command || "").startsWith("run-") ? String(command).slice(4) : command;
}


export const FLOW_COMMANDS = {
  resume: {
    helpKey: "flow.resume",
    helpPath: "sennel flow resume --help",
    requiresFlow: false,
    explicitTargetResolution: true,
    specOptionAsTarget: true,
    command: () => import("./lib/run-resume.js"),
    args: {
      flags: withTargetGuardFlags(),
      options: withTargetGuardOptions(["--spec"]),
    },
    help: [
      `Usage: sennel flow resume [--spec <specId>] ${FLOW_TARGET_GUARD_USAGE}`,
      "",
      "Show context for one registered active flow.",
      "When multiple flows are active concurrently, pass --spec to select one.",
      "Use `sennel flow get status` for current-context status display.",
      "",
      "Options:",
      "  --spec <specId>          Select a registered active flow.",
      ...FLOW_TARGET_GUARD_HELP_LINES,
    ].join("\n"),
  },
  prepare: {
    helpKey: "flow.prepare",
    helpPath: "sennel flow prepare --help",
    requiresFlow: false,
    requiresConfig: true,
    runtimeLog: { stepId: "prepare-spec" },
    command: () => import("./lib/run-prepare-spec.js"),
    args: {
      flags: withTargetGuardFlags(["--no-branch", "--worktree", "--dry-run"]),
      options: withTargetGuardOptions(["--title", "--base", "--issue", "--request", "--run-id"]),
    },
    help: [
      `Usage: sennel flow prepare [options] ${FLOW_TARGET_GUARD_USAGE}`,
      "",
      "Create branch/worktree and initialize spec directory.",
      "",
      "Options:",
      "  --title <name>     Feature title (required)",
      "  --base <branch>    Base branch (default: current HEAD)",
      "  --worktree         Use git worktree mode",
      "  --no-branch        Spec-only mode (no branch creation)",
      "  --issue <number>   GitHub Issue number to link",
      "  --request <text>   User request text to save in flow.json",
      "  --run-id <runId>   Use preparing runId from flow set init (isolated from unrelated active flows)",
      ...FLOW_TARGET_GUARD_HELP_LINES,
      "  --dry-run          Show what would happen without executing",
    ].join("\n"),
    async post(ctx, result) {
      await applyLifecycleActionsFromRegistry(ctx, {
        event: "prepare:post",
        command: "prepare",
        pluginLifecycleHandled: true,
      }, result);
    },
  },
  get: {
    status: {
      helpKey: "flow.get.status",
      requiresFlow: false,
      targetGuard: false,
      explicitTargetResolution: true,
      positionalRunIdTarget: true,
      preparingRunIdSelection: false,
      command: () => import("./lib/get-status.js"),
      args: { positional: ["runId"], flags: withTargetGuardFlags(["--details"]), options: FLOW_TARGET_GUARD_OPTIONS },
      help: [
        "Usage: sennel flow get status [runId] [--details] [--expect-issue <number> | --expect-no-issue] [--expect-spec <spec>] [--expect-run-id <runId>]",
        "",
        "Return active flow state for the current execution context.",
        "If no active flow exists, returns { active: false }.",
        "If runId is provided, resolve by runId instead of context.",
        "  --details  Include audit fields such as request, notes, metrics, and history.",
        "  --expect-issue <number>  Fail with ACTIVE_FLOW_MISMATCH when the resolved flow belongs to another Issue.",
        "  --expect-no-issue        Fail with ACTIVE_FLOW_MISMATCH when the resolved flow belongs to an Issue.",
        "  --expect-spec <spec>     Fail with ACTIVE_FLOW_MISMATCH when the current context is another spec.",
        "  --expect-run-id <runId>  Fail with ACTIVE_FLOW_MISMATCH when the current context is another runId.",
        "Use `sennel flow resume` to discover or recover active flows.",
      ].join("\n"),
    },
    "resolve-context": {
      helpKey: "flow.get.resolve-context",
      explicitTargetResolution: true,
      mismatchTargetResolution: true,
      targetNotFoundAsMismatch: true,
      command: () => import("./lib/get-resolve-context.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: FLOW_TARGET_GUARD_OPTIONS },
      help: [
        `Usage: sennel flow get resolve-context ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Resolve worktree/repo paths and active flow for context recovery.",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    check: {
      helpKey: "flow.get.check",
      requiresFlow: false,
      command: () => import("./lib/get-check.js"),
      args: { positional: ["target"] },
      help: "Usage: sennel flow get check <target>\n\nCheck a condition. Targets: dirty, gh, impl, finalize.",
    },
    prompt: {
      helpKey: "flow.get.prompt",
      requiresFlow: false,
      explicitTargetResolution: true,
      mismatchTargetResolution: true,
      targetNotFoundAsMismatch: true,
      command: () => import("./lib/get-prompt.js"),
      args: { positional: ["kind"], flags: FLOW_TARGET_GUARD_FLAGS, options: FLOW_TARGET_GUARD_OPTIONS },
      help: [
        "Usage: sennel flow get prompt <kind> [--expect-issue <number> | --expect-no-issue] [--expect-spec <spec>] [--expect-run-id <runId>]",
        "",
        "Return a prompt template by kind.",
        "Target-sensitive prompts such as plan.approval validate that the resolved active flow matches the expected target.",
      ].join("\n"),
    },
    artifact: {
      helpKey: "flow.get.artifact",
      // Active targets use the ordinary guarded Flow resolution. Historical
      // targets are resolved by get-artifact itself from the complete explicit
      // spec/version pair and never through active-flow inference.
      requiresFlow: false,
      // The command performs the active guard itself, because historical
      // Version pairs must reject all active-flow guards without resolving an
      // unrelated ambient Flow in the dispatcher.
      targetGuard: false,
      explicitTargetResolution: true,
      mismatchTargetResolution: true,
      skipAmbientFlowContext: (input) => input.specId != null || input.version != null,
      command: () => import("./lib/get-artifact.js"),
      args: {
        positional: ["logicalKey"],
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: withTargetGuardOptions(["--mode", "--spec-id", "--version"]),
      },
      help: [
        "Usage: sennel flow get artifact <spec.record|acceptance.review> --mode <full|summary> [--spec-id <specId> --version <number>]",
        "",
        "Render one registered canonical artifact for human review.",
        "Without --spec-id/--version, read the guarded active Flow. For a completed",
        "Version, provide both options exactly; latest, Issue, and runId inference is not supported.",
        "",
        "Options:",
        "  --mode <full|summary>  Required deterministic full view or validated structured summary",
        "  --spec-id <specId>     Completed Version spec identity (requires --version)",
        "  --version <number>     Completed Version number (requires --spec-id)",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    "qa-count": {
      helpKey: "flow.get.qa-count",
      command: () => import("./lib/get-qa-count.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: FLOW_TARGET_GUARD_OPTIONS },
      help: "Usage: sennel flow get qa-count\n\nReturn the number of answered questions in draft phase.",
    },
    guardrail: {
      helpKey: "flow.get.guardrail",
      requiresFlow: false,
      command: () => import("./lib/get-guardrail.js"),
      args: { positional: ["phase"], options: ["--format"] },
      help: `Usage: sennel flow get guardrail <phase> [--format json]\n\nReturn guardrails filtered by phase. Phases: ${VALID_GUARDRAIL_PHASES.join(", ")}. Alias: impl -> task-impl.`,
    },
    issue: {
      helpKey: "flow.get.issue",
      requiresFlow: false,
      command: () => import("./lib/get-issue.js"),
      args: { positional: ["number"] },
      help: "Usage: sennel flow get issue <number>\n\nGet GitHub issue content as JSON.",
    },
    "next-action": {
      helpKey: "flow.get.next-action",
      requiresFlow: false,
      explicitTargetResolution: true,
      command: () => import("./lib/get-next-action.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: FLOW_TARGET_GUARD_OPTIONS },
      help: [
        "Usage: sennel flow get next-action [--expect-issue <number> | --expect-no-issue] [--expect-spec <spec>] [--expect-run-id <runId>]",
        "",
        "Return the next AI/skill action for the current in_progress step.",
        "Dispatches from static context rules; the response carries an inline",
        "output_schema usable with validateSchema. The exact response shape",
        "is defined by the command itself and verified by its unit tests.",
      ].join("\n"),
    },
    context: {
      helpKey: "flow.get.context",
      command: () => import("./lib/get-context.js"),
      args: { positional: ["path"], flags: withTargetGuardFlags(["--raw"]), options: withTargetGuardOptions(["--search"]) },
      help: [
        "Usage: sennel flow get context [path] [--raw] [--search <query>]",
        "",
        "List mode (no path): filtered analysis entries.",
        "File mode (with path): file content + metric increment.",
        "Search mode (--search): keyword search in analysis entries.",
        "",
        "Options:",
        "  --raw              Output content without JSON envelope",
        "  --search <query>   Search entries by keyword (matches against keywords array)",
      ].join("\n"),
      post(ctx, result) {
        const phase = deriveActivePhase(ctx);
        if (!phase) return;

        if (result?.type) {
          // File mode: result.type is "docs" or "src"
          ctx.flowManager.incrementMetric(phase, result.type === "docs" ? "docsRead" : "srcRead");
        } else if (result?.entries || result?.total != null) {
          // List mode or search mode: reads analysis.json → docsRead
          ctx.flowManager.incrementMetric(phase, "docsRead");
        }
      },
    },
    "runtime-log": {
      helpKey: "flow.get.runtime-log",
      requiresFlow: false,
      explicitTargetResolution: true,
      mismatchTargetResolution: true,
      preparingRunIdSelection: false,
      parseErrorsAsEnvelope: true,
      command: () => import("./lib/get-runtime-log.js"),
      args: {
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: withTargetGuardOptions(["--format", "--sequence", "--run-id"]),
      },
      help: [
        `Usage: sennel flow get runtime-log [--format json] [--sequence <n>] [--run-id <runId[#sequence]>] ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Return the selected runtime log block. Raw block text is printed by default.",
        "With --format json, prints an envelope containing the block text and metadata.",
        "At least one target expectation is required; every supplied expectation must match.",
        "",
        "Options:",
        "  --format <json>     Return a JSON envelope instead of raw block text.",
        "  --sequence <n>      Select a positive runtime-log sequence.",
        "  --run-id <runId[#sequence]>  Select a runtime-log runId and optional sequence.",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
  },
  set: {
    step: {
      helpKey: "flow.set.step",
      explicitTargetResolution: true,
      runtimeLog: { stepId: setStepRuntimeLogStepId },
      command: () => import("./lib/set-step.js"),
      args: { positional: ["id", "status"], flags: FLOW_TARGET_GUARD_FLAGS, options: FLOW_TARGET_GUARD_OPTIONS },
      help: "Usage: sennel flow set step <id> <status>\n\nUpdate a workflow step's status.",
    },
    request: {
      helpKey: "flow.set.request",
      requiresFlow: false,
      command: () => import("./lib/set-request.js"),
      args: { positional: ["text"], flags: FLOW_TARGET_GUARD_FLAGS, options: withTargetGuardOptions(["--run-id"]) },
      help: [
        `Usage: sennel flow set request \"<text>\" [--run-id <id>] ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Set the request on a preparing Flow. An active Version-1 request is immutable.",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    issue: {
      helpKey: "flow.set.issue",
      command: () => import("./lib/set-issue.js"),
      args: { positional: ["number"], flags: FLOW_TARGET_GUARD_FLAGS, options: FLOW_TARGET_GUARD_OPTIONS },
      help: "Usage: sennel flow set issue <number>\n\nReject an Issue change after canonical Flow creation; Issue identity and issue.md are immutable.",
    },
    note: {
      helpKey: "flow.set.note",
      requiresFlow: false,
      command: () => import("./lib/set-note.js"),
      args: { positional: ["text"], flags: FLOW_TARGET_GUARD_FLAGS, options: withTargetGuardOptions(["--task-id", "--run-id"]) },
      help: [
        `Usage: sennel flow set note \"<text>\" [--task-id <id>] [--run-id <id>] ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Append a typed note Activity to an active Version-1 Flow, or append a",
        "pre-creation note to the selected preparing Flow.",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    "draft-answer": {
      helpKey: "flow.set.draft-answer",
      explicitTargetResolution: true,
      targetNotFoundAsMismatch: true,
      command: () => import("./lib/set-draft-answer.js"),
      args: {
        positional: ["questionId"],
        flags: withTargetGuardFlags(["--drop"]),
        options: withTargetGuardOptions(["--question-revision", "--answer", "--why", "--considered", "--dropped-reason"]),
      },
      help: [
        `Usage: sennel flow set draft-answer <questionId> --question-revision <revision> (--answer <text> --why <text> [--considered <text>] | --drop --dropped-reason <text>) ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Record the explicit user's answer to the current draft question without completing draft-refine.",
        "The question id and active Flow target are guarded; the next unresolved question remains the dispatcher boundary.",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    files: {
      helpKey: "flow.set.files",
      command: () => import("./lib/set-files.js"),
      args: { positional: ["reqId"], rest: "paths", flags: FLOW_TARGET_GUARD_FLAGS, options: FLOW_TARGET_GUARD_OPTIONS },
      help: "Usage: sennel flow set files <reqId> <path...>\n\nAppend file paths to the active Version's cataloged file.map for a requirement. Deduplicates.",
    },
    "review-evidence": {
      helpKey: "flow.set.review-evidence",
      command: () => import("./lib/set-review-evidence.js"),
      args: {
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: withTargetGuardOptions(["--file"]),
      },
      help: [
        `Usage: sennel flow set review-evidence --file <path> ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Register one finalized independent review document for the active review target.",
        "The file must be a bounded regular JSON file inside the active spec directory.",
        "The command validates phase, task, current tree, provenance, findings, and target guards.",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    broad: {
      helpKey: "flow.set.broad",
      command: () => import("./lib/set-broad.js"),
      args: { positional: ["action"], flags: FLOW_TARGET_GUARD_FLAGS, options: withTargetGuardOptions(["--step", "--reason"]) },
      help: [
        "Usage: sennel flow set broad on --step <implement|impl-review|impl-gate> --reason <text>",
        "",
        "Record an audited broad-mode exception for task-decomposed implementation.",
        "The reason must be non-empty. The record stores step, reason, timestamp,",
        "and currentTaskId at the time of opt-in.",
      ].join("\n"),
    },
    policy: {
      helpKey: "flow.set.policy",
      command: () => import("./lib/set-policy.js"),
      args: { positional: ["value"], flags: FLOW_TARGET_GUARD_FLAGS, options: withTargetGuardOptions(["--reason"]) },
      help: "Usage: sennel flow set policy nonblocking --reason <text>\n\nOne-way opt-in that keeps eligible quality results advisory while preserving acceptance disposition.",
    },
    "nonblocking-decision": {
      helpKey: "flow.set.nonblocking-decision",
      command: () => import("./lib/set-nonblocking-decision.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: withTargetGuardOptions(["--choice", "--reason", "--expect-evidence-digest", "--remaining-risk"]) },
      help: "Usage: sennel flow set nonblocking-decision --choice <repair|retry|continue> --reason <text> --expect-evidence-digest <sha256> [--remaining-risk <text>]\n\nBind an agent-owned advisory decision to the active step's latest evidence.",
    },
    metric: {
      helpKey: "flow.set.metric",
      command: () => import("./lib/set-metric.js"),
      args: { positional: ["phase", "counter"], flags: FLOW_TARGET_GUARD_FLAGS, options: withTargetGuardOptions(["--task-id"]) },
      help: `Usage: sennel flow set metric <phase> <counter> [--task-id <id>]\n\nAppend a metric entry. Phases: ${VALID_PHASES.join(", ")}. Counters: ${VALID_METRIC_COUNTERS.join(", ")}.`,
    },
    approval: {
      helpKey: "flow.set.approval",
      command: () => import("./lib/set-approval.js"),
      args: { flags: withTargetGuardFlags(["--approved"]), options: withTargetGuardOptions(["--notes", "--confirmed-at"]) },
      help: [
        "Usage: sennel flow set approval --approved [--notes <text>] [--confirmed-at <iso>]",
        "",
        "Persist user approval into the active Version's cataloged spec.json",
        "`user_approval` field. Subsequent `spec render` runs read that canonical",
        "record when producing their transient Markdown output.",
        "",
        "Options:",
        "  --approved             Required. Marks the spec as approved.",
        "  --notes <text>         Optional confirmation note.",
        "  --confirmed-at <iso>   Optional ISO 8601 timestamp; defaults to now.",
      ].join("\n"),
    },
    "issue-log": {
      helpKey: "flow.set.issue-log",
      explicitTargetResolution: true,
      targetNotFoundAsMismatch: true,
      command: () => import("./lib/set-issue-log.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: withTargetGuardOptions(["--step", "--reason", "--trigger", "--resolution", "--guardrail-candidate", "--normalized-finding-id", "--repair-ref-commit", "--repair-ref-file", "--task-id"]) },
      help: "Usage: sennel flow set issue-log --step <id> --reason <text> [--trigger <text>] [--resolution <text>] [--guardrail-candidate <text>] [--normalized-finding-id <id>] [--repair-ref-commit <sha>] [--repair-ref-file <path>] [--task-id <id>] [--expect-issue <number> | --expect-no-issue] [--expect-spec <spec>] [--expect-run-id <runId>]\n\nAppend an Activity-backed entry to the active Version's cataloged issue.log artifact. When target guards are supplied, append only to the matching flow. Infers taskId from active task unless --task-id is given.",
      post(ctx) {
        const phase = deriveActivePhase(ctx);
        if (phase) ctx.flowManager.incrementMetric(phase, "issueLog");
      },
    },
    init: {
      helpKey: "flow.set.init",
      requiresFlow: false,
      command: () => import("./lib/set-init.js"),
      args: { options: ["--issue", "--request"] },
      help: [
        "Usage: sennel flow set init [--issue N] [--request \"<text>\"]",
        "",
        "Initialize a preparing flow state. Creates .active-flow.<runId>",
        "and returns the runId.",
        "",
        "Options:",
        "  --issue <number>   GitHub Issue number to seed into preparing state",
        "  --request <text>   User request text to seed into preparing state",
      ].join("\n"),
    },
    retry: {
      helpKey: "flow.set.retry",
      command: () => import("./lib/set-retry.js"),
      args: { positional: ["action", "kind", "phase"], flags: withTargetGuardFlags(["--yes"]), options: withTargetGuardOptions(["--reason"]) },
      help: [
        "Usage: sennel flow set retry reset <gate|review> <phase> --reason <text> --yes",
        "",
        "Request the next retry action for <phase>; normal retries use the canonical failure disposition.",
        `  gate   phases: ${RETRY_HELP_GATE_PHASES.join(" | ")}`,
        `  review phases: ${RETRY_HELP_REVIEW_PHASES.join(" | ")}`,
        "When the canonical budget is exhausted, the parent derives and audits the previous/current evidence and grants one tooling re-evaluation.",
        "Unchanged/replayed evidence is rejected. --reason and --yes are required.",
      ].join("\n"),
    },
    "acceptance-decision": {
      helpKey: "flow.set.acceptance-decision",
      command: () => import("./lib/set-acceptance-decision.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: withTargetGuardOptions(["--choice"]) },
      help: [
        "Usage: sennel flow set acceptance-decision --choice <choice>",
        "",
        "Resolve a notVerifiable requirement or unresolved deferred-finding risk with an explicit user choice.",
        "Choices: accept_risk_and_continue, abort",
        "No choice is inferred from autoApprove or an omitted --choice option.",
      ].join("\n"),
    },
    auto: {
      helpKey: "flow.set.auto",
      requiresFlow: false,
      command: () => import("./lib/set-auto.js"),
      args: { positional: ["value"], flags: FLOW_TARGET_GUARD_FLAGS, options: withTargetGuardOptions(["--run-id"]) },
      help: [
        `Usage: sennel flow set auto on|off [--run-id <id>] ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Enable or disable autoApprove mode. Appends a typed policy Activity when",
        "an active Version-1 Flow exists; otherwise writes to the matching preparing",
        "flow (.active-flow.<runId>). --run-id selects a preparing flow",
        "when multiple exist; auto-detected when exactly one is present.",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
  },
  run: {
    "seal-handoff": {
      helpKey: "flow.run.seal-handoff",
      requiresFlow: false,
      skipAmbientFlowContext: true,
      runtimeLog: { stepMetadata: false, writeWhenNoFlow: false },
      command: () => import("./lib/run-seal-handoff.js"),
      args: { options: FLOW_RUN_RUNTIME_OPTIONS },
      help: [
        "Usage: sennel flow run seal-handoff [--agent-work-dir <path>]",
        "",
        "Seal the current dispatcher-owned worker artifact payload for validation",
        "and publication by the parent dispatcher. This command does not mutate Flow state.",
        "",
        "Options:",
        "  --agent-work-dir <path>  Set the agent/tmp/log base directory for this invocation.",
      ].join("\n"),
    },
    dispatch: {
      helpKey: "flow.run.dispatch",
      requiresFlow: true,
      explicitTargetResolution: true,
      targetNotFoundAsMismatch: true,
      runtimeLog: { authority: "main-repository" },
      command: () => import("./lib/run-dispatch.js"),
      args: {
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: withTargetGuardOptions(["--approve", "--agent-work-dir"]),
      },
      help: [
        `Usage: sennel flow run dispatch ${FLOW_TARGET_GUARD_USAGE} [--approve <token>] [--agent-work-dir <path>]`,
        "",
        "Own the active Flow continuation inside one CLI process. Non-terminal",
        "directives are executed serially through the configured Agent service;",
        "the command returns only for approval, a user decision, a terminal",
        "directive, a concrete blocker, or a true target mismatch.",
        "",
        "Options:",
        "  --approve <token>  Resume the exact approval boundary returned by a prior dispatch.",
        "  --agent-work-dir <path>  Set the agent/tmp/log base directory for this invocation.",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    "recover-existing-implementation": {
      helpKey: "flow.run.recover-existing-implementation",
      command: () => import("./lib/run-recover-existing-implementation.js"),
      args: {
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: FLOW_RUN_OPTIONS,
      },
      help: [
        `Usage: sennel flow run recover-existing-implementation [--agent-work-dir <path>] ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Record an audited transition from a post-acceptance-rewind scenario-validity preflight block to post-implementation test execution. The command requires exact target guards, the latest rewind from acceptance-review, and preflight evidence of implementation-target changes.",
        "",
        "Options:",
        "  --agent-work-dir <path>  Set the agent/tmp/log base directory for this invocation.",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    "recover-review-pass": {
      helpKey: "flow.run.recover-review-pass",
      command: () => import("./lib/run-recover-review-pass.js"),
      args: {
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: [...FLOW_RUN_OPTIONS, "--phase"],
      },
      help: [
        `Usage: sennel flow run recover-review-pass --phase <draft-questions|draft-coverage|spec|test|impl> ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Check whether an exact canonical PASS needs recovery.",
        "Version-1 publishes each review result, immutable evidence, Activity, and",
        "state transition atomically, so the retired projection recovery is never",
        "eligible. The command requires exact target guards and fails without mutation.",
        "",
        "Options:",
        "  --phase <phase>       Exact flow-level review phase to recover.",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    "preimplementation-bootstrap": {
      helpKey: "flow.run.preimplementation-bootstrap",
      command: () => import("./lib/run-preimplementation-bootstrap.js"),
      args: {
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: FLOW_RUN_OPTIONS,
      },
      help: [
        `Usage: sennel flow run preimplementation-bootstrap [--agent-work-dir <path>] ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Record an audited recovery from a scenario-validity preflight block caused by existing implementation-target changes. Exact target guards, an immutable repair baseline, and the persisted preflight evidence are required; the command skips only scenario-validity and test-review, then resumes implement.",
        "",
        "Options:",
        "  --agent-work-dir <path>  Set the agent/tmp/log base directory for this invocation.",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    gate: {
      helpKey: "flow.run.gate",
      failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      requiresFlow: false,
      responsibilities: DRAFT_REVIEW_GATE_RESPONSIBILITIES,
      runtimeLog: { stepId: gateRuntimeLogStepId },
      async pre(ctx) {
        if (!ctx.flowState) return;
        // When --phase is omitted, phase resolution and stale-step recovery
        // happen inside RunGateCommand.execute (which has exclusive ownership
        // over flow state mutations for the duration of the gate). The
        // pre-hook's step-status update is only valid when phase is already
        // known, so skip it otherwise.
        if (ctx.phase == null) return;
        if (terminalGateRevalidation(ctx)) {
          ctx.terminalGateRevalidation = true;
          return;
        }
        await applyLifecycleActionsFromRegistry(ctx, {
          event: "gate:pre",
          command: "run-gate",
          phase: ctx.phase,
        });
      },
      command: () => import("./lib/run-gate.js"),
      args: {
        options: ["--spec", "--phase", ...FLOW_RUN_OPTIONS],
        flags: FLOW_TARGET_GUARD_FLAGS,
      },
      help: [
        "Usage: sennel flow run gate [options]",
        "",
        "Run gate check. Resolves target from the active Version-1 Flow if omitted.",
        `Responsibility boundary: ${DRAFT_REVIEW_REGISTRY_RESPONSIBILITY_BOUNDARY.summary}.`,
        "",
        "Options:",
        "  --spec <path>                 Path to canonical Spec (directory / spec.json; auto-resolved from the active Version-1 Flow)",
        `  --phase <${VALID_GATE_PHASES.join("|")}>  Gate phase (default: auto-resolve from in-progress step)`,
        "  --agent-work-dir <path>       Per-invocation agent/tmp base directory",
        "  Required evaluations cannot be bypassed from the public CLI.",
      ].join("\n"),
      async post(ctx, result) {
        if (!ctx.flowState) return;
        const phase = result?.artifacts?.phase || ctx.phase;
        if (
          ctx.terminalGateRevalidation === true
        ) return;
        const { attachedCanonicalCommandResultArtifact } = await import("./lib/canonical-command-result.js");
        const canonicalResult = attachedCanonicalCommandResultArtifact(result) !== null;
        const specId = ctx.specId ?? ctx.flowState.specId;
        let recoveryEffect = null;
        if (canonicalResult) {
          // Publication precedes classification.  Definition therefore sees
          // the exact current catalog result, including its Attempt binding,
          // before the persistence adapter chooses whether the Attempt is
          // retryable or must settle.
          ctx.flowManager.publishCurrentAttemptResult({ specId, commandResult: result });
          ctx.flowState = ctx.flowManager.loadReadOnly(specId);
          ctx.gateTransitionDecision = resolvePersistedPlanGateDecision(ctx, result);
          recoveryEffect = ctx.gateTransitionDecision.plan.recoveryEffect;
          if (recoveryEffect !== null) {
            if (recoveryEffect.operation !== "rewind-test-evidence") {
              throw new Error("Definition-owned Gate recovery operation is unsupported");
            }
          }
          if (ctx.gateTransitionDecision.facts.scope !== "task"
            && ctx.gateTransitionDecision.facts.result === "fail") {
            const stepAttempt = ctx.flowManager.recordGateObservationDecision({
              specId,
              decision: ctx.gateTransitionDecision,
            });
            if (stepAttempt !== null) result.stepAttempt = stepAttempt.toJSON();
            ctx.flowState = ctx.flowManager.loadReadOnly(specId);
            ctx.gateTransitionDecision = resolvePersistedPlanGateDecision(ctx, result);
          }
          ctx.flowState = ctx.flowManager.loadReadOnly(specId);
        }
        if (!(ctx.gateTransitionDecision instanceof GateTransitionDecision)) {
          throw new Error("gate post requires a canonical Definition-selected GateTransitionDecision");
        }
        await applyLifecycleActionsFromRegistry(ctx, {
          event: "gate:post",
          command: "run-gate",
          phase,
          gateTransitionDecision: ctx.gateTransitionDecision,
        }, result);
        // Recovery is a sealed Definition effect, but it must run after the
        // selected lifecycle updates.  Rewinding earlier would let an
        // in-progress Gate update reactivate the obsolete impl-gate step.
        if (recoveryEffect !== null) {
          ctx.flowManager.rewindTestEvidence({ specId, decision: ctx.gateTransitionDecision });
          ctx.flowState = ctx.flowManager.loadReadOnly(specId);
        }
        const projection = projectGatePublicOutcome(ctx.gateTransitionDecision);
        // `next` is retained only as a legacy command-output projection.  Its
        // value comes from the already selected Definition recovery effect;
        // neither this hook nor any subsequent transition reader treats it as
        // authority for routing.
        applyGatePublicOutcomeProjection(result, projection);
        if (projection?.failed) {
          return Envelope.fail("run", "gate", projection.failureCode,
            result.artifacts?.reasons?.map((reason) => reason.detail || reason) || "required gate evaluation failed",
            { ...result });
        }
      },
      async nonblockingPost(ctx, result) {
        const handoff = ctx.gateTransitionDecision?.plan.nonblockingHandoff ?? null;
        if (handoff === null) return;
        const { recordEligibleNonblockingAttempt } = await import("./lib/nonblocking.js");
        recordEligibleNonblockingAttempt(ctx, handoff.sourceStepId, result);
      },
      async onError(ctx, err) {
        const { appendIssueLogFromGateError } = await import("./lib/run-gate.js");
        const phase = err?.data?.effectivePhase
          || ctx.phase
          || resolveGatePhaseFromState(ctx.flowState)?.phase;
        const errorCtx = { ...ctx, phase };
        tryAppendIssueLog(() => appendIssueLogFromGateError(errorCtx, err));
        if (ctx.terminalGateRevalidation === true) return;
        if (err?.code === "GATE_OUTPUT_TOOLING_FAILURE") return;
        await applyLifecycleActionsFromRegistry(errorCtx, {
          event: "gate:onError",
          command: "run-gate",
          phase,
        }, null, err);
      },
    },
    review: {
      helpKey: "flow.run.review",
      failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      draftReviewPostHookBoundary: DRAFT_REVIEW_REGISTRY_RESPONSIBILITY_BOUNDARY,
      responsibilities: DRAFT_REVIEW_REVIEW_RESPONSIBILITIES,
      runtimeLog: { stepId: reviewRuntimeLogStepId },
      command: () => import("./lib/run-review.js"),
      args: {
        flags: withTargetGuardFlags(["--dry-run", "--skip-confirm"]),
        options: ["--phase", ...FLOW_RUN_OPTIONS],
      },
      help: [
        `Usage: sennel flow run review [options] ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Run AI code review on current changes.",
        `Responsibility boundary: ${DRAFT_REVIEW_REGISTRY_RESPONSIBILITY_BOUNDARY.summary}.`,
        "",
        "Options:",
        `  --phase <type>   Review phase: ${VALID_REVIEW_PHASES.map((p) => `'${p}'`).join(", ")}`,
        "  --agent-work-dir <path>  Per-invocation agent/tmp base directory",
        "  --dry-run        Show proposals without applying",
        "  --skip-confirm   Skip initial confirmation prompt",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
      async post(ctx, result) {
        assertDraftReviewRegistryHookBoundary();
        if (
          result?.result === "recovered"
          && result?.artifacts?.evidenceRefresh?.recovered === true
        ) return;
        assertCurrentTaskReviewSource(ctx, result);
        if (result?.artifacts?.phase === "impl"
          && result?.artifacts?.taskId != null
          && result?.artifacts?.toolingOutcome == null) {
          const specId = ctx.specId ?? ctx.flowState.specId;
          ctx.flowManager.confirmTaskReviewResult({ specId, commandResult: result });
          ctx.flowState = ctx.flowManager.loadReadOnly(specId);
          const { attachedCanonicalReviewWorkUnit } = await import("./lib/canonical-review-artifacts.js");
          attachedCanonicalReviewWorkUnit(result)?.cleanup();
          return;
        }
        await persistNonTerminalReviewResult(ctx, result);
        try {
          await applyLifecycleActionsFromRegistry(ctx, {
            event: "review:post",
            command: "run-review",
            phase: ctx.phase,
            currentStepId: activeImplReviewStepId(ctx.flowState),
            dryRun: ctx.dryRun,
          }, result);
          const { attachedCanonicalReviewWorkUnit } = await import("./lib/canonical-review-artifacts.js");
          attachedCanonicalReviewWorkUnit(result)?.cleanup();
        } catch (error) {
          throw error;
        }
      },
      async nonblockingPost(ctx, result) {
        if (ctx.dryRun) return;
        const phase = result?.artifacts?.phase || result?.data?.phase || ctx.phase;
        const active = findActiveNode(ctx.flowState || {});
        const stepId = phase === "draft-questions"
          ? "draft-questions-review"
          : phase === "draft-coverage"
            ? "draft-coverage-review"
            : phase === "spec"
              ? "spec-review"
              : phase === "test"
                ? "test-review"
                : phase === "impl"
                  ? active?.stepId === "task-review" ? "task-review" : "impl-review"
                  : null;
        if (!stepId || !nonblockingRouteFor(stepId)) return;
        const { recordEligibleNonblockingAttempt } = await import("./lib/nonblocking.js");
        recordEligibleNonblockingAttempt(ctx, stepId, result);
      },
    },
    "auto-check": {
      helpKey: "flow.run.auto-check",
      runtimeLog: { stepMetadata: false },
      command: () => import("./lib/run-auto-check.js"),
      requiresFlow: false,
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: withTargetGuardOptions(["--run-id", ...FLOW_RUN_RUNTIME_OPTIONS]) },
      help: [
        `Usage: sennel flow run auto-check [--run-id <id>] ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Evaluate whether the current request qualifies for auto mode.",
        "Input is derived statically from flow state based on phase:",
        "  - approval done            → skip AI (unconditionally eligible)",
        "  - draft-gate done + draft  → issue + request + draft body",
        "  - otherwise                → issue + request",
        "",
        "Runs static keyword gates first; if clear, calls the AI once for scoring.",
        "For an active Version-1 Flow, the verdict is returned without adding a",
        "mutable autoCheck field to flow.json. A preparing flow persists the verdict",
        "in .active-flow.<runId> so `flow set auto on` can reuse the same input.",
        "",
        "Options:",
        "  --run-id <runId>   Target preparing flow (required for prelude, even when another flow is active)",
        ...FLOW_TARGET_GUARD_HELP_LINES,
        "  --agent-work-dir <path>  Per-invocation agent/tmp base directory",
      ].join("\n"),
    },
    "finalize-commit": {
      helpKey: "flow.run.finalize-commit",
      failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
      runtimeLog: { stepId: "finalize-commit" },
      command: () => import("./lib/run-finalize-commit.js"),
      args: {
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: ["--message", ...FLOW_RUN_OPTIONS],
      },
      help: [
        "Usage: sennel flow run finalize-commit [options]",
        "",
        "Commit implementation changes from the execution worktree.",
        "",
        "Options:",
        "  --message <msg>  Custom commit message",
        "  --agent-work-dir <path>  Per-invocation agent/tmp base directory",
      ].join("\n"),
      async pre(ctx) {
        await applyLifecycleActionsFromRegistry(ctx, {
          event: "finalize:pre",
          command: "finalize-commit",
        });
      },
      async post(ctx, result) {
        await applyLifecycleActionsFromRegistry(ctx, {
          event: "finalize:post",
          command: "finalize-commit",
        }, result);
      },
      async onError(ctx, err) {
        await applyLifecycleActionsFromRegistry(ctx, {
          event: "finalize:onError",
          command: "finalize-commit",
        }, null, err);
      },
    },
    "finalize-merge": {
      helpKey: "flow.run.finalize-merge",
      failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
      // Its failure handler commits the complete Flow metadata transaction.
      // Do not append a second runtime-log state mutation after that commit.
      runtimeLog: { stepMetadata: false },
      command: () => import("./lib/run-finalize-merge.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: [...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run finalize-merge",
        "",
        "Squash merge or PR creation. On failure, subsequent steps are skipped.",
      ].join("\n"),
      async pre(ctx) {
        await applyLifecycleActionsFromRegistry(ctx, {
          event: "finalize:pre",
          command: "finalize-merge",
        });
      },
      async post(ctx, result) {
        await applyLifecycleActionsFromRegistry(ctx, {
          event: "finalize:post",
          command: "finalize-merge",
        }, result);
      },
      async onError(ctx, err) {
        await applyLifecycleActionsFromRegistry(ctx, {
          event: "finalize:onError",
          command: "finalize-merge",
        }, null, err);
      },
    },
    "finalize-sync": {
      helpKey: "flow.run.finalize-sync",
      failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
      runtimeLog: { stepId: "finalize-sync", authority: "main-repository" },
      command: () => import("./lib/run-finalize-sync.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: [...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run finalize-sync",
        "",
        "Build docs on main repo after merge and commit.",
      ].join("\n"),
      async pre(ctx) {
        acquireFinalizeSyncOperation(ctx);
        try {
          await applyLifecycleActionsFromRegistry(ctx, {
            event: "finalize:pre",
            command: finalizeCommand("sync"),
          });
        } catch (error) {
          releaseFinalizeSyncOperation(ctx);
          throw error;
        }
      },
      async post(ctx, result) {
        try {
          await applyLifecycleActionsFromRegistry(ctx, {
            event: "finalize:post",
            command: finalizeCommand("sync"),
          }, result);
        } finally {
          releaseFinalizeSyncOperation(ctx);
        }
      },
      async onError(ctx, err) {
        try {
          if (["REPOSITORY_FLOW_OPERATION_BUSY", "REPOSITORY_MAINTENANCE_BUSY"].includes(err?.code)) return;
          await applyLifecycleActionsFromRegistry(ctx, {
            event: "finalize:onError",
            command: finalizeCommand("sync"),
          }, null, err);
        } finally {
          releaseFinalizeSyncOperation(ctx);
        }
      },
    },
    "finalize-cleanup": {
      helpKey: "flow.run.finalize-cleanup",
      failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
      runtimeLog: { stepMetadata: false, authority: "main-repository" },
      explicitTargetResolution: true,
      command: () => import("./lib/run-finalize-cleanup.js"),
      args: { flags: withTargetGuardFlags(["--auto-rescue", "--force"]), options: [...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run finalize-cleanup [--auto-rescue | --force]",
        "",
        "Clear flow state, remove worktree/branch, write last-finalized-spec pointer.",
        "",
        "Spec 253 orphan commit handling (squash route only):",
        "  --auto-rescue  Cherry-pick orphan commits onto baseBranch before deletion.",
        "                 Aborts on conflict; halts on main repo dirty/locked.",
        "  --force        Delete feature branch even if orphan commits exist.",
        "                 Records the dropped commit list to issue-log.",
        "  (no flag)      Detect orphan commits and halt (worktree/branch retained).",
        "                 The user must re-run with --auto-rescue or --force, or",
        "                 archive the branch and run --force after manual recovery.",
        "",
        "--auto-rescue and --force are mutually exclusive.",
      ].join("\n"),
      async pre(ctx) {
        await applyLifecycleActionsFromRegistry(ctx, {
          event: "finalize:pre",
          command: finalizeCommand("cleanup"),
        });
      },
      // The command body removes the worktree before returning. The dispatcher
      // then records the closed runtime log and commits the shared spec + docs
      // from repository-owned modules before clearing the active entry.
      async onError(ctx, err) {
        await applyLifecycleActionsFromRegistry(ctx, {
          event: "finalize:onError",
          command: finalizeCommand("cleanup"),
        }, null, err);
      },
    },
    abort: {
      helpKey: "flow.run.abort",
      runtimeLog: { stepMetadata: false },
      explicitTargetResolution: true,
      recoveryTargetResolution: true,
      command: () => import("./lib/run-abort.js"),
      args: { flags: withTargetGuardFlags(["--force"]), options: [...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run abort [--force]",
        "",
        "Remove only the selected flow worktree, feature branch, shared spec directory, and active entry.",
        "--force permits removal of a dirty isolated worktree; unrelated base-checkout changes are never removed.",
      ].join("\n"),
    },
    sync: {
      helpKey: "flow.run.sync",
      runtimeLog: { stepMetadata: false },
      requiresFlow: false,
      command: () => import("./lib/run-sync.js"),
      args: { flags: withTargetGuardFlags(["--dry-run"]), options: [...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run sync [options]",
        "",
        "Sync documentation: build -> review -> add -> commit.",
        "",
        "Options:",
        "  --dry-run   Preview only",
      ].join("\n"),
    },
    "reopen-draft": {
      helpKey: "flow.run.reopen-draft",
      runtimeLog: { stepMetadata: false },
      command: () => import("./lib/run-reopen-draft.js"),
      args: {
        flags: ["--expect-no-issue"],
        options: ["--reason", "--category", ...FLOW_RUN_OPTIONS],
      },
      help: [
        `Usage: sennel flow run reopen-draft [--reason <text>] [--category <category>] ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Rewind the flow's draft step to in_progress. The task-addition route",
        "requires at least one done task. Source-discovered spec corrections use:",
        "  --category spec-correction",
        "  --expect-run-id <runId> --expect-spec <spec>",
        "  --expect-issue <number> or --expect-no-issue",
        "",
        "The reason and target identity are recorded in the rewind audit.",
        "",
        "Task-level mode rewinds draft so the user can add tasks to an approved spec;",
        "its existing optional reason and completed-task prerequisites are unchanged.",
        "",
        "Flow-level mode rewinds impl-review, impl-gate, retro, acceptance-review,",
        "or final-regression to draft. It requires --reason and all target guards,",
        "preserves source/tasks/artifacts, and invalidates prior approval/evidence.",
        ...FLOW_TARGET_GUARD_HELP_LINES,
        "",
        "Each reopen is recorded as a typed Version-1 Activity, and its reason is appended",
        "to the active Version's cataloged issue-log.json.",
      ].join("\n"),
    },
    "repair-plan-gate": {
      helpKey: "flow.run.repair-plan-gate",
      runtimeLog: { stepMetadata: false },
      explicitTargetResolution: true,
      command: () => import("./lib/run-repair-plan-gate.js"),
      args: {
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: [...FLOW_RUN_OPTIONS],
      },
      help: [
        `Usage: sennel flow run repair-plan-gate ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Rewind a failed draft/spec gate or scenario-validity check to its worker-artifact handoff step.",
        "The command freezes the canonical blocking observations in Flow state;",
        "the worker may publish only through the normal handoff authority.",
        "",
        "Options:",
        ...FLOW_TARGET_GUARD_HELP_LINES,
        "  --agent-work-dir <path>  Per-invocation agent/tmp base directory",
      ].join("\n"),
    },
    "settle-failure": {
      helpKey: "flow.run.settle-failure",
      runtimeLog: { stepMetadata: false },
      explicitTargetResolution: true,
      command: () => import("./lib/run-settle-failure.js"),
      args: {
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: [...FLOW_RUN_OPTIONS],
      },
      help: [
        `Usage: sennel flow run settle-failure ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Execute the definition-owned record or rewind transition for the current failed Attempt.",
        "The command derives the transition, failed result, and rewind target from canonical state; it accepts no route or result input.",
        "",
        "Options:",
        ...FLOW_TARGET_GUARD_HELP_LINES,
        "  --agent-work-dir <path>  Per-invocation agent/tmp base directory",
      ].join("\n"),
    },
    "settle-review-transition": {
      helpKey: "flow.run.settle-review-transition",
      runtimeLog: { stepMetadata: false },
      explicitTargetResolution: true,
      command: () => import("./lib/run-settle-review-transition.js"),
      args: {
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: [...FLOW_RUN_OPTIONS],
      },
      help: [
        `Usage: sennel flow run settle-review-transition ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Persist the active Review's definition-selected transition, including an exhausted finding handoff or no-change Task implementation correction.",
        "The command accepts no result, retry count, or route; definition-derived persisted facts are its only authority.",
        "",
        "Options:",
        ...FLOW_TARGET_GUARD_HELP_LINES,
        "  --agent-work-dir <path>  Per-invocation agent/tmp base directory",
      ].join("\n"),
    },
    "recover-missing-producer-artifact": {
      helpKey: "flow.run.recover-missing-producer-artifact",
      runtimeLog: { stepMetadata: false },
      explicitTargetResolution: true,
      command: () => import("./lib/run-recover-missing-producer-artifact.js"),
      args: {
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: [...FLOW_RUN_OPTIONS],
      },
      help: [
        `Usage: sennel flow run recover-missing-producer-artifact ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Restore the exact recorded failed producer Attempt only when a historical consumer claim lacks its cataloged producer result.",
        "The command derives run, producer, consumer, Attempt, and catalog identities from canonical storage; it accepts no mutable state input.",
        "",
        "Options:",
        ...FLOW_TARGET_GUARD_HELP_LINES,
        "  --agent-work-dir <path>  Per-invocation agent/tmp base directory",
      ].join("\n"),
    },
    "reconcile-task-review": {
      helpKey: "flow.run.reconcile-task-review",
      runtimeLog: { stepMetadata: false },
      explicitTargetResolution: true,
      command: () => import("./lib/run-reconcile-task-review.js"),
      args: {
        flags: [...FLOW_TARGET_GUARD_FLAGS, "--dry-run", "--yes"],
        options: [...FLOW_RUN_OPTIONS, "--expect-digest", "--reason"],
      },
      help: [
        "Usage: sennel flow run reconcile-task-review --expect-run-id <runId> --expect-spec <specId> [--expect-issue <number> | --expect-no-issue] --dry-run",
        "",
        "Explicitly adopt current unreviewed input for an orphaned, unpublished recovered Task Review Attempt.",
        "Preview first, then supply --yes --expect-digest <preview-digest> --reason <20-500 characters>.",
        "Preserves failed evidence and retained work units, grants one reevaluation, and never executes Review or advances to Gate.",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    "recover-finalization": {
      helpKey: "flow.run.recover-finalization",
      runtimeLog: { stepMetadata: false, authority: "main-repository" },
      explicitTargetResolution: true,
      command: () => import("./lib/run-recover-finalization.js"),
      args: {
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: [...FLOW_RUN_OPTIONS],
      },
      help: [
        `Usage: sennel flow run recover-finalization ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Apply only the Definition-selected exact finalization outbox recovery or interrupted finalize-sync settlement.",
        "The command reloads canonical facts and obtains the main operation lock before changing state.",
        "",
        "Options:",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    "recover-task-execution-overrun": {
      helpKey: "flow.run.recover-task-execution-overrun",
      runtimeLog: { stepMetadata: false },
      explicitTargetResolution: true,
      command: () => import("./lib/run-recover-task-execution-overrun.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: [...FLOW_RUN_OPTIONS] },
      help: [
        `Usage: sennel flow run recover-task-execution-overrun ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Cancel only a Definition-detected Task implementation Attempt opened beyond its execution-round budget. The command preserves the prior Gate and issue-log evidence, restores the failed Gate frontier, and returns to the normal bounded retry/settlement route.",
        "",
        "Options:",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    "claim-next-action": {
      helpKey: "flow.run.claim-next-action",
      runtimeLog: { stepMetadata: false },
      explicitTargetResolution: true,
      command: () => import("./lib/run-claim-next-action.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: [...FLOW_RUN_OPTIONS] },
      help: [
        `Usage: sennel flow run claim-next-action ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Atomically claim the current ordinary Definition-selected action before its worker starts.",
        "The command accepts no step or route input and rejects a stale or non-claimable selection.",
        "",
        "Options:",
        ...FLOW_TARGET_GUARD_HELP_LINES,
      ].join("\n"),
    },
    "settle-gate-transition": {
      helpKey: "flow.run.settle-gate-transition",
      runtimeLog: { stepMetadata: false },
      explicitTargetResolution: true,
      command: () => import("./lib/run-settle-gate-transition.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: [...FLOW_RUN_OPTIONS] },
      help: "Persist the Definition-selected exhausted Draft or Spec Gate finding and settle its current Attempt.",
    },
    "repair-test-review": {
      helpKey: "flow.run.repair-test-review",
      runtimeLog: { stepMetadata: false },
      explicitTargetResolution: true,
      command: () => import("./lib/run-repair-test-review.js"),
      args: {
        flags: FLOW_TARGET_GUARD_FLAGS,
        options: [...FLOW_RUN_OPTIONS],
      },
      help: [
        `Usage: sennel flow run repair-test-review ${FLOW_TARGET_GUARD_USAGE}`,
        "",
        "Freeze the current canonical rejected test-review findings and test revision,",
        "then rewind test, scenario-validity, and test-review without changing review budgets.",
        "The repaired test tree must return through the dispatcher worker-artifact handoff.",
        "",
        "Options:",
        ...FLOW_TARGET_GUARD_HELP_LINES,
        "  --agent-work-dir <path>  Per-invocation agent/tmp base directory",
      ].join("\n"),
    },
    "start-task": {
      helpKey: "flow.run.start-task",
      explicitTargetResolution: true,
      runtimeLog: { stepMetadata: false },
      command: () => import("./lib/run-start-task.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: ["--task-id", ...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run start-task --task-id <id>",
        "",
        "Manually promote a pending task to currentTaskId and transition",
        "it to in_progress. Useful for recovery or manual ordering when",
        "auto-promote is not desired.",
      ].join("\n"),
    },
    "complete-task": {
      helpKey: "flow.run.complete-task",
      explicitTargetResolution: true,
      runtimeLog: { stepMetadata: false },
      command: () => import("./lib/run-complete-task.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: ["--task-id", ...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run complete-task [--task-id <id>]",
        "",
        "Complete currentTaskId (or --task-id if specified), apply parent",
        "propagation, and auto-promote the next pending task. Useful for",
        "recovery when impl-gate post-hook did not fire.",
      ].join("\n"),
    },
    "update-overview": {
      helpKey: "flow.run.update-overview",
      runtimeLog: { stepMetadata: false },
      command: () => import("./lib/run-update-overview.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: ["--json", ...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run update-overview --json '<additions>'",
        "",
        "Append this task's overview contribution to the parent spec.json.",
        "Additions JSON shape:",
        "  {modules: string[], data_flow: string[], decisions: string[]}",
        "All three categories are required.",
        "The current task id is auto-stamped as added_by_task. The update is",
        "published through the active Version Store as a typed spec.record",
        "Activity; derived Markdown is not persisted.",
      ].join("\n"),
    },
    // lint is a sub-task of the implement phase; it does not exclusively own the step.
    // Step status is managed by the skill, not hooks.
    lint: {
      helpKey: "flow.run.lint",
      runtimeLog: { stepMetadata: false },
      command: () => import("./lib/run-lint.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: ["--base", ...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run lint [options]",
        "",
        "Check changed files against guardrail lint patterns.",
        "",
        "Options:",
        "  --base <branch>  Base branch for git diff (auto-resolved from flow.json)",
      ].join("\n"),
    },
    "test-execute": {
      helpKey: "flow.run.test-execute",
      failureOwnership: DefinitionFailureOwnership.dispatcherPrimary(),
      runtimeLog: { stepId: "test-execute" },
      command: () => import("./lib/run-test-execute.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: [...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run test-execute",
        "",
        "Execute the project's test runner via AI agent and publish to the active Version:",
        "  steps/test-execute/result.json (machine-readable attempt history)",
        "  steps/test-execute/output.log (transient raw stdout/stderr)",
      ].join("\n"),
      async post(ctx, result) {
        const { attachedCanonicalCommandResultArtifact } = await import("./lib/canonical-command-result.js");
        const { validateTestExecuteResultV2 } = await import("./lib/test-artifacts.js");
        const attached = attachedCanonicalCommandResultArtifact(result);
        if (attached?.logicalKey !== "test.execute") throw new Error("test-execute canonical result artifact is missing");
        validateTestExecuteResultV2(attached.payload);
        await applyTestChainTransition(ctx, result, "test-execute");
      },
    },
    "scenario-validity": {
      helpKey: "flow.run.scenario-validity",
      failureOwnership: DefinitionFailureOwnership.dispatcherPrimary(),
      runtimeLog: { stepId: "scenario-validity" },
      internal: true,
      requiresFlow: true,
      command: () => import("./lib/run-scenario-validity.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: [...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run scenario-validity",
        "",
        "Execute pre-implementation spec-local tests and publish to the active Version:",
        "  steps/scenario-validity/result.json",
        "  steps/scenario-validity/output.log (transient raw output)",
      ].join("\n"),
      post(ctx, result) {
        const attached = attachedCanonicalCommandResultArtifact(result);
        if (attached?.logicalKey !== "scenario.validity") throw new Error("scenario-validity canonical result artifact is missing");
        validateScenarioValidityArtifactShape(attached.payload);
        validateScenarioValidityObservationCoherence(attached.payload);
        return applyTestChainTransition(ctx, result, "scenario-validity");
      },
    },
    "test-result-review": {
      helpKey: "flow.run.test-result-review",
      failureOwnership: DefinitionFailureOwnership.dispatcherPrimary(),
      runtimeLog: { stepId: "test-result-review" },
      command: () => import("./lib/run-test-result-review.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: [...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run test-result-review",
        "",
        "Verify the cataloged test.execute attempt against transient raw output and code.",
        "Publishes the review history as steps/test-result-review/result.json; derived Markdown is not persisted.",
      ].join("\n"),
      async post(ctx, result) {
        const { attachedCanonicalCommandResultArtifact } = await import("./lib/canonical-command-result.js");
        const { validateTestResultReview } = await import("./lib/test-artifacts.js");
        const attached = attachedCanonicalCommandResultArtifact(result);
        if (attached?.logicalKey !== "test.result.review") throw new Error("test-result-review canonical result artifact is missing");
        validateTestResultReview(attached.payload);
        await applyTestChainTransition(ctx, result, "test-result-review");
      },
    },
    // retro is a mainline impl-phase step that aggregates test-execute results.
    retro: {
      helpKey: "flow.run.retro",
      failureOwnership: DefinitionFailureOwnership.dispatcherPrimary(),
      runtimeLog: { stepId: "retro" },
      command: () => import("./lib/run-retro.js"),
      args: { flags: withTargetGuardFlags(["--dry-run"]), options: [...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run retro [options]",
        "",
        "Aggregate cataloged test execution and result-review attempts per requirement.",
        "Publishes steps/impl/retro/result.json; does not execute tests.",
        "",
        "Options:",
        "  --dry-run   Preview only, do not publish the attempt result",
      ].join("\n"),
      post(ctx, result) {
        if (
          result?.result === "recovered"
          && result?.artifacts?.evidenceRefresh?.recovered === true
        ) return;
        if (ctx.flowState?.policy?.nonblocking?.enabled === true) {
          const artifact = attachedCanonicalCommandResultPublications(result)
            .find((publication) => publication.logicalKey === "retro")?.payload ?? null;
          if (Number(artifact?.summary?.not_done || 0) > 0) return;
        }
        tryUpdateStepStatus(ctx, "retro", "done", undefined, { event: "retro:post", result });
      },
      async nonblockingPost(ctx, result) {
        const { recordEligibleNonblockingAttempt } = await import("./lib/nonblocking.js");
        recordEligibleNonblockingAttempt(ctx, "retro", result);
      },
    },
    "final-regression": {
      helpKey: "flow.run.final-regression",
      failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      runtimeLog: { stepId: "final-regression" },
      command: () => import("./lib/run-final-regression.js"),
      args: {
        flags: withTargetGuardFlags(["--record-and-proceed"]),
        options: ["--record-category", "--record-evidence", "--remaining-risk", ...FLOW_RUN_OPTIONS],
      },
      help: [
        "Usage: sennel flow run final-regression [--record-and-proceed --record-category <category> --record-evidence <text> --remaining-risk <text>]",
        "",
        "Run the full project-level regression command after retro and before finalize.",
        "Publishes steps/final-regression/result.json and transient attempt logs through the active Version Store.",
        "A current-diff failure may be recorded only as out_of_scope with explicit evidence and remaining risk.",
      ].join("\n"),
      async post(ctx, result) {
        if (
          result?.result === "recovered"
          && result?.artifacts?.evidenceRefresh?.recovered === true
        ) return;
        const { attachedCanonicalCommandResultArtifact } = await import("./lib/canonical-command-result.js");
        const { CanonicalTestArtifactStore } = await import("./lib/canonical-test-artifacts.js");
        const { captureFinalRegressionChangedSnapshotDigest, resolveCanonicalFinalRegressionTransition } = await import("./lib/final-regression-transition-facts.js");
        const { applyFinalRegressionTransition } = await import("./lib/final-regression-transition-application.js");
        const attached = attachedCanonicalCommandResultArtifact(result);
        if (attached?.logicalKey !== "final.regression") throw new Error("final-regression canonical result artifact is missing");
        const specId = ctx.specId ?? ctx.flowState.specId;
        // Explicit acceptance is a Definition-selected replacement Attempt.
        // The producer merely publishes the evidence; this plan adapter owns
        // the canonical settlement and must not reinterpret artifact fields.
        if (result?.failedRecorded !== true) {
          ctx.flowManager.publishCurrentAttemptResult({ specId, commandResult: result });
        }
        const state = ctx.flowManager.canonicalState(specId);
        const store = new CanonicalTestArtifactStore({ flowManager: ctx.flowManager, state });
        const decision = resolveCanonicalFinalRegressionTransition({
          flowManager: ctx.flowManager, specId,
          changedFileSnapshotDigest: () => captureFinalRegressionChangedSnapshotDigest({
            root: ctx.executionRoot || ctx.root,
            relativeSpecFile: store.location.relativeSpecFile,
          }),
          candidateArtifact: result?.failedRecorded === true ? attached.payload : null,
        });
        applyFinalRegressionTransition({
          flowManager: ctx.flowManager,
          specId,
          commandResult: result,
          decision,
        });
      },
      async nonblockingPost(ctx, result) {
        const { recordEligibleNonblockingAttempt } = await import("./lib/nonblocking.js");
        recordEligibleNonblockingAttempt(ctx, "final-regression", result);
      },
    },
    "acceptance-review": {
      helpKey: "flow.run.acceptance-review",
      failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      runtimeLog: { stepId: "acceptance-review" },
      command: () => import("./lib/run-acceptance-review.js"),
      args: { flags: FLOW_TARGET_GUARD_FLAGS, options: [...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run acceptance-review",
        "",
        "Evaluate original request satisfaction after retro and before final-regression.",
        "Publishes steps/acceptance-review/result.json through the active Version Store and routes pass/non-pass verdicts.",
      ].join("\n"),
      async post(ctx, result) {
        const { attachedCanonicalCommandResultArtifact } = await import("./lib/canonical-command-result.js");
        const { validateAcceptanceReviewArtifact } = await import("./lib/acceptance-review-artifacts.js");
        const { resolveDefinitionRoute } = await import("./definition.js");
        const { acceptanceReviewRouteFacts } = await import("./lib/definition-route-facts.js");
        const attached = attachedCanonicalCommandResultArtifact(result);
        if (attached?.logicalKey !== "acceptance.review") {
          throw new Error("acceptance-review canonical result artifact is missing");
        }
        const spec = ctx.flowManager.readArtifact({
          specId: ctx.flowState.specId,
          logicalKey: "spec.record",
          consumerNodeId: "acceptance-review",
        });
        const requirementIds = JSON.parse(spec.bytes.toString("utf8")).requirements
          .map((entry) => entry.id);
        const artifact = validateAcceptanceReviewArtifact(attached.payload, { requirementIds });
        const specId = ctx.flowState.specId;
        const plan = resolveDefinitionRoute(acceptanceReviewRouteFacts({
          state: ctx.flowManager.canonicalState(specId),
          artifact,
        }));
        plan.apply({
          blocked() {
            ctx.flowManager.publishCurrentAttemptResult({ specId, commandResult: result });
          },
          repairAcceptanceToImplTriage() {
            // One Store Activity retains the reviewed artifact and creates
            // the replacement impl-triage Attempt together.
            ctx.flowManager.repairAcceptanceReview({ specId, commandResult: result });
          },
          awaitAcceptanceDecision() {
            tryUpdateStepStatus(ctx, "acceptance-review", "done", undefined, { event: "acceptance-review:post", result });
            ctx.flowManager.updateStepStatus({ stepId: "acceptance-decision", requestedStatus: "in_progress" }, { specId });
          },
          advanceFinalRegression() {
            tryUpdateStepStatus(ctx, "acceptance-review", "done", undefined, { event: "acceptance-review:post", result });
            ctx.flowManager.completeAcceptanceDecisionNoOp({ specId });
            ctx.flowManager.updateStepStatus({ stepId: "final-regression", requestedStatus: "in_progress" }, { specId });
          },
        });
        ctx.flowState = ctx.flowManager.load(specId);
      },
    },
    // report generates a work report from the current flow state.
    report: {
      helpKey: "flow.run.report",
      failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
      runtimeLog: { stepId: "report" },
      command: () => import("./lib/run-report.js"),
      args: { flags: withTargetGuardFlags(["--dry-run"]), options: [...FLOW_RUN_OPTIONS] },
      help: [
        "Usage: sennel flow run report [options]",
        "",
        "Generate a work report from the current flow state.",
        "",
        "Options:",
        "  --dry-run   Preview only, do not write report.json",
      ].join("\n"),
      async pre(ctx) {
        await applyLifecycleActionsFromRegistry(ctx, {
          event: "report:pre",
          command: "report",
        });
      },
      async post(ctx, result) {
        await applyLifecycleActionsFromRegistry(ctx, {
          event: "report:post",
          command: "report",
        }, result);
      },
      async onError(ctx, err) {
        await applyLifecycleActionsFromRegistry(ctx, {
          event: "report:onError",
          command: "report",
        }, null, err);
      },
    },
  },
  report: {
    show: {
      helpKey: "flow.report.show",
      runtimeLog: { stepMetadata: false },
      command: () => import("./lib/run-report-show.js"),
      requiresFlow: false,
      args: { flags: [] },
      help: [
        "Usage: sennel flow report show",
        "",
        "Stream the most recent finalize Report text to stdout.",
        "Reads .sennel/last-finalized-spec to locate the latest",
        "finalized spec and prints its report.json `text` field.",
        "Exits non-zero if the pointer or report.json is missing.",
      ].join("\n"),
    },
  },
};
