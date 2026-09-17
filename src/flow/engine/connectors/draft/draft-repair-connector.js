import { StepConnector } from "../../step-connector.js";

/** Binds a triage Attempt and its repair target to the selected repair step. */
export class DraftRepairConnector extends StepConnector {
  async connect() {
    throw new Error("DraftRepairConnector.connect() is not implemented");
  }
}
