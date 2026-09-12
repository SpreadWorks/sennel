import crypto from "node:crypto";

import { CanonicalTestArtifactStore } from "./canonical-test-artifacts.js";
import { canonicalRepairAttemptOwner } from "./repair-attempt-lineage.js";
import { WorkerArtifactRevision } from "./worker-artifact-revision.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_TEXT_LENGTH = 4000;

/** Bounded, deterministic limits for one repair-worker capability. */
export const TEST_REVIEW_REPAIR_BATCH_LIMITS = Object.freeze({
  findingCount: 8,
  findingTextChars: 12_000,
  pathCount: 8,
  targetFileBytes: 256 * 1024,
});

function requiredString(value, field, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function requiredDigest(value, field) {
  const digest = requiredString(value, field, 64);
  if (!SHA256.test(digest)) {
    throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `${field} must be a SHA-256 digest`);
  }
  return digest;
}

function frozenDocument(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `${field} must be an object`);
  }
  return Object.freeze(structuredClone(value));
}

function exactObject(value, keys, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `${field} has an invalid schema`);
  }
}

export class TestReviewRepairError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TestReviewRepairError";
    this.code = code;
  }
}

export class TestReviewRepairFinding {
  constructor(input = {}) {
    this.findingId = requiredString(input.findingId, "test review repair findingId", 500);
    this.fingerprint = requiredDigest(input.fingerprint, "test review repair finding fingerprint");
    this.document = frozenDocument(input, "test review repair finding");
    Object.freeze(this);
  }

  toJSON() { return structuredClone(this.document); }

}

/** A parent-selected, concrete spec-test repair surface. */
export class TestReviewRepairScope {
  constructor({ finding, testPaths = [] } = {}) {
    if (!(finding instanceof TestReviewRepairFinding)) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "repair scope requires a canonical finding");
    const paths = [...new Set(testPaths)].sort();
    for (const candidate of paths) this.#assertTestPath(candidate);
    const raw = String(finding.document.target || "GLOBAL").trim().replaceAll("\\", "/");
    const explicit = this.#explicitPaths(finding.document, raw, paths);
    const creates = Array.isArray(finding.document.createTestPaths) ? finding.document.createTestPaths : null;
    if (creates !== null) for (const candidate of creates) this.#assertTestPath(candidate);
    const createPaths = creates === null ? null : [...new Set(creates)].sort();
    if (createPaths !== null && createPaths.some((candidate) => paths.includes(candidate))) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "create repair target already exists in the canonical test tree");
    }
    const uncoveredRequirement = creates !== null || explicit.length === 0;
    this.finding = finding;
    // GLOBAL, unresolved, and coverage-only targets must never inherit an
    // arbitrary lexical file. They receive a deterministic create capability.
    const fallback = `repair-${finding.fingerprint.slice(0, 16)}.test.js`;
    if (uncoveredRequirement && createPaths === null && paths.includes(fallback)) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "deterministic create repair target already exists in the canonical test tree");
    }
    this.targetFiles = Object.freeze(createPaths !== null
      ? createPaths
      : explicit.length > 0
      ? explicit
      : [fallback]);
    this.allowedTestPaths = this.targetFiles;
    this.targetFile = this.targetFiles[0];
    this.operation = uncoveredRequirement ? "create" : "modify";
    this.repairScope = requiredString(
      finding.document.requiredChange || finding.document.issue || finding.document.title,
      "test review repair scope", MAX_TEXT_LENGTH,
    );
    this.#assertTestPath(this.targetFile);
    Object.freeze(this);
  }

  #assertTestPath(value) {
    if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\")
      || value.split("/").some((part) => part === "" || part === "." || part === "..")
      || value.startsWith(".raw/") || !/\.(?:test|spec)\.(?:[cm]?js|ts)$/.test(value)) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "repair target must be a normalized spec test file");
    }
  }

  #explicitPaths(document, raw, paths) {
    if ((raw === "GLOBAL" || /^R\d+$/i.test(raw)) && !Array.isArray(document.testPaths)) return [];
    const declared = Array.isArray(document.testPaths) ? document.testPaths : raw.split(/\s*,\s*/);
    const resolved = [];
    for (const candidate of declared) {
      if (typeof candidate !== "string") throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "repair target paths must be strings");
      const locator = candidate.trim().replaceAll("\\", "/")
        .replace(/\s+[—–-]\s+.*$/, "")
        .replace(/:(?:requirement|line)\b.*$/i, "").replace(/:(?:R\d+|\d+(?::\d+)?)$/i, "");
      if (locator === "") continue;
      if (paths.includes(locator)) {
        resolved.push(locator);
        continue;
      }
      const canonical = paths.find((testPath) => locator === `tests/${testPath}` || locator.endsWith(`/${testPath}`));
      if (canonical) {
        resolved.push(canonical);
        continue;
      }
      if (locator.includes("/") || /\.(?:test|spec)\./.test(locator)) {
        throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "explicit repair target is not a canonical spec test file");
      }
    }
    return [...new Set(resolved)].sort();
  }

  toJSON() {
    return {
      finding: this.finding.toJSON(), targetFiles: [...this.targetFiles],
      allowedTestPaths: [...this.allowedTestPaths], operation: this.operation, repairScope: this.repairScope,
    };
  }

  static fromWorkerJSON(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "allowedTestPaths,finding,operation,repairScope,targetFiles") {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "worker-visible repair scope is invalid");
    }
    const finding = new TestReviewRepairFinding(value.finding);
    const scope = new TestReviewRepairScope({ finding, testPaths: value.operation === "modify" ? value.targetFiles : [] });
    if (JSON.stringify(scope.targetFiles) !== JSON.stringify(value.targetFiles)
      || JSON.stringify(scope.allowedTestPaths) !== JSON.stringify(value.allowedTestPaths)
      || scope.operation !== value.operation || scope.repairScope !== value.repairScope) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "worker-visible repair scope does not satisfy canonical invariants");
    }
    return scope;
  }
}

