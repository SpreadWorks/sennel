import { createHash } from "node:crypto";
import { stableJson } from "./review-work-unit-values.js";
import { requireString, requireDigest } from "./flow-value-assertions.js";

/** One immutable catalog input consumed by the retro stale-evidence route. */
export class RetroStaleEvidencePublication {
  constructor({ logicalKey, relativePath, hash, activityId } = {}) {
    this.logicalKey = requireString(logicalKey, "retro stale evidence logicalKey");
    if (!new Set(["test.execute", "test.result.review"]).has(this.logicalKey)) {
      throw new Error("retro stale evidence logicalKey is invalid");
    }
    this.relativePath = requireString(relativePath, "retro stale evidence relativePath");
    this.hash = requireDigest(hash, "retro stale evidence hash");
    this.activityId = requireString(activityId, "retro stale evidence activityId");
    Object.freeze(this);
  }

  toJSON() {
    return {
      logicalKey: this.logicalKey,
      relativePath: this.relativePath,
      hash: this.hash,
      activityId: this.activityId,
    };
  }
}

/** Canonical facts for the fixed retro -> test-execute stale-evidence recovery. */
export class RetroStaleEvidenceRecoveryFacts {
  constructor({ runId, specId, stepId, attemptId, sequence, snapshotRevision, publications, artifactNames, previousFingerprint, currentFingerprint } = {}) {
    this.runId = requireString(runId, "retro stale evidence runId");
    this.specId = requireString(specId, "retro stale evidence specId");
    this.stepId = requireString(stepId, "retro stale evidence stepId");
    if (this.stepId !== "retro") throw new Error("retro stale evidence facts require the retro Step");
    this.attemptId = requireString(attemptId, "retro stale evidence Attempt id");
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("retro stale evidence Attempt sequence is invalid");
    this.sequence = sequence;
    this.snapshotRevision = requireString(snapshotRevision, "retro stale evidence snapshot revision");
    if (!Array.isArray(publications) || publications.length !== 2) {
      throw new Error("retro stale evidence facts require exactly two catalog publications");
    }
    this.publications = Object.freeze(publications.map((entry) => (
      entry instanceof RetroStaleEvidencePublication ? entry : new RetroStaleEvidencePublication(entry)
    )).sort((left, right) => left.logicalKey.localeCompare(right.logicalKey)));
    if (new Set(this.publications.map((entry) => entry.logicalKey)).size !== this.publications.length) {
      throw new Error("retro stale evidence catalog publications must be unique");
    }
    if (!Array.isArray(artifactNames) || artifactNames.length === 0
      || artifactNames.some((entry) => typeof entry !== "string" || entry === "")) {
      throw new Error("retro stale evidence artifact names are required");
    }
    this.artifactNames = Object.freeze([...new Set(artifactNames)].sort());
    this.previousFingerprint = requireDigest(previousFingerprint, "retro stale evidence previous fingerprint");
    this.currentFingerprint = requireDigest(currentFingerprint, "retro stale evidence current fingerprint");
    if (this.previousFingerprint === this.currentFingerprint) {
      throw new Error("retro stale evidence recovery requires mismatched fingerprints");
    }
    this.catalogFingerprint = createHash("sha256").update(stableJson(this.publications.map((entry) => entry.toJSON()))).digest("hex");
    Object.freeze(this);
  }

  static fromJSON(value) { return new this(value); }

  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      stepId: this.stepId,
      attemptId: this.attemptId,
      sequence: this.sequence,
      snapshotRevision: this.snapshotRevision,
      publications: this.publications.map((entry) => entry.toJSON()),
      artifactNames: [...this.artifactNames],
      previousFingerprint: this.previousFingerprint,
      currentFingerprint: this.currentFingerprint,
      catalogFingerprint: this.catalogFingerprint,
    };
  }
}
