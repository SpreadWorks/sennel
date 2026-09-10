import crypto from "crypto";
import fs from "fs";
import path from "path";
import { AgentFailure } from "../../lib/agent-failure.js";

const CHECKPOINT_VERSION = 2;
const RETRYABLE_FAILURE_KINDS = new Set(["provider_failure", "timeout", "parser_failure", "schema_failure"]);
const COMMAND_FAILURE_KINDS = new Set(["checkpoint_io_failure", "invariant_violation"]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkUnitInvariantError(`${name} is required`);
  }
  return value.trim();
}

function optionalParentUnitId(value) {
  if (value == null) return null;
  return requiredString(value, "parentUnitId");
}

function normalizeTargetFile(file) {
  const normalized = file.split(path.sep).join("/").replace(/^\.\//, "");
  return requiredString(normalized, "targetFile");
}

function normalizeTargetFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new WorkUnitInvariantError("targetFiles is required");
  }
  return [...new Set(files.map(normalizeTargetFile))].sort();
}

function normalizeAllowedRequirementIds(ids = []) {
  if (!Array.isArray(ids)) {
    throw new WorkUnitInvariantError("allowedRequirementIds must be an array");
  }
  return [...new Set(ids.map((id) => requiredString(id, "allowedRequirementId")))].sort();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

export class WorkUnitInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkUnitInvariantError";
    this.failureKind = "invariant_violation";
  }
}

export class WorkUnitToolingFailure extends Error {
  constructor({
    failureKind,
    message,
    rawResponse = null,
    cause = null,
    failureCode = null,
    retryable = null,
    recoveryHint = null,
    agentFailureKind = null,
    attemptCount = null,
    maxAttempts = null,
  }) {
    super(message || failureKind);
    this.name = "WorkUnitToolingFailure";
    this.failureKind = requiredString(failureKind, "failureKind");
    this.rawResponse = rawResponse;
    this.failureCode = failureCode == null ? null : requiredString(failureCode, "failureCode");
    if (retryable != null && typeof retryable !== "boolean") {
      throw new WorkUnitInvariantError("retryable must be boolean");
    }
    this.retryable = retryable;
    this.recoveryHint = recoveryHint == null ? null : requiredString(recoveryHint, "recoveryHint");
    this.agentFailureKind = agentFailureKind == null
      ? null
      : requiredString(agentFailureKind, "agentFailureKind");
    if ((attemptCount == null) !== (maxAttempts == null)) {
      throw new WorkUnitInvariantError("attemptCount and maxAttempts must be provided together");
    }
    if (attemptCount != null && (
      !Number.isSafeInteger(attemptCount)
      || attemptCount < 1
      || !Number.isSafeInteger(maxAttempts)
      || maxAttempts < attemptCount
    )) throw new WorkUnitInvariantError("attempt metadata is invalid");
    this.attemptCount = attemptCount;
    this.maxAttempts = maxAttempts;
    if (cause) this.cause = cause;
  }
}

export class WorkUnitIdentity {
  constructor(fields = {}) {
    this.phase = requiredString(fields.phase, "phase");
    this.kind = requiredString(fields.kind, "kind");
    this.stableOrderKey = requiredString(fields.stableOrderKey, "stableOrderKey");
    this.parentUnitId = optionalParentUnitId(fields.parentUnitId);
    this.targetFiles = normalizeTargetFiles(fields.targetFiles);
    this.inputHash = requiredString(fields.inputHash, "inputHash");
    this.commandId = requiredString(fields.commandId, "commandId");
    this.providerIdentity = requiredString(fields.providerIdentity, "providerIdentity");
    this.promptVersion = requiredString(fields.promptVersion, "promptVersion");
    this.schemaVersion = requiredString(fields.schemaVersion, "schemaVersion");
    this.schemaDigest = requiredString(fields.schemaDigest || sha256(this.schemaVersion), "schemaDigest");
    this.allowedRequirementIds = Object.freeze(normalizeAllowedRequirementIds(fields.allowedRequirementIds));
    this.unitId = sha256(stableJson({
      phase: this.phase,
      kind: this.kind,
      stableOrderKey: this.stableOrderKey,
      parentUnitId: this.parentUnitId,
      schemaDigest: this.schemaDigest,
      allowedRequirementIds: this.allowedRequirementIds,
    })).slice(0, 24);
  }

