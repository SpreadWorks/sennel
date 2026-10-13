import { DraftStepExecutionLifecycle, DraftExecutionSettlement } from "../definition.js";

/** Save only the Step-selected Draft Review Result. */
export class DraftReviewSettlementWriter {
  #executionContract;
  #flowManager;
  #binding;
  #commandResult;
  #executionBinding;
  #publicationResult;

  constructor({ flowManager, executionContract = null, binding, commandResult = null,
    executionBinding = null, publicationResult = null }) {
    this.#executionContract = executionContract;
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#commandResult = commandResult;
    this.#executionBinding = executionBinding;
    this.#publicationResult = publicationResult;
  }

  async settle({ stepResult, settlement, draftCompletionApplication }) {
    const execution = this.#executionBinding !== null || this.#publicationResult !== null;
    const input = { binding: this.#binding, stepResult, settlement, executionContract: this.#executionContract,
      draftCompletionApplication,
      commandResult: execution ? this.#publicationResult ?? undefined
        : stepResult.error === null ? this.#commandResult : undefined,
      ...(this.#executionBinding === null ? {} : {
        executionLifecycle: DraftStepExecutionLifecycle.checkpoint(this.#executionBinding),
      }) };
    const committed = execution && this.#executionBinding !== null
      ? this.#flowManager.commitDraftStepCheckpoint({
            binding: this.#binding, stepResult, settlement,
            executionBinding: this.#executionBinding,
          })
      : await this.#flowManager.commitDraftStepResult(input);
    return committed.receipt;
  }
}
