import { StepConnector } from "../../step-connector.js";

/** Connects a validated initial Spec publication to its first review. */
export class SpecReviewConnector extends StepConnector {
  constructor({ binding, facts } = {}) {
    super();
    this.binding = binding;
    this.facts = facts;
  }

  async connect() {
    const [{ SpecWorkerStepBinding }, {
      SpecReviewSettlementApplication,
      SpecWorkerCompletionFacts,
    }] = await Promise.all([
      import("./spec-step-binding.js"),
      import("../../../lib/spec-step-connection.js"),
    ]);
    if (!(this.binding instanceof SpecWorkerStepBinding)
      || !(this.facts instanceof SpecWorkerCompletionFacts)) {
      throw new TypeError("Spec review connector requires typed worker facts");
    }
    this.binding.assertCurrent();
    return new SpecReviewSettlementApplication({ binding: this.binding, facts: this.facts });
  }
}
