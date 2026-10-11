import { settleFinalizationStepResult } from "../definition.js";
import { StepResult } from "../engine/step-result.js";

/** Shared save procedure; acquisition and semantic selection remain outside. */
export class FinalizationStepService {
  #input;
  #writer;
  #outcome = null;
  constructor(input, writer) {
    if (new.target === FinalizationStepService) throw new TypeError("FinalizationService requires a concrete operation");
    this.#input = input;
    this.#writer = writer;
  }
  inspectInput() { return this.#input; }
  get settlementOutcome() { return this.#outcome; }
  persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) {
      throw new TypeError("FinalizationService requires its bound Result");
    }
    const outcome = this.#writer.settle({ stepResult,
      settlement: settleFinalizationStepResult(this.#input.stepId, stepResult) });
    if (outcome instanceof Promise) {
      return outcome.then((saved) => { this.#outcome = saved; return saved.receipt; });
    }
    this.#outcome = outcome;
    return outcome.receipt;
  }
}
