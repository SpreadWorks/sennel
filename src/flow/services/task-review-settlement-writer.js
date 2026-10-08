/** Save the selected Task Result and its already acquired publication together. */
export class TaskReviewSettlementWriter {
  #flowManager;
  #binding;
  #publication;
  #executionBinding;
  #manifest;
  #failurePublication;

  constructor({ flowManager, binding, publication = null, executionBinding = null, manifest = null, failurePublication = null }) {
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#publication = publication;
    this.#executionBinding = executionBinding;
    this.#manifest = manifest;
    this.#failurePublication = failurePublication;
  }

  settle({ stepResult, settlement }) {
    return this.#flowManager.commitSpecStepResult({
      binding: this.#binding, stepResult, settlement,
      ...(this.#publication?.commandResult == null ? {} : { commandResult: this.#publication.commandResult }),
      ...(this.#failurePublication === null ? {} : { reviewFailurePublication: this.#failurePublication }),
      ...(this.#publication === null ? {} : { taskStagePublication: this.#publication }),
      ...(this.#executionBinding === null ? {} : { executionBinding: this.#executionBinding }),
      ...(this.#manifest === null ? {} : { manifest: this.#manifest }),
    });
  }
}
