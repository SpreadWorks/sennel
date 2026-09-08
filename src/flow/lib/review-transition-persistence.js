/**
 * Persist Review facts and materialize a transition already selected by
 * definition.js. This module never chooses a route.
 */
import {
  applyLifecycleActions,
  resolveReviewDeferralLifecycle,
  resolveLifecycle,
  resolveReviewTransition,
} from "../definition.js";
import {
  buildDeferredSemanticFindingsPublication,
} from "./flow-findings.js";
import { createLifecycleStepTransition } from "./lifecycle-step-transition.js";
import {
  ReviewTransitionFacts,
  reviewPhaseForStep,
} from "./review-transition-facts.js";
import { flowReviewRouteForPhase } from "./review-route.js";

function phaseFor(ctx, result) {
  return result?.artifacts?.retryPhase || result?.artifacts?.phase || ctx.phase || "impl";
}

export function reviewTransitionFacts({ flowManager, flowState, typedState = null, scope, phase }) {
  return ReviewTransitionFacts.forCurrentAttempt({ flowManager, flowState, typedState, scope, phase });
}

export function resolveCurrentReviewTransition({ flowManager, flowState, typedState = null, scope, stepId }) {
  const phase = scope === "task" ? "impl" : reviewPhaseForStep(stepId);
  if (phase === null) return Object.freeze({ facts: null, disposition: null });
  if (phase === "spec") return Object.freeze({ facts: null, disposition: null });
  const facts = reviewTransitionFacts({ flowManager, flowState, typedState, scope, phase });
  return Object.freeze({
    facts,
    disposition: resolveReviewTransition({ stepId, flowState, facts }),
  });
}

/** Persist observed retry accounting; get-next-action owns route selection. */
export function persistReviewTransitionFacts(ctx, result) {
  const phase = phaseFor(ctx, result);
  if (phase === "spec") return null;
  if (flowReviewRouteForPhase(phase) === null) return null;
  const passed = result?.artifacts?.verdict === "PASS" || result?.artifacts?.verdict === "ADVISORY";
  const toolingOutcome = result?.artifacts?.toolingOutcome ?? null;
  let retryRecorded = false;
  if (ctx.flowState.currentTaskId == null && toolingOutcome === null) {
    ctx.flowManager.appendMetric(
      passed ? { phase, counter: "reviewRetry", delta: 0, reset: true } : { phase, counter: "reviewRetry", delta: 1 },
      { taskId: null },
    );
    ctx.flowState = ctx.flowManager.loadReadOnly(ctx.specId);
    retryRecorded = true;
  }
  return Object.freeze({ phase, retryRecorded });
}

/** Materialize a definition-selected Review disposition from current canonical facts. */
export function settleDefinitionReviewTransition(ctx) {
  const flowState = ctx.flowManager.loadReadOnly(ctx.specId ?? ctx.flowState.specId);
  const taskId = flowState.currentTaskId ?? null;
  const scope = taskId === null ? "flow" : "task";
  const nodeId = scope === "task" ? `${taskId}-review` : flowState.currentNodeId;
  const stepId = scope === "task" ? "task-review" : nodeId;
  const selection = resolveCurrentReviewTransition({
    flowManager: ctx.flowManager,
    flowState,
    scope,
    stepId,
  });
  if (selection.disposition?.operation !== "defer") return null;
  const { facts, disposition } = selection;
  const findings = buildDeferredSemanticFindingsPublication({
    flowManager: ctx.flowManager,
    flowState,
    nodeId,
    sourceStep: stepId,
    sourceArtifact: facts.sourceArtifact,
    attempts: disposition.attempts,
    fingerprints: new Set(disposition.sourceFingerprints),
  });
  const findingWrite = findings.artifactWrite();
  if (taskId === null) {
    ctx.flowManager.confirmCurrentAttempt({
      specId: flowState.specId,
      status: "done",
      artifactWrites: findingWrite === null ? [] : [findingWrite],
      artifactBaselines: [findings.baseline],
    });
    applyLifecycleActions({
      setStepStatus(step, status) {
        const current = ctx.flowManager.loadReadOnly(flowState.specId);
        const transition = createLifecycleStepTransition({
          flowState: current,
          stepId: step,
          status,
          event: "review:defer",
          taskId,
        });
        if (transition) ctx.flowManager.updateStepStatus(transition, { taskId });
      },
    }, resolveReviewDeferralLifecycle({ scope, stepId, disposition }));
  } else {
    ctx.flowManager.deferFailedReview({
      specId: flowState.specId,
      findingsPublication: findings,
    });
  }
  return Object.freeze({
    stepId,
    phase: facts.phase,
    operation: disposition.operation,
    findingCount: findings.deferred.length,
    attempts: disposition.attempts,
  });
}
