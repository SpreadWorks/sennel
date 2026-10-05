import { DraftStepExecutionLifecycle } from "../definition.js";

/** Save the selected Spec Review Result with its exact Attempt binding. */
export class SpecReviewSettlementWriter {
  #flowManager;
  #binding;
  #executionBinding;

  constructor({ flowManager, binding, executionBinding = null }) {
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#executionBinding = executionBinding;
  }

  settle({ stepResult, settlement }) {
    const input = { binding: this.#binding, stepResult, settlement,
      ...(this.#executionBinding === null ? {} : {
        executionLifecycle: DraftStepExecutionLifecycle.checkpoint(this.#executionBinding),
      }) };
    const committed = this.#executionBinding === null
      ? this.#flowManager.commitSpecStepResult(input)
      : this.#flowManager.commitDraftStepCheckpoint({ binding: this.#binding,
          stepResult, settlement, executionBinding: this.#executionBinding });
    return committed.receipt;
  }
}
