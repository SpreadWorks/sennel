/**
 * Catalog-backed acceptance handoff for a non-semantic checkpoint.
 *
 * The handoff is a bounded index, never a root sidecar: its source evidence,
 * the index itself, and the deferred finding are all resolved through the
 * active Version Store.
 */

import crypto from "node:crypto";
import {
  buildDeferredFlowFindingPublication,
  DeferredFlowFindingsPublication,
  FlowFindingSourceIdentity,
  MAX_SOURCE_ARTIFACT_READ_BYTES,
  normalizeSourceArtifactPath,
  readCatalogedSourceArtifact,
} from "./flow-findings.js";
import {
  CanonicalFlowArtifactBaseline,
  CanonicalFlowArtifactWrite,
} from "./current-flow-state.js";

export const NONBLOCKING_HANDOFF_LOGICAL_KEY = "nonblocking.handoffs";

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function evidencePayloadBytes(source) {
  return Buffer.from(`${JSON.stringify(source.payload, null, 2)}\n`, "utf8");
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function canonicalFlowState(flowState) {
  if (flowState?.schemaRevision !== 3 || typeof flowState.specId !== "string" || flowState.specId === "") {
    throw new Error("nonblocking handoff requires a Version-1 Flow state");
  }
  return flowState;
}

function jsonFromBytes(bytes, field) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${field} must be JSON: ${error.message}`);
  }
}

export class NonBlockingHandoffFinding {
  constructor({ findingId, fingerprint, sourceStep, sourceArtifact, evidenceDigest, resultKind } = {}) {
    this.findingId = requireString(findingId, "findingId");
    if (!/^[a-f0-9]{64}$/.test(fingerprint || "")) throw new Error("handoff finding fingerprint must be SHA-256");
    this.fingerprint = fingerprint;
    this.sourceStep = requireString(sourceStep, "sourceStep");
    this.sourceArtifact = normalizeSourceArtifactPath(sourceArtifact, "sourceArtifact");
    if (!/^[a-f0-9]{64}$/.test(evidenceDigest || "")) throw new Error("handoff evidenceDigest must be SHA-256");
    this.evidenceDigest = evidenceDigest;
    if (!["quality", "tooling", "unavailable"].includes(resultKind)) {
      throw new Error("handoff resultKind is invalid");
    }
    this.resultKind = resultKind;
    Object.freeze(this);
  }

  toJSON() {
    return {
      findingId: this.findingId,
      fingerprint: this.fingerprint,
      sourceStep: this.sourceStep,
      sourceArtifact: this.sourceArtifact,
      evidenceDigest: this.evidenceDigest,
      resultKind: this.resultKind,
    };
  }
}

export class NonBlockingHandoffArtifact {
  constructor({ version = 1, findings = [] } = {}) {
    if (version !== 1) throw new Error("nonblocking handoff version is invalid");
    if (!Array.isArray(findings)) throw new Error("nonblocking handoff findings must be an array");
    this.version = 1;
    this.findings = Object.freeze(findings.map((entry) => (
      entry instanceof NonBlockingHandoffFinding ? entry : new NonBlockingHandoffFinding(entry)
    )));
    Object.freeze(this);
  }

  toJSON() {
    return { version: this.version, findings: this.findings.map((finding) => finding.toJSON()) };
  }
}

/** Both acceptance indexes prepared for one lifecycle Activity commit. */
export class NonBlockingAcceptanceHandoffPublication {
  constructor({ handoffWrite, handoffBaseline, findingsPublication, finding } = {}) {
    if (!(handoffWrite instanceof CanonicalFlowArtifactWrite)
      || handoffWrite.artifact.logicalKey !== NONBLOCKING_HANDOFF_LOGICAL_KEY
      || !(handoffBaseline instanceof CanonicalFlowArtifactBaseline)
      || handoffBaseline.artifact.logicalKey !== NONBLOCKING_HANDOFF_LOGICAL_KEY
      || !(findingsPublication instanceof DeferredFlowFindingsPublication)
      || !(finding instanceof NonBlockingHandoffFinding)) {
      throw new Error("nonblocking acceptance handoff publication is invalid");
    }
    const deferred = findingsPublication.deferred;
    const sourceIdentity = new FlowFindingSourceIdentity({
      sourceArtifact: handoffWrite.artifact.relativePath,
      sourceStep: finding.sourceStep,
      sourceFindingId: finding.findingId,
      fingerprint: finding.fingerprint,
    });
    if (deferred.length !== 1 || !deferred[0].sourceIdentity().equals(sourceIdentity)) {
      throw new Error("nonblocking acceptance handoff publication does not bind its deferred finding");
    }
    this.handoffWrite = handoffWrite;
    this.handoffBaseline = handoffBaseline;
    this.findingsPublication = findingsPublication;
    this.finding = finding;
    Object.freeze(this);
  }

  settlementArtifacts() {
    const findings = this.findingsPublication.settlementArtifacts();
    return Object.freeze({
      artifactWrites: Object.freeze([
        this.handoffWrite,
        ...findings.artifactWrites,
      ]),
      artifactBaselines: Object.freeze([
        this.handoffBaseline,
        ...findings.artifactBaselines,
      ]),
    });
  }
}

/**
 * Prepare the handoff and its acceptance finding from one catalog snapshot.
 * The owning continuation Activity publishes both indexes atomically.
 */
export function buildNonblockingAcceptanceHandoffPublication({
  flowManager,
  flowState,
  nodeId,
  sourceStep,
  evidenceRef,
  evidenceDigest,
  resultKind,
  attempts,
  rationale,
} = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("nonblocking handoff attempts must be a positive integer");
  }
  const state = canonicalFlowState(flowState);
  const source = readCatalogedSourceArtifact({
    flowManager,
    flowState: state,
    nodeId: requireString(nodeId, "nonblocking handoff nodeId"),
    sourceArtifact: normalizeSourceArtifactPath(evidenceRef, "evidenceRef"),
  });
  if (source === null) {
    throw new Error(`canonical handoff evidence is absent from catalog: ${evidenceRef}`);
  }
  if (source.bytes.length > MAX_SOURCE_ARTIFACT_READ_BYTES || digest(evidencePayloadBytes(source)) !== evidenceDigest) {
    throw new Error("nonblocking handoff evidence digest does not match cataloged source");
  }
  const existing = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: NONBLOCKING_HANDOFF_LOGICAL_KEY,
    consumerNodeId: nodeId,
    optional: true,
  });
  const artifact = new NonBlockingHandoffArtifact(existing === null
    ? {}
    : jsonFromBytes(existing.bytes, "canonical nonblocking handoff"));
  const fingerprint = digest(`${sourceStep}\u0000${evidenceDigest}`);
  const finding = artifact.findings.find((entry) => (
    entry.sourceStep === sourceStep && entry.evidenceDigest === evidenceDigest
  )) ?? new NonBlockingHandoffFinding({
    findingId: `NB-${fingerprint.slice(0, 16)}`,
    fingerprint,
    sourceStep,
    sourceArtifact: source.relativePath,
    evidenceDigest,
    resultKind,
  });
  const handoff = artifact.findings.includes(finding)
    ? artifact
    : new NonBlockingHandoffArtifact({ findings: [...artifact.findings, finding] });
  const handoffWrite = new CanonicalFlowArtifactWrite({
    logicalKey: NONBLOCKING_HANDOFF_LOGICAL_KEY,
    mediaType: "application/json",
    bytes: Buffer.from(`${JSON.stringify(handoff.toJSON(), null, 2)}\n`, "utf8"),
  });
  const findingsPublication = buildDeferredFlowFindingPublication({
    flowManager,
    flowState: state,
    nodeId,
    sourceStep,
    sourceArtifact: handoffWrite.artifact.relativePath,
    sourceFindingId: finding.findingId,
    fingerprint,
    rationale,
    attempts,
    finalDisposition: "still_open",
  });
  return new NonBlockingAcceptanceHandoffPublication({
    handoffWrite,
    handoffBaseline: new CanonicalFlowArtifactBaseline({
      logicalKey: NONBLOCKING_HANDOFF_LOGICAL_KEY,
      digest: existing?.descriptor.hash ?? null,
      byteLength: existing?.bytes.length ?? 0,
    }),
    findingsPublication,
    finding,
  });
}
