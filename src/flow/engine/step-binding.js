import { CurrentAttemptIdentity } from "../lib/current-flow-state.js";
import { CurrentFlowStateConflictError } from "../lib/current-flow-state-conflict-error.js";

export function canonicalStepState(flowManager, specId) {
  if (!flowManager || typeof flowManager.canonicalState !== "function") {
    throw new TypeError("Step binding requires FlowManager canonical state reads");
  }
  const state = flowManager.canonicalState(specId);
  if (state === null) throw new CurrentFlowStateConflictError("Step binding has no canonical Flow state");
  return state;
}

/** A typed, proof-bearing choice of a successor Attempt before its atomic save. */
export class StepBindingContinuation {
  constructor({ sourceBinding, attempt } = {}) {
    if (new.target === StepBindingContinuation || !(sourceBinding instanceof StepBinding)) {
      throw new TypeError("Step binding continuation requires its concrete source binding proof");
    }
    this.sourceBinding = sourceBinding;
    this.attempt = CurrentAttemptIdentity.from(attempt);
    if (this.attempt.nodeId !== sourceBinding.nodeId || this.attempt.id === sourceBinding.attempt.id
      || this.attempt.sequence !== sourceBinding.attempt.sequence + 1) {
      throw new CurrentFlowStateConflictError("Step binding continuation must choose the next source Attempt");
    }
  }
  matchesState() { throw new Error("Step binding continuation must authenticate its source state"); }
}

/** Shared immutable binding to one exact active Step Attempt. */
export class StepBinding {
  constructor({ flowManager, state, stepId, nodeId = stepId, attempt, allowFailed = false, continuation = null } = {}) {
    if (new.target === StepBinding) throw new TypeError("StepBinding is abstract");
    if (typeof stepId !== "string" || stepId.trim() === "") {
      throw new TypeError("Step binding requires a Step id");
    }
    if (typeof state?.runId !== "string" || state.runId === ""
      || typeof state.specId !== "string" || state.specId === "") {
      throw new TypeError("Step binding requires a canonical Flow state");
    }
    this.flowManager = flowManager;
    this.runId = state.runId;
    this.specId = state.specId;
    this.stepId = stepId;
    this.nodeId = nodeId;
    this.attempt = CurrentAttemptIdentity.from(attempt);
    this.allowFailed = allowFailed;
    if (continuation !== null && (!(continuation instanceof StepBindingContinuation)
      || continuation.sourceBinding.flowManager !== flowManager
      || continuation.sourceBinding.runId !== this.runId || continuation.sourceBinding.specId !== this.specId
      || continuation.sourceBinding.stepId !== stepId || continuation.sourceBinding.nodeId !== nodeId
      || continuation.attempt.id !== this.attempt.id || continuation.attempt.sequence !== this.attempt.sequence)) {
      throw new CurrentFlowStateConflictError("Step binding continuation belongs to another source responsibility");
    }
    this.continuation = continuation;
    if (this.attempt.nodeId !== this.nodeId
      || !(continuation === null ? this.attempt.matches(state) || (allowFailed && this.attempt.matchesFailed(state))
        : continuation.matchesState(state))) {
      throw new CurrentFlowStateConflictError("Step binding requires the exact active Step Attempt");
    }
  }

  assertCurrent() {
    const state = canonicalStepState(this.flowManager, this.specId);
    if (state.runId !== this.runId || state.specId !== this.specId
      || !(this.continuation === null ? this.attempt.matches(state) || (this.allowFailed && this.attempt.matchesFailed(state))
        : this.continuation.matchesState(state))) {
      throw new CurrentFlowStateConflictError("Step binding is stale for the canonical Step Attempt");
    }
    return state;
  }
}