export class TestReviewRepairBatch {
  constructor({ sourceArtifactDigest, sourceTestRevision, scopes, limits = TEST_REVIEW_REPAIR_BATCH_LIMITS, sourceEntries = [], measurements = null } = {}) {
    this.sourceArtifactDigest = requiredDigest(sourceArtifactDigest, "test review repair batch sourceArtifactDigest");
    this.sourceTestRevision = WorkerArtifactRevision.from(sourceTestRevision);
    if (!Array.isArray(scopes) || scopes.length === 0) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "repair batch requires scopes");
    this.scopes = Object.freeze(scopes.map((scope) => scope instanceof TestReviewRepairScope ? scope : new TestReviewRepairScope(scope)));
    this.limits = Object.freeze({ ...TEST_REVIEW_REPAIR_BATCH_LIMITS, ...limits });
    for (const key of Object.keys(TEST_REVIEW_REPAIR_BATCH_LIMITS)) {
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `repair batch ${key} limit is invalid`);
    }
    if (new Set(this.scopes.map((scope) => scope.finding.findingId)).size !== this.scopes.length) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "repair batch duplicates finding identity");
    this.findingIds = Object.freeze(this.scopes.map((scope) => scope.finding.findingId));
    if (JSON.stringify(this.findingIds) !== JSON.stringify([...this.findingIds].sort((left, right) => left.localeCompare(right)))) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "repair batch finding order is not deterministic");
    }
    this.allowedTestPaths = Object.freeze([...new Set(this.scopes.flatMap((scope) => scope.allowedTestPaths))].sort());
    const sizeByPath = new Map(sourceEntries.map((entry) => [entry.testPath, entry.bytes?.length ?? entry.byteLength ?? 0]));
    const measuredText = this.scopes.reduce((total, scope) => total + JSON.stringify(scope.finding.toJSON()).length, 0);
    const measuredBytes = this.allowedTestPaths.reduce((total, testPath) => total + (sizeByPath.get(testPath) ?? 0), 0);
    if (measurements !== null && (measurements === null || !Number.isSafeInteger(measurements.findingTextChars) || !Number.isSafeInteger(measurements.targetFileBytes) || measurements.findingTextChars < 0 || measurements.targetFileBytes < 0)) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "repair batch measurements are invalid");
    }
    if (sourceEntries.length > 0 && measurements !== null && (measurements.findingTextChars !== measuredText || measurements.targetFileBytes !== measuredBytes)) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "repair batch measurements do not match canonical inputs");
    }
    this.findingTextChars = measurements?.findingTextChars ?? measuredText;
    this.targetFileBytes = measurements?.targetFileBytes ?? measuredBytes;
    this.#assertWithinLimits();
    this.batchId = crypto.createHash("sha256").update(JSON.stringify({
      sourceArtifactDigest: this.sourceArtifactDigest, sourceTestRevision: this.sourceTestRevision.toJSON(),
      findingIds: this.findingIds, allowedTestPaths: this.allowedTestPaths,
      findingTextChars: this.findingTextChars, targetFileBytes: this.targetFileBytes,
    })).digest("hex");
    Object.freeze(this);
  }

  #assertWithinLimits() {
    if (this.scopes.length > this.limits.findingCount || this.findingTextChars > this.limits.findingTextChars
      || this.allowedTestPaths.length > this.limits.pathCount || this.targetFileBytes > this.limits.targetFileBytes) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_BATCH_LIMIT", "repair batch exceeds deterministic limits");
    }
  }

  overlaps(scope) { return scope.allowedTestPaths.some((candidate) => this.allowedTestPaths.includes(candidate)); }

  toJSON() {
    return { batchId: this.batchId, findingIds: [...this.findingIds], allowedTestPaths: [...this.allowedTestPaths], limits: { ...this.limits }, findingTextChars: this.findingTextChars, targetFileBytes: this.targetFileBytes, scopes: this.scopes.map((scope) => scope.toJSON()) };
  }
}