  toJSON() {
    return {
      phase: this.phase,
      kind: this.kind,
      stableOrderKey: this.stableOrderKey,
      parentUnitId: this.parentUnitId,
      targetFiles: this.targetFiles,
      inputHash: this.inputHash,
      commandId: this.commandId,
      providerIdentity: this.providerIdentity,
      promptVersion: this.promptVersion,
      schemaVersion: this.schemaVersion,
      schemaDigest: this.schemaDigest,
      allowedRequirementIds: this.allowedRequirementIds,
      unitId: this.unitId,
    };
  }

  static fromJSON(data) {
    return new WorkUnitIdentity(data);
  }

  matchesFullIdentity(other) {
    const rhs = other instanceof WorkUnitIdentity ? other : new WorkUnitIdentity(other);
    return stableJson(this.toJSON()) === stableJson(rhs.toJSON());
  }
}

export class WorkUnitPlanEntry {
  constructor({ identity, input = "", groups = [], execute = null }) {
    if (!(identity instanceof WorkUnitIdentity)) throw new WorkUnitInvariantError("identity must be WorkUnitIdentity");
    this.identity = identity;
    this.input = String(input);
    this.groups = groups;
    this.execute = execute;
  }

  canSplitAgain() {
    return this.identity.kind === "loop-chunk" && !this.identity.parentUnitId;
  }
}

export class WorkUnitCheckpoint {
  constructor({
    identity,
    status,
    attemptCount = 1,
    startedAt = nowIso(),
    finishedAt = nowIso(),
    success = null,
    failure = null,
    rawResponse = null,
  }) {
    if (!(identity instanceof WorkUnitIdentity)) throw new WorkUnitInvariantError("identity must be WorkUnitIdentity");
    if (!["success", "failed"].includes(status)) throw new WorkUnitInvariantError(`invalid status: ${status}`);
    this.identity = identity;
    this.status = status;
    this.attemptCount = attemptCount;
    this.startedAt = startedAt;
    this.finishedAt = finishedAt;
    this.success = success;
    this.failure = failure;
    this.rawResponse = rawResponse;
  }

  get unitId() {
    return this.identity.unitId;
  }

  get kind() {
    return this.identity.kind;
  }

  toJSON() {
    const identity = this.identity.toJSON();
    return {
      version: CHECKPOINT_VERSION,
      phase: identity.phase,
      kind: identity.kind,
      unitId: identity.unitId,
      identity,
      targetFiles: identity.targetFiles,
      inputHash: identity.inputHash,
      providerIdentity: identity.providerIdentity,
      promptVersion: identity.promptVersion,
      schemaVersion: identity.schemaVersion,
      schemaDigest: identity.schemaDigest,
      allowedRequirementIds: identity.allowedRequirementIds,
      status: this.status,
      attemptCount: this.attemptCount,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      ...(this.rawResponse != null ? { rawResponse: this.rawResponse } : {}),
      ...(this.success != null ? { success: this.success } : {}),
      ...(this.failure != null ? { failure: this.failure } : {}),
    };
  }

  static fromJSON(data) {
    return new WorkUnitCheckpoint({
      identity: WorkUnitIdentity.fromJSON(data.identity),
      status: data.status,
      attemptCount: data.attemptCount,
      startedAt: data.startedAt,
      finishedAt: data.finishedAt,
      success: data.success ?? null,
      failure: data.failure ?? null,
      rawResponse: data.rawResponse ?? null,
    });
  }
}

export class WorkUnitResumeDecision {
  constructor({ action, reason = null, checkpoint = null }) {
    if (!["reuse", "execute", "blocked"].includes(action)) throw new WorkUnitInvariantError(`invalid resume action: ${action}`);
    this.action = action;
    this.reason = reason;
    this.checkpoint = checkpoint;
  }

  static fromCheckpoint(plannedIdentity, checkpoint) {
    if (!checkpoint) return new WorkUnitResumeDecision({ action: "execute", reason: "missing" });
    if (!plannedIdentity.matchesFullIdentity(checkpoint.identity)) {
      return new WorkUnitResumeDecision({ action: "execute", reason: "stale", checkpoint });
    }
    if (checkpoint.status !== "success") {
      return new WorkUnitResumeDecision({
        action: checkpoint.failure?.retryable === false ? "blocked" : "execute",
        reason: checkpoint.failure?.retryable === false ? "non_retryable_failure" : "failed",
        checkpoint,
      });
    }
    return new WorkUnitResumeDecision({ action: "reuse", reason: "success", checkpoint });
  }
}

export class WorkUnitCheckpointStore {
  constructor({ specDir, namespace = "impl-review" }) {
    this.specDir = requiredString(specDir, "specDir");
    this.namespace = requiredString(namespace, "namespace");
  }

