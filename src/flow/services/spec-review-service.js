import { DraftExecutionSettlement, settleSpecStepResult } from "../definition.js";
import { StepResult } from "../engine/step-result.js";
import { SpecReviewInput } from "./spec-review-input.js";
import { SpecReviewSettlementWriter } from "./spec-review-settlement-writer.js";

/** Save the Result selected from one prepared Spec Review input. */
export class SpecReviewService {
  static argumentTypes = [SpecReviewInput, SpecReviewSettlementWriter];
  #input;
  #writer;

  constructor(input, writer) {
    if (!(input instanceof SpecReviewInput) || !(writer instanceof SpecReviewSettlementWriter)) {
      throw new TypeError("SpecReviewService requires a typed input and settlement writer");
    }
    this.#input = input;
    this.#writer = writer;
  }

  inspectReview() {
    return this.#input.executionBinding === null ? this.#input.review : this.#input.manifest;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) {
      throw new TypeError("SpecReviewService requires its Step Result");
    }
    const settlement = settleSpecStepResult(this.#input.stepId, stepResult);
    if (this.#input.executionBinding !== null && !(settlement instanceof DraftExecutionSettlement)) {
      throw new TypeError("Spec Review execution requires its Execution settlement");
    }
    return this.#writer.settle({ stepResult, settlement });
  }
}
