import { SpecGateSettlementPublication } from "../lib/spec-gate-prospective.js";
import { StepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";
/** Save a selected Spec Gate Result and its prospective evidence. */
export class SpecGateSettlementWriter {
  #flowManager;
  #binding;
  #commandResult;
  #publication;

  constructor({ flowManager, binding, commandResult, publication }) {
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#commandResult = commandResult;
    this.#publication = publication;
  }

  settle({ stepResult, settlement, selection }) {
    const input = { binding: this.#binding, stepResult, settlement,
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
