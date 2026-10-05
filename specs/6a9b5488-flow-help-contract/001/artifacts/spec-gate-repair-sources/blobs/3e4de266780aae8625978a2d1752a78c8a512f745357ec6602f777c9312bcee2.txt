/**
 * Canonical implementation-review finding readiness for the integration Gate.
 *
 * This module deliberately contains no transition selection.  It converts the
 * persisted review/triage/repair evidence into a typed fact consumed only by
 * definition.js.
 */
import { FindingDispositionPolicy, ReviewFindingGateArtifact } from "./finding-disposition-policy.js";

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Immutable, serializable finding readiness result; it never decides a route. */
export class ReviewFindingGateReadiness {
  constructor({ artifact, decision, reviewFingerprints = [], triageFingerprint = null, repairFingerprint = null } = {}) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error("review finding readiness requires a cataloged review artifact");
    }
    if (!decision || typeof decision.allowsPass !== "function" || typeof decision.toJSON !== "function") {
      throw new Error("review finding readiness requires a typed finding decision");
    }
    if (!Array.isArray(reviewFingerprints) || reviewFingerprints.some((value) => typeof value !== "string" || value === "")) {
      throw new Error("review finding readiness review fingerprints are invalid");
    }
    this.artifact = Object.freeze(structuredClone(artifact));
    this.decision = decision;
    this.status = decision.allowsPass() ? "ready" : "blocking";
    this.findingFingerprints = Object.freeze((decision.blocks || []).map((block) => requiredText(
      block.finding?.fingerprint,
      "review finding readiness finding fingerprint",
    )).sort());
    this.reviewFingerprints = Object.freeze([...reviewFingerprints]);
    this.triageFingerprint = triageFingerprint == null ? null : requiredText(triageFingerprint, "review finding readiness triage fingerprint");
    this.repairFingerprint = repairFingerprint == null ? null : requiredText(repairFingerprint, "review finding readiness repair fingerprint");
    this.decisionFingerprint = stableJson(decision.toJSON());
    Object.freeze(this);
  }

  get allowsPass() { return this.status === "ready"; }

  toJSON() {
    return {
      status: this.status,
      findingFingerprints: [...this.findingFingerprints],
      reviewFingerprints: [...this.reviewFingerprints],
      triageFingerprint: this.triageFingerprint,
      repairFingerprint: this.repairFingerprint,
      decisionFingerprint: this.decisionFingerprint,
    };
  }
}

/** Derive finding readiness from canonical review artifacts; Definition owns all routing. */
export function evaluateReviewFindingGateReadiness({
  reviewArtifacts = [], phase, taskId = null, issueLog = null,
  triage = null, repairLedger = null, runId = null, supersedesHistory = false,
  reviewFingerprints = [], triageFingerprint = null, repairFingerprint = null,
  resolvedFindingIds = [],
} = {}) {
  const expectedTaskId = taskId == null ? null : String(taskId).trim();
  const artifacts = reviewArtifacts.filter((artifact) => (
    (artifact?.taskId == null ? null : String(artifact.taskId).trim()) === expectedTaskId
  ));
  const latest = artifacts.at(-1) ?? null;
  if (latest === null) throw new Error("cataloged implementation review artifact is missing");
  const obligations = new Map();
  const latestFingerprint = latest.repairFingerprint ?? null;
  for (const raw of artifacts) {
    if (runId !== null && raw.runId != null && raw.runId !== runId) continue;
    if (supersedesHistory && latestFingerprint !== null && raw.repairFingerprint != null && raw.repairFingerprint !== latestFingerprint) continue;
    if (Array.isArray(raw.blockingFindings) && raw.blockingFindings.length === 0 && raw.verdict !== "REJECTED") continue;
    const parsed = new ReviewFindingGateArtifact(raw, { source: "catalog:impl.review" });
    for (const finding of parsed.findings) obligations.set(finding.fingerprint, finding);
  }
  if (!Array.isArray(resolvedFindingIds) || resolvedFindingIds.some((value) => typeof value !== "string" || value === "")) {
    throw new Error("review finding readiness resolved finding identities are invalid");
  }
  const rejected = new Set((triage?.items || [])
    .filter((item) => item?.decision === "reject")
    .map((item) => item.findingId));
  const resolved = new Set(resolvedFindingIds);
  const findings = [...obligations.values()].map((finding) => (
    rejected.has(finding.findingId) || resolved.has(finding.findingId)
      ? { ...finding.toJSON(), explicitDecision: { kind: "allow", findingFingerprint: finding.fingerprint } }
      : finding
  ));
  const decision = new FindingDispositionPolicy({ maxOccurrences: 3 }).evaluateGate({
    findings,
    issueLogEntries: issueLog?.entries || [],
    phase,
    taskId: expectedTaskId,
    repairDiff: repairLedger?.changedPathsDigest ?? null,
    ...(runId === null ? {} : { runId }),
  });
  return new ReviewFindingGateReadiness({
    artifact: latest,
    decision,
    reviewFingerprints,
    triageFingerprint,
    repairFingerprint,
  });
}
