import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import { AgentResponseProtocolEvidence, AgentResponseProtocolFailure } from "../../lib/agent-response-protocol.js";
import { ReviewProvenance, ReviewEvidenceIdentity, MAX_REVIEW_AUTHORED_STRING_CHARS, requireObject, requireString, requireNullableTaskId, requireTreeSha, requireSha256 } from "./review-evidence-values.js";

export const REVIEW_EVIDENCE_VERSION = 1;
export const MAX_REVIEW_EVIDENCE_BYTES = 1024 * 1024;
export const MAX_REVIEW_FINDINGS = 100;

export const REVIEW_DISPOSITIONS = new Set(["PASS", "ADVISORY", "REJECTED"]);
const REVIEW_FINDING_DISPOSITIONS = new Set(["must-fix", "informational", "deferred"]);
const REVIEW_TOOLING_STAGES = new Set([
  "startup",
  "communication",
  "parse",
  "post_hook",
  "canonical_write",
  "projection",
  "result_recording",
]);
const IMPL_REVIEW_BOUNDED_PROTOCOL_STOPS = new Set([
  "file_read_failure", "file_read_retry_exhausted", "context_limit", "evaluation_failed",
]);
function requireFindingText(value, field) {
  const normalized = requireString(value, field);
  if (
    /^<[^<>\r\n]+>$/.test(normalized)
    || /^\{\{[^{}\r\n]+\}\}$/.test(normalized)
  ) {
    throw new Error(`${field} must contain concrete review evidence, not a template placeholder`);
  }
  return normalized;
}

