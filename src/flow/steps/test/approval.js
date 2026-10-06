import { Step } from "../../engine/step.js";
import {
  ApprovalAwaitingUserResult, ApprovalConfirmedWithTestsResult,
  ApprovalConfirmedWithoutTestsResult, StepErrorResult,
} from "../../engine/step-result.js";
import { ApprovalService } from "../../services/approval-service.js";

/** Interpret acquired approval evidence and persist its selected Result before returning. */
export class ApprovalStep extends Step {
  static dependencies = [ApprovalService];
  #service;
  constructor(service) {
    super();
    if (!(service instanceof ApprovalService)) throw new TypeError("ApprovalStep requires ApprovalService");
    this.#service = service;
  }
  async _execute() {
    const input = this.#service.inspectInput();
    const result = input.error !== null ? new StepErrorResult("approval", input.error, { evidence: input.evidence })
      : !input.evidence.approved ? new ApprovalAwaitingUserResult({ evidence: input.evidence })
        : input.evidence.testsRequired ? new ApprovalConfirmedWithTestsResult({ evidence: input.evidence })
          : new ApprovalConfirmedWithoutTestsResult({ evidence: input.evidence });
    await result.persist(this.#service);
    return result;
  }
}
