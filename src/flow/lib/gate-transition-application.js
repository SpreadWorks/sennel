/**
 * Non-policy Gate transition consumers.
 *
 * Persistence, command admission, and next-action projection accept only the
 * sealed decision selected by definition.js. They never inspect Gate result,
 * failure, retry, or recovery facts to choose another route.
 */
import {
  GatePublicOutcomeProjection,
  GateTransitionDecision,
  projectGatePublicOutcome,
  resolveGatePublicationRecovery,
  resolveGateTransition,
  resolveTaskGateSettlementRecovery,
} from "../definition.js";
import { GateTransitionFacts } from "./gate-transition.js";
import { readCurrentGateTransitionFacts } from "./gate-transition-facts.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";
import { isDeepStrictEqual } from "node:util";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { assertGateSettlementPublication } from "./gate-settlement-publication.js";

const PROJECTION_TOKEN = Symbol("gate-transition-action-projection");

export class GateTransitionActionProjection {
  constructor(token, decision) {
    if (token !== PROJECTION_TOKEN || !(decision instanceof GateTransitionDecision)) {
      throw new Error("Gate action projections require a definition decision");
    }
    this.actionId = decision.plan.action.identity;
    this.phase = decision.facts.phase;
    this.scope = decision.facts.scope;
    this.stepId = decision.facts.target.stepId;
    this.operation = decision.disposition.operation;
    this.reason = decision.disposition.reason;
    this.failureCode = projectGatePublicOutcome(decision).failureCode;
    this.advance = decision.advance?.operation === "advance";
    // The directive projection must not reopen the Decision to recover
    // route-specific details.  Keep the Definition-selected handoff with the
    // Action so consumers can render it without policy interpretation.
    this.nonblockingHandoff = decision.plan.nonblockingHandoff;
    Object.freeze(this);
  }

  toJSON() {
    return {
      phase: this.phase,
      scope: this.scope,
      stepId: this.stepId,
      actionId: this.actionId.toJSON(),
      operation: this.operation,
      reason: this.reason,
      failureCode: this.failureCode,
      advance: this.advance,
      nonblockingHandoff: this.nonblockingHandoff?.toJSON() ?? null,
    };
  }
}

/** The selected continuation is recovered from the authenticated saved Result. */
export class SavedImplementationGateSelection {
  constructor(saved) {
    if (!["task-gate", "impl-gate"].includes(saved?.result?.stepId)
      || saved.settlement.sourceStepId !== saved.result.stepId
      || saved.receipt.binding.stepId !== saved.result.stepId) {
      throw new TypeError("Implementation Gate continuation requires its bound Result and receipt");
    }
    this.result = saved.result;
    this.settlement = saved.settlement;
    this.receipt = saved.receipt;
    this.activityId = saved.activityId;
    this.decision = saved.settlement.application?.decision ?? null;
    if (this.decision !== null && !(this.decision instanceof GateTransitionDecision)) {
      throw new TypeError("Saved Gate settlement must retain its selected decision");
    }
    this.action = this.decision === null ? null : projectGateTransitionDecision(this.decision);
    Object.freeze(this);
  }
  toJSON() {
    return { result: this.result.toJSON(), settlement: this.settlement.toJSON(),
      receiptId: this.receipt.id, action: this.action?.toJSON() ?? null };
  }
}

/** Apply exactly the definition-owned plan; the adapter cannot select a route. */
export function applyGateTransitionDecision(adapter, decision) {
  if (adapter === null || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new Error("gate transition persistence adapter must be an object");
  }
  if (!(decision instanceof GateTransitionDecision)) {
    throw new Error("gate transition persistence requires a definition decision");
  }
  if (typeof adapter.applyStepUpdate !== "function") {
    throw new Error("gate transition persistence adapter.applyStepUpdate is required");
  }
  for (const update of decision.plan.updates) adapter.applyStepUpdate(update, decision);
  if (decision.plan.taskLifecycle !== null) {
    if (typeof adapter.applyTaskLifecycle !== "function") {
      throw new Error("gate Task lifecycle plan requires adapter.applyTaskLifecycle");
    }
    adapter.applyTaskLifecycle(decision.plan.taskLifecycle, decision);
  }
  if (decision.plan.recoveryEffect !== null) {
    if (typeof adapter.applyRecoveryEffect !== "function") {
      throw new Error("gate recovery plan requires adapter.applyRecoveryEffect");
    }
    adapter.applyRecoveryEffect(decision.plan.recoveryEffect, decision);
  }
  if (decision.plan.nonblockingHandoff !== null) {
    if (typeof adapter.applyNonblockingHandoff !== "function") {
      throw new Error("gate nonblocking plan requires adapter.applyNonblockingHandoff");
    }
    adapter.applyNonblockingHandoff(decision.plan.nonblockingHandoff, decision);
  }
  if (decision.plan.retryMetric !== null) {
    if (typeof adapter.applyRetryMetric !== "function") {
      throw new Error("gate transition retry plan requires adapter.applyRetryMetric");
    }
    adapter.applyRetryMetric(decision.plan.retryMetric, decision);
  }
}

