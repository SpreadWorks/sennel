import { FlowExecutionObservationBinding } from "../../lib/flow-execution-observation.js";
import { CurrentFlowStateConflictError } from "./current-flow-state-conflict-error.js";

/** Persistence admission only; it never selects a route or retries work. */
export class FlowExecutionObservationStartingAdmission {
  constructor(binding) {
    if (!(binding instanceof FlowExecutionObservationBinding)) throw new TypeError("Observation starting admission requires its typed binding");
    this.binding = binding;
    Object.freeze(this);
  }
  assert({ state }) {
    this.binding.assertVersion(state);
    if (state.attempt?.id !== this.binding.attemptId || state.attempt.sequence !== this.binding.attemptSequence
      || state.attempt.nodeId !== this.binding.nodeId || state.current?.at(-1) !== this.binding.nodeId) {
      throw new CurrentFlowStateConflictError("Execution observation starting Attempt changed before publication");
    }
  }
}