/** Deterministic greedy planner: overlap first, canonical evidence order second. */
export class TestReviewRepairBatchPlanner {
  constructor({ repair, testSources, limits = TEST_REVIEW_REPAIR_BATCH_LIMITS } = {}) {
    if (!(repair instanceof CanonicalTestReviewRepair)) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "repair batch planner requires canonical repair");
    this.repair = repair;
    this.testSources = Object.freeze([...(testSources ?? [])]);
    this.testPaths = this.testSources.map((source) => source.testPath);
    this.limits = limits;
    Object.freeze(this);
  }

  plan(progress) {
    if (!(progress instanceof TestReviewRepairProgress)) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "repair batch planning requires progress");
    const pending = this.repair.blockingFindings.filter((finding) => progress.entryFor(finding.findingId).status === "pending");
    const scopes = pending.map((finding) => new TestReviewRepairScope({ finding, testPaths: this.testPaths }));
    const batches = [];
    for (const scope of scopes) {
      const compatible = batches.find((batchScopes) => {
        const candidate = [...batchScopes, scope];
        try { new TestReviewRepairBatch({ sourceArtifactDigest: this.repair.sourceArtifactDigest, sourceTestRevision: this.repair.sourceTestRevision, scopes: candidate, limits: this.limits, sourceEntries: this.testSources }); return batchScopes.some((entry) => entry.allowedTestPaths.some((path) => scope.allowedTestPaths.includes(path))); } catch { return false; }
      });
      if (compatible) compatible.push(scope);
      else batches.push([scope]);
    }
    return Object.freeze(batches.map((scopes) => new TestReviewRepairBatch({ sourceArtifactDigest: this.repair.sourceArtifactDigest, sourceTestRevision: this.repair.sourceTestRevision, scopes, limits: this.limits, sourceEntries: this.testSources })));
  }
}

/** Exact worker capability for a selected bounded repair batch. */
export class WorkerVisibleTestReviewRepair {
  constructor(value = {}) {
    exactObject(value, [
      "version", "sourceStepId", "targetStepId", "sourceArtifact", "sourceAttempt",
      "sourceArtifactDigest", "sourceEvidenceId", "sourceTestRevision", "blockingFindings", "batch",
    ], "worker-visible selected repair contract");
    if (value.version !== 2 || value.sourceStepId !== "test-review" || value.targetStepId !== "test"
      || value.sourceArtifact !== "test-review.json" || !Number.isSafeInteger(value.sourceAttempt) || value.sourceAttempt < 1) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "worker-visible selected repair contract has invalid identity");
    }
    this.version = 2;
    this.sourceStepId = "test-review";
    this.targetStepId = "test";
    this.sourceArtifact = "test-review.json";
    this.sourceAttempt = value.sourceAttempt;
    this.sourceArtifactDigest = requiredDigest(value.sourceArtifactDigest, "worker-visible repair sourceArtifactDigest");
    this.sourceEvidenceId = requiredDigest(value.sourceEvidenceId, "worker-visible repair sourceEvidenceId");
    try {
      this.sourceTestRevision = WorkerArtifactRevision.from(value.sourceTestRevision);
    } catch (cause) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `worker-visible repair source revision is invalid: ${cause.message}`);
    }
    if (this.sourceTestRevision.stepId !== "test") {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "worker-visible repair source revision must belong to test");
    }
    if (!Array.isArray(value.blockingFindings) || value.blockingFindings.length === 0) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "worker-visible selected repair contract requires findings");
    }
    this.blockingFindings = Object.freeze(value.blockingFindings.map((finding) => new TestReviewRepairFinding(finding)));
    exactObject(value.batch, ["batchId", "findingIds", "allowedTestPaths", "limits", "findingTextChars", "targetFileBytes", "scopes"], "worker-visible repair batch");
    this.batch = new TestReviewRepairBatch({
      sourceArtifactDigest: this.sourceArtifactDigest, sourceTestRevision: this.sourceTestRevision,
      scopes: value.batch.scopes.map((scope) => TestReviewRepairScope.fromWorkerJSON(scope)), limits: value.batch.limits,
      measurements: { findingTextChars: value.batch.findingTextChars, targetFileBytes: value.batch.targetFileBytes },
    });
    if (this.batch.batchId !== value.batch.batchId
      || JSON.stringify(this.batch.findingIds) !== JSON.stringify(this.blockingFindings.map((finding) => finding.findingId))) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "worker-visible repair batch does not bind selected findings");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      version: this.version,
      sourceStepId: this.sourceStepId,
      targetStepId: this.targetStepId,
      sourceArtifact: this.sourceArtifact,
      sourceAttempt: this.sourceAttempt,
      sourceArtifactDigest: this.sourceArtifactDigest,
      sourceEvidenceId: this.sourceEvidenceId,
      sourceTestRevision: this.sourceTestRevision.toJSON(),
      blockingFindings: this.blockingFindings.map((finding) => finding.toJSON()),
      batch: this.batch.toJSON(),
    };
  }
}

