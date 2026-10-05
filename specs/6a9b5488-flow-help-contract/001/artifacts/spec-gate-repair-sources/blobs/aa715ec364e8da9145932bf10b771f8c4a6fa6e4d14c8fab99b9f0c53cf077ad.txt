import { StepConnector } from "../../step-connector.js";
import { draftReviewRouteForStepId } from "../../../lib/draft-review-routes.js";

/** Binds a review Attempt and its Draft revision to the selected triage step. */
export class DraftTriageConnector extends StepConnector {
  constructor(request) {
    super();
    this.request = request;
  }

  async connect() {
    const { DraftWorkerStepBinding } = await import("./draft-step-binding.js");
    const route = draftReviewRouteForStepId(this.request?.stepId);
    if (route === null || route.triageStepId !== this.request.stepId) {
      throw new Error("Draft triage requires a selected review triage worker request");
    }
    const binding = new DraftWorkerStepBinding({ request: this.request });
    binding.assertCurrent();
    return binding;
  }
}
