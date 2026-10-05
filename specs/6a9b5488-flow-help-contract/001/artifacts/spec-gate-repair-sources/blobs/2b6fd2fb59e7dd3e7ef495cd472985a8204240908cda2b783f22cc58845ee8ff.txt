import { Step } from "../../engine/step.js";
import {
  DraftGateCarryForwardResult,
  DraftGatePassedResult,
  DraftGateRepairRequiredResult,
  StepErrorResult,
} from "../../engine/step-result.js";
import { GateService } from "../../services/review-service.js";
import { DraftGateProspectiveFacts } from "../../lib/draft-gate-prospective.js";

/** Pure mapping from one validated prospective Gate observation to its semantic Result. */
export function draftGateResult(facts) {
  if (facts instanceof Error) return new StepErrorResult("draft-gate", facts);
  if (!(facts instanceof DraftGateProspectiveFacts)) {
    throw new TypeError("Draft Gate Result requires typed prospective facts");
  }
  if (facts.result === "pass") return new DraftGatePassedResult();
  if (facts.failureCategory !== "semantic") {
    const error = new Error(facts.failureReason
      ?? "Draft Gate observation cannot be settled as a semantic Result");
    if (facts.failureCode !== null) error.code = facts.failureCode;
    error.data = {
      ...(facts.failureMode === null ? {} : { failureMode: facts.failureMode }),
      ...(facts.responseProtocolEvidence === null ? {} : {
        responseProtocolEvidence: facts.responseProtocolEvidence.toJSON(),
      }),
    };
    return new StepErrorResult("draft-gate", error);
  }
  if (facts.sameEvidence || facts.retryExhausted) return new DraftGateCarryForwardResult();
  return new DraftGateRepairRequiredResult();
}

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
    this.#gateService.assertGateResultAdmission();
    let result;
    try {
      result = draftGateResult(this.#gateService.inspectGateFacts());
    } catch (error) {
      result = draftGateResult(error);
    }
    await result.persist(this.#gateService);
    return result;
  }
}