/** Parse the worker-visible subset without admitting an unchecked raw object. */
export function parseWorkerVisibleTestReviewRepair(value) {
  return value instanceof WorkerVisibleTestReviewRepair ? value : new WorkerVisibleTestReviewRepair(value);
}

/** A sealed receipt shared by every finding published from one repair batch. */
class TestReviewRepairProgressHandoff {
  constructor(value = {}) {
    exactObject(value, ["batchId", "findingIds", "beforeTreeDigest", "afterTreeDigest", "changedPaths", "sourceTestRevision", "handoffDigest", "requestDigest", "payloadDigest"], "test review repair progress handoff");
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
    this.sourceTestRevision = WorkerArtifactRevision.from(value.sourceTestRevision);
    this.handoffDigest = requiredDigest(value.handoffDigest, "test review repair progress handoffDigest");
    this.requestDigest = requiredDigest(value.requestDigest, "test review repair progress requestDigest");
    this.payloadDigest = requiredDigest(value.payloadDigest, "test review repair progress payloadDigest");
    Object.freeze(this);
  }

  toJSON() {
    return {
      batchId: this.batchId, findingIds: [...this.findingIds], beforeTreeDigest: this.beforeTreeDigest,
      afterTreeDigest: this.afterTreeDigest, changedPaths: this.changedPaths.map((entry) => ({ ...entry })),
      sourceTestRevision: this.sourceTestRevision.toJSON(),
      handoffDigest: this.handoffDigest,
      requestDigest: this.requestDigest,
      payloadDigest: this.payloadDigest,
    };
  }
}

class TestReviewRepairProgressEntry {
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

/**
 * Binds compact canonical evidence to the rich, sealed test-review artifact.
 * Review evidence intentionally records only stable review identities.  Repair
 * needs the original target and requested change, so it may use them only
 * after count, order, and immutable identity agree with that evidence.
 */
class CanonicalTestReviewRepairFindingBinding {
  constructor({ evidenceFindings, artifactFindings } = {}) {
    if (!Array.isArray(evidenceFindings) || !Array.isArray(artifactFindings)
      || evidenceFindings.length === 0 || evidenceFindings.length !== artifactFindings.length) {
      throw new TestReviewRepairError(
        "TEST_REVIEW_REPAIR_EVIDENCE_INVALID",
        "canonical test-review evidence must bind every original blocking finding",
      );
    }
    this.findings = Object.freeze(artifactFindings.map((artifactFinding, index) => {
      const evidenceFinding = evidenceFindings[index];
      const finding = new TestReviewRepairFinding(artifactFinding);
      if (evidenceFinding === null || typeof evidenceFinding !== "object" || Array.isArray(evidenceFinding)
        || finding.findingId !== evidenceFinding.findingId || finding.fingerprint !== evidenceFinding.fingerprint) {
        throw new TestReviewRepairError(
          "TEST_REVIEW_REPAIR_EVIDENCE_INVALID",
          "canonical test-review evidence does not match its original blocking finding",
        );
      }
      return finding;
    }));
    Object.freeze(this);
  }
}

/** A structurally complete persisted repair episode, before matching it to current evidence. */
class TestReviewRepairProgressEpisode {
  constructor(value = {}) {
    exactObject(value, ["version", "sourceArtifactDigest", "sourceEvidenceId", "sourceTestRevision", "entries"], "test review repair progress artifact");
    if (value.version !== 2) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair progress version is invalid");
    }
    this.version = 2;
    this.sourceArtifactDigest = requiredDigest(value.sourceArtifactDigest, "test review repair progress sourceArtifactDigest");
    this.sourceEvidenceId = requiredDigest(value.sourceEvidenceId, "test review repair progress sourceEvidenceId");
    try {
      this.sourceTestRevision = WorkerArtifactRevision.from(value.sourceTestRevision);
    } catch (cause) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `test review repair progress source revision is invalid: ${cause.message}`);
    }
    if (this.sourceTestRevision.stepId !== "test") {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair progress source revision must belong to test");
    }
    if (!Array.isArray(value.entries) || value.entries.length === 0) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair progress entries are invalid");
    }
    this.entries = Object.freeze(value.entries.map((entry) => new TestReviewRepairProgressEntry(entry)));
    if (new Set(this.entries.map((entry) => entry.findingId)).size !== this.entries.length) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair progress duplicates a finding");
    }
    Object.freeze(this);
  }

  static fromJSON(value) { return new TestReviewRepairProgressEpisode(value); }

  assertFlow(state) {
    try {
      this.sourceTestRevision.assertFlow(state);
    } catch (cause) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `test review repair progress lineage is invalid: ${cause.message}`);
    }
    return this;
  }

  matchesArtifact(repair) { return this.sourceArtifactDigest === repair.sourceArtifactDigest; }

  materialize(repair) {
    if (!this.matchesArtifact(repair)
      || this.sourceEvidenceId !== repair.sourceEvidenceId
      || JSON.stringify(this.sourceTestRevision.toJSON()) !== JSON.stringify(repair.sourceTestRevision.toJSON())) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_STALE", "test review repair progress belongs to different canonical evidence");
    }
    return new TestReviewRepairProgress({ repair, entries: this.entries });
  }
}

