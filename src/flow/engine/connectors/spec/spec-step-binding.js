import { requiresWorkerArtifactHandoff } from "../../../lib/flow-artifact-authority.js";
import { WorkerArtifactHandoffRequest } from "../../../lib/worker-artifact-handoff.js";
import { StepBinding, canonicalStepState } from "../../step-binding.js";
import { SpecRevisionIdentity } from "../../../lib/spec-review-artifacts.js";
import { CurrentFlowStateConflictError } from "../../../lib/current-flow-state.js";
import { createHash } from "node:crypto";

/** Binds a Spec worker publication to its exact active Attempt. */
export class SpecWorkerStepBinding extends StepBinding {
  constructor({ request = null, flowManager = null, specId = null, revision = null } = {}) {
    if (request !== null && (flowManager !== null || specId !== null || revision !== null)) {
      throw new TypeError("Spec worker binding accepts one authority source");
    }
    if (request !== null && (!(request instanceof WorkerArtifactHandoffRequest)
      || !["spec", "spec-triage", "spec-repair", "spec-gate-repair"].includes(request.stepId)
      || !requiresWorkerArtifactHandoff(request.stepId))
      || request === null && (typeof revision !== "string" || !revision.startsWith("sha256:"))) {
      throw new TypeError("Spec worker binding requires a Spec handoff request");
    }
    const selectedManager = request?.flowManager ?? flowManager;
    const selectedSpecId = request?.specId ?? specId;
    const state = canonicalStepState(selectedManager, selectedSpecId);
    super({ flowManager: selectedManager, state, stepId: request?.stepId ?? "spec-gate-repair", attempt: state.attempt });
    this.request = request;
    this.revision = request === null ? revision : request.inputs.find((entry) => (
      entry.name === "spec-gate-repair-context.json"
    ))?.document?.baseRevision;
    Object.freeze(this);
  }

  assertCurrent() {
    const state = super.assertCurrent();
    if (this.stepId === "spec-gate-repair") {
      const spec = this.flowManager.readArtifact({ specId: this.specId,
        logicalKey: "spec.record", consumerNodeId: this.stepId });
      if (this.revision !== `sha256:${createHash("sha256").update(spec.bytes).digest("hex")}`) {
        throw new CurrentFlowStateConflictError("Spec Gate repair handoff is stale for the canonical Spec revision");
      }
    } else {
      this.request.assertCurrent(this.flowManager.loadReadOnly(this.specId));
    }
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
      throw new CurrentFlowStateConflictError("Spec Review binding is stale for the canonical Spec revision");
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
