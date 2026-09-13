import path from "node:path";
import crypto from "node:crypto";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { ReviewFindingCycle } from "./finding-disposition-policy.js";
import { RequirementTestFailureArtifact } from "./requirement-test-artifacts.js";
import {
  CanonicalFlowArtifactBaseline,
  CanonicalFlowArtifactWrite,
} from "./current-flow-state.js";

export const FLOW_FINDINGS_LOGICAL_KEY = "flow.findings";
export const MAX_FLOW_FINDINGS = 200;
export const MAX_SOURCE_REF_CHARS = 300;
export const MAX_MIRROR_FIELD_CHARS = 1000;
export const MAX_SOURCE_ARTIFACT_READ_BYTES = 1024 * 1024;
export const ACCEPTANCE_FINAL_DISPOSITIONS = Object.freeze([
  "fixed",
  "not_needed",
  "false_positive",
  "pre_existing",
  "still_open",
  "blocking",
]);

const ACCEPTANCE_FINAL_DISPOSITION_SET = new Set(ACCEPTANCE_FINAL_DISPOSITIONS);
const FORBIDDEN_DETAIL_FIELDS = Object.freeze(["summary", "reason", "details", "detail", "body", "message"]);

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_SOURCE_REF_CHARS) {
    throw new Error(`${field} exceeds ${MAX_SOURCE_REF_CHARS} characters`);
  }
  return value;
}

function requireMirrorString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_MIRROR_FIELD_CHARS) {
    throw new Error(`${field} exceeds ${MAX_MIRROR_FIELD_CHARS} characters`);
  }
  return value.trim();
}

function requireFindingFingerprint(value, field = "fingerprint") {
  const fingerprint = requireString(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error(`${field} must be a lowercase SHA-256 string`);
  }
  return fingerprint;
}