/** Canonical, parent-owned checkpoint for a frozen review repair episode. */
export class TestReviewRepairProgress {
  constructor({ repair, entries } = {}) {
    if (!(repair instanceof CanonicalTestReviewRepair)) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair progress requires canonical repair evidence");
    }
    if (!Array.isArray(entries) || entries.length !== repair.blockingFindings.length) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair progress entries do not match findings");
    }
    this.version = 2;
    this.sourceArtifactDigest = repair.sourceArtifactDigest;
    this.sourceEvidenceId = repair.sourceEvidenceId;
    this.sourceTestRevision = repair.sourceTestRevision.toJSON();
    this.entries = Object.freeze(entries.map((entry) => entry instanceof TestReviewRepairProgressEntry
      ? entry : new TestReviewRepairProgressEntry(entry)));
    for (const finding of repair.blockingFindings) {
      const entry = this.entries.find((candidate) => candidate.findingId === finding.findingId);
      if (!entry || entry.fingerprint !== finding.fingerprint) {
        throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair progress does not bind canonical findings");
      }
    }
    if (new Set(this.entries.map((entry) => entry.findingId)).size !== this.entries.length) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair progress duplicates a finding");
    }
    this.#assertCompletedReceiptGroups(repair);
    Object.freeze(this);
  }

  #assertCompletedReceiptGroups(repair) {
    const groups = new Map();
    for (const entry of this.entries) {
      if (entry.status !== "done") continue;
      const serialized = JSON.stringify(entry.handoff.toJSON());
      const group = groups.get(entry.handoff.batchId) ?? { receipt: entry.handoff, entries: [], serialized };
      if (group.serialized !== serialized) {
        throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair batch entries do not share one exact receipt");
      }
      group.entries.push(entry);
      groups.set(entry.handoff.batchId, group);
    }
    for (const group of groups.values()) {
      const expectedFindingIds = repair.blockingFindings
        .filter((finding) => group.receipt.findingIds.includes(finding.findingId))
        .map((finding) => finding.findingId);
      if (JSON.stringify(group.receipt.findingIds) !== JSON.stringify(expectedFindingIds)
        || JSON.stringify(group.entries.map((entry) => entry.findingId).sort((left, right) => left.localeCompare(right))) !== JSON.stringify(expectedFindingIds)) {
        throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair receipt does not cover exactly its completed finding group");
      }
      if (JSON.stringify(group.receipt.sourceTestRevision.toJSON()) !== JSON.stringify(repair.sourceTestRevision.toJSON())) {
        throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair receipt source revision is stale");
      }
      const changedPaths = group.receipt.changedPaths.map((entry) => entry.path);
      if (new Set(changedPaths).size !== changedPaths.length
        || JSON.stringify(changedPaths) !== JSON.stringify([...changedPaths].sort((left, right) => left.localeCompare(right)))) {
        throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair receipt changed paths are not unique and deterministic");
      }
    }
  }

  static start(repair) {
    return new TestReviewRepairProgress({ repair, entries: repair.blockingFindings.map((finding) => ({
      findingId: finding.findingId, fingerprint: finding.fingerprint, status: "pending", handoff: null,
    })) });
  }

  static fromJSON(value, repair) {
    return TestReviewRepairProgressEpisode.fromJSON(value).materialize(repair);
  }

  entryFor(findingId) {
    const entry = this.entries.find((candidate) => candidate.findingId === findingId);
    if (!entry) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair finding is absent from progress");
    return entry;
  }

  nextFinding(repair) {
    const entry = this.entries.find((candidate) => candidate.status === "pending") ?? null;
    return entry === null ? null : repair.blockingFindings.find((finding) => finding.findingId === entry.findingId) ?? null;
  }

  markBatchComplete(repair, batch, handoff) {
    if (!(batch instanceof TestReviewRepairBatch)) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair batch completion requires typed batch");
    const receipt = handoff instanceof TestReviewRepairProgressHandoff ? handoff : new TestReviewRepairProgressHandoff(handoff);
    if (receipt.batchId !== batch.batchId || JSON.stringify(receipt.findingIds) !== JSON.stringify(batch.findingIds)) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair receipt does not bind batch");
    if (JSON.stringify(receipt.sourceTestRevision.toJSON()) !== JSON.stringify(repair.sourceTestRevision.toJSON())) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair receipt source revision is stale");
    }
    const changedPaths = receipt.changedPaths.map((entry) => entry.path);
    if (new Set(changedPaths).size !== changedPaths.length
      || JSON.stringify(changedPaths) !== JSON.stringify([...changedPaths].sort((left, right) => left.localeCompare(right)))
      || changedPaths.some((changedPath) => !batch.allowedTestPaths.includes(changedPath))) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair receipt changed paths escape its batch capability");
    }
    for (const findingId of batch.findingIds) {
      if (this.entryFor(findingId).status !== "pending") throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair batch completion does not target pending findings");
    }
    return new TestReviewRepairProgress({ repair, entries: this.entries.map((entry) => (
      batch.findingIds.includes(entry.findingId)
        ? new TestReviewRepairProgressEntry({ findingId: entry.findingId, fingerprint: entry.fingerprint, status: "done", handoff: receipt })
        : entry
    )) });
  }

  nextBatch(repair, testSources, limits = TEST_REVIEW_REPAIR_BATCH_LIMITS) {
    return new TestReviewRepairBatchPlanner({ repair, testSources, limits }).plan(this).at(0) ?? null;
  }

  get complete() { return this.entries.every((entry) => entry.status === "done"); }
  toJSON() { return { version: this.version, sourceArtifactDigest: this.sourceArtifactDigest, sourceEvidenceId: this.sourceEvidenceId, sourceTestRevision: this.sourceTestRevision, entries: this.entries.map((entry) => entry.toJSON()) }; }
}

