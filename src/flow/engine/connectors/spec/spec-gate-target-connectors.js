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

/** The selected repair disposition returns to the shared Draft recovery route. */
export class SpecGateRepairDraftReturnConnector extends StepConnector {
  async connect() { return "draft"; }
}
