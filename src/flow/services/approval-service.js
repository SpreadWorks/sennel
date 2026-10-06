import { StepResult } from "../engine/step-result.js";
import { settleRequirementTestStepResult } from "../definition.js";
import { ApprovalInput } from "./approval-input.js";
import { ApprovalSettlementWriter } from "./approval-settlement-writer.js";

/** Supply canonical approval input and save its single Definition-selected settlement. */
export class ApprovalService {
  static argumentTypes = [ApprovalInput, ApprovalSettlementWriter];
  #input;
  #writer;
  #outcome = null;

  constructor(input, writer) {
    if (!(input instanceof ApprovalInput) || !(writer instanceof ApprovalSettlementWriter)) throw new TypeError("ApprovalService requires typed input and settlement writer");
    this.#input = input;
    this.#writer = writer;
  }
  inspectInput() { return this.#input; }
  persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== "approval") throw new TypeError("Approval Service requires its bound Step Result");
    const settlement = settleRequirementTestStepResult("approval", stepResult);
    this.#outcome = this.#writer.settle({ stepResult, settlement, evidence: this.#input.evidence });
    return this.#outcome.receipt;
  }
  get settlementOutcome() { return this.#outcome; }
}
