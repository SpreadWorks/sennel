/**
 * Typed, persisted observations used by the final-regression Definition.
 * This module intentionally describes evidence only: it never recommends a
 * route, retry budget, or command action.
 */
import crypto from "node:crypto";
import { NonGateStepFacts } from "./non-gate-transition.js";

/** Stable guarded user-action name; Definition binds it to canonical facts. */
export const FINAL_REGRESSION_RECORD_AND_PROCEED_ACTION_ID = "ACCEPT_FINAL_REGRESSION_FAILURE";

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function count(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function digest(value, field) {
  const normalized = text(value, field);
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${field} must be a SHA-256 digest`);
  return normalized;
}

export class FinalRegressionArtifactDigest {
  constructor({ value } = {}) { this.value = digest(value, "final-regression artifact digest"); Object.freeze(this); }
  toJSON() { return { value: this.value }; }

  static fromArtifact(artifact) {
    if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error("final-regression artifact digest requires an artifact");
    }
    return new FinalRegressionArtifactDigest({
      value: crypto.createHash("sha256").update(JSON.stringify(artifact)).digest("hex"),
    });
  }
}

export class FinalRegressionFailureProfileFact {
  constructor({ kind = null, category = null } = {}) {
    if (kind !== null) text(kind, "final-regression failure kind");
    if (category !== null) text(category, "final-regression failure category");
    this.kind = kind;
    this.category = category;
    Object.freeze(this);
  }
  get tooling() { return this.category === "environment" || this.category === "sandbox" || this.category === "timeout" || this.category === "dependency"; }
  get currentChange() { return this.category === "caused_by_current_change"; }
  get existing() { return this.category === "existing_failure"; }
  toJSON() { return { kind: this.kind, category: this.category }; }
}

export class FinalRegressionRetryHistory {
  constructor({ used = 0, maximum = 1 } = {}) {
    this.used = count(used, "final-regression retry used");
    this.maximum = count(maximum, "final-regression retry maximum");
    if (this.maximum < 1) throw new Error("final-regression retry maximum must be positive");
    Object.freeze(this);
  }
  get exhausted() { return this.used >= this.maximum; }
  toJSON() { return { used: this.used, maximum: this.maximum }; }
}

export class FinalRegressionChangedFileSnapshot {
  constructor({ digest: value, current = true } = {}) { this.digest = digest(value, "final-regression changed-file snapshot digest"); if (typeof current !== "boolean") throw new Error("final-regression changed-file snapshot current must be boolean"); this.current = current; Object.freeze(this); }
  toJSON() { return { digest: this.digest, current: this.current }; }
}

export class FinalRegressionProceedEvidence {
  constructor({ accepted = false, digest: value = null } = {}) {
    if (typeof accepted !== "boolean") throw new Error("final-regression record-and-proceed accepted must be boolean");
    if (accepted && value === null) throw new Error("final-regression accepted record-and-proceed requires evidence digest");
    this.accepted = accepted;
    this.digest = value === null ? null : digest(value, "final-regression record-and-proceed evidence digest");
    Object.freeze(this);
  }
  toJSON() { return { accepted: this.accepted, digest: this.digest }; }

  static fromRecord(record) {
    const accepted = record?.validated === true;
    if (!accepted) return new FinalRegressionProceedEvidence();
    const evidence = {
      evidence: text(record.evidence, "final-regression record evidence"),
      failureClassification: text(record.failureClassification, "final-regression record failure classification"),
      operatorJustification: text(record.operatorJustification, "final-regression record operator justification"),
      remainingRisk: text(record.remainingRisk, "final-regression record remaining risk"),
      executionBinding: record.executionBinding,
    };
    if (evidence.executionBinding === null || typeof evidence.executionBinding !== "object" || Array.isArray(evidence.executionBinding)) {
      throw new Error("final-regression record execution binding is required");
    }
    return new FinalRegressionProceedEvidence({
      accepted: true,
      digest: crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    });
  }
}

export class FinalRegressionNonblockingPolicy {
  constructor({ enabled = false } = {}) { if (typeof enabled !== "boolean") throw new Error("final-regression nonblocking policy enabled must be boolean"); this.enabled = enabled; Object.freeze(this); }
  toJSON() { return { enabled: this.enabled }; }
}

export class FinalRegressionStepFacts extends NonGateStepFacts {
  constructor({ result, artifactDigest, failure = {}, retry = {}, changedFileSnapshot, recordAndProceed = {}, nonblocking = {}, failureRecorded = false } = {}) {
    if (!new Set(["pass", "skipped", "fail"]).has(result)) throw new Error("final-regression result is invalid");
    const digest = artifactDigest instanceof FinalRegressionArtifactDigest ? artifactDigest : new FinalRegressionArtifactDigest(artifactDigest);
    const profile = failure instanceof FinalRegressionFailureProfileFact ? failure : new FinalRegressionFailureProfileFact(failure);
    const history = retry instanceof FinalRegressionRetryHistory ? retry : new FinalRegressionRetryHistory(retry);
    const snapshot = changedFileSnapshot instanceof FinalRegressionChangedFileSnapshot ? changedFileSnapshot : new FinalRegressionChangedFileSnapshot(changedFileSnapshot);
    const evidence = recordAndProceed instanceof FinalRegressionProceedEvidence ? recordAndProceed : new FinalRegressionProceedEvidence(recordAndProceed);
    const policy = nonblocking instanceof FinalRegressionNonblockingPolicy ? nonblocking : new FinalRegressionNonblockingPolicy(nonblocking);
    if (typeof failureRecorded !== "boolean") throw new Error("final-regression failureRecorded must be boolean");
    super({ kind: "final-regression", values: { result, artifactDigest: digest.toJSON(), failure: profile.toJSON(), retry: history.toJSON(), changedFileSnapshot: snapshot.toJSON(), recordAndProceed: evidence.toJSON(), nonblocking: policy.toJSON(), failureRecorded } });
  }
  get result() { return this.value("result"); }
  get artifactDigest() { return new FinalRegressionArtifactDigest(this.value("artifactDigest")); }
  get failure() { return new FinalRegressionFailureProfileFact(this.value("failure")); }
  get retryHistory() { return new FinalRegressionRetryHistory(this.value("retry")); }
  get changedFileSnapshot() { return new FinalRegressionChangedFileSnapshot(this.value("changedFileSnapshot")); }
  get recordAndProceed() { return new FinalRegressionProceedEvidence(this.value("recordAndProceed")); }
  get nonblockingPolicy() { return new FinalRegressionNonblockingPolicy(this.value("nonblocking")); }
  get failureRecorded() { return this.value("failureRecorded"); }
  toJSON() { return { kind: this.kind, values: { result: this.result, artifactDigest: this.artifactDigest.toJSON(), failure: this.failure.toJSON(), retry: this.retryHistory.toJSON(), changedFileSnapshot: this.changedFileSnapshot.toJSON(), recordAndProceed: this.recordAndProceed.toJSON(), nonblocking: this.nonblockingPolicy.toJSON(), failureRecorded: this.failureRecorded } }; }

  static fromPersisted(value) {
    if (value?.kind !== "final-regression" || value.values === null || typeof value.values !== "object") {
      throw new Error("persisted final-regression facts are invalid");
    }
    return new FinalRegressionStepFacts({
      result: value.values.result,
      artifactDigest: value.values.artifactDigest,
      failure: value.values.failure,
      retry: value.values.retry,
      changedFileSnapshot: value.values.changedFileSnapshot,
      recordAndProceed: value.values.recordAndProceed,
      nonblocking: value.values.nonblocking,
      failureRecorded: value.values.failureRecorded,
    });
  }

  /** Builds facts from persisted artifact bytes plus canonical snapshot values. */
  static fromCanonicalArtifact({ artifact, artifactDigest, retry, changedFileSnapshot, nonblocking = false, failureRecorded = false } = {}) {
    if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error("final-regression canonical artifact is required");
    return new FinalRegressionStepFacts({
      result: artifact.result,
      artifactDigest: { value: artifactDigest },
      failure: { kind: artifact.failureKind ?? null, category: artifact.failureCategory ?? null },
      retry,
      changedFileSnapshot,
      recordAndProceed: FinalRegressionProceedEvidence.fromRecord(artifact.recordAndProceed),
      nonblocking: { enabled: nonblocking },
      failureRecorded,
    });
  }
}
