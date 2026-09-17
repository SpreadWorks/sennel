import { StepConnector } from "../../step-connector.js";

/** Binds the Draft questions and any user answer to the refine step. */
export class DraftRefineConnector extends StepConnector {
  constructor(request) {
    super();
    this.request = request;
  }

  async connect() {
    const { DraftWorkerStepBinding, DraftRefineAwaitBinding } = await import("./draft-step-binding.js");
    const binding = this.request?.stepId === "draft-refine"
      ? new DraftWorkerStepBinding({ request: this.request })
      : new DraftRefineAwaitBinding(this.request);
    binding.assertCurrent();
    return binding;
  }
}
