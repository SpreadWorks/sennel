import { DraftConditionalWorkerExecutionBinding, DraftStepExecutionLifecycle,
  DraftStepExecutionState } from "../definition.js";
import { ArtifactWorkerRecoveryReceipt } from "./artifact-worker-recovery-values.js";
import { FlowExecutionContractRefusal } from "./flow-execution-contract.js";
import { isConditionalDraftWorkerStep } from "./draft-conditional-worker.js";

/** Rebind the already selected conditional Result without changing its semantic frontier. */
export class DraftWorkerRecoveryCheckpoint {
  #binding;
  #identity;
  #executionBinding;
  #lifecycle;

  constructor({ binding, executionState, recovery, targetRequest, targetContentDigest }) {
    if (!(executionState instanceof DraftStepExecutionState)
      || !(recovery instanceof ArtifactWorkerRecoveryReceipt)) {
      throw new TypeError("Draft recovery checkpoint requires its typed execution state and authorization");
    }
    const { sourceContract, targetContract, evidence } = recovery;
    const source = executionState.lifecycle;
    const identity = executionState.executionIdentity();
    if (!isConditionalDraftWorkerStep(sourceContract.stepId) || identity === null
      || source?.phase !== "claimed" || !(source.binding instanceof DraftConditionalWorkerExecutionBinding)
      || source.claim.requestDigest !== evidence.requestDigest
      || source.claim.dispatchInvocationId !== evidence.sourceDispatchInvocationId
      || executionState.flowBinding.runId !== sourceContract.runId
      || executionState.flowBinding.specId !== sourceContract.specId
      || executionState.flowBinding.stepId !== sourceContract.stepId
      || executionState.flowBinding.attemptId !== sourceContract.attemptId
      || executionState.flowBinding.attemptSequence !== sourceContract.attemptSequence) {
      throw new FlowExecutionContractRefusal("Draft recovery authorization does not own the retained conditional claim");
    }
    sourceContract.assertExecutionBinding(binding, source.binding);
    targetContract.assertMatches(targetRequest.executionContract);
    evidence.inputContinuation?.assertContracts(sourceContract, targetContract);
    if (targetRequest.inputRevision !== targetContract.inputRevision
      || targetRequest.requestDigest !== evidence.targetRequestDigest
      || targetRequest.dispatchInvocationId !== evidence.targetDispatchInvocationId
      || targetContentDigest !== source.binding.contentDigest) {
      throw new FlowExecutionContractRefusal("Draft recovery replacement differs from its authorized request or checkpoint inputs");
    }
    this.#binding = binding;
    this.#identity = identity;
    this.#executionBinding = new DraftConditionalWorkerExecutionBinding({
      executionGeneration: targetContract.generation, inputDigest: targetRequest.inputDigest,
      inputRevision: targetContract.inputRevision, contentDigest: targetContentDigest,
    });
    targetContract.assertExecutionBinding(binding, this.#executionBinding);
    this.#lifecycle = DraftStepExecutionLifecycle.checkpoint(this.#executionBinding);
    Object.freeze(this);
  }

  get binding() { return this.#binding; }
  get stepResult() { return this.#identity.stepResult; }
  get settlement() { return this.#identity.settlement; }
  get executionBinding() { return this.#executionBinding; }
  get lifecycle() { return this.#lifecycle; }
}
