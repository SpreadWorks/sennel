import { GateAttemptIdentity, GateCatalogPublication } from "./gate-transition.js";
import { isDeepStrictEqual } from "node:util";

const digest = (value, field) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} requires a sha256 digest`);
  return value;
};

/** Exact findings bytes accepted by the explicit deferred-finding decision. */
export class AcceptedGateFindingsPublication {
  constructor({ logicalKey, relativePath, hash, size, findingCount } = {}) {
    if (logicalKey !== "flow.findings" || typeof relativePath !== "string" || relativePath === ""
      || relativePath.startsWith("/") || relativePath.split("/").some((part) => part === ".." || part === "")
      || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(findingCount) || findingCount < 1) {
      throw new TypeError("accepted Gate deferral requires its exact findings publication");
    }
    this.logicalKey = logicalKey;
    this.relativePath = relativePath;
    this.hash = digest(hash, "accepted Gate findings");
    this.size = size;
    this.findingCount = findingCount;
    Object.freeze(this);
  }
  toJSON() { return { logicalKey: this.logicalKey, relativePath: this.relativePath,
    hash: this.hash, size: this.size, findingCount: this.findingCount }; }
}

/** Receipt-bound explicit acceptance; the original evaluator identity never changes. */
export class AcceptedGateDeferral {
  constructor({ sourceReceiptId, sourceResultDigest, sourcePublication, settlementAttempt, findingsPublication } = {}) {
    if (!(sourcePublication instanceof GateCatalogPublication) || !(settlementAttempt instanceof GateAttemptIdentity)
      || !(findingsPublication instanceof AcceptedGateFindingsPublication)
      || settlementAttempt.id === sourcePublication.attempt.id
      || settlementAttempt.sequence !== sourcePublication.attempt.sequence + 1) {
      throw new TypeError("accepted Gate deferral requires source publication and its next decision Attempt");
    }
    this.sourceReceiptId = digest(sourceReceiptId, "accepted Gate source receipt");
    this.sourceResultDigest = digest(sourceResultDigest, "accepted Gate source Result");
    this.sourcePublication = sourcePublication;
    this.settlementAttempt = settlementAttempt;
    this.findingsPublication = findingsPublication;
    Object.freeze(this);
  }
  assertEvaluation(evidence) {
    if (evidence.result !== "fail" || evidence.failure?.category !== "semantic"
      || !evidence.identity.attempt.matches(this.sourcePublication.attempt)
      || JSON.stringify(evidence.publication?.toJSON()) !== JSON.stringify(this.sourcePublication.toJSON())) {
      throw new TypeError("accepted Gate deferral changed its original failed implementation evaluation");
    }
  }
  assertOriginalSource({ receipt, resultDigest, evidence, originalEvidence }) {
    this.assertEvaluation(evidence);
    const expected = evidence.toJSON();
    delete expected.continuation;
    if (originalEvidence.continuation != null || originalEvidence.acceptedDecision != null
      || receipt?.id !== this.sourceReceiptId || receipt.resultDigest !== this.sourceResultDigest
      || resultDigest !== this.sourceResultDigest || !isDeepStrictEqual(expected, originalEvidence)) {
      throw new TypeError("Accepted Gate deferral changed its original source receipt, Result digest or evidence");
    }
  }
  toJSON() { return { sourceReceiptId: this.sourceReceiptId, sourceResultDigest: this.sourceResultDigest,
    sourcePublication: this.sourcePublication.toJSON(), settlementAttempt: this.settlementAttempt.toJSON(),
    findingsPublication: this.findingsPublication.toJSON() }; }
  static fromJSON(value) {
    if (value instanceof AcceptedGateDeferral) return value;
    return new AcceptedGateDeferral({ ...value,
      sourcePublication: new GateCatalogPublication(value.sourcePublication),
      settlementAttempt: new GateAttemptIdentity(value.settlementAttempt),
      findingsPublication: new AcceptedGateFindingsPublication(value.findingsPublication) });
  }
}
