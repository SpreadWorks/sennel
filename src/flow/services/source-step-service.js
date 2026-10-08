import { StepResult, StepErrorResult } from "../engine/step-result.js";
import { settleImplStepResult, settleTaskStepResult } from "../definition.js";
import { SourceStepSelection } from "../lib/source-effect-values.js";
import { SourceStepInput } from "./source-step-input.js";
import { SourceStepSettlementWriter } from "./source-step-settlement-writer.js";

/** Keep one adopted source candidate bound to its exact semantic Result. */
export class SourceStepService {
  static argumentTypes = [SourceStepInput, SourceStepSettlementWriter];
  #input;
  #writer;
  #selection = null;
  #outcome = null;
  constructor(input, writer) {
    if (!(input instanceof SourceStepInput) || !(writer instanceof SourceStepSettlementWriter)) {
      throw new TypeError("Source service requires its typed input and settlement writer");
    }
    this.#input = input;
    this.#writer = writer;
  }
  inspectSourceCompletion() { return this.#input.facts; }
  adoptSourceSelection(facts, selection) {
    if (facts !== this.#input.facts || !(selection instanceof SourceStepSelection)
      || selection.facts !== facts || selection.result.stepId !== facts.stepId) {
      throw new TypeError("Source selection does not bind its acquired facts");
    }
    this.#selection = selection;
  }
  persistStepResult(stepResult) {
    const stepId = this.#input.facts.stepId;
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== stepId
      || (!(stepResult instanceof StepErrorResult) && this.#selection?.result !== stepResult)) {
      throw new TypeError("Source persistence requires its Step-selected Result");
    }
    const settlement = stepId.startsWith("task-")
      ? settleTaskStepResult(stepId, stepResult) : settleImplStepResult(stepId, stepResult);
    this.#outcome = this.#writer.settle({ stepResult, settlement, sourceSelection: this.#selection });
    return this.#outcome.receipt;
  }
  get settlementOutcome() { return this.#outcome; }
}
