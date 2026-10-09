import { NonGateTargetBinding, NonGateCatalogPublication, NonGateSourcePublication } from "../../lib/non-gate-transition.js";
import { CANONICAL_NODE_STATUSES } from "../../lib/canonical-node-status.js";
import { requireDigest } from "../../lib/flow-value-assertions.js";

const REVIEW_KINDS = Object.freeze({ execution: "acceptance-review-execution-required", pass: "acceptance-review-passed",
  repair_required: "acceptance-review-repair-required", user_decision_required: "acceptance-review-decision-required",
  blocked: "acceptance-review-mechanically-blocked" });
function strings(values, field) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value === "")
    || new Set(values).size !== values.length) throw new TypeError(`${field} requires unique strings`);
  return Object.freeze([...values]);
}
function assertPublication(identity, publication) {
  if (publication !== null && (!(publication instanceof NonGateCatalogPublication)
    || publication.runId !== identity.runId || publication.specId !== identity.specId
    || publication.stepId !== identity.stepId || !publication.attempt.matches(identity.attempt))) {
    throw new TypeError("Acceptance publication must belong to its exact Attempt");
  }
}

/** An explicit choice bound to the current canonical Review digest. */
export class AcceptanceDecisionRequest {
  constructor({ reviewDigest, choice, record = null }) {
    this.reviewDigest = requireDigest(reviewDigest, "Acceptance decision Review digest");
    if (!["accept_risk_and_continue", "abort"].includes(choice)) throw new TypeError("Acceptance choice is invalid");
    if (record !== null && (record.reviewDigest !== reviewDigest || record.choice !== choice)) {
      throw new TypeError("acceptance decision record is not bound to canonical review evidence");
    }
    this.choice = choice;
    Object.freeze(this);
  }
}

/** Pure acceptance meaning and immutable producer ownership, without artifact bodies. */
export class AcceptanceReviewResultEvidence {
  constructor({ identity, publication = null, fingerprint, requirementIds, reviewDigest = null,
    reviewAttempt = null, verdict = null, findingIds = [], executionGeneration = 0,
    decisionAttemptSequence, decisionStatus } = {}) {
    if (!(identity instanceof NonGateTargetBinding) || identity.stepId !== "acceptance-review") {
      throw new TypeError("Acceptance Review requires its exact typed identity");
    }
    assertPublication(identity, publication);
    if (verdict !== null && !["pass", "repair_required", "user_decision_required", "blocked"].includes(verdict)) throw new TypeError("Acceptance verdict is invalid");
    if (!Number.isSafeInteger(executionGeneration) || executionGeneration < 0) throw new TypeError("Acceptance generation is invalid");
    if (!Number.isSafeInteger(decisionAttemptSequence) || decisionAttemptSequence < 0
      || !CANONICAL_NODE_STATUSES.includes(decisionStatus)) throw new TypeError("Acceptance decision frontier is invalid");
    if (verdict === null ? publication !== null || reviewDigest !== null || reviewAttempt !== null
      : publication === null || reviewDigest !== publication.fingerprint || reviewAttempt !== identity.attempt.sequence) {
      throw new TypeError("Acceptance Review meaning requires its exact canonical publication");
    }
    this.identity = identity;
    this.publication = publication;
    this.fingerprint = requireDigest(fingerprint, "Acceptance evidence fingerprint");
    this.requirementIds = strings(requirementIds, "Acceptance requirement IDs");
    this.reviewDigest = reviewDigest === null ? null : requireDigest(reviewDigest, "Acceptance Review publication digest");
    this.reviewAttempt = reviewAttempt;
    this.verdict = verdict;
    this.findingIds = strings(findingIds, "Acceptance repair findings");
    if (verdict === "repair_required" && this.findingIds.length === 0
      || [null, "pass", "blocked"].includes(verdict) && this.findingIds.length !== 0) {
      throw new TypeError("Acceptance repair findings contradict its acquired verdict");
    }
    this.executionGeneration = executionGeneration;
    this.decisionAttemptSequence = decisionAttemptSequence;
    this.decisionStatus = decisionStatus;
    Object.freeze(this);
  }
  get stepId() { return this.identity.stepId; }
  get executionRequired() { return this.verdict === null; }
  get resultKind() { return REVIEW_KINDS[this.verdict ?? "execution"]; }
  assertResultKind(kind) { if (kind !== this.resultKind) throw new TypeError("Acceptance Review Result contradicts its acquired evidence"); }
  toJSON() { return { identity: this.identity.toJSON(), publication: this.publication?.toJSON() ?? null,
    fingerprint: this.fingerprint, requirementIds: [...this.requirementIds], reviewDigest: this.reviewDigest,
    reviewAttempt: this.reviewAttempt, verdict: this.verdict, findingIds: [...this.findingIds], executionGeneration: this.executionGeneration,
    decisionAttemptSequence: this.decisionAttemptSequence, decisionStatus: this.decisionStatus }; }
  static fromJSON(value) { return new this({ ...value, identity: new NonGateTargetBinding(value.identity),
    publication: value.publication === null ? null : new NonGateCatalogPublication(value.publication) }); }
}

/** One tokenless explicit choice bound to the current immutable Review producer. */
export class AcceptanceDecisionResultEvidence {
  constructor({ identity, sourcePublication, reviewAttempt, repairFingerprint, choice = null, publication = null } = {}) {
    if (!(identity instanceof NonGateTargetBinding) || identity.stepId !== "acceptance-decision"
      || !(sourcePublication instanceof NonGateSourcePublication) || sourcePublication.stepId !== "acceptance-review"
      || sourcePublication.runId !== identity.runId || sourcePublication.specId !== identity.specId
      || sourcePublication.attempt.sequence !== reviewAttempt) throw new TypeError("Acceptance decision requires its exact Review source");
    if (choice !== null && !["accept_risk_and_continue", "abort"].includes(choice)) throw new TypeError("Acceptance choice is invalid");
    requireDigest(sourcePublication.fingerprint, "Acceptance decision Review digest");
    assertPublication(identity, publication);
    if ((choice === null) !== (publication === null)) throw new TypeError("Acceptance choice requires its exact decision publication");
    Object.assign(this, { identity, sourcePublication, reviewAttempt, repairFingerprint: requireDigest(repairFingerprint,
      "Acceptance decision repair fingerprint"), choice, publication });
    Object.freeze(this);
  }
  get stepId() { return this.identity.stepId; }
  get reviewDigest() { return this.sourcePublication.fingerprint; }
  get resultKind() { return this.choice === null ? "acceptance-decision-awaiting-choice"
    : this.choice === "abort" ? "acceptance-decision-aborted" : "acceptance-decision-risk-accepted"; }
  assertResultKind(kind) { if (kind !== this.resultKind) throw new TypeError("Acceptance decision Result contradicts its acquired choice"); }
  toJSON() { return { identity: this.identity.toJSON(), sourcePublication: this.sourcePublication.toJSON(),
    reviewAttempt: this.reviewAttempt, repairFingerprint: this.repairFingerprint, choice: this.choice,
    publication: this.publication?.toJSON() ?? null }; }
  static fromJSON(value) { return new this({ ...value, identity: new NonGateTargetBinding(value.identity),
    sourcePublication: new NonGateSourcePublication(value.sourcePublication),
    publication: value.publication === null ? null : new NonGateCatalogPublication(value.publication) }); }
}
