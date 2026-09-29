import { CanonicalSpecReview, SpecReviewDelta } from "./spec-review-artifacts.js";
import { SpecTriageCompletedResult, SpecRepairChangedResult, SpecRepairUnchangedResult } from "../engine/step-result.js";
import { SpecJsonValidator } from "../../lib/spec-json-validator.js";

/** Immutable, validated inputs captured from one sealed Review worker handoff. */
export class SpecReviewWorkerFacts {
  constructor({ stepId, spec, review, delta, reviewDigest, reviewByteLength, validator } = {}) {
    if (!["spec-triage", "spec-repair"].includes(stepId)
      || !spec || typeof spec !== "object" || Array.isArray(spec)
      || !(review instanceof CanonicalSpecReview)
      || !(delta instanceof SpecReviewDelta) || delta.stage !== stepId
      || typeof reviewDigest !== "string" || !Number.isSafeInteger(reviewByteLength)
      || !(validator instanceof SpecJsonValidator)) {
      throw new TypeError("Spec Review worker facts require bound canonical inputs");
    }
    delta.assertCurrent(review);
    this.stepId = stepId;
    this.spec = structuredClone(spec);
    this.review = review;
    this.delta = delta;
    this.reviewDigest = reviewDigest;
    this.reviewByteLength = reviewByteLength;
    this.validator = validator;
    Object.freeze(this.spec);
    Object.freeze(this);
  }
}

/** The Step's pure Spec candidate, retained with its selected Result. */
export class SpecReviewWorkerCandidate {
  constructor(spec) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new TypeError("Spec Review worker candidate requires a Spec object");
    }
    this.spec = Object.freeze(structuredClone(spec));
    Object.freeze(this);
  }
}

/** Pure Step selection: semantic Result and its exact canonical candidates. */
export class SpecReviewWorkerSelection {
  constructor({ result, review, candidate = undefined, facts } = {}) {
    if (!(result instanceof SpecTriageCompletedResult
      || result instanceof SpecRepairChangedResult
      || result instanceof SpecRepairUnchangedResult)
      || !(review instanceof CanonicalSpecReview)
      || !(facts instanceof SpecReviewWorkerFacts)
      || facts.stepId !== result.stepId
      || !review.identity.equals(facts.review.identity)
      || (candidate !== undefined && !(candidate instanceof SpecReviewWorkerCandidate))
      || (result instanceof SpecRepairChangedResult) !== (candidate !== undefined)) {
      throw new TypeError("Spec Review worker selection requires matching Result and candidate");
    }
    this.result = result;
    this.review = review;
    this.candidate = candidate;
    this.facts = facts;
    Object.freeze(this);
  }
}