export function requireInteger(value, field, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${field} must be an integer greater than or equal to ${min}`);
  }
  return value;
}

export function requireBoolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function freezeArray(values) {
  return Object.freeze([...values]);
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function normalizeFindings(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return freezeArray(value.map((entry) => (
    entry instanceof ReviewFinding ? entry : new ReviewFinding(entry)
  )));
}

function assertFindingBudget(blockingFindings, advisoryFindings) {
  if (blockingFindings.length + advisoryFindings.length > MAX_REVIEW_FINDINGS) {
    throw new Error(`review finding count exceeds ${MAX_REVIEW_FINDINGS}`);
  }
  const findings = [...blockingFindings, ...advisoryFindings];
  for (const field of ["findingId", "fingerprint"]) {
    const values = findings.map((finding) => finding[field]);
    if (new Set(values).size !== values.length) {
      throw new Error(`review findings contain duplicate ${field} values`);
    }
  }
}

export class ReviewFinding {
  constructor(input = {}) {
    requireObject(input, "review finding");
    this.findingId = requireFindingText(input.findingId, "findingId");
    this.summary = requireFindingText(input.summary, "summary");
    this.fingerprint = requireSha256(input.fingerprint, "fingerprint");
    if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) {
      throw new Error("evidenceRefs must be a non-empty array");
    }
    if (input.evidenceRefs.length > MAX_REVIEW_FINDINGS) {
      throw new Error(`evidenceRefs count exceeds ${MAX_REVIEW_FINDINGS}`);
    }
    this.evidenceRefs = freezeArray(input.evidenceRefs.map((value, index) => (
      requireFindingText(value, `evidenceRefs[${index}]`)
    )));
    this.disposition = input.disposition == null
      ? null
      : requireString(input.disposition, "disposition");
    if (this.disposition != null && !REVIEW_FINDING_DISPOSITIONS.has(this.disposition)) {
      throw new Error(`invalid review finding disposition: ${this.disposition}`);
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      findingId: this.findingId,
      summary: this.summary,
      fingerprint: this.fingerprint,
      evidenceRefs: [...this.evidenceRefs],
      ...(this.disposition == null ? {} : { disposition: this.disposition }),
    };
  }
}

export class ReviewDisposition {
  constructor({ value, blockingFindings = [], advisoryFindings = [] } = {}) {
    if (!REVIEW_DISPOSITIONS.has(value)) {
      throw new Error(`invalid review disposition: ${value}`);
    }
    this.value = value;
    this.blockingFindings = normalizeFindings(blockingFindings, "blockingFindings");
    this.advisoryFindings = normalizeFindings(advisoryFindings, "advisoryFindings");
    assertFindingBudget(this.blockingFindings, this.advisoryFindings);

    if (value === "PASS" && (this.blockingFindings.length > 0 || this.advisoryFindings.length > 0)) {
      throw new Error("PASS disposition cannot contain findings");
    }
    if (value === "ADVISORY" && (
      this.blockingFindings.length > 0 || this.advisoryFindings.length === 0
    )) {
      throw new Error("ADVISORY disposition requires advisory findings and no blocking findings");
    }
    if (value === "REJECTED" && this.blockingFindings.length === 0) {
      throw new Error("REJECTED disposition requires at least one blocking finding");
    }
    Object.freeze(this);
  }

  get findings() {
    return [...this.blockingFindings, ...this.advisoryFindings];
  }

  toJSON() {
    return {
      value: this.value,
      blockingFindings: this.blockingFindings.map((finding) => finding.toJSON()),
      advisoryFindings: this.advisoryFindings.map((finding) => finding.toJSON()),
    };
  }
}

function canonicalEvidenceDocument({ phase, taskId, treeSha, targetStateDigest, provenance, disposition }) {
  return {
    version: REVIEW_EVIDENCE_VERSION,
    phase,
    taskId,
    treeSha,
    ...(targetStateDigest && { targetStateDigest }),
    provenance: provenance.toJSON(),
    disposition: disposition.value,
    blockingFindings: disposition.blockingFindings.map((finding) => finding.toJSON()),
    advisoryFindings: disposition.advisoryFindings.map((finding) => finding.toJSON()),
  };
}

export class ReviewEvidence {
  constructor(input = {}) {
    requireObject(input, "review evidence");
    for (const callerOwnedField of ["identity", "evidenceDigest"]) {
      if (Object.hasOwn(input, callerOwnedField)) {
        throw new Error(`${callerOwnedField} is computed by the CLI and cannot be supplied by a caller`);
      }
    }
    if (input.version != null && input.version !== REVIEW_EVIDENCE_VERSION) {
      throw new Error(`review evidence version must be ${REVIEW_EVIDENCE_VERSION}`);
    }
    this.phase = requireString(input.phase, "phase");
    this.taskId = requireNullableTaskId(input.taskId);
    this.treeSha = requireTreeSha(input.treeSha);
    this.targetStateDigest = input.targetStateDigest == null
      ? null
      : requireSha256(input.targetStateDigest, "targetStateDigest");
    this.provenance = input.provenance instanceof ReviewProvenance
      ? input.provenance
      : new ReviewProvenance(input.provenance);
    if (!(input.disposition instanceof ReviewDisposition)) {
      throw new Error("disposition must be a ReviewDisposition");
    }
    this.disposition = input.disposition;
    this.canonicalDocument = deepFreeze(canonicalEvidenceDocument(this));
    this.canonicalText = stableStringify(this.canonicalDocument);
    if (Buffer.byteLength(this.canonicalText, "utf8") > MAX_REVIEW_EVIDENCE_BYTES) {
      throw new Error(`canonical review evidence exceeds ${MAX_REVIEW_EVIDENCE_BYTES} bytes`);
    }
    this.identity = new ReviewEvidenceIdentity({
      phase: this.phase,
      taskId: this.taskId,
      treeSha: this.treeSha,
      provenance: this.provenance,
      evidenceDigest: sha256(this.canonicalText),
    });
    Object.freeze(this);
  }

  static fromJSON(value) {
    const { identity, ...document } = value;
    const evidence = new ReviewEvidence({ ...document, disposition: new ReviewDisposition({
      value: document.disposition, blockingFindings: document.blockingFindings,
      advisoryFindings: document.advisoryFindings }) });
    if (!isDeepStrictEqual(evidence.toJSON(), value)) throw new TypeError("Canonical Review evidence or identity changed");
    return evidence;
  }

  get findings() {
    return this.disposition.findings;
  }

  toCanonicalJSON() {
    return structuredClone(this.canonicalDocument);
  }

  toJSON() {
    return {
      ...this.toCanonicalJSON(),
      identity: this.identity.toJSON(),
    };
  }
}

export class ReviewToolingOutcome {
  constructor({ stage, attempt, maxAttempts, reason, permissionRelated = false } = {}) {
    if (!REVIEW_TOOLING_STAGES.has(stage)) throw new Error(`invalid review tooling stage: ${stage}`);
    this.kind = "TOOLING_ERROR";
    this.stage = stage;
    this.attempt = requireInteger(attempt, "attempt", { min: 1 });
    this.maxAttempts = requireInteger(maxAttempts, "maxAttempts", { min: 1 });
    if (this.attempt > this.maxAttempts) throw new Error("tooling attempt exceeds maxAttempts");
    const normalizedReason = requireString(reason, "reason", { max: Number.MAX_SAFE_INTEGER });
    this.reason = normalizedReason.slice(0, MAX_REVIEW_AUTHORED_STRING_CHARS);
    this.permissionRelated = requireBoolean(permissionRelated, "permissionRelated");
    this.remainingAttempts = this.maxAttempts - this.attempt;
    Object.freeze(this);
  }

  toJSON() {
    return {
      kind: this.kind,
      stage: this.stage,
      attempt: this.attempt,
      maxAttempts: this.maxAttempts,
      remainingAttempts: this.remainingAttempts,
      reason: this.reason,
      permissionRelated: this.permissionRelated,
    };
  }
}

/** A bounded inability to evaluate immutable Review input, rather than a semantic verdict. */
export class ImplReviewToolingObservation {
  constructor({ failureMode, toolingOutcome, responseProtocolEvidence, manifestDigest }) {
    if (!IMPL_REVIEW_BOUNDED_PROTOCOL_STOPS.has(failureMode)
      || !(toolingOutcome instanceof ReviewToolingOutcome)
      || !(responseProtocolEvidence instanceof AgentResponseProtocolEvidence)
      || !responseProtocolEvidence.groups.some((group) => group.outcome === "failed" && group.stopReason === failureMode)) {
      throw new TypeError("Implementation Review tooling requires its bounded failed evaluation protocol");
    }
    const failed = responseProtocolEvidence.groups.findLast((group) => group.outcome === "failed" && group.stopReason === failureMode);
    if (failed.attempts.at(-1)?.reason?.trim().slice(0, MAX_REVIEW_AUTHORED_STRING_CHARS) !== toolingOutcome.reason) {
      throw new TypeError("Bounded Review tooling reason differs from its original evaluator protocol");
    }
    Object.assign(this, { failureMode, toolingOutcome, responseProtocolEvidence,
      manifestDigest: requireSha256(manifestDigest, "bounded Review manifest digest") });
    Object.freeze(this);
  }
  static isBoundedFailure(error) {
    return error instanceof AgentResponseProtocolFailure
      && IMPL_REVIEW_BOUNDED_PROTOCOL_STOPS.has(error.data.failureMode);
  }
  static fromFailure(error, manifest) {
    if (!ImplReviewToolingObservation.isBoundedFailure(error)) return null;
    return new ImplReviewToolingObservation({ failureMode: error.data.failureMode,
      toolingOutcome: new ReviewToolingOutcome({ stage: "communication", attempt: 1, maxAttempts: 1, reason: error.message }),
      responseProtocolEvidence: error.evidence, manifestDigest: manifest.digest });
  }
  assertManifest(manifest) {
    if (manifest?.phase !== "impl" || manifest.taskId !== null || manifest.nodeId !== "impl-review"
      || manifest.digest !== this.manifestDigest) throw new TypeError("Bounded Flow Review tooling changed its original immutable inputs or Attempt");
  }
  toJSON() { return { failureMode: this.failureMode, toolingOutcome: this.toolingOutcome.toJSON(),
    responseProtocolEvidence: this.responseProtocolEvidence.toJSON(), manifestDigest: this.manifestDigest }; }
  static fromJSON(value) { return new ImplReviewToolingObservation({ ...value,
    toolingOutcome: new ReviewToolingOutcome(value.toolingOutcome),
    responseProtocolEvidence: AgentResponseProtocolEvidence.from(value.responseProtocolEvidence) }); }
  static fromArtifact(artifact, manifest) {
    const observation = ImplReviewToolingObservation.fromJSON(artifact.toolingObservation);
    observation.assertManifest(manifest);
    if (artifact.phase !== "impl" || artifact.taskId != null
      || artifact.verdict !== undefined || artifact.canonicalEvidence !== undefined
      || !Array.isArray(artifact.blockingFindings) || artifact.blockingFindings.length !== 0
      || !Array.isArray(artifact.nonBlockingImprovements) || artifact.nonBlockingImprovements.length !== 0
      || !isDeepStrictEqual(artifact.toolingOutcome, observation.toolingOutcome.toJSON())) {
      throw new TypeError("Bounded implementation Review tooling cannot claim semantic evidence");
    }
    return observation;
  }
}