  checkpointDir() {
    return path.join(this.specDir, "review-history", "work-units", this.namespace);
  }

  checkpointPath(unitId) {
    return path.join(this.checkpointDir(), `${unitId}.json`);
  }

  load(identityOrUnitId) {
    const unitId = typeof identityOrUnitId === "string" ? identityOrUnitId : identityOrUnitId.unitId;
    const filePath = this.checkpointPath(unitId);
    if (!fs.existsSync(filePath)) return null;
    return WorkUnitCheckpoint.fromJSON(JSON.parse(fs.readFileSync(filePath, "utf8")));
  }

  save(checkpoint) {
    fs.mkdirSync(this.checkpointDir(), { recursive: true });
    const filePath = this.checkpointPath(checkpoint.unitId);
    fs.writeFileSync(filePath, `${JSON.stringify(checkpoint.toJSON(), null, 2)}\n`);
    return filePath;
  }

  saveSuccess({ identity, rawResponse = null, success = {} }) {
    return this.save(new WorkUnitCheckpoint({ identity, status: "success", rawResponse, success }));
  }

  saveFailed({ identity, unitId = null, failure }) {
    const checkpointIdentity = identity || new WorkUnitIdentity({
      phase: "impl-review",
      kind: "loop-chunk",
      stableOrderKey: unitId || "unknown",
      parentUnitId: null,
      targetFiles: ["unknown"],
      inputHash: "unknown",
      commandId: "unknown",
      providerIdentity: "unknown",
      promptVersion: "unknown",
      schemaVersion: "unknown",
    });
    return this.save(new WorkUnitCheckpoint({
      identity: checkpointIdentity,
      status: "failed",
      failure: normalizeFailure(failure),
    }));
  }

  recordsByStatus(status) {
    return this.records().filter((record) => record.status === status);
  }

  recordsByKind(kind) {
    return this.records().filter((record) => record.kind === kind);
  }

  recordsByUnitId(unitId) {
    return this.records().filter((record) => record.unitId === unitId);
  }

  recordsByNamespace(namespace) {
    return namespace === this.namespace ? this.records() : [];
  }

  failuresForUnit(unitId) {
    return this.recordsByUnitId(unitId).filter((record) => record.status === "failed").map((record) => record.failure);
  }

  records() {
    const dir = this.checkpointDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => this.load(name.slice(0, -5)));
  }
}

class MemoryWorkUnitCheckpointStore extends WorkUnitCheckpointStore {
  constructor({ specDir = process.cwd(), namespace = "impl-review" } = {}) {
    super({ specDir, namespace });
    this.items = [];
  }

  load(identityOrUnitId) {
    const unitId = typeof identityOrUnitId === "string" ? identityOrUnitId : identityOrUnitId.unitId;
    return this.items.filter((record) => record.unitId === unitId).at(-1) || null;
  }

  save(checkpoint) {
    this.items.push(checkpoint);
    return path.join(this.checkpointDir(), `${checkpoint.unitId}.json`);
  }

  saveFailed({ identity, unitId = null, failure }) {
    if (identity) return super.saveFailed({ identity, failure });
    this.items.push({
      unitId,
      kind: "loop-chunk",
      status: "failed",
      failure: normalizeFailure({ ...failure, unitId }),
    });
    return path.join(this.checkpointDir(), `${unitId}.json`);
  }

  records() {
    return [...this.items];
  }
}

export function createMemoryWorkUnitCheckpointStore(options) {
  return new MemoryWorkUnitCheckpointStore(options);
}

export function hashWorkUnitInput(input) {
  return sha256(String(input));
}

export function createLoopChunkWorkUnitIdentity({
  index,
  parentUnitId = null,
  targetFiles,
  input,
  commandId = "flow.impl.review.propose",
  providerIdentity = "default",
  promptVersion = "impl-review-loop-v1",
  schemaVersion = "impl-review-proposals-v1",
  schemaDigest = null,
  allowedRequirementIds = [],
  kind = parentUnitId ? "loop-chunk-child" : "loop-chunk",
}) {
  return new WorkUnitIdentity({
    phase: "impl-review",
    kind,
    stableOrderKey: `chunk-${String(index).padStart(4, "0")}`,
    parentUnitId,
    targetFiles,
    inputHash: hashWorkUnitInput(input),
    commandId,
    providerIdentity,
    promptVersion,
    schemaVersion,
    schemaDigest,
    allowedRequirementIds,
  });
}