/** Authenticate the selected continuation before direct execution. */
export function admitGateTransition({ facts, decision, flowManager, flowState, phase, root } = {}) {
  if (!(decision instanceof GateTransitionDecision)) {
    throw new Error("gate admission requires a definition decision");
  }
  const implementation = ["task-impl", "integration"].includes(decision.facts.phase);
  const current = implementation
    ? resolveGateNextAction({ flowManager, flowState, phase: phase ?? decision.facts.phase, root })?.decision ?? null
    : resolveGateTransition(facts);
  if (current === null || !current.plan.action.identity.matches(decision.plan.action.identity)) {
    throw new Error("gate transition admission rejected a stale or bypassed decision");
  }
  return current;
}

/** Project a selected decision without interpreting Gate semantics. */
export function projectGateTransitionDecision(decision) {
  return new GateTransitionActionProjection(PROJECTION_TOKEN, decision);
}

/** Apply a Definition-owned public recovery projection without exposing routing authority. */
export function applyGatePublicOutcomeProjection(commandResult, projection) {
  if (commandResult === null || typeof commandResult !== "object" || Array.isArray(commandResult)) {
    throw new Error("Gate public outcome projection requires a command result");
  }
  if (!(projection instanceof GatePublicOutcomeProjection)) {
    throw new Error("Gate public outcome projection must be Definition-owned");
  }
  if (projection.nextStepId !== null) commandResult.next = projection.nextStepId;
  return commandResult;
}

/** Restore implementation Results; other phases retain their canonical Gate owner. */
export function resolveGateNextAction({ flowManager, flowState, phase, root = null, validateRoute = () => {} } = {}) {
  if (typeof validateRoute !== "function") throw new Error("Gate next-action validateRoute must be a function");
  if (["task-impl", "integration"].includes(phase)) {
    const stepId = phase === "integration" ? "impl-gate" : "task-gate";
    const saved = flowManager.readCurrentStepSettlement({ specId: flowState.specId, stepId });
    const facts = readCurrentGateTransitionFacts({ flowManager, flowState, phase, root });
    if (saved === null || saved.result.evidence?.executionRequired === true) {
      if (facts !== null) throw new StepAdmissionRefusal("Implementation Gate observation requires its atomic saved Result and receipt");
      return saved === null ? null : new SavedImplementationGateSelection(saved);
    }
    const selected = new SavedImplementationGateSelection(saved);
    if (selected.result.type === "error") {
      // File-input failures can stop before the facts reader exposes a Gate
      // observation. Authenticate any attached publication without judging it.
      const publication = selected.result.error.data?.evidence?.publication;
      if (publication != null) {
        const state = flowManager.canonicalState(flowState.specId);
        const nodeId = state.current.at(-1);
        const source = flowManager.readProducerArtifact({ specId: state.specId, nodeId,
          logicalKey: phase === "integration" ? "impl.gate" : "task.gate",
          parameters: phase === "integration" ? {} : { taskId: selected.result.error.data.evidence.identity.taskId } });
        const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: source.descriptor.logicalKey, bytes: source.bytes });
        const activity = flowManager.activityLedger(state.specId).find((entry) => entry.id === selected.activityId);
        assertGateSettlementPublication({ state, activity, descriptor: source.descriptor,
          historyEntry: history.current, attempt: state.attempt, publicationBytes: source.bytes });
      }
      return selected;
    }
    const original = selected.decision?.facts;
    if (facts === null || original == null || facts.integrityFailure !== null
      || !isDeepStrictEqual(facts.target.toJSON(), original.target.toJSON())
      || !isDeepStrictEqual(facts.catalogPublication.toJSON(), original.catalogPublication.toJSON())
      || !isDeepStrictEqual(facts.lineage.toJSON(), original.lineage.toJSON())) {
      throw new StepAdmissionRefusal("Saved implementation Gate observation is stale or no longer canonically bound");
    }
    validateRoute(selected.decision.plan, selected.decision);
    return selected;
  }
  const facts = readCurrentGateTransitionFacts({ flowManager, flowState, phase, root });
  if (facts === null) return null;
  if (!(facts instanceof GateTransitionFacts)) throw new Error("Gate next-action facts must be typed");
  const decision = resolveTaskGateSettlementRecovery(facts)
    ?? resolveGatePublicationRecovery(facts)
    ?? resolveGateTransition(facts);
  validateRoute(decision.plan, decision);
  return Object.freeze({ decision, action: projectGateTransitionDecision(decision) });
}

export function sameGateTransitionDecision(left, right) {
  if (!(left instanceof GateTransitionDecision) || !(right instanceof GateTransitionDecision)) {
    throw new Error("Gate transition comparison requires definition decisions");
  }
  return left.plan.action.identity.matches(right.plan.action.identity);
}