export function normalizeSourceArtifactPath(value, field = "sourceArtifact") {
  const source = requireString(value, field).split("\\").join("/");
  if (path.posix.isAbsolute(source) || path.win32.isAbsolute(source)) {
    throw new Error(`${field} must be relative to the spec directory`);
  }
  const normalized = path.posix.normalize(source);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${field} must stay inside the spec directory`);
  }
  return normalized;
}

function requireInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function validateFinalDisposition(value, field = "finalDisposition") {
  if (value === null) return null;
  if (typeof value !== "string" || !ACCEPTANCE_FINAL_DISPOSITION_SET.has(value)) {
    throw new Error(`${field} must be one of ${ACCEPTANCE_FINAL_DISPOSITIONS.join(", ")} or null`);
  }
  if (value.length > MAX_MIRROR_FIELD_CHARS) throw new Error(`${field} exceeds ${MAX_MIRROR_FIELD_CHARS} characters`);
  return value;
}

function rejectCopiedDetail(input = {}) {
  for (const field of FORBIDDEN_DETAIL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw new Error(`flow finding must not copy full finding detail field: ${field}`);
    }
  }
}

export class FlowFinding {
  constructor(input = {}) {
    rejectCopiedDetail(input);
    this.findingId = requireString(input.findingId, "findingId");
    this.sourceStep = requireString(input.sourceStep, "sourceStep");
    this.sourceArtifact = normalizeSourceArtifactPath(input.sourceArtifact, "sourceArtifact");
    this.sourceFindingId = requireString(input.sourceFindingId, "sourceFindingId");
    this.runId = input.runId == null ? null : requireString(input.runId, "runId");
    this.fingerprint = requireFindingFingerprint(input.fingerprint);
    this.disposition = requireString(input.disposition, "disposition");
    if (this.disposition !== "deferred") throw new Error("disposition must be deferred");
    this.rationale = requireMirrorString(input.rationale, "rationale");
    this.retryExhausted = requireBoolean(input.retryExhausted, "retryExhausted");
    this.attempts = requireInteger(input.attempts, "attempts");
    this.round = requireInteger(input.round, "round");
    this.completionKind = requireString(input.completionKind, "completionKind");
    if (this.completionKind !== "deferred") throw new Error("completionKind must be deferred");
    this.finalDisposition = validateFinalDisposition(
      Object.prototype.hasOwnProperty.call(input, "finalDisposition") ? input.finalDisposition : null,
    );
    this.planRewindAt = input.planRewindAt == null
      ? null
      : requireString(input.planRewindAt, "planRewindAt");
    Object.freeze(this);
  }

  toJSON() {
    return {
      findingId: this.findingId,
      sourceStep: this.sourceStep,
      sourceArtifact: this.sourceArtifact,
      sourceFindingId: this.sourceFindingId,
      runId: this.runId,
      fingerprint: this.fingerprint,
      disposition: this.disposition,
      rationale: this.rationale,
      retryExhausted: this.retryExhausted,
      attempts: this.attempts,
      round: this.round,
      completionKind: this.completionKind,
      finalDisposition: this.finalDisposition,
      ...(this.planRewindAt && { planRewindAt: this.planRewindAt }),
    };
  }
}

export class FlowFindingsArtifact {
  constructor(input = {}) {
    if (input.version != null && input.version !== 2) {
      throw new Error("flow findings version must be 2");
    }
    const entries = Array.isArray(input.entries) ? input.entries : [];
    if (entries.length > MAX_FLOW_FINDINGS) {
      throw new Error(`flow findings entry count exceeds ${MAX_FLOW_FINDINGS}`);
    }
    this.version = 2;
    this.entries = Object.freeze(entries.map((entry) => (
      entry instanceof FlowFinding ? entry : new FlowFinding(entry)
    )));
    Object.freeze(this);
  }

  toJSON() {
    return {
      version: this.version,
      entries: this.entries.map((entry) => entry.toJSON()),
    };
  }
}

/** One catalog observation of flow.findings and its compare-and-swap token. */
export class CanonicalFlowFindingsSnapshot {
  constructor({ artifact, baseline } = {}) {
    if (!(artifact instanceof FlowFindingsArtifact)) {
      throw new Error("flow findings snapshot requires a FlowFindingsArtifact");
    }
    if (!(baseline instanceof CanonicalFlowArtifactBaseline)
      || baseline.artifact.logicalKey !== FLOW_FINDINGS_LOGICAL_KEY) {
      throw new Error("flow findings snapshot requires a flow.findings baseline");
    }
    this.artifact = artifact;
    this.baseline = baseline;
    Object.freeze(this);
  }
}

/**
 * An immutable deferred-findings update prepared from one canonical snapshot.
 * The owner of the lifecycle Activity attaches its one artifact write to that
 * Activity, so finding publication cannot commit ahead of settlement.
 */
export class DeferredFlowFindingsPublication {
  constructor({ artifact, deferred, changed, baseline } = {}) {
    if (!(artifact instanceof FlowFindingsArtifact)) {
      throw new Error("deferred findings publication requires a FlowFindingsArtifact");
    }
    if (!Array.isArray(deferred) || deferred.some((entry) => !(entry instanceof FlowFinding))) {
      throw new Error("deferred findings publication requires typed findings");
    }
    if (typeof changed !== "boolean") throw new Error("deferred findings publication changed must be boolean");
    if (!(baseline instanceof CanonicalFlowArtifactBaseline)
      || baseline.artifact.logicalKey !== FLOW_FINDINGS_LOGICAL_KEY) {
      throw new Error("deferred findings publication requires a flow.findings baseline");
    }
    this.artifact = artifact;
    this.deferred = Object.freeze([...deferred]);
    this.changed = changed;
    this.baseline = baseline;
    Object.freeze(this);
  }

  artifactWrite() {
    if (!this.changed) return null;
    return new CanonicalFlowArtifactWrite({
      logicalKey: FLOW_FINDINGS_LOGICAL_KEY,
      mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(this.artifact.toJSON(), null, 2)}\n`, "utf8"),
    });
  }

  /** The sole catalog mutation permitted alongside a deferred lifecycle settlement. */
  settlementArtifacts() {
    const artifactWrite = this.artifactWrite();
    return Object.freeze({
      artifactWrites: Object.freeze(artifactWrite === null ? [] : [artifactWrite]),
      artifactBaselines: Object.freeze([this.baseline]),
    });
  }
}

function canonicalFlowState(flowState) {
  if (flowState?.schemaRevision !== 3 || typeof flowState.specId !== "string" || flowState.specId === "") {
    throw new Error("flow findings require a Version-1 Flow state");
  }
  return flowState;
}

function jsonFromArtifact(bytes, field) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("must contain an object");
    }
    return value;
  } catch (error) {
    throw new Error(`${field} must be JSON: ${error.message}`);
  }
}

