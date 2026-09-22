import { CurrentAttemptIdentity } from "../lib/current-flow-state.js";

export function canonicalStepState(flowManager, specId) {
  if (!flowManager || typeof flowManager.canonicalState !== "function") {
    throw new TypeError("Step binding requires FlowManager canonical state reads");
  }
  const state = flowManager.canonicalState(specId);
  if (state === null) throw new Error("Step binding has no canonical Flow state");
  return state;
}

/** Shared immutable binding to one exact active Step Attempt. */
export class StepBinding {
  constructor({ flowManager, state, stepId, attempt, allowFailed = false } = {}) {
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
    this.attempt = CurrentAttemptIdentity.from(attempt);
    this.allowFailed = allowFailed;
    if (this.attempt.nodeId !== this.stepId
      || !(this.attempt.matches(state) || (allowFailed && this.attempt.matchesFailed(state)))) {
      throw new Error("Step binding requires the exact active Step Attempt");
    }
  }

  assertCurrent() {
    const state = canonicalStepState(this.flowManager, this.specId);
    if (state.runId !== this.runId || state.specId !== this.specId
      || !(this.attempt.matches(state) || (this.allowFailed && this.attempt.matchesFailed(state)))) {
      throw new Error("Step binding is stale for the canonical Step Attempt");
    }
    return state;
  }
}
