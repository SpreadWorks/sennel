import { WorkerArtifactHandoffError } from "../lib/worker-artifact-handoff-error.js";
import { StepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";
import { CurrentFlowStateConflictError } from "../lib/current-flow-state-conflict-error.js";
import { isStepAdmissionRefusal } from "../lib/step-admission-refusal.js";

/** Apply the selected source settlement through the one canonical save operation. */
export class SourceStepSettlementWriter {
  #flowManager;
  #binding;
  #request;
  #preparation;
  #handoffCoordinator;
  constructor({ flowManager, binding, request = null, preparation = null, handoffCoordinator = null }) {
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#request = request;
    this.#preparation = preparation;
    this.#handoffCoordinator = handoffCoordinator;
  }
  settle({ stepResult, settlement, sourceSelection }) {
    if (this.#preparation !== null) {
      try { this.#handoffCoordinator.faultInjector({ phase: "before-worker-handoff-publication", stepId: this.#binding.stepId }); }
      catch (cause) {
        if (cause instanceof CurrentFlowStateConflictError) throw cause;
        throw new StepPersistenceFailure(cause);
      }
    }
    let committed;
    try {
      committed = this.#flowManager.commitSpecStepResult({
        binding: this.#binding, stepResult, settlement, sourceSelection,
        ...(this.#preparation === null ? {} : this.#preparation.publication),
      });
    } catch (cause) {
      if (this.#preparation === null) throw cause;
      const conflict = cause instanceof CurrentFlowStateConflictError
        || (isStepAdmissionRefusal(cause) && cause.cause instanceof CurrentFlowStateConflictError);
      const sourceDrift = cause instanceof WorkerArtifactHandoffError
        && cause.code === "FLOW_SOURCE_HANDOFF_MANIFEST_STALE";
      if (isStepAdmissionRefusal(cause) && !conflict && !sourceDrift) throw cause;
      throw new WorkerArtifactHandoffError(conflict ? "conflict" : "recovery-required",
        conflict ? "FLOW_ARTIFACT_HANDOFF_CONFLICT" : "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED",
        `canonical source worker handoff could not commit: ${cause.message}`, {
          cause, recoveryPossible: !conflict && cause?.code !== "CURRENT_FLOW_STATE_INVARIANT_INVALID"
            && cause?.code !== "FLOW_SOURCE_HANDOFF_MANIFEST_STALE",
          data: { stepId: this.#binding.stepId, handoffDirectory: this.#request.directory },
        });
    }
    if (this.#preparation === null) return committed;
    return this.#handoffCoordinator.completeSourceStepHandoff({ request: this.#request,
      preparation: this.#preparation, stepResult, receipt: committed.receipt });
  }
}
