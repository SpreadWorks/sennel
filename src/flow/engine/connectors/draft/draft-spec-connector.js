import { StepConnector } from "../../step-connector.js";

/** Binds the completed Draft Gate result for the handoff to Spec. */
export class DraftSpecConnector extends StepConnector {
  async connect() {
    throw new Error("DraftSpecConnector.connect() is not implemented");
  }
}
