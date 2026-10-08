import { DraftReviewExecutionBinding, ReviewProviderRequestIdentity } from "../definition.js";
import { SpecReviewStepBinding } from "../engine/connectors/spec/spec-step-binding.js";
import { StepBinding } from "../engine/step-binding.js";
import { StepResult, SpecReviewExecutionRequiredResult } from "../engine/step-result.js";

export class ReviewExecutionAdmission {
  constructor({ request, recoveredClaim }) {
    if (!(request instanceof ReviewProviderRequestIdentity) || typeof recoveredClaim !== "boolean") {
      throw new TypeError("Review execution admission requires its request and claim status");
    }
    this.request = request;
    this.recoveredClaim = recoveredClaim;
    Object.freeze(this);
  }
}

export class ReviewExecutionClaimPreparation {
  constructor({ flowManager, binding, executionBinding, request, recoveredClaim, needsCheckpoint, ResultClass }) {
    if (!(binding instanceof StepBinding) || binding.flowManager !== flowManager
      || !(executionBinding instanceof DraftReviewExecutionBinding)
      || !(request instanceof ReviewProviderRequestIdentity)
      || typeof recoveredClaim !== "boolean" || typeof needsCheckpoint !== "boolean"
      || (recoveredClaim && needsCheckpoint)
      || !(ResultClass?.prototype instanceof StepResult)) {
      throw new TypeError("Review claim preparation requires its exact binding and request");
    }
    this.flowManager = flowManager;
    this.binding = binding;
    this.executionBinding = executionBinding;
    this.request = request;
    this.recoveredClaim = recoveredClaim;
    this.needsCheckpoint = needsCheckpoint;
    this.ResultClass = ResultClass;
    Object.freeze(this);
  }
}

export class SpecReviewExecutionAdmission extends ReviewExecutionAdmission {}

export class SpecReviewExecutionClaimPreparation extends ReviewExecutionClaimPreparation {
  constructor(input) {
    if (!(input.binding instanceof SpecReviewStepBinding)) throw new TypeError("Spec Review claim requires its Spec binding");
    super({ ...input, ResultClass: SpecReviewExecutionRequiredResult });
  }
}

export class SpecReviewPublicationPreparation {
  constructor({ binding = null, reviewDigest = null, result = null }) {
    if (result === null
      ? !(binding instanceof SpecReviewStepBinding) || typeof reviewDigest !== "string" || reviewDigest.length === 0
      : binding !== null || reviewDigest !== null || result?.result !== "ok"
        || result.artifacts?.phase !== "spec" || typeof result.artifacts.reviewDigest !== "string") {
      throw new TypeError("Spec Review publication preparation requires a binding or an exact replay");
    }
    this.binding = binding;
    this.reviewDigest = reviewDigest;
    this.result = result;
    Object.freeze(this);
  }

  get completed() { return this.result !== null; }
}

/** Canonical I/O and settlement for one revision-bound Spec Review Attempt. */