export function createCrossCheckWorkUnitIdentity({
  summaries,
  commandId = "flow.impl.review.propose",
  providerIdentity = "default",
  promptVersion = "impl-review-cross-check-v1",
  schemaVersion = "impl-review-proposals-v1",
  schemaDigest = null,
  allowedRequirementIds = [],
}) {
  const summaryHashes = summaries.map((summary) => hashWorkUnitInput(stableJson(summary)));
  return new WorkUnitIdentity({
    phase: "impl-review",
    kind: "cross-check",
    stableOrderKey: `cross-check-${hashWorkUnitInput(stableJson(summaryHashes)).slice(0, 16)}`,
    parentUnitId: null,
    targetFiles: summaries.flatMap((summary) => summary.files || [summary.file]),
    inputHash: hashWorkUnitInput(stableJson(summaryHashes)),
    commandId,
    providerIdentity,
    promptVersion,
    schemaVersion,
    schemaDigest,
    allowedRequirementIds,
  });
}

function normalizeFailure(failure = {}) {
  const failureKind = failure.failureKind || "provider_failure";
  return {
    ...(failure.unitId ? { unitId: failure.unitId } : {}),
    failureKind,
    retryable: failure.retryable ?? RETRYABLE_FAILURE_KINDS.has(failureKind),
    message: failure.message || failureKind,
    ...(failure.failureCode ? { failureCode: failure.failureCode } : {}),
    ...(failure.recoveryHint ? { recoveryHint: failure.recoveryHint } : {}),
    ...(failure.agentFailureKind ? { agentFailureKind: failure.agentFailureKind } : {}),
    ...(failure.attemptCount != null ? { attemptCount: failure.attemptCount } : {}),
    ...(failure.maxAttempts != null ? { maxAttempts: failure.maxAttempts } : {}),
  };
}

export function classifyWorkUnitFailure(err, options = {}) {
  const agentFailure = err instanceof AgentFailure ? err : null;
  const failureKind = options.failureKind
    || err?.failureKind
    || (agentFailure ? "provider_failure" : null)
    || (err instanceof WorkUnitInvariantError ? "invariant_violation" : "provider_failure");
  const retryable = agentFailure?.retryable ?? RETRYABLE_FAILURE_KINDS.has(failureKind);
  return {
    failureKind,
    retryable,
    toolingFailure: agentFailure != null || RETRYABLE_FAILURE_KINDS.has(failureKind),
    commandFailure: COMMAND_FAILURE_KINDS.has(failureKind),
    message: err?.message || failureKind,
    rawResponse: err?.rawResponse ?? null,
    ...(agentFailure ? {
      failureCode: agentFailure.code,
      recoveryHint: agentFailure.recoveryHint,
      agentFailureKind: agentFailure.kind,
      attemptCount: agentFailure.attemptCount,
      maxAttempts: agentFailure.maxAttempts,
    } : {}),
  };
}

export function shouldFallbackSplit(failures = []) {
  const byUnit = new Map();
  for (const failure of failures) {
    if (!failure?.retryable) continue;
    const key = failure.unitId || "default";
    byUnit.set(key, (byUnit.get(key) || 0) + 1);
  }
  return [...byUnit.values()].some((count) => count >= 2);
}

export function planFallbackChildWorkUnits({ parentIdentity, parentChunk, priorFailures = [] }) {
  if (!(parentIdentity instanceof WorkUnitIdentity)) {
    throw new WorkUnitInvariantError("parentIdentity must be WorkUnitIdentity");
  }
  if (!shouldFallbackSplit(priorFailures.map((failure) => ({ ...failure, unitId: failure.unitId || parentIdentity.unitId })))) return [];
  return parentChunk.map((group, index) => new WorkUnitPlanEntry({
    identity: createLoopChunkWorkUnitIdentity({
      index,
      parentUnitId: parentIdentity.unitId,
      targetFiles: group.files,
      input: `${parentIdentity.stableOrderKey}:${group.files.join(",")}`,
      commandId: parentIdentity.commandId,
      providerIdentity: parentIdentity.providerIdentity,
      promptVersion: parentIdentity.promptVersion,
      schemaVersion: parentIdentity.schemaVersion,
      schemaDigest: parentIdentity.schemaDigest,
      allowedRequirementIds: parentIdentity.allowedRequirementIds,
      kind: "loop-chunk-child",
    }),
    groups: [group],
  }));
}

export function shouldUseWorkUnitsForReviewPhase({ phase, mode }) {
  return phase === "impl" && mode === "loop";
}
