/** Save-only access to the canonical test-chain publication transaction. */
export class TestChainSettlementWriter {
  #flowManager;
  #binding;
  #commandResult;
  #publication;
  #nonblockingPublication;

  constructor({ flowManager, binding, commandResult = null, testChainPublication = null, nonblockingPublication = null }) {
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#commandResult = commandResult;
    this.#publication = testChainPublication;
    this.#nonblockingPublication = nonblockingPublication;
  }

  settle({ stepResult, settlement }) {
    return this.#flowManager.commitSpecStepResult({ binding: this.#binding, stepResult, settlement,
      commandResult: this.#commandResult, testChainPublication: this.#publication,
      nonblockingPublication: this.#nonblockingPublication });
  }
}
