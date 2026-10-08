import { GateStepObservation } from "../lib/gate-observation-values.js";
export class ImplGateInput {
  constructor(observation) {
    if (!(observation instanceof GateStepObservation) || observation.evidence.stepId !== "impl-gate") throw new TypeError("Implementation Gate input requires typed acquired evidence");
    this.evidence = observation.evidence;
    this.stepId = "impl-gate";
    Object.freeze(this);
  }
}
