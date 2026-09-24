import { StepConnector } from "../../step-connector.js";

export class SpecGateRepairConnector extends StepConnector {
  async connect() { return "spec-gate-repair"; }
}

export class SpecGateApprovalConnector extends StepConnector {
  async connect() { return "approval"; }
}

/** A repaired Spec needs Review without the initial-Spec publication application. */
export class SpecGateRepairReviewConnector extends StepConnector {
  async connect() { return "spec-review"; }
}
