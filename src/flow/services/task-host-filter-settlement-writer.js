/** Save the selected Task Result and its already acquired publication together. */
export class TaskHostFilterSettlementWriter {
  #flowManager;
  #binding;
  #publication;
  #executionBinding;

  constructor({ flowManager, binding, publication = null, executionBinding = null }) {
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#publication = publication;
    this.#executionBinding = executionBinding;
  }

  settle({ stepResult, settlement }) {
    return this.#flowManager.commitSpecStepResult({
      binding: this.#binding, stepResult, settlement,
      ...(this.#publication === null ? {} : { taskStagePublication: this.#publication }),
      ...(this.#executionBinding === null ? {} : { executionBinding: this.#executionBinding }),
    });
  }
}
