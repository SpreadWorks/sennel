/** Save-only canonical acceptance publication and execution claim. */
export class AcceptanceSettlementWriter {
  #flowManager; #binding; #commandResult; #publication; #executionBinding; #executionLifecycle; #nonblockingPublication;
  constructor({ flowManager, binding, commandResult = null, acceptancePublication = null,
    executionBinding = null, executionLifecycle = null, nonblockingPublication = null }) {
    this.#flowManager = flowManager; this.#binding = binding; this.#commandResult = commandResult;
    this.#publication = acceptancePublication; this.#executionBinding = executionBinding;
    this.#executionLifecycle = executionLifecycle; this.#nonblockingPublication = nonblockingPublication;
  }
  settle({ stepResult, settlement }) {
    return this.#flowManager.commitSpecStepResult({ binding: this.#binding, stepResult, settlement,
      commandResult: this.#commandResult, acceptancePublication: this.#publication,
      executionBinding: this.#executionBinding, executionLifecycle: this.#executionLifecycle, nonblockingPublication: this.#nonblockingPublication });
  }
}