function sourceLogicalKey(sourceArtifact) {
  const normalized = normalizeSourceArtifactPath(sourceArtifact);
  try {
    return FLOW_ARTIFACT_CONTRACTS.require(normalized).logicalKey.toString();
  } catch {
    // Collection logical keys require parameters only when resolving a path.
  }
  try {
    return FLOW_ARTIFACT_CONTRACTS.resolve(normalized).logicalKey;
  } catch {
    // A recorded finding stores the descriptor's canonical relative path,
    // while callers use its logical key. Both are catalog identities.
  }
  for (const contract of FLOW_ARTIFACT_CONTRACTS.inventory()) {
    if (contract.matchesCanonicalPath(normalized)) return contract.logicalKey.toString();
  }
  throw new Error(`sourceArtifact has no canonical catalog contract: ${normalized}`);
}

function sourcePayloads({ logicalKey, bytes }) {
  if (logicalKey === "spec.review") {
    const review = jsonFromArtifact(bytes, "canonical spec review");
    const findings = Array.isArray(review.findings) ? review.findings : [];
    return [{
      verdict: findings.some((finding) => finding?.kind === "blocking") ? "REJECTED" : "PASS",
      blockingFindings: findings.filter((finding) => finding?.kind === "blocking"),
      nonBlockingImprovements: findings.filter((finding) => finding?.kind !== "blocking"),
      canonicalReview: review,
    }];
  }
  try {
    const attempts = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey, bytes }).attempts;
    if (attempts.length > 0) return attempts.map((attempt) => attempt.payload);
  } catch {}
  return [jsonFromArtifact(bytes, `canonical ${logicalKey}`)];
}

/** Cataloged finding source retaining every immutable producer Attempt. */
export class CanonicalFlowFindingSourceArtifact {
  constructor({ logicalKey, relativePath, descriptor, bytes, payloads } = {}) {
    this.logicalKey = requireString(logicalKey, "finding source logicalKey");
    this.relativePath = requireString(relativePath, "finding source relativePath");
    if (!Buffer.isBuffer(bytes)) throw new Error("finding source bytes must be a Buffer");
    if (!Array.isArray(payloads) || payloads.length === 0) {
      throw new Error("finding source must retain at least one producer payload");
    }
    this.descriptor = descriptor;
    this.bytes = Buffer.from(bytes);
    this.payloads = Object.freeze(payloads.map((payload) => structuredClone(payload)));
    this.payload = this.payloads.at(-1);
    Object.freeze(this);
  }

  findFinding(sourceStep, sourceFindingId) {
    for (const payload of this.payloads.toReversed()) {
      const finding = findSourceFinding(payload, sourceStep, sourceFindingId);
      if (finding !== null) return finding;
    }
    return null;
  }
}

/**
 * One deep catalog boundary for deferred semantic findings. It owns both the
 * catalog read and the producer-authorized publication; callers never infer a
 * spec directory, reconstruct a source path, or write a sidecar file.
 */
export class CanonicalFlowFindingsStore {
  constructor({ flowManager, flowState, nodeId } = {}) {
    if (!flowManager || typeof flowManager.readArtifact !== "function" || typeof flowManager.readProducerArtifact !== "function" || typeof flowManager.publishArtifacts !== "function" || typeof flowManager.activityLedger !== "function") {
      throw new Error("canonical flow findings require FlowManager catalog APIs");
    }
    const state = canonicalFlowState(flowState);
    if (typeof nodeId !== "string" || nodeId === "") throw new Error("canonical flow findings nodeId is required");
    this.flowManager = flowManager;
    this.flowState = state;
    this.nodeId = nodeId;
    this.cycle = ReviewFindingCycle.fromActivityLedger({
      runId: state.runId,
      activities: flowManager.activityLedger(state.specId),
    });
    Object.freeze(this);
  }

  readSnapshot() {
    const resolved = this.flowManager.readArtifact({
      specId: this.flowState.specId,
      logicalKey: FLOW_FINDINGS_LOGICAL_KEY,
      consumerNodeId: this.nodeId,
      optional: true,
    });
    const artifact = new FlowFindingsArtifact(resolved === null ? { entries: [] } : jsonFromArtifact(
      resolved.bytes,
      "canonical flow findings",
    ));
    return new CanonicalFlowFindingsSnapshot({
      artifact,
      baseline: new CanonicalFlowArtifactBaseline({
        logicalKey: FLOW_FINDINGS_LOGICAL_KEY,
        digest: resolved?.descriptor.hash ?? null,
        byteLength: resolved?.descriptor.size ?? 0,
      }),
    });
  }