/**
 * Recognize a committed checkpoint from the sealed request capability alone.
 * This intentionally does not rebind the request to current repair state:
 * after publication, current progress has advanced and the old request must
 * still be identifiable for replay cleanup.
 */
export function testReviewRepairProgressReceiptForSelectedContract({
  state, progressDocument, selectedContract, requestDigest,
} = {}) {
  const selected = parseWorkerVisibleTestReviewRepair(selectedContract);
  const episode = TestReviewRepairProgressEpisode.fromJSON(progressDocument).assertFlow(state);
  if (episode.sourceArtifactDigest !== selected.sourceArtifactDigest
    || episode.sourceEvidenceId !== selected.sourceEvidenceId
    || JSON.stringify(episode.sourceTestRevision.toJSON()) !== JSON.stringify(selected.sourceTestRevision.toJSON())) {
    return null;
  }
  const entries = selected.blockingFindings.map((finding) => episode.entries.find((candidate) => (
    candidate.findingId === finding.findingId
    && candidate.fingerprint === finding.fingerprint
    && candidate.status === "done"
  )));
  const receipt = entries[0]?.handoff ?? null;
  if (receipt === null
    || JSON.stringify(receipt.findingIds) !== JSON.stringify(selected.batch.findingIds)
    || receipt.batchId !== selected.batch.batchId
    || receipt.requestDigest !== requestDigest
    || JSON.stringify(receipt.sourceTestRevision.toJSON()) !== JSON.stringify(selected.sourceTestRevision.toJSON())) return null;
  const changedPaths = receipt.changedPaths.map((entry) => entry.path);
  if (new Set(changedPaths).size !== changedPaths.length
    || JSON.stringify(changedPaths) !== JSON.stringify([...changedPaths].sort((left, right) => left.localeCompare(right)))
    || changedPaths.some((changedPath) => !selected.batch.allowedTestPaths.includes(changedPath))) return null;
  const serializedReceipt = JSON.stringify(receipt.toJSON());
  if (entries.some((entry) => entry?.handoff == null || JSON.stringify(entry.handoff.toJSON()) !== serializedReceipt)) return null;
  return receipt.handoffDigest;
}

