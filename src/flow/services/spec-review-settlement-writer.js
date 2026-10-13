import { DraftStepExecutionLifecycle } from "../definition.js";

/** Save the selected Spec Review Result with its exact Attempt binding. */
export class SpecReviewSettlementWriter {
  #executionContract;
  #flowManager;
  #binding;
  #executionBinding;

  constructor({ flowManager, executionContract = null, binding, executionBinding = null }) {
    this.#executionContract = executionContract;
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#executionBinding = executionBinding;
  }

  settle({ stepResult, settlement }) {
    const input = { binding: this.#binding, stepResult, settlement, executionContract: this.#executionContract,
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
