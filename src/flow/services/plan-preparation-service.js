import { StepResult } from "../engine/step-result.js";
import { settlePrepareStepResult } from "../definition.js";
import { PlanPreparationInput } from "./plan-preparation-input.js";
import { PlanPreparationSettlementWriter } from "./plan-preparation-settlement-writer.js";

/** Provide acquired preparation facts and save the Step-selected Result. */
export class PlanPreparationService {
  static argumentTypes = [PlanPreparationInput, PlanPreparationSettlementWriter];
  #input;
  #writer;
  #outcome = null;

  constructor(input, writer) {
    if (!(input instanceof PlanPreparationInput) || !(writer instanceof PlanPreparationSettlementWriter)) {
      throw new TypeError("PlanPreparationService requires a typed input and settlement writer");
    }
    this.#input = input;
    this.#writer = writer;
  }

  inspectPreparation() { return this.#input.preparation; }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) {
      throw new TypeError("PlanPreparationService requires its bound Step Result");
    }
    const settlement = settlePrepareStepResult(this.#input.stepId, stepResult);
    this.#outcome = await this.#writer.settle({
      stepResult, settlement, preparation: this.#input.preparation,
    });
    return this.#outcome.receipt;
  }

  get preparationOutcome() { return this.#outcome; }
}
