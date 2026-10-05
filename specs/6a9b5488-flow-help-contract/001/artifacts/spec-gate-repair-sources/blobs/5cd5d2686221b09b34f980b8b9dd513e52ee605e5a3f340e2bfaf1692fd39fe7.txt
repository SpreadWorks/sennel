import crypto from "node:crypto";
import path from "node:path";

import { PRODUCT } from "../../lib/product.js";
import { draftReviewSourceStepIds } from "./draft-review-routes.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DRAFT_ARTIFACT_VERSION = 1;

export const DRAFT_ARTIFACT_FAILURE_MARKER_PREFIX = `${PRODUCT.env("DRAFT_ARTIFACT_FAILURE")} `;
export const DRAFT_ARTIFACT_WRITER_STEPS = Object.freeze([
  "draft", "draft-questions-repair", "draft-refine", "draft-gate-repair", "draft-coverage-repair",
]);

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function requireDigest(value, field) {
  const digest = requireString(value, field);
  if (!SHA256_PATTERN.test(digest)) throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}

function requireByteLength(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function requireIsoTimestamp(value, field) {
  const timestamp = requireString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${field} must be an ISO timestamp`);
  return timestamp;
}

function reviewRecoveryCommand(phase) {
  return `sennel flow run review --phase ${phase === "draft-questions" ? "draft" : "draft-coverage"}`;
}

export class DraftArtifactRecoveryError extends Error {
  constructor(code, message, { recoveryCommand = null, cause = null, data = {} } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DraftArtifactRecoveryError";
    this.code = requireString(code, "draft artifact error code");
    this.recoveryCommand = recoveryCommand == null ? null : requireString(recoveryCommand, "draft artifact recovery command");
    this.data = Object.freeze({ ...data });
  }

  toMarkerLine() {
    return DRAFT_ARTIFACT_FAILURE_MARKER_PREFIX + JSON.stringify({
      code: this.code,
      message: this.message,
      recoveryCommand: this.recoveryCommand,
      data: this.data,
      retryBudgetConsumed: false,
    });
  }

  static fromMarkerLine(line) {
    if (typeof line !== "string" || !line.startsWith(DRAFT_ARTIFACT_FAILURE_MARKER_PREFIX)) return null;
    try {
      const input = JSON.parse(line.slice(DRAFT_ARTIFACT_FAILURE_MARKER_PREFIX.length));
      return new DraftArtifactRecoveryError(input.code, input.message, {
        recoveryCommand: input.recoveryCommand,
        data: input.data,
      });
    } catch {
      return null;
    }
  }
}

export class DraftArtifactSnapshot {
  constructor({ filePath, bytes }) {
    this.filePath = path.resolve(requireString(filePath, "draft artifact path"));
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("draft artifact bytes must be a non-empty Buffer");
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (cause) {
      throw new DraftArtifactRecoveryError(
        "DRAFT_ARTIFACT_INVALID",
        `draft artifact is not valid JSON: ${this.filePath}: ${cause.message}`,
        { cause },
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DraftArtifactRecoveryError("DRAFT_ARTIFACT_INVALID", `draft artifact must contain a JSON object: ${this.filePath}`);
    }
    this.bytes = Buffer.from(bytes);
    this.digest = crypto.createHash("sha256").update(this.bytes).digest("hex");
    this.byteLength = this.bytes.length;
    this.document = Object.freeze(structuredClone(parsed));
    Object.freeze(this);
  }
}

export class DraftArtifactRevision {
  constructor(input = {}) {
    if (input.version !== DRAFT_ARTIFACT_VERSION) throw new Error(`draft artifact revision version must be ${DRAFT_ARTIFACT_VERSION}`);
    this.version = DRAFT_ARTIFACT_VERSION;
    this.runId = requireString(input.runId, "draft artifact revision runId");
    this.specId = requireString(input.specId, "draft artifact revision specId");
    this.sourceStepId = requireString(input.sourceStepId, "draft artifact revision sourceStepId");
    this.digest = requireDigest(input.digest, "draft artifact revision digest");
    this.byteLength = requireByteLength(input.byteLength, "draft artifact revision byteLength");
    this.finalizedAt = requireIsoTimestamp(input.finalizedAt, "draft artifact revision finalizedAt");
    Object.freeze(this);
  }

  static from(value) { return value instanceof DraftArtifactRevision ? value : new DraftArtifactRevision(value); }

  assertFlow(state) {
    if (state?.runId !== this.runId || state?.specId !== this.specId) {
      throw new DraftArtifactRecoveryError("DRAFT_ARTIFACT_BINDING_MISMATCH", "draft artifact revision does not match the active Flow target");
    }
  }

  matchesSnapshot(snapshot) { return snapshot.digest === this.digest && snapshot.byteLength === this.byteLength; }
  matches(value) {
    try { return JSON.stringify(this.toJSON()) === JSON.stringify(DraftArtifactRevision.from(value).toJSON()); }
    catch { return false; }
  }

  assertReviewSource(phase) {
    const allowedSources = draftReviewSourceStepIds(phase);
    if (allowedSources !== null && !allowedSources.includes(this.sourceStepId)) {
      throw new DraftArtifactRecoveryError(
        "DRAFT_REVIEW_REVISION_STALE",
        `${phase} review requires a draft finalized by its immediately preceding draft-writing step`,
        { recoveryCommand: reviewRecoveryCommand(phase), data: { phase, sourceStepId: this.sourceStepId } },
      );
    }
  }

  assertCurrentReview(state, phase) {
    this.assertFlow(state);
    this.assertReviewSource(phase);
    if (!this.matches(state?.draftArtifactRevision)) {
      throw new DraftArtifactRecoveryError(
        "DRAFT_REVIEW_REVISION_CHANGED",
        "draft review artifact does not match the current finalized draft revision",
        { data: { phase, reviewedDigest: this.digest } },
      );
    }
  }

  toJSON() {
    return {
      version: this.version,
      runId: this.runId,
      specId: this.specId,
      sourceStepId: this.sourceStepId,
      digest: this.digest,
      byteLength: this.byteLength,
      finalizedAt: this.finalizedAt,
    };
  }
}

/** Retired mutable publication state is rejected rather than replayed. */
export class DraftArtifactPromotion {
  constructor() {
    throw new DraftArtifactRecoveryError(
      "DRAFT_ARTIFACT_INVALID",
      "mutable draft promotion state is retired; use the canonical artifact catalog",
    );
  }
  static from(value) { return new DraftArtifactPromotion(value); }
}

export function completeDraftArtifactStep() {
  throw new DraftArtifactRecoveryError(
    "DRAFT_ARTIFACT_INVALID",
    "filesystem draft promotion is retired; publish draft through the canonical Store",
  );
}
