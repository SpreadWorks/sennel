import { StepConnector } from "../../step-connector.js";

/** Connects a settled Spec Repair to its gate. */
export class SpecGateConnector extends StepConnector {
  async connect() { return "spec-gate"; }
}
