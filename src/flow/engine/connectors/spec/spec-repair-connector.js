import { StepConnector } from "../../step-connector.js";

/** Connects a settled Spec Triage to its repair Step. */
export class SpecRepairConnector extends StepConnector {
  async connect() { return "spec-repair"; }
}
