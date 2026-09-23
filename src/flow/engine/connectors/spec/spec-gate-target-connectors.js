import { StepConnector } from "../../step-connector.js";

export class SpecGateRepairConnector extends StepConnector {
  async connect() { return "spec"; }
}

export class SpecGateApprovalConnector extends StepConnector {
  async connect() { return "approval"; }
}
