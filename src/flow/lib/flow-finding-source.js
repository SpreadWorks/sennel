import path from "node:path";
import crypto from "node:crypto";

export const MAX_SOURCE_REF_CHARS = 300;

export function requireSourceString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  if (value.length > MAX_SOURCE_REF_CHARS) throw new Error(`${field} exceeds ${MAX_SOURCE_REF_CHARS} characters`);
  return value;
}

export function requireFindingFingerprint(value, field = "fingerprint") {
  const fingerprint = requireSourceString(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error(`${field} must be a lowercase SHA-256 string`);
  return fingerprint;
}

export function normalizeSourceArtifactPath(value, field = "sourceArtifact") {
  const source = requireSourceString(value, field).split("\\").join("/");
  if (path.posix.isAbsolute(source) || path.win32.isAbsolute(source)) {
    throw new Error(`${field} must be relative to the spec directory`);
  }
  const normalized = path.posix.normalize(source);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${field} must stay inside the spec directory`);
  }
  return normalized;
}

/** Exact identity of one finding within one canonical source artifact. */
export class FlowFindingSourceIdentity {
  constructor({ sourceArtifact, sourceStep, sourceFindingId, fingerprint } = {}) {
    this.sourceArtifact = normalizeSourceArtifactPath(sourceArtifact, "finding source identity sourceArtifact");
    this.sourceStep = requireSourceString(sourceStep, "finding source identity sourceStep");
    this.sourceFindingId = requireSourceString(sourceFindingId, "finding source identity sourceFindingId");
    this.fingerprint = requireFindingFingerprint(fingerprint, "finding source identity fingerprint");
    Object.freeze(this);
  }

  equals(other) {
    return other instanceof FlowFindingSourceIdentity
      && other.sourceArtifact === this.sourceArtifact
      && other.sourceStep === this.sourceStep
      && other.sourceFindingId === this.sourceFindingId
      && other.fingerprint === this.fingerprint;
  }

  toString() {
    return JSON.stringify([
      this.sourceArtifact,
      this.sourceStep,
      this.sourceFindingId,
      this.fingerprint,
    ]);
  }

  toJSON() {
    return {
      sourceArtifact: this.sourceArtifact,
      sourceStep: this.sourceStep,
      sourceFindingId: this.sourceFindingId,
      fingerprint: this.fingerprint,
    };
  }
}

function failedEvaluations(artifact) {
  return Array.isArray(artifact?.evaluations)
    ? artifact.evaluations.filter((entry) => entry?.result === "fail")
    : [];
}

function blockingObservations(artifact) {
  const observations = artifact?.nextAction?.diagnosis?.observations || artifact?.observations || [];
  return Array.isArray(observations)
    ? observations.filter((entry) => entry?.severity === "blocking" || entry?.severity == null)
    : [];
}

function reviewBlockingFindings(artifact, sourceStep) {
  const candidates = [
    ...(sourceStep === "spec-review" ? [artifact?.blocking] : []),
    artifact?.blockingFindings,
    artifact?.findings,
    artifact?.comments,
    artifact?.proposals,
    artifact?.advisoryFindings,
  ];
  return candidates.find((candidate) => Array.isArray(candidate) && candidate.length > 0) || [];
}

function evaluatedSource(artifact) {
  // Command-result artifacts retain the producer payload under `artifacts`.
  // Findings always inspect the evaluated payload, never the envelope.
  return artifact?.artifacts && typeof artifact.artifacts === "object" && !Array.isArray(artifact.artifacts)
    ? artifact.artifacts
    : artifact;
}

function sourceFindingsForArtifact(artifact, sourceStep) {
  const source = evaluatedSource(artifact);
  if (sourceStep === "spec-gate") {
    const observations = blockingObservations(source);
    if (observations.length > 0) return observations;
  }
  const evaluations = failedEvaluations(source);
  if (evaluations.length > 0) return evaluations;
  const review = reviewBlockingFindings(source, sourceStep);
  if (review.length > 0) return review;
  return blockingObservations(source);
}

export function findSourceFinding(artifact, identity) {
  if (!(identity instanceof FlowFindingSourceIdentity)) {
    throw new Error("source finding resolution requires a FlowFindingSourceIdentity");
  }
  const source = evaluatedSource(artifact);
  const facets = [
    failedEvaluations(source),
    reviewBlockingFindings(source, identity.sourceStep),
    blockingObservations(source),
  ];
  for (const findings of facets) {
    const match = findings.find((finding, index) => (
      stableSourceFindingId(identity.sourceStep, finding, index) === identity.sourceFindingId
        && sourceFindingFingerprint(identity.sourceStep, finding) === identity.fingerprint
    ));
    if (match !== undefined) return match;
  }
  return null;
}

function stableSourceFindingId(sourceStep, finding, index) {
  return finding?.sourceFindingId
    || finding?.findingId
    || finding?.id
    || finding?.proposalId
    || finding?.guardrail_id
    || `${sourceStep}:${index + 1}`;
}

function sourceFindingFingerprint(sourceStep, finding) {
  if (typeof finding?.fingerprint === "string" && /^[a-f0-9]{64}$/.test(finding.fingerprint)) {
    return finding.fingerprint;
  }
  const canonical = JSON.stringify({
    sourceStep,
    requirementId: String(finding?.requirementId || finding?.requirementRef || finding?.guardrail_id || "").trim(),
    category: String(finding?.category || finding?.failureMode || finding?.failureKind || "").trim(),
    file: String(finding?.file || finding?.where?.file || finding?.location?.file || "").trim().replace(/\\/g, "/"),
    issue: String(finding?.issue || finding?.observed || finding?.reason || finding?.title || "").trim(),
    ...(sourceStep === "spec-gate" && Array.isArray(finding?.targets) ? {
      specTarget: {
        targets: finding.targets.map((target) => JSON.stringify(target)).sort(),
        allowedTargets: (finding.allowedTargets ?? []).map((permission) => JSON.stringify({
          target: permission.target, operationKinds: [...permission.operationKinds].sort(),
        })).sort(),
        specRevision: finding.specRevision,
      },
    } : {}),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** Canonical source finding and its complete identity for exact consumers. */
export class CanonicalSourceFinding {
  constructor({ identity, finding }) {
    if (!(identity instanceof FlowFindingSourceIdentity) || finding === null
      || typeof finding !== "object" || Array.isArray(finding)) {
      throw new TypeError("canonical source finding requires an exact identity and source value");
    }
    this.identity = identity;
    this.finding = Object.freeze(structuredClone(finding));
    Object.freeze(this);
  }
}

export function canonicalSourceFindings({ artifact, sourceStep, sourceArtifact } = {}) {
  return Object.freeze(sourceFindingsForArtifact(artifact, sourceStep).map((finding, index) => (
    new CanonicalSourceFinding({
      identity: new FlowFindingSourceIdentity({
        sourceArtifact,
        sourceStep,
        sourceFindingId: stableSourceFindingId(sourceStep, finding, index),
        fingerprint: sourceFindingFingerprint(sourceStep, finding),
      }),
      finding,
    })
  )));
}
