/** Save a Draft Gate publication chosen by the Step and Definition. */
export class DraftGateSettlementWriter {
  #executionContract;
  #flowManager;
  #binding;
  #commandResult;

  constructor({ flowManager, executionContract = null, binding, commandResult }) {
    this.#executionContract = executionContract;
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#commandResult = commandResult;
  }

  async settle({ stepResult, settlement, gatePublication }) {
    const input = { binding: this.#binding, stepResult, settlement, executionContract: this.#executionContract,
      commandResult: this.#commandResult, gatePublication };
    return (await this.#flowManager.commitDraftStepResult(input)).receipt;
  }
}
