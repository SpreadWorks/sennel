import { StepConnector } from "../../step-connector.js";

/** Connects the initial request to the first Draft step. */
export class DraftEntryConnector extends StepConnector {
  constructor(request) {
    super();
    this.request = request;
  }

  async connect() {
    const { DraftWorkerStepBinding } = await import("./draft-step-binding.js");
    if (this.request?.stepId !== "draft") throw new Error("Draft entry requires the draft worker request");
    const binding = new DraftWorkerStepBinding({ request: this.request });
    binding.assertCurrent();
    return binding;
  }
}
