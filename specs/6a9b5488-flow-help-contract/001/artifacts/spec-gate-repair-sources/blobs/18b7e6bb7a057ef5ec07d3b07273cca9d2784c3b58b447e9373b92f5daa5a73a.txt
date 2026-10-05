import { StepConnector } from "../../step-connector.js";

/** Connects an accepted canonical Spec Review to Spec Triage. */
export class SpecTriageConnector extends StepConnector {
  async connect() {
    return "spec-triage";
  }
}
