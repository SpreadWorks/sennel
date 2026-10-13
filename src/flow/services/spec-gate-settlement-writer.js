import { SpecGateSettlementPublication } from "../lib/spec-gate-prospective.js";
import { StepPersistenceFailure } from "../lib/step-persistence-failure.js";
/** Save a selected Spec Gate Result and its prospective evidence. */
export class SpecGateSettlementWriter {
  #executionContract;
  #flowManager;
  #binding;
  #commandResult;
  #publication;

  constructor({ flowManager, executionContract = null, binding, commandResult, publication }) {
    this.#executionContract = executionContract;
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#commandResult = commandResult;
    this.#publication = publication;
  }

  settle({ stepResult, settlement, selection }) {
    const input = { binding: this.#binding, stepResult, settlement, executionContract: this.#executionContract,
      commandResult: this.#commandResult,
      gatePublication: new SpecGateSettlementPublication({
        publication: this.#publication, selection,
      }) };
    try {
      return this.#flowManager.commitSpecStepResult(input).receipt;
    } catch (error) {
      throw error instanceof StepPersistenceFailure ? error : new StepPersistenceFailure(error);
    }
  }
}
