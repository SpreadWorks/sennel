import { requiresWorkerArtifactHandoff } from "../../../lib/flow-artifact-authority.js";
import { WorkerArtifactHandoffRequest } from "../../../lib/worker-artifact-handoff.js";
import { StepBinding, canonicalStepState } from "../../step-binding.js";
import { SpecRevisionIdentity } from "../../../lib/spec-review-artifacts.js";

/** Binds a Spec worker publication to its exact active Attempt. */
export class SpecWorkerStepBinding extends StepBinding {
  constructor({ request } = {}) {
    if (!(request instanceof WorkerArtifactHandoffRequest)
      || !["spec", "spec-triage", "spec-repair"].includes(request.stepId)
      || !requiresWorkerArtifactHandoff(request.stepId)) {
      throw new TypeError("Spec worker binding requires a Spec handoff request");
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

/** Binds Spec Review execution or settlement to its revision and active Attempt. */
export class SpecReviewStepBinding extends StepBinding {
  constructor({ flowManager, specId } = {}) {
    const state = canonicalStepState(flowManager, specId);
    if (state.current?.at(-1) !== "spec-review" || state.attempt?.failure !== null) {
      throw new Error("Spec Review requires its active Attempt");
    }
    super({ flowManager, state, stepId: "spec-review", attempt: state.attempt });
    const source = flowManager.readCurrentSpecReviewInput({ specId, consumerNodeId: "spec-review" });
    this.revision = new SpecRevisionIdentity(source.review.identity.toJSON());
    Object.freeze(this);
  }

  assertCurrent() {
    const state = super.assertCurrent();
    const source = this.flowManager.readCurrentSpecReviewInput({
      specId: this.specId, consumerNodeId: "spec-review",
    });
    if (!this.revision.equals(source.review.identity)) {
      throw new Error("Spec Review binding is stale for the canonical Spec revision");
    }
    return state;
  }
}

/** Binds a prospective Spec Gate result to the active producer Attempt. */
export class SpecGateEvaluationBinding extends StepBinding {
  constructor({ flowManager, specId } = {}) {
    const state = canonicalStepState(flowManager, specId);
    if (state.current?.at(-1) !== "spec-gate" || state.attempt?.nodeId !== "spec-gate"
      || state.attempt.failure !== null) {
      throw new Error("Spec Gate evaluation requires its active Attempt");
    }
    super({ flowManager, state, stepId: "spec-gate", attempt: state.attempt });
    Object.freeze(this);
  }
}
