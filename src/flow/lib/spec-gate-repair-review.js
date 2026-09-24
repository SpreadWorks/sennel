import { createHash } from "node:crypto";
import { CanonicalSpecReview, canonicalSpecReviewJson } from "./spec-review-artifacts.js";
import { canonicalSourceFindings, FlowFindingSourceIdentity } from "./flow-findings.js";
import { SpecRepairTarget } from "./spec-repair-operations.js";

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function semanticDigest(value) { return digest(canonicalSpecReviewJson(value)); }
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** A review remains bound to its original snapshot and publication. */
export class SpecGateRepairReviewSource {
  constructor({ review, descriptor, snapshotBytes = null }) {
    if (!(review instanceof CanonicalSpecReview) || typeof descriptor?.relativePath !== "string"
      || descriptor.hash !== review.digest) {
      throw new TypeError("Gate repair review source requires its canonical review and exact descriptor");
    }
    this.review = review;
    this.descriptor = freeze(structuredClone(descriptor.toJSON?.() ?? descriptor));
    this.specDigest = null;
    if (snapshotBytes !== null) {
      if (!Buffer.isBuffer(snapshotBytes)
        || digest(snapshotBytes) !== review.identity.digest
        || snapshotBytes.length !== review.identity.byteLength) {
        throw new Error("Gate repair review snapshot does not match its original revision identity");
      }
      this.specDigest = semanticDigest(JSON.parse(snapshotBytes.toString("utf8")));
    }
    Object.freeze(this);
  }
}

/** Keep the complete finding and its explicit edit relationships; never re-key it. */
export class SpecGateRepairReviewFinding {
  constructor({ source, acceptedGroups }) {
    if (!(source.identity instanceof FlowFindingSourceIdentity)) throw new TypeError("Review relation requires the complete canonical finding identity");
    this.identity = source.identity;
    this.finding = freeze(structuredClone(source.finding));
    const permissions = (this.finding.allowedTargets ?? []).map((permission) =>
      SpecRepairTarget.fromJSON(permission.target, "review finding target"));
    this.relatedChanges = Object.freeze(acceptedGroups.flatMap((group) => group.operations.flatMap((operation, operationIndex) => {
      const target = SpecRepairTarget.fromJSON(operation.target, "Gate repair target");
      if (!permissions.some((permission) => permission.permissionKey() === target.permissionKey())) return [];
      return [freeze({ groupIndex: group.index, operationIndex, target: target.toJSON(),
        gateFindingIdentities: structuredClone(group.findingIdentities) })];
    })));
    // An explicit triage disposition is canonical; a worker's "fixed" report
    // or an accepted edit alone does not resolve a blocking review finding.
    this.unresolvedBlocking = this.finding.kind === "blocking"
      && !["invalid", "already_resolved", "downgraded_to_non_blocking"].includes(this.finding.disposition);
    Object.freeze(this);
  }
  toJSON() {
    return { identity: this.identity.toJSON(), finding: this.finding,
      relatedChanges: this.relatedChanges, unresolvedBlocking: this.unresolvedBlocking };
  }
}

/** Service facts for the Step's concrete ready/review Result, not a route selector. */
export class SpecGateRepairReviewFacts {
  constructor({ sourceReview, baseRevision, resultSpec, resultRevision, acceptedGroups }) {
    if (!/^sha256:[a-f0-9]{64}$/.test(baseRevision)
      || !/^[a-f0-9]{64}$/.test(resultRevision?.digest)
      || !Array.isArray(acceptedGroups)) throw new TypeError("Gate repair review facts require a bound revision and adopted edits");
    const source = sourceReview === null ? null : sourceReview instanceof SpecGateRepairReviewSource
      ? sourceReview : new SpecGateRepairReviewSource(sourceReview);
    this.baseRevision = baseRevision;
    this.resultRevision = freeze(structuredClone(resultRevision));
    this.resultSpecDigest = semanticDigest(resultSpec);
    this.sourceReviewIdentity = source?.review.identity.toJSON() ?? null;
    this.sourceReviewDigest = source?.review.digest ?? null;
    this.sourceReviewArtifact = source?.descriptor.relativePath ?? null;
    this.sourceSpecDigest = source?.specDigest ?? null;
    this.findings = Object.freeze(source === null ? [] : canonicalSourceFindings({
      artifact: source.review.toJSON(), sourceStep: "spec-review", sourceArtifact: source.descriptor.relativePath,
    }).map((entry) => new SpecGateRepairReviewFinding({ source: entry, acceptedGroups })));
    this.reviewInputPreserved = source?.review.audit.some((entry) => entry.stage === "spec-review") === true
      && this.sourceSpecDigest !== null && this.sourceSpecDigest === this.resultSpecDigest;
    this.unresolvedBlocking = this.findings.some((finding) => finding.unresolvedBlocking);
    this.requiresReview = !this.reviewInputPreserved || this.unresolvedBlocking;
    this.reason = this.unresolvedBlocking ? "unresolved-blocking-review"
      : source === null ? "review-evidence-unavailable"
        : !this.reviewInputPreserved ? "review-input-preservation-unproven" : "exact-reviewed-input-preserved";
    freeze(this.sourceReviewIdentity);
    Object.freeze(this);
  }
  toJSON() {
    return { version: 1, baseRevision: this.baseRevision, resultRevision: this.resultRevision,
      sourceReviewIdentity: this.sourceReviewIdentity, sourceReviewDigest: this.sourceReviewDigest,
      sourceReviewArtifact: this.sourceReviewArtifact, sourceSpecDigest: this.sourceSpecDigest,
      resultSpecDigest: this.resultSpecDigest, findings: this.findings.map((finding) => finding.toJSON()),
      reviewInputPreserved: this.reviewInputPreserved, unresolvedBlocking: this.unresolvedBlocking,
      requiresReview: this.requiresReview, reason: this.reason };
  }
  static fromJSON(value, inputs) {
    const facts = new SpecGateRepairReviewFacts(inputs);
    if (canonicalSpecReviewJson(value) !== canonicalSpecReviewJson(facts.toJSON())) {
      throw new Error("Saved Gate repair review facts differ from their canonical revision and changes");
    }
    return facts;
  }
}