  read({ filterCurrentRun = false } = {}) {
    const artifact = this.readSnapshot().artifact;
    if (!filterCurrentRun) return artifact;
    return new FlowFindingsArtifact({
      entries: artifact.entries.filter((entry) => this.cycle.matchesArtifact(entry)),
    });
  }

  publish(artifact, { artifactBaselines = undefined } = {}) {
    const normalized = artifact instanceof FlowFindingsArtifact ? artifact : new FlowFindingsArtifact(artifact);
    this.flowManager.publishArtifacts({
      specId: this.flowState.specId,
      nodeId: this.nodeId,
      artifactWrites: [{
        logicalKey: FLOW_FINDINGS_LOGICAL_KEY,
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(normalized.toJSON(), null, 2)}\n`, "utf8"),
      }],
      ...(artifactBaselines === undefined ? {} : { artifactBaselines }),
    });
    return normalized;
  }

  sourceArtifact(sourceArtifact) {
    const logicalKey = sourceLogicalKey(sourceArtifact);
    if (logicalKey === "spec.review") {
      const current = this.flowManager.readCurrentSpecReview({
        specId: this.flowState.specId,
        consumerNodeId: this.nodeId,
      });
      const bytes = Buffer.from(current.bytes);
      const payloads = sourcePayloads({ logicalKey, bytes });
      return new CanonicalFlowFindingSourceArtifact({
        logicalKey,
        relativePath: current.descriptor.relativePath,
        descriptor: current.descriptor,
        bytes,
        payloads,
      });
    }
    const contract = FLOW_ARTIFACT_CONTRACTS.require(logicalKey);
    const taskArtifact = new Set(["task.review", "task.gate"]).has(logicalKey);
    const parameters = taskArtifact
      ? { taskId: this.flowState.currentTaskId }
      : logicalKey === "test.requirement.failure"
        ? RequirementTestFailureArtifact.fromRelativePath(sourceArtifact).parameters
        : {};
    const taskRole = logicalKey === "task.review" ? "review" : logicalKey === "task.gate" ? "gate" : null;
    const ownsTaskProducer = taskRole !== null
      && this.nodeId === `${this.flowState.currentTaskId}-${taskRole}`
      && contract.ownership.producers.includes(`task-${taskRole}`);
    const activeNodeId = this.flowState.currentNodeId ?? this.flowState.current?.at(-1) ?? null;
    const ownsFlowProducer = activeNodeId === this.nodeId
      && contract.ownership.producers.includes(this.nodeId);
    const resolved = (ownsFlowProducer || ownsTaskProducer)
      ? this.flowManager.readProducerArtifact({
        specId: this.flowState.specId,
        nodeId: this.nodeId,
        logicalKey,
        parameters,
        optional: true,
      })
      : this.flowManager.readArtifact({
        specId: this.flowState.specId,
        logicalKey,
        parameters,
        consumerNodeId: this.nodeId,
        optional: true,
      });
    if (resolved === null) return null;
    const bytes = Buffer.from(resolved.bytes);
    return new CanonicalFlowFindingSourceArtifact({
      logicalKey,
      relativePath: resolved.relativePath,
      descriptor: resolved.descriptor,
      bytes,
      payloads: sourcePayloads({ logicalKey, bytes }),
    });
  }
}

/** Resolve a cataloged source once, preserving its descriptor path and bytes. */
export function readCatalogedSourceArtifact({ flowManager, flowState, nodeId, sourceArtifact } = {}) {
  return new CanonicalFlowFindingsStore({ flowManager, flowState, nodeId })
    .sourceArtifact(sourceArtifact);
}

/** Catalog-only source lookup used by semantic finding classifiers. */
export function readBoundedSourceArtifact({ flowManager, flowState, nodeId, sourceArtifact } = {}) {
  return readCatalogedSourceArtifact({ flowManager, flowState, nodeId, sourceArtifact })?.payload ?? null;
}

export function sourceArtifactExists(input = {}) {
  return readBoundedSourceArtifact(input) !== null;
}

function nextFindingId(existing) {
  return `DF-${existing.entries.length + 1}`;
}

function nextRound(existing) {
  const rounds = existing.entries.map((entry) => Number(entry.round)).filter(Number.isInteger);
  return rounds.length === 0 ? 1 : Math.max(...rounds) + 1;
}

function appendDeferredFindingToArtifact({
  artifact,
  cycle,
  flowState,
  sourceStep,
  sourceArtifact,
  sourceFindingId,
  fingerprint,
  rationale,
  attempts,
  round = null,
  finalDisposition = null,
}) {
  const existing = artifact instanceof FlowFindingsArtifact ? artifact : new FlowFindingsArtifact(artifact);
  const planRewindAt = cycle.planRewindAt;
  const normalizedFingerprint = requireFindingFingerprint(fingerprint);
  const runId = flowState?.runId == null ? null : requireString(flowState.runId, "flowState.runId");
  const existingIndex = existing.entries.findIndex((entry) => (
    entry.fingerprint === normalizedFingerprint
      && entry.runId === runId
      && entry.planRewindAt === planRewindAt
  ));
  if (existingIndex >= 0) {
    const current = existing.entries[existingIndex];
    const entry = new FlowFinding({
      ...current.toJSON(),
      retryExhausted: true,
      attempts,
      round: round ?? attempts,
      completionKind: "deferred",
      disposition: "deferred",
      rationale: requireMirrorString(rationale, "rationale"),
      runId,
      finalDisposition: current.finalDisposition ?? finalDisposition,
      planRewindAt,
    });
    if (JSON.stringify(entry.toJSON()) === JSON.stringify(current.toJSON())) {
      return Object.freeze({ artifact: existing, entry, changed: false });
    }
    return Object.freeze({
      artifact: new FlowFindingsArtifact({
        entries: existing.entries.map((item, index) => (index === existingIndex ? entry : item)),
      }),
      entry,
      changed: true,
    });
  }
  const entry = new FlowFinding({
    findingId: nextFindingId(existing),
    sourceStep,
    sourceArtifact,
    sourceFindingId,
    fingerprint: normalizedFingerprint,
    disposition: "deferred",
    rationale: requireMirrorString(rationale, "rationale"),
    runId,
    retryExhausted: true,
    attempts,
    round: round ?? nextRound(existing),
    completionKind: "deferred",
    finalDisposition,
    planRewindAt,
  });
  return Object.freeze({
    artifact: new FlowFindingsArtifact({ entries: [...existing.entries, entry] }),
    entry,
    changed: true,
  });
}

/**
 * Prepare one deferred index entry for a source artifact that will be
 * published by the same Store transaction. The caller must already own and
 * validate that source write; this function only owns flow.findings CAS.
 */
export function buildDeferredFlowFindingPublication({
  flowManager,
  flowState,
  nodeId,
  sourceStep,
  sourceArtifact,
  sourceFindingId,
  fingerprint,
  rationale,
  attempts,
  round = null,
  finalDisposition = null,
} = {}) {
  const store = new CanonicalFlowFindingsStore({ flowManager, flowState, nodeId });
  const snapshot = store.readSnapshot();
  const update = appendDeferredFindingToArtifact({
    artifact: snapshot.artifact,
    cycle: store.cycle,
    flowState,
    sourceStep,
    sourceArtifact: normalizeSourceArtifactPath(sourceArtifact),
    sourceFindingId,
    fingerprint,
    rationale,
    attempts,
    round,
    finalDisposition,
  });
  return new DeferredFlowFindingsPublication({
    artifact: update.artifact,
    deferred: [update.entry],
    changed: update.changed,
    baseline: snapshot.baseline,
  });
}

export function buildDeferredFindingsSummary({ flowManager, flowState, nodeId }) {
  const artifact = new CanonicalFlowFindingsStore({ flowManager, flowState, nodeId }).read({ filterCurrentRun: true });
  const sourceSteps = [];
  const seen = new Set();
  for (const entry of artifact.entries) {
    if (seen.has(entry.sourceStep)) continue;
    seen.add(entry.sourceStep);
    sourceSteps.push(entry.sourceStep);
  }
  return {
    count: artifact.entries.length,
    sourceSteps,
    artifactPath: FLOW_ARTIFACT_CONTRACTS.resolve(FLOW_FINDINGS_LOGICAL_KEY).relativePath,
  };
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

function sourceFindingsForArtifact(artifact, sourceStep) {
  // Command-result artifacts retain the producer payload under `artifacts`.
  // Findings always inspect the evaluated payload, never the envelope.
  const source = artifact?.artifacts && typeof artifact.artifacts === "object" && !Array.isArray(artifact.artifacts)
    ? artifact.artifacts
    : artifact;
  const evaluations = failedEvaluations(source);
  if (evaluations.length > 0) return evaluations;
  const review = reviewBlockingFindings(source, sourceStep);
  if (review.length > 0) return review;
  return blockingObservations(source);
}

export function findSourceFinding(artifact, sourceStep, sourceFindingId) {
  return sourceFindingsForArtifact(artifact, sourceStep).find((finding, index) => (
    stableSourceFindingId(sourceStep, finding, index) === sourceFindingId
  )) || null;
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
    requirementId: String(finding?.requirementId || finding?.guardrail_id || "").trim(),
    category: String(finding?.category || finding?.failureMode || finding?.failureKind || "").trim(),
    file: String(finding?.file || finding?.location?.file || "").trim().replace(/\\/g, "/"),
    issue: String(finding?.issue || finding?.reason || finding?.title || "").trim(),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function sourceFindingRationale(finding) {
  return String(
    finding?.rationale
      || finding?.reason
      || finding?.whyBlocking
      || finding?.issue
      || finding?.title
      || "Retry exhaustion deferred this finding for bounded final disposition.",
  ).trim();
}

export function buildDeferredSemanticFindingsPublication({
  flowManager,
  flowState,
  nodeId,
  sourceStep,
  sourceArtifact,
  attempts,
  round = attempts,
  fingerprints = null,
  sourcePayload = null,
  sourceRelativePath = null,
} = {}) {
  const store = new CanonicalFlowFindingsStore({ flowManager, flowState, nodeId });
  if (sourcePayload !== null && (typeof sourceRelativePath !== "string" || sourceRelativePath === "")) {
    throw new Error("deferred source payload requires its canonical relative path");
  }
  const source = sourcePayload === null
    ? store.sourceArtifact(sourceArtifact)
    : Object.freeze({
        payload: structuredClone(sourcePayload),
        relativePath: sourceRelativePath,
      });
  const artifact = source?.payload ?? null;
  const selectedFingerprints = fingerprints instanceof Set ? fingerprints : null;
  const sourceFindings = sourceFindingsForArtifact(artifact, sourceStep).filter((finding) => (
    selectedFingerprints === null || selectedFingerprints.has(sourceFindingFingerprint(sourceStep, finding))
  ));
  const byFingerprint = new Map();
  sourceFindings.forEach((finding, index) => {
    const fingerprint = sourceFindingFingerprint(sourceStep, finding);
    if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, { finding, index });
  });
  const snapshot = store.readSnapshot();
  const existing = snapshot.artifact;
  let nextArtifact = existing;
  const deferred = [];
  for (const [fingerprint, { finding, index }] of byFingerprint) {
    const update = appendDeferredFindingToArtifact({
      artifact: nextArtifact,
      cycle: store.cycle,
      flowState,
      sourceStep,
      sourceArtifact: source.relativePath,
      sourceFindingId: stableSourceFindingId(sourceStep, finding, index),
      fingerprint,
      rationale: sourceFindingRationale(finding),
      attempts,
      round,
      finalDisposition: "still_open",
    });
    nextArtifact = update.artifact;
    deferred.push(update.entry);
  }
  return new DeferredFlowFindingsPublication({
    artifact: nextArtifact,
    deferred,
    changed: JSON.stringify(nextArtifact.toJSON()) !== JSON.stringify(existing.toJSON()),
    baseline: snapshot.baseline,
  });
}

export function deferExhaustedSemanticFindings(input = {}) {
  const publication = buildDeferredSemanticFindingsPublication(input);
  if (publication.changed) {
    new CanonicalFlowFindingsStore(input).publish(publication.artifact, {
      artifactBaselines: [publication.baseline],
    });
  }
  return {
    completed: true,
    blockedByRetryExhaustionOnly: false,
    deferred: publication.deferred,
  };
}

export function resolveRetryExhaustionForFlowStep({
  sourceArtifact,
} = {}) {
  return {
    stepDisposition: "continue",
    retryExhaustionOnlyStop: false,
    deferredTo: FLOW_ARTIFACT_CONTRACTS.resolve(FLOW_FINDINGS_LOGICAL_KEY).relativePath,
    sourceArtifact,
  };
}

export function mirrorFinalDispositions({ flowManager, flowState, nodeId, deferredFindings }) {
  const store = new CanonicalFlowFindingsStore({ flowManager, flowState, nodeId });
  const artifact = store.read();
  const byId = new Map((deferredFindings || []).map((finding) => [finding.findingId, finding.finalDisposition]));
  const entries = artifact.entries.map((entry) => new FlowFinding({
    ...entry.toJSON(),
    finalDisposition: byId.has(entry.findingId) ? byId.get(entry.findingId) : entry.finalDisposition,
  }));
  store.publish(new FlowFindingsArtifact({ entries }));
}