/** Resolve only the progress record owned by this immutable review episode. */
export function canonicalTestReviewRepairProgress({ flowManager, state, repair, consumerNodeId } = {}) {
  const artifact = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: "test.review.repair.progress",
    consumerNodeId,
    optional: true,
  });
  if (artifact === null) return TestReviewRepairProgress.start(repair);
  let value;
  try {
    value = JSON.parse(artifact.bytes.toString("utf8"));
  } catch (cause) {
    throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", `test review repair progress is not JSON: ${cause.message}`);
  }
  // Validate the complete persisted episode before deciding whether it belongs
  // to current evidence. A digest mismatch is ordinary immutable history;
  // malformed or unbound history is never a reason to silently reset state.
  const episode = TestReviewRepairProgressEpisode.fromJSON(value).assertFlow(state);
  if (!episode.matchesArtifact(repair)) return TestReviewRepairProgress.start(repair);
  return episode.materialize(repair);
}

/**
 * Catalog-backed repair evidence for the schema-revision-three runtime.
 * The worker-visible shape stays stable, but identity comes solely from the
 * review Attempt, catalog descriptor, and current cataloged test tree.
 */
export class CanonicalTestReviewRepair {
  constructor({ state, attempt, artifactDigest, evidenceId, sourceTestRevision, blockingFindings } = {}) {
    if (state?.schemaRevision !== 3) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test-review repair requires a Version-1 Flow");
    }
    this.version = 1;
    this.runId = requiredString(state.runId, "test review repair runId", 500);
    this.specId = requiredString(state.specId, "test review repair specId", 500);
    this.sourceStepId = "test-review";
    this.targetStepId = "test";
    this.sourceArtifact = "test-review.json";
    this.sourceAttempt = Number(attempt);
    if (!Number.isSafeInteger(this.sourceAttempt) || this.sourceAttempt < 1) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair source Attempt is invalid");
    }
    this.sourceArtifactDigest = requiredDigest(artifactDigest, "test review repair sourceArtifactDigest");
    this.sourceEvidenceId = requiredDigest(evidenceId, "test review repair sourceEvidenceId");
    this.sourceTestRevision = WorkerArtifactRevision.from(sourceTestRevision);
    if (this.sourceTestRevision.stepId !== "test") {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair source revision must belong to test");
    }
    if (!Array.isArray(blockingFindings) || blockingFindings.length === 0) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test review repair requires blocking findings");
    }
    this.blockingFindings = Object.freeze(blockingFindings.map((finding) => (
      finding instanceof TestReviewRepairFinding ? finding : new TestReviewRepairFinding(finding)
    )).sort((left, right) => left.findingId.localeCompare(right.findingId)));
    Object.freeze(this);
  }

  toJSON() {
    return {
      version: this.version,
      runId: this.runId,
      specId: this.specId,
      sourceStepId: this.sourceStepId,
      targetStepId: this.targetStepId,
      sourceArtifact: this.sourceArtifact,
      sourceAttempt: this.sourceAttempt,
      sourceArtifactDigest: this.sourceArtifactDigest,
      sourceEvidenceId: this.sourceEvidenceId,
      sourceTestRevision: this.sourceTestRevision.toJSON(),
      blockingFindings: this.blockingFindings.map((finding) => finding.toJSON()),
    };
  }

  toWorkerJSON() {
    const value = this.toJSON();
    delete value.runId;
    delete value.specId;
    return value;
  }

  forBatch(batch) {
    if (!(batch instanceof TestReviewRepairBatch)
      || batch.sourceArtifactDigest !== this.sourceArtifactDigest
      || batch.sourceTestRevision.digest !== this.sourceTestRevision.digest
      || batch.findingIds.some((findingId) => !this.blockingFindings.some((finding) => finding.findingId === findingId))) {
      throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test-review repair batch is not canonical evidence");
    }
    const value = this.toWorkerJSON();
    value.version = 2;
    value.blockingFindings = batch.scopes.map((scope) => scope.finding.toJSON());
    value.batch = batch.toJSON();
    return new WorkerVisibleTestReviewRepair(value);
  }

  /** One-finding repairs deliberately use the same batch capability. */
  forFinding(findingId, testPaths = []) {
    const finding = this.blockingFindings.find((entry) => entry.findingId === findingId);
    if (!finding) throw new TestReviewRepairError("TEST_REVIEW_REPAIR_INVALID", "test-review repair finding is not canonical evidence");
    return this.forBatch(new TestReviewRepairBatch({
      sourceArtifactDigest: this.sourceArtifactDigest, sourceTestRevision: this.sourceTestRevision,
      scopes: [new TestReviewRepairScope({ finding, testPaths })], sourceEntries: testPaths.map((testPath) => ({ testPath })),
    }));
  }

  references() {
    return {
      evaluations: [],
      findings: this.blockingFindings.map((finding) => ({ id: finding.findingId, label: "test-review" })),
      repairs: [],
      artifacts: [
        { id: this.sourceArtifactDigest, label: "test.review" },
        { id: this.sourceTestRevision.digest, label: "tests.source" },
      ],
    };
  }
}

