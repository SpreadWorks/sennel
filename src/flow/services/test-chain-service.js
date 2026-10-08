import { settleImplStepResult } from "../definition.js";
import { StepResult } from "../engine/step-result.js";
import { TestChainInput } from "./test-chain-input.js";
import { TestChainSettlementWriter } from "./test-chain-settlement-writer.js";

export class TestChainSettlementOutcome {
  constructor({ stepResult, state, receipt }) {
    if (!(stepResult instanceof StepResult) || receipt.resultKind !== stepResult.kind) {
      throw new TypeError("Test-chain outcome requires its saved Result and receipt");
    }
    this.stepResult = stepResult;
    this.state = state;
    this.receipt = receipt;
    Object.freeze(this);
  }
}

export class TestChainService {
  static argumentTypes = [TestChainInput, TestChainSettlementWriter];
  #input;
  #writer;
  #outcome = null;

  constructor(input, writer) {
    if (!(input instanceof TestChainInput) || !(writer instanceof TestChainSettlementWriter)) throw new TypeError("Test chain Service requires acquired input and save-only writer");
    this.#input = input;
    this.#writer = writer;
  }

  inspectInput() { return this.#input; }
  get settlementOutcome() { return this.#outcome; }

  persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) throw new TypeError("Test chain Service requires its bound Result");
    const saved = this.#writer.settle({ stepResult, settlement: settleImplStepResult(this.#input.stepId, stepResult) });
    this.#outcome = new TestChainSettlementOutcome({ stepResult, state: saved.state, receipt: saved.receipt });
    return this.#outcome.receipt;
  }
}
