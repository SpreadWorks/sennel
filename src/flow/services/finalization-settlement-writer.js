/** Save-only boundary for acquired finalization evidence and the selected Result. */
export class FinalizationSettlementWriter {
  #flowManager; #binding; #evidence; #commandResult; #publication; #executionBinding; #executionLifecycle; #operationOwnerToken;
  constructor({ flowManager, binding, evidence, commandResult = null, finalizationPublication = null,
    executionBinding = null, executionLifecycle = null, operationOwnerToken = null }) {
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#evidence = evidence;
    this.#commandResult = commandResult;
    this.#publication = finalizationPublication;
    this.#executionBinding = executionBinding;
    this.#executionLifecycle = executionLifecycle;
    this.#operationOwnerToken = operationOwnerToken;
  }
  settle({ stepResult, settlement }) {
    return this.#flowManager.commitSpecStepResult({ binding: this.#binding, evidence: this.#evidence, stepResult, settlement,
      commandResult: this.#commandResult, finalizationPublication: this.#publication,
      executionBinding: this.#executionBinding, executionLifecycle: this.#executionLifecycle, operationOwnerToken: this.#operationOwnerToken });
  }
}
