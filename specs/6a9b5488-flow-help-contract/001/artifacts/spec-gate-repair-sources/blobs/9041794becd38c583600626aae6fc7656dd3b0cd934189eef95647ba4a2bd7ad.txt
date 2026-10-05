import { StepConnector } from "../../step-connector.js";
import { SpecWorkerStepBinding } from "./spec-step-binding.js";

/** Connects the sealed initial Spec handoff to the Spec Step. */
export class SpecEntryConnector extends StepConnector {
  constructor(request) {
    super();
    this.request = request;
  }

  async connect() {
    const binding = new SpecWorkerStepBinding({ request: this.request });
    binding.assertCurrent();
    return binding;
  }
}
