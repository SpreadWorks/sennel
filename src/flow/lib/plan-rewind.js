import path from "node:path";

/**
 * Public value limits retained by the canonical reopen-draft command.
 *
 * Version-1 recovery itself is an Activity transition owned by the Store.
 * This module deliberately contains no mutable-state transformer, filesystem
 * inventory walker, or recovery writer.
 */
export const PLAN_REWIND_SUPPORTED_STAGES = Object.freeze([
  "impl-review",
  "impl-gate",
  "retro",
  "acceptance-review",
  "final-regression",
]);

export const SPEC_CORRECTION_SUPPORTED_STAGES = Object.freeze([
  "implement",
  ...PLAN_REWIND_SUPPORTED_STAGES,
]);

export const PLAN_REWIND_REVIEW_PHASES = Object.freeze([
  "draft-questions",
  "draft-coverage",
  "spec",
  "impl",
]);

export const PLAN_REWIND_GATE_PHASES = Object.freeze([
  "draft",
  "spec",
  "integration",
]);

export const PLAN_REWIND_EVIDENCE_KINDS = Object.freeze([
  "approval",
  "draft-review",
  "spec-review",
  "plan-gate",
  "test-execute",
  "test-result-review",
  "implementation",
  "impl-review",
  "impl-gate",
  "retro",
  "acceptance-review",
  "flow-findings",
  "completion-overrides",
  "final-regression",
]);

export const PLAN_REWIND_LIMITS = Object.freeze({
  maxReasonChars: 500,
  maxPathChars: 1000,
  maxEvidenceFiles: 500,
  maxEvidenceBytes: 268435456,
  hashChunkBytes: 65536,
  maxAuditRecords: 100,
});

export class PlanRewindError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PlanRewindError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PlanRewindError(code, message);
}

function requireString(value, field, maxChars = null) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("PLAN_REWIND_INVALID_REQUEST", `${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (maxChars != null && normalized.length > maxChars) {
    fail("PLAN_REWIND_INVALID_REQUEST", `${field} exceeds ${maxChars} characters`);
  }
  return normalized;
}

function requireIso(value, field) {
  const normalized = requireString(value, field);
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) fail("PLAN_REWIND_INVALID_REQUEST", `${field} must be ISO 8601`);
  return new Date(parsed).toISOString();
}

function normalizeEvidencePath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("PLAN_REWIND_INVALID_EVIDENCE", "evidence path must be non-empty");
  }
  const portable = value.replaceAll("\\", "/");
  if (portable.length > PLAN_REWIND_LIMITS.maxPathChars) {
    fail("PLAN_REWIND_INVALID_EVIDENCE", `evidence path exceeds ${PLAN_REWIND_LIMITS.maxPathChars} characters`);
  }
  const normalized = path.posix.normalize(portable);
  if (
    path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    fail("PLAN_REWIND_INVALID_EVIDENCE", "evidence path must stay inside the Version directory");
  }
  return normalized;
}

export class PlanRewindEvidence {
  constructor(input = {}) {
    this.path = normalizeEvidencePath(input.path);
    if (!Number.isSafeInteger(input.size) || input.size < 0) {
      fail("PLAN_REWIND_INVALID_EVIDENCE", "evidence size must be a non-negative safe integer");
    }
    this.size = input.size;
    this.mtime = requireIso(input.mtime, "evidence mtime");
    if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)) {
      fail("PLAN_REWIND_INVALID_EVIDENCE", "evidence sha256 must be a lowercase SHA-256 digest");
    }
    this.sha256 = input.sha256;
    Object.freeze(this);
  }

  toJSON() {
    return { path: this.path, size: this.size, mtime: this.mtime, sha256: this.sha256 };
  }
}

export class PlanRewindRequest {
  constructor(input = {}) {
    this.runId = requireString(input.runId, "runId", 128);
    if (!Number.isSafeInteger(input.issue) || input.issue < 1) {
      fail("PLAN_REWIND_INVALID_REQUEST", "issue must be a positive safe integer");
    }
    this.issue = input.issue;
    this.specId = requireString(input.specId, "specId", PLAN_REWIND_LIMITS.maxPathChars);
    this.sourceStage = requireString(input.sourceStage, "sourceStage", 100);
    this.destinationStep = requireString(input.destinationStep, "destinationStep", 100);
    try {
      this.reason = requireString(input.reason, "reason", PLAN_REWIND_LIMITS.maxReasonChars);
    } catch (error) {
      if (error instanceof PlanRewindError) {
        throw new PlanRewindError("PLAN_REWIND_INVALID_REASON", error.message);
      }
      throw error;
    }
    this.rewoundAt = requireIso(input.rewoundAt, "rewoundAt");
    this.invalidatedApprovalConfirmedAt = input.invalidatedApprovalConfirmedAt == null
      ? null
      : requireIso(input.invalidatedApprovalConfirmedAt, "invalidatedApprovalConfirmedAt");
    Object.freeze(this);
  }

  toJSON() {
    return {
      runId: this.runId,
      issue: this.issue,
      specId: this.specId,
      sourceStage: this.sourceStage,
      destinationStep: this.destinationStep,
      reason: this.reason,
      rewoundAt: this.rewoundAt,
      invalidatedApprovalConfirmedAt: this.invalidatedApprovalConfirmedAt,
    };
  }
}
