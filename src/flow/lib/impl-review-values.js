import { NonGateTargetBinding, NonGateCatalogPublication, NonGateRetryMetrics } from "./non-gate-transition.js";
import { ReviewEvidence, ReviewToolingOutcome, ImplReviewToolingObservation } from "./review-observation-values.js";
import { ReviewWorkUnitManifest, ReviewWorkUnitSeal } from "./review-work-unit-values.js";
import { AcceptedNonblockingDecision } from "./accepted-nonblocking-decision.js";
import { CANONICAL_NODE_STATUSES } from "./canonical-node-status.js";

/** Acquired lifecycle statuses of the Review's current downstream consumers. */
export class ImplReviewFrontier {
  constructor({ triageStatus, repairStatus, gateStatus, triageAttemptSequence, repairAttemptSequence }) {
    for (const [field, status] of Object.entries({ triageStatus, repairStatus, gateStatus })) {
      if (!CANONICAL_NODE_STATUSES.includes(status)) throw new TypeError(`Implementation Review ${field} is invalid`);
      this[field] = status;
    }
    for (const [field, value] of Object.entries({ triageAttemptSequence, repairAttemptSequence })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Implementation Review ${field} is invalid`);
      this[field] = value;
    }
    Object.freeze(this);
  }
  toJSON() { return { triageStatus: this.triageStatus, repairStatus: this.repairStatus, gateStatus: this.gateStatus,
    triageAttemptSequence: this.triageAttemptSequence, repairAttemptSequence: this.repairAttemptSequence }; }
  static fromJSON(value) { return new ImplReviewFrontier(value); }
}

export class ImplReviewMeaning {
  constructor(value) {
    const kinds = { execution: "impl-review-execution-required", PASS: "impl-review-passed",
      ADVISORY: "impl-review-advisory", REJECTED: "impl-review-rejected", tooling: "impl-review-tooling" };
    if (!Object.hasOwn(kinds, value)) throw new TypeError("Unknown implementation Review meaning");
    this.value = value;
    this.resultKind = kinds[value];
    Object.freeze(this);
  }
}

/** Exact Review Attempt, worker receipt, canonical evidence and independent Flow budget. */
export class ImplReviewResultEvidence {
  #meaning;
  constructor({ identity, manifest = null, seal = null, review = null, publication = null,
    retry, frontier, tooling = null, toolingObservation = null, acceptedDecision = null } = {}) {
    if (!(identity instanceof NonGateTargetBinding) || identity.stepId !== "impl-review"
      || !(retry instanceof NonGateRetryMetrics) || retry.maximum !== 4 || !(frontier instanceof ImplReviewFrontier)
      || manifest !== null && !(manifest instanceof ReviewWorkUnitManifest)
      || seal !== null && !(seal instanceof ReviewWorkUnitSeal)
      || review !== null && !(review instanceof ReviewEvidence)
      || publication !== null && !(publication instanceof NonGateCatalogPublication)
      || tooling !== null && !(tooling instanceof ReviewToolingOutcome)
      || review !== null && tooling !== null) {
      throw new TypeError("Implementation Review requires acquired typed evidence and its Flow budget");
    }
    if (manifest !== null && (manifest.runId !== identity.runId || manifest.specId !== identity.specId
      || manifest.nodeId !== identity.stepId || manifest.attemptId !== identity.attempt.id
      || manifest.phase !== "impl" || manifest.taskId !== null)) {
      throw new TypeError("Implementation Review manifest does not match its Attempt");
    }
    if (seal !== null) seal.assertManifest(manifest);
    if (tooling !== null) {
      if (!(toolingObservation instanceof ImplReviewToolingObservation) || seal === null
        || JSON.stringify(tooling.toJSON()) !== JSON.stringify(toolingObservation.toolingOutcome.toJSON())) {
        throw new TypeError("Bounded implementation Review tooling requires its sealed protocol observation");
      }
      toolingObservation.assertManifest(manifest);
    } else if (toolingObservation !== null) throw new TypeError("Semantic Review cannot carry a tooling observation");
    if (review !== null && (review.phase !== "impl" || review.taskId !== null
      || seal === null || review.treeSha !== manifest.target.treeSha
      || review.targetStateDigest !== manifest.target.targetStateDigest)) {
      throw new TypeError("Implementation Review evidence is not bound to its sealed work unit");
    }
    if (publication !== null && (publication.runId !== identity.runId || publication.specId !== identity.specId
      || publication.stepId !== identity.stepId || !publication.attempt.matches(identity.attempt))) {
      throw new TypeError("Implementation Review publication belongs to another Attempt");
    }
    if (review === null && tooling === null && manifest === null) throw new TypeError("Implementation Review execution requires its manifest");
    Object.assign(this, { identity, manifest, seal, review, publication, retry, frontier, tooling, toolingObservation });
    if (acceptedDecision !== null && (!(acceptedDecision instanceof AcceptedNonblockingDecision)
      || tooling === null)) throw new TypeError("Accepted Review decision requires its actual tooling observation");
    this.acceptedDecision = acceptedDecision;
    acceptedDecision?.assertEvidence(this);
    this.#meaning = new ImplReviewMeaning(this.executionRequired ? "execution"
      : tooling !== null ? "tooling" : review.disposition.value);
    Object.freeze(this);
  }
  get stepId() { return this.identity.stepId; }
  get executionRequired() { return this.review === null && this.tooling === null; }
  get meaning() { return this.#meaning; }
  get resultKind() { return this.#meaning.resultKind; }
  assertResultKind(kind) {
    if (kind !== this.resultKind) throw new TypeError("Implementation Review Result kind contradicts its acquired evidence");
  }
  toJSON() { return { identity: this.identity.toJSON(), manifest: this.manifest?.toJSON() ?? null,
    seal: this.seal?.toJSON() ?? null, review: this.review?.toJSON() ?? null,
    publication: this.publication?.toJSON() ?? null, retry: this.retry.toJSON(),
    frontier: this.frontier.toJSON(), tooling: this.tooling?.toJSON() ?? null,
    ...(this.toolingObservation === null ? {} : { toolingObservation: this.toolingObservation.toJSON() }),
    ...(this.acceptedDecision === null ? {} : { acceptedDecision: this.acceptedDecision.toJSON() }) }; }
  static fromJSON(value) {
    let review = null;
    if (value.review !== null) {
      review = ReviewEvidence.fromJSON(value.review);
    }
    return new ImplReviewResultEvidence({ acceptedDecision: value.acceptedDecision === undefined ? null
      : AcceptedNonblockingDecision.fromJSON(value.acceptedDecision), identity: new NonGateTargetBinding(value.identity),
      manifest: value.manifest === null ? null : new ReviewWorkUnitManifest(value.manifest),
      seal: value.seal === null ? null : new ReviewWorkUnitSeal(value.seal), review,
      publication: value.publication === null ? null : new NonGateCatalogPublication(value.publication),
      retry: new NonGateRetryMetrics(value.retry), frontier: ImplReviewFrontier.fromJSON(value.frontier),
      toolingObservation: value.toolingObservation === undefined ? null : ImplReviewToolingObservation.fromJSON(value.toolingObservation),
      tooling: value.tooling === null ? null : new ReviewToolingOutcome(value.tooling) });
  }
}
