import { GateStepObservation } from "../lib/gate-observation-values.js";

/** Acquired Task source Gate evidence; TaskSpec is a separate Spec Gate. */
export class TaskGateInput {
  constructor(observation) {
    if (!(observation instanceof GateStepObservation) || observation.evidence.stepId !== "task-gate") {
      throw new TypeError("Task Gate input requires its Task source Gate observation");
    }
    this.observation = observation;
    this.stepId = "task-gate";
    Object.freeze(this);
  }
}
