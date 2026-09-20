import { Step } from "../../engine/step.js";
import {
  DraftGateCarryForwardResult,
  DraftGatePassedResult,
  DraftGateRepairRequiredResult,
  DraftStepErrorResult,
} from "../../engine/step-result.js";
import { GateService } from "../../services/review-service.js";
import { isDraftStepPersistenceFailure } from "../../lib/definition-lifecycle-failure.js";

/**
 * Evaluate the completed Draft and produce the Gate result.
 * The existing Gate command evaluates and publishes the bound Attempt.
 */
export class DraftGateStep extends Step {
  static dependencies = [GateService];

  #gateService;

  constructor(gateService) {
    super();
    if (!(gateService instanceof GateService)) throw new TypeError("GateService is required");
    this.#gateService = gateService;
  }

  async _execute() {
    try {
      const facts = this.#gateService.inspectGateFacts();
      let result;
      if (facts.result === "pass") {
        result = new DraftGatePassedResult();
      } else if (facts.failureCategory !== "semantic") {
        throw new Error("Draft Gate observation cannot be settled as a semantic Result");
      } else if (facts.sameEvidence || facts.retryExhausted) {
        result = new DraftGateCarryForwardResult();
      } else {
        result = new DraftGateRepairRequiredResult();
      }
      await result.persist(this.#gateService);
      return result;
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      const result = new DraftStepErrorResult("draft-gate", error);
      await result.persist(this.#gateService);
      return result;
    }
  }
}
