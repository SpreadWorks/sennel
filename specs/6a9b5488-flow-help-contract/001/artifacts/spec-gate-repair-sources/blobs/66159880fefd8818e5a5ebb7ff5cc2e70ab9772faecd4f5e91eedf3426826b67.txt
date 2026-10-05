import { StepConnector } from "../../step-connector.js";

/** Binds the Draft revision consumed by a questions or coverage review. */
export class DraftReviewConnector extends StepConnector {
  constructor(source) {
    super();
    this.source = source;
  }

  async connect() {
    const { DraftReviewStepBinding } = await import("./draft-step-binding.js");
    const binding = new DraftReviewStepBinding({ source: this.source });
    binding.assertCurrent();
    return binding;
  }
}
