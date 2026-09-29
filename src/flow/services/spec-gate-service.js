import { StepResult } from "../engine/step-result.js";
import { settleSpecStepResult } from "../definition.js";
import { SpecGateResultSelection } from "../lib/spec-gate-result-selection.js";
import { SpecGateInput } from "./spec-gate-input.js";
import { SpecGateSettlementWriter } from "./spec-gate-settlement-writer.js";

/** Select a Result from prepared Spec Gate facts and save its publication. */
export class SpecGateService {
  static argumentTypes = [SpecGateInput, SpecGateSettlementWriter];
  #input;
  #writer;
  #selection = null;

  constructor(input, writer) {
    if (!(input instanceof SpecGateInput) || !(writer instanceof SpecGateSettlementWriter)) {
      throw new TypeError("SpecGateService requires a typed Gate input and settlement writer");
    }
    this.#input = input;
    this.#writer = writer;
  }

  assertGateResultAdmission() { return this.#input.facts; }
  inspectGateFacts() { return this.#input.facts; }

  acceptGateResultSelection(selection) {
    if (!(selection instanceof SpecGateResultSelection)
      || selection.facts !== this.#input.facts) {
      throw new TypeError("Spec Gate Service requires the Step selection for its exact publication");
    }
    if (this.#selection !== null) this.#selection.assertResult(selection.result);
    this.#selection = selection;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) {
      throw new TypeError("SpecGateService requires its bound Result");
    }
    if (this.#selection === null) throw new TypeError("Spec Gate Result requires a sealed Step selection");
    this.#selection.assertResult(stepResult);
    return this.#writer.settle({ stepResult,
      settlement: settleSpecStepResult(this.#input.stepId, stepResult),
      selection: this.#selection });
  }
}
