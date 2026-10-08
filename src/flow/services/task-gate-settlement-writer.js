/** Save Task Gate evaluation, Result and selected effects in one canonical commit. */
export class TaskGateSettlementWriter {
  #flowManager;
  #binding;
  #publication;
  #executionBinding;
  #commandResult;
  #deferralPublication;
  #nonblockingPublication;

  constructor({ flowManager, binding, publication = null, executionBinding = null, commandResult = null, gateDeferralPublication = null, nonblockingPublication = null }) {
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#publication = publication;
    this.#executionBinding = executionBinding;
    this.#commandResult = commandResult;
    this.#deferralPublication = gateDeferralPublication;
    this.#nonblockingPublication = nonblockingPublication;
  }

  settle({ stepResult, settlement }) {
    return this.#flowManager.commitSpecStepResult({ binding: this.#binding, stepResult, settlement,
      commandResult: this.#commandResult,
      gateDeferralPublication: this.#deferralPublication,
      nonblockingPublication: this.#nonblockingPublication,
      ...(this.#publication === null ? {} : { gatePublication: this.#publication }),
      ...(this.#executionBinding === null ? {} : { executionBinding: this.#executionBinding }),
    });
  }
}
