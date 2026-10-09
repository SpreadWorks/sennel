import { settleAcceptanceStepResult } from "../definition.js";
import { RetroInput } from "./retro-input.js";
import { AcceptanceSettlementWriter } from "./acceptance-settlement-writer.js";
export class RetroService {
  static argumentTypes = [RetroInput, AcceptanceSettlementWriter];
  #input;
  #writer;
  #outcome = null;
  constructor(input, writer) {
    if (!(input instanceof RetroInput) || !(writer instanceof AcceptanceSettlementWriter)) throw new TypeError("Retro requires typed input and save-only writer");
    this.#input = input; this.#writer = writer;
  }
  inspectInput() { return this.#input; }
  get settlementOutcome() { return this.#outcome; }
  persistStepResult(stepResult) {
    this.#outcome = this.#writer.settle({ stepResult, settlement: settleAcceptanceStepResult("retro", stepResult) });
    return this.#outcome.receipt;
  }
}
