import { STEP_RESULT_TYPE } from "../engine/step-result.js";
import { DraftCompletionConnector, DraftExecutionSettlement, DraftStepExecutionLifecycle } from "../definition.js";
import { createDraftCompletionSettlementApplication } from "../lib/draft-completion-connector.js";
import { isConditionalDraftWorkerStep } from "../lib/draft-conditional-worker.js";

/** Save the selected Draft Result against one exact binding. */
export class DraftSettlementWriter {
  #flowManager;
  #binding;
  #ctx;
  #request;
  #preparation;
  #executionBinding;
  #handoffCoordinator;
  #publicationRecovery;

  constructor({ flowManager, binding, ctx = null, request = null,
    preparation = null, handoffCoordinator = null, executionBinding = null,
    publicationRecovery = false }) {
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#ctx = ctx;
    this.#request = request;
    this.#preparation = preparation;
    this.#executionBinding = executionBinding;
    this.#handoffCoordinator = handoffCoordinator;
    this.#publicationRecovery = publicationRecovery;
  }

  async settle({ stepResult, settlement, draftCompletionApplication = null,
    awaitQuestion = null, repairCandidate = null }) {
    if (this.#preparation !== null) {
      const preparation = repairCandidate === null ? this.#preparation
        : this.#preparation.adoptRepairCandidate(repairCandidate);
      const completionApplication = draftCompletionApplication === null
        && settlement.connector === DraftCompletionConnector
        ? createDraftCompletionSettlementApplication(preparation.publications?.draftCoverageRepairFacts)
        : draftCompletionApplication;
      const input = { ctx: this.#ctx, request: this.#request, preparation,
        binding: this.#binding, stepResult, settlement,
        draftCompletionApplication: completionApplication };
      const failed = stepResult.type === STEP_RESULT_TYPE.ERROR;
      return { error: null, ...(failed && isConditionalDraftWorkerStep(this.#binding.stepId)
        && this.#publicationRecovery
        ? this.#handoffCoordinator.completePublishedDraftWorker(input)
        : failed ? this.#handoffCoordinator.commitDraftWorkerError(input)
          : this.#handoffCoordinator.commitDraftWorker(input)) };
    }
    const input = { binding: this.#binding, stepResult, settlement,
      draftCompletionApplication, awaitQuestion };
    if (settlement instanceof DraftExecutionSettlement) {
      input.executionLifecycle = DraftStepExecutionLifecycle.checkpoint(this.#executionBinding);
    }
    if (settlement instanceof DraftExecutionSettlement) {
      return this.#flowManager.commitDraftStepCheckpoint({
        binding: this.#binding, stepResult, settlement,
        executionBinding: this.#executionBinding,
      });
    }
    return this.#flowManager.commitDraftStepResult(input);
  }
}