function repairFromCatalog({ flowManager, state, consumerNodeId, reviewAttemptSequence = null }) {
  const store = new CanonicalTestArtifactStore({ flowManager, state });
  const current = store.readCurrentAttempt({ logicalKey: "test.review", consumerNodeId });
  if (reviewAttemptSequence !== null && current.attempt < reviewAttemptSequence) return null;
  if (reviewAttemptSequence !== null && current.attempt > reviewAttemptSequence) {
    throw new TestReviewRepairError(
      "TEST_REVIEW_REPAIR_ATTEMPT_MISMATCH",
      "cataloged test-review evidence belongs to a future review Attempt",
    );
  }
  const artifact = current.payload;
  const evidence = artifact?.canonicalEvidence;
  if (
    artifact?.phase !== "test"
    || artifact?.verdict !== "REJECTED"
    || evidence?.disposition !== "REJECTED"
    || !Array.isArray(evidence.blockingFindings)
    || evidence.blockingFindings.length === 0
    || !SHA256.test(evidence?.identity?.evidenceDigest || "")
  ) {
    throw new TestReviewRepairError(
      "TEST_REVIEW_REPAIR_EVIDENCE_INVALID",
      "cataloged test-review evidence must be a REJECTED review with blocking findings",
    );
  }
  const artifactRevision = WorkerArtifactRevision.from(artifact.sourceTestArtifactRevision);
  const findingBinding = new CanonicalTestReviewRepairFindingBinding({
    evidenceFindings: evidence.blockingFindings,
    artifactFindings: artifact.blockingFindings,
  });
  const repair = new CanonicalTestReviewRepair({
    state,
    attempt: current.attempt,
    artifactDigest: current.descriptor.hash,
    evidenceId: evidence.identity.evidenceDigest,
    sourceTestRevision: artifactRevision.toJSON(),
    blockingFindings: findingBinding.findings,
  });
  const progress = canonicalTestReviewRepairProgress({ flowManager, state, repair, consumerNodeId });
  // A checkpoint is published atomically with the repaired test tree, but it
  // deliberately keeps the test Attempt open for the next finding.  Such a
  // tree does not yet have the final confirmation required by
  // CanonicalTestSourceRevision.  The checkpoint is the canonical authority
  // for that in-progress repair episode; only a fresh episode needs the
  // fully-finalized tree comparison.
  if (progress.entries.every((entry) => entry.status === "pending") && artifactRevision.digest !== store.testSourceRevision().digest) {
    throw new TestReviewRepairError(
      "TEST_REVIEW_REPAIR_REVISION_MISMATCH",
      "cataloged test-review evidence targets a stale test revision",
    );
  }
  return repair;
}

export function inspectCanonicalTestReviewRepair({ flowManager, state } = {}) {
  if (state?.schemaRevision !== 3 || state.currentNodeId !== "test-review") return null;
  const typedState = typeof flowManager.canonicalState === "function"
    ? flowManager.canonicalState(state.specId)
    : state;
  return repairFromCatalog({
    flowManager,
    state: typedState,
    consumerNodeId: "test-review",
    reviewAttemptSequence: typedState.attempt.sequence,
  });
}

export function canonicalTestReviewRepairForTarget({ flowManager, state, targetStepId } = {}) {
  if (state?.schemaRevision !== 3 || targetStepId !== "test" || state.currentNodeId !== "test") return null;
  const typedState = typeof flowManager.canonicalState === "function"
    ? flowManager.canonicalState(state.specId)
    : state;
  const activity = canonicalRepairAttemptOwner({
    state: typedState,
    activities: flowManager.activityLedger(state.specId),
    targetStepId,
  });
  if (activity?.transition?.operation !== "repair_test_review") return null;
  const repair = repairFromCatalog({ flowManager, state: typedState, consumerNodeId: "test" });
  if (!activity.references?.artifacts?.some((reference) => reference.id === repair.sourceArtifactDigest)) {
    throw new TestReviewRepairError(
      "TEST_REVIEW_REPAIR_STALE",
      "test-review repair Activity does not reference the current review evidence",
    );
  }
  return repair;
}

/** Retired state-blob APIs remain explicit rejection points during alpha. */
export class TestReviewRepairRecord {
  constructor() {
    throw new TestReviewRepairError(
      "TEST_REVIEW_REPAIR_INVALID",
      "mutable test-review repair records are retired; use the canonical Activity and catalog",
    );
  }
  static from(value) { return new TestReviewRepairRecord(value); }
  static forTarget() { return null; }
}

export class TestReviewRepairCompletion extends TestReviewRepairRecord {}

export function inspectTestReviewRepair() { return null; }
