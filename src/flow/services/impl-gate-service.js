import { settleImplStepResult } from "../definition.js";
import { StepResult } from "../engine/step-result.js";
import { ImplGateInput } from "./impl-gate-input.js";
import { ImplReviewGateSettlementWriter } from "./impl-review-gate-settlement-writer.js";
export class ImplGateService {
  static argumentTypes = [ImplGateInput, ImplReviewGateSettlementWriter];
  #input;
  #writer;
  #outcome = null;
  #settlement = null;
  constructor(input, writer) {
    if (!(input instanceof ImplGateInput) || !(writer instanceof ImplReviewGateSettlementWriter)) throw new TypeError("Implementation Gate requires typed input and writer");
    this.#input = input; this.#writer = writer;
  }
  inspectInput() { return this.#input; }
  get settlementOutcome() { return this.#outcome; }
  get selectedSettlement() { return this.#settlement; }
  persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) throw new TypeError("Implementation Gate requires its Result");
    this.#settlement = settleImplStepResult(this.#input.stepId, stepResult);
    this.#outcome = this.#writer.settle({ stepResult, settlement: this.#settlement });
    return this.#outcome.receipt;
  }
}
