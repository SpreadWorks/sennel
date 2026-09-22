import { requiresWorkerArtifactHandoff } from "../../../lib/flow-artifact-authority.js";
import { WorkerArtifactHandoffRequest } from "../../../lib/worker-artifact-handoff.js";
import { StepBinding, canonicalStepState } from "../../step-binding.js";

/** Binds the initial Spec worker publication to its exact active Attempt. */
export class SpecWorkerStepBinding extends StepBinding {
  constructor({ request } = {}) {
    if (!(request instanceof WorkerArtifactHandoffRequest)
      || request.stepId !== "spec"
      || !requiresWorkerArtifactHandoff(request.stepId)) {
      throw new TypeError("Spec worker binding requires the spec handoff request");
    }
    const state = canonicalStepState(request.flowManager, request.specId);
    super({ flowManager: request.flowManager, state, stepId: request.stepId, attempt: state.attempt });
    this.request = request;
    Object.freeze(this);
  }

  assertCurrent() {
    const state = super.assertCurrent();
    this.request.assertCurrent(this.flowManager.loadReadOnly(this.specId));
    return state;
  }
}
