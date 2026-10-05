/**
 * Non-policy consumers for Definition-owned non-Gate transitions.
 *
 * Readers, direct commands, persistence and get-next-action share this small
 * contract.  None receives raw route fields that could become a second route
 * authority.
 */
import {
  NonGateTransitionDecision,
  resolveNonGateTransition,
} from "../definition.js";
import { NonGateTransitionFacts } from "./non-gate-transition.js";
import { readCurrentNonGateTransitionFacts } from "./non-gate-transition-facts.js";

const PROJECTION_TOKEN = Symbol("non-gate-transition-action-projection");

function sameDecision(left, right) {
  return JSON.stringify(left.toJSON()) === JSON.stringify(right.toJSON());
}

function requireDecision(decision, field = "non-Gate transition") {
  if (!(decision instanceof NonGateTransitionDecision)) {
    throw new Error(`${field} requires a definition decision`);
  }
  return decision;
}

/** Compatibility Action projection; the typed plan remains route authority. */
export class NonGateTransitionActionProjection {
  constructor(token, decision) {
    requireDecision(decision, "non-Gate Action projection");
    if (token !== PROJECTION_TOKEN) throw new Error("non-Gate Action projections are created only by the projection boundary");
    this.actionId = decision.plan.action.identity;
    this.stepId = decision.facts.stepId;
    this.operation = decision.disposition.operation;
    this.reason = decision.disposition.reason;
    Object.freeze(this);
  }

  matches(action) {
    return action instanceof NonGateTransitionActionProjection && this.actionId.matches(action.actionId);
  }

  toJSON() {
    return {
      actionId: this.actionId.toJSON(),
      stepId: this.stepId,
      operation: this.operation,
      reason: this.reason,
    };
  }
}

/** Apply only the sealed plan created by definition.js. */
export function applyNonGateTransitionDecision(adapter, decision) {
  if (adapter === null || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new Error("non-Gate transition persistence adapter must be an object");
  }
  requireDecision(decision, "non-Gate transition persistence");
  for (const action of decision.plan.actions) action.apply(adapter, decision.plan);
}

/** Project a definition-selected plan without inspecting observed outcome facts. */
export function projectNonGateTransitionDecision(decision) {
  return new NonGateTransitionActionProjection(PROJECTION_TOKEN, requireDecision(decision));
}

function selectedActionIdentity(selectedAction) {
  if (selectedAction instanceof NonGateTransitionActionProjection) return selectedAction.actionId;
  if (selectedAction instanceof NonGateTransitionDecision) return selectedAction.plan.action.identity;
  throw new Error("non-Gate direct command requires a typed selected Action");
}

/**
 * Re-read current canonical facts before a direct run/set command starts a
 * worker, appends an Activity, or changes state.  The caller invokes its
 * side-effectful command only after this returns.
 */
function canonicalFacts({ flowManager, specId, readStepFacts }) {
  if (typeof readStepFacts !== "function") throw new Error("non-Gate transition requires a Step-specific facts reader");
  return readCurrentNonGateTransitionFacts({ flowManager, specId, readFacts: readStepFacts });
}

export function admitNonGateDirectCommand({ flowManager, specId, readStepFacts, stepDefinition, selectedAction } = {}) {
  const selectedIdentity = selectedActionIdentity(selectedAction);
  const facts = canonicalFacts({ flowManager, specId, readStepFacts });
  if (!(facts instanceof NonGateTransitionFacts)) {
    throw new Error("non-Gate direct command readFacts() must return current typed facts");
  }
  const current = resolveNonGateTransition(facts, stepDefinition);
  if (!current.plan.action.identity.matches(selectedIdentity)) {
    throw new Error("non-Gate direct command admission rejected a stale or bypassed Action");
  }
  return current;
}

/** Backwards-neutral names for the two direct CLI boundaries. */
export const admitNonGateRunCommand = admitNonGateDirectCommand;
export const admitNonGateSetCommand = admitNonGateDirectCommand;

/** Own the admission/execution sequence so rejected commands cannot start work. */
export function executeAdmittedNonGateCommand({ execute, ...input } = {}) {
  if (typeof execute !== "function") throw new Error("non-Gate direct command requires execute()");
  const decision = admitNonGateDirectCommand(input);
  return execute(decision);
}

/**
 * Common get-next-action contract: pure facts read, Definition decision,
 * selected-route precondition validation, then a compatibility projection.
 */
export function resolveNonGateNextAction({ flowManager, specId, readStepFacts, stepDefinition, validateRoute = () => {} } = {}) {
  if (typeof validateRoute !== "function") throw new Error("non-Gate next-action validateRoute must be a function");
  const facts = canonicalFacts({ flowManager, specId, readStepFacts });
  if (!(facts instanceof NonGateTransitionFacts)) {
    throw new Error("non-Gate next-action readFacts() must return current typed facts");
  }
  const decision = resolveNonGateTransition(facts, stepDefinition);
  validateRoute(decision.plan, decision);
  return Object.freeze({ decision, action: projectNonGateTransitionDecision(decision) });
}

/** Deterministic equality helper for storage adapters that re-read a plan. */
export function sameNonGateTransitionDecision(left, right) {
  requireDecision(left, "left non-Gate transition");
  requireDecision(right, "right non-Gate transition");
  return sameDecision(left, right);
}
