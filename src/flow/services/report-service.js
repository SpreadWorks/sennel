import { settleAcceptanceStepResult } from "../definition.js";
import { StepResult } from "../engine/step-result.js";
import { ReportInput } from "./report-input.js";
import { AcceptanceSettlementWriter } from "./acceptance-settlement-writer.js";
export class ReportService {
  static argumentTypes = [ReportInput, AcceptanceSettlementWriter];
  #input;
  #writer;
  #outcome = null;
  constructor(input, writer) {
    if (!(input instanceof ReportInput) || !(writer instanceof AcceptanceSettlementWriter)) throw new TypeError("ReportService requires typed input and a save-only writer");
    this.#input = input;
    this.#writer = writer;
  }
  inspectInput() { return this.#input; }
  get settlementOutcome() { return this.#outcome; }
  persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) throw new TypeError("ReportService requires its bound Result");
    this.#outcome = this.#writer.settle({ stepResult, settlement: settleAcceptanceStepResult(this.#input.stepId, stepResult) });
    return this.#outcome.receipt;
  }
}
