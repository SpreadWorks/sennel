import { GateAttemptIdentity, GateCatalogPublication } from "./gate-transition.js";
import { NonGateAttemptIdentity, NonGateCatalogPublication } from "./non-gate-transition.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const digest = (value, field) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} requires a sha256 digest`);
  return value;
};
const text = (value, field) => {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} requires text`);
  return value;
};

/** Exact acceptance publication bytes selected at the explicit decision boundary. */
export class AcceptedNonblockingPublication {
  constructor({ logicalKey, relativePath, hash, size }) {
    if (!["flow.findings", "nonblocking.handoffs"].includes(logicalKey)
      || typeof relativePath !== "string" || relativePath === "" || relativePath.startsWith("/")
      || relativePath.split("/").some((part) => part === ".." || part === "")
      || !Number.isSafeInteger(size) || size < 0) throw new TypeError("Accepted decision requires its exact acceptance publication");
    this.logicalKey = logicalKey;
    this.relativePath = relativePath;
    this.hash = digest(hash, "accepted nonblocking publication");
    this.size = size;
    Object.freeze(this);
  }
  toJSON() { return { logicalKey: this.logicalKey, relativePath: this.relativePath, hash: this.hash, size: this.size }; }
  static fromBytes({ logicalKey, relativePath, bytes }) {
    return new AcceptedNonblockingPublication({ logicalKey, relativePath,
      hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
  }
  matchesBytes(input) {
    return JSON.stringify(this.toJSON()) === JSON.stringify(AcceptedNonblockingPublication.fromBytes(input).toJSON());
  }
}

/** Explicit acceptance of one immutable observed Result, never an evaluator success. */
export class AcceptedNonblockingDecision {
  constructor({ sourceStepId, sourceReceiptId, sourceResultDigest, sourcePublication, settlementAttempt,
    evidenceRef, evidenceDigest, definitionDigest, resultKind, rationale, remainingRisk, publications }) {
    const review = ["impl-review", "test-result-review"].includes(sourceStepId);
    if (!["impl-review", "impl-gate", "task-gate", "test-result-review"].includes(sourceStepId)
      || !(sourcePublication instanceof (review ? NonGateCatalogPublication : GateCatalogPublication))
      || !(settlementAttempt instanceof (review ? NonGateAttemptIdentity : GateAttemptIdentity))
      || settlementAttempt.id === sourcePublication.attempt.id
      || settlementAttempt.sequence !== sourcePublication.attempt.sequence + 1
      || !["quality", "tooling", "unavailable"].includes(resultKind)
      || !Array.isArray(publications) || publications.length === 0
      || publications.some((entry) => !(entry instanceof AcceptedNonblockingPublication))) {
      throw new TypeError("Accepted nonblocking decision requires its original source and next decision Attempt");
    }
    this.sourceStepId = sourceStepId;
    this.sourceReceiptId = digest(sourceReceiptId, "accepted source receipt");
    this.sourceResultDigest = digest(sourceResultDigest, "accepted source Result");
    this.sourcePublication = sourcePublication;
    this.settlementAttempt = settlementAttempt;
    this.evidenceRef = text(evidenceRef, "accepted evidence reference");
    this.evidenceDigest = digest(evidenceDigest, "accepted evidence");
    this.definitionDigest = digest(definitionDigest, "accepted Definition");
    this.resultKind = resultKind;
    this.rationale = text(rationale, "accepted rationale");
    this.remainingRisk = text(remainingRisk, "accepted remaining risk");
    if (evidenceRef !== sourcePublication.artifactId || new Set(publications.map((entry) => entry.relativePath)).size !== publications.length) {
      throw new TypeError("Accepted decision changed its original evidence reference or duplicated acceptance publication");
    }
    this.publications = Object.freeze([...publications]);
    Object.freeze(this);
  }
  assertEvidence(evidence) {
    if (evidence.stepId !== this.sourceStepId || !evidence.identity.attempt.matches(this.sourcePublication.attempt)
      || JSON.stringify(evidence.publication.toJSON()) !== JSON.stringify(this.sourcePublication.toJSON())) {
      throw new TypeError("Accepted nonblocking decision changed its original evaluation identity");
    }
  }
  assertOriginalSource({ receipt, resultDigest, evidence, originalEvidence }) {
    this.assertEvidence(evidence);
    const expected = evidence.toJSON();
    delete expected.acceptedDecision;
    if (receipt?.id !== this.sourceReceiptId || receipt.resultDigest !== this.sourceResultDigest
      || resultDigest !== this.sourceResultDigest || !isDeepStrictEqual(expected, originalEvidence)) {
      throw new TypeError("Accepted decision changed its original source receipt, Result digest or evidence");
    }
  }
  assertRecord(record) {
    if (record?.kind !== "decision" || record.action !== "continue"
      || record.sourceStep !== this.sourceStepId
      || record.sourceAttempt !== this.sourcePublication.attempt.sequence
      || record.evidenceRef !== this.evidenceRef || record.evidenceDigest !== this.evidenceDigest
      || record.definitionDigest !== this.definitionDigest || record.resultKind !== this.resultKind
      || record.rationale !== this.rationale || record.remainingRisk !== this.remainingRisk) {
      throw new TypeError("Accepted decision differs from its original advisory acceptance");
    }
  }
  toJSON() {
    return { sourceStepId: this.sourceStepId, sourceReceiptId: this.sourceReceiptId,
      sourceResultDigest: this.sourceResultDigest, sourcePublication: this.sourcePublication.toJSON(),
      settlementAttempt: this.settlementAttempt.toJSON(), evidenceRef: this.evidenceRef,
      evidenceDigest: this.evidenceDigest, definitionDigest: this.definitionDigest, resultKind: this.resultKind,
      rationale: this.rationale, remainingRisk: this.remainingRisk, publications: this.publications.map((entry) => entry.toJSON()) };
  }
  static fromJSON(value) {
    const review = ["impl-review", "test-result-review"].includes(value.sourceStepId);
    return new AcceptedNonblockingDecision({ ...value,
      sourcePublication: new (review ? NonGateCatalogPublication : GateCatalogPublication)(value.sourcePublication),
      settlementAttempt: new (review ? NonGateAttemptIdentity : GateAttemptIdentity)(value.settlementAttempt),
      publications: value.publications.map((entry) => new AcceptedNonblockingPublication(entry)) });
  }
}
