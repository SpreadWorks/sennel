import { StepConnector } from "../../step-connector.js";

/** Binds a review Attempt and its Draft revision to the selected triage step. */
export class DraftTriageConnector extends StepConnector {
  async connect() {
    throw new Error("DraftTriageConnector.connect() is not implemented");
  }
}
