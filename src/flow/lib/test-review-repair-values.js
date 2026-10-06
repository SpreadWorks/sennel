/** Pure canonical repair progress entries and sealed batch receipt values. */
import { RequirementTestCandidateBundle } from "./requirement-test-artifacts.js";

export const SHA256 = /^[a-f0-9]{64}$/;
export const MAX_TEXT_LENGTH = 4000;

export class TestReviewRepairError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TestReviewRepairError";
    this.code = code;
  }
}
export function requiredString(value, field, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

export function requiredDigest(value, field) {
  const digest = requiredString(value, field, 64);
  if (!SHA256.test(digest)) {
    throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `${field} must be a SHA-256 digest`);
  }
  return digest;
}

export function exactObject(value, keys, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `${field} has an invalid schema`);
  }
}

/** A sealed receipt shared by every finding published from one repair batch. */
export class TestReviewRepairProgressHandoff {
  constructor(value = {}) {
    exactObject(value, ["batchId", "findingIds", "beforeTreeDigest", "afterTreeDigest", "changedPaths", "sourceCandidate", "handoffDigest", "requestDigest", "payloadDigest"], "test review repair progress handoff");
    this.batchId = requiredDigest(value.batchId, "test review repair batchId");
    if (!Array.isArray(value.findingIds) || value.findingIds.length === 0) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair receipt requires findingIds");
    this.findingIds = Object.freeze(value.findingIds.map((id) => requiredString(id, "test review repair receipt findingId", 500)));
    if (new Set(this.findingIds).size !== this.findingIds.length) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair receipt duplicates findingIds");
    this.beforeTreeDigest = requiredDigest(value.beforeTreeDigest, "test review repair receipt beforeTreeDigest");
    this.afterTreeDigest = requiredDigest(value.afterTreeDigest, "test review repair receipt afterTreeDigest");
    if (this.beforeTreeDigest === this.afterTreeDigest) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair receipt has no tree change");
    if (!Array.isArray(value.changedPaths) || value.changedPaths.length === 0) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair receipt requires changed paths");
    this.changedPaths = Object.freeze(value.changedPaths.map((entry) => {
      exactObject(entry, ["path", "beforeDigest", "afterDigest"], "test review repair receipt changed path");
      const beforeDigest = entry.beforeDigest === null ? null : requiredDigest(entry.beforeDigest, "test review repair receipt before digest");
      const afterDigest = requiredDigest(entry.afterDigest, "test review repair receipt after digest");
      if (beforeDigest === afterDigest) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair receipt changed path has no digest change");
      return Object.freeze({ path: requiredString(entry.path, "test review repair receipt path"), beforeDigest, afterDigest });
    }));
    this.sourceCandidate = value.sourceCandidate instanceof RequirementTestCandidateBundle
      ? value.sourceCandidate
      : RequirementTestCandidateBundle.fromJSON(value.sourceCandidate);
    this.handoffDigest = requiredDigest(value.handoffDigest, "test review repair progress handoffDigest");
    this.requestDigest = requiredDigest(value.requestDigest, "test review repair progress requestDigest");
    this.payloadDigest = requiredDigest(value.payloadDigest, "test review repair progress payloadDigest");
    Object.freeze(this);
  }

  toJSON() {
    return {
      batchId: this.batchId, findingIds: [...this.findingIds], beforeTreeDigest: this.beforeTreeDigest,
      afterTreeDigest: this.afterTreeDigest, changedPaths: this.changedPaths.map((entry) => ({ ...entry })),
      sourceCandidate: this.sourceCandidate.toJSON(),
      handoffDigest: this.handoffDigest,
      requestDigest: this.requestDigest,
      payloadDigest: this.payloadDigest,
    };
  }
}

export class TestReviewRepairProgressEntry {
  constructor(value = {}) {
    exactObject(value, ["findingId", "fingerprint", "status", "handoff"], "test review repair progress entry");
    const { findingId, fingerprint, status = "pending", handoff = null } = value;
    this.findingId = requiredString(findingId, "test review repair progress findingId", 500);
    this.fingerprint = requiredDigest(fingerprint, "test review repair progress fingerprint");
    if (!["pending", "done"].includes(status)) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair progress status is invalid");
    }
    this.status = status;
    this.handoff = handoff === null ? null : handoff instanceof TestReviewRepairProgressHandoff
      ? handoff
      : new TestReviewRepairProgressHandoff(handoff);
    if ((this.status === "done") !== (this.handoff !== null)) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair progress completion receipt is invalid");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      findingId: this.findingId,
      fingerprint: this.fingerprint,
      status: this.status,
      handoff: this.handoff?.toJSON() ?? null,
    };
  }
}
