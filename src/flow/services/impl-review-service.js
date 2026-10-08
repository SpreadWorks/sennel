import { settleImplStepResult } from "../definition.js";
import { StepResult } from "../engine/step-result.js";
import { ImplReviewInput } from "./impl-review-input.js";
import { ImplReviewGateSettlementWriter } from "./impl-review-gate-settlement-writer.js";
export class ImplReviewService {
  static argumentTypes = [ImplReviewInput, ImplReviewGateSettlementWriter];
  #input;
  #writer;
  #outcome = null;
  constructor(input, writer) {
    if (!(input instanceof ImplReviewInput) || !(writer instanceof ImplReviewGateSettlementWriter)) throw new TypeError("Implementation Review requires typed input and writer");
    this.#input = input; this.#writer = writer;
  }
  inspectInput() { return this.#input; }
  get settlementOutcome() { return this.#outcome; }
  persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) throw new TypeError("Implementation Review requires its Result");
    this.#outcome = this.#writer.settle({ stepResult, settlement: settleImplStepResult(this.#input.stepId, stepResult) });
    return this.#outcome.receipt;
  }
}
