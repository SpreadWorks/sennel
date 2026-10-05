import { StepConnector } from "../../step-connector.js";

/** Binds the completed Draft Gate result for the handoff to Spec. */
export class DraftSpecConnector extends StepConnector {
  constructor({ flowManager, facts }) {
    super();
    this.flowManager = flowManager;
    this.facts = facts;
  }

  async connect() {
    const { DraftGateStepBinding } = await import("./draft-step-binding.js");
    const binding = new DraftGateStepBinding({ flowManager: this.flowManager, facts: this.facts });
    binding.assertCurrent();
    return binding;
  }
}
