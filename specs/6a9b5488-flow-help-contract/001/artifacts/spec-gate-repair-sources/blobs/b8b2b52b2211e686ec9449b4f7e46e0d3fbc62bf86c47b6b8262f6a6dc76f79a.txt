import { StepConnector } from "../../step-connector.js";
import { draftReviewRouteForStepId } from "../../../lib/draft-review-routes.js";

/** Binds a triage Attempt and its repair target to the selected repair step. */
export class DraftRepairConnector extends StepConnector {
  constructor(request) {
    super();
    this.request = request;
  }

  async connect() {
    const { DraftWorkerStepBinding } = await import("./draft-step-binding.js");
    const route = draftReviewRouteForStepId(this.request?.stepId);
    if (route === null || route.repairStepId !== this.request.stepId) {
      throw new Error("Draft repair requires a selected review repair worker request");
    }
    const binding = new DraftWorkerStepBinding({ request: this.request });
    binding.assertCurrent();
    return binding;
  }
}
