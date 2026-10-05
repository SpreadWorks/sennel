/** Save a Draft Gate publication chosen by the Step and Definition. */
export class DraftGateSettlementWriter {
  #flowManager;
  #binding;
  #commandResult;

  constructor({ flowManager, binding, commandResult }) {
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#commandResult = commandResult;
  }

  async settle({ stepResult, settlement, gatePublication }) {
    const input = { binding: this.#binding, stepResult, settlement,
      commandResult: this.#commandResult, gatePublication };
    return (await this.#flowManager.commitDraftStepResult(input)).receipt;
  }
}
