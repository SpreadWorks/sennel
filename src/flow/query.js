import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { FlowSpecId } from "../lib/flow-spec-id.js";
import { repoRoot } from "../lib/cli.js";
import {
  FlowArtifactCatalog,
  FlowArtifactActivityAssociation,
  FlowArtifactActivityIndex,
  FlowVersion,
  FlowVersionAuthorityScope,
  FlowVersionLocation,
} from "../lib/flow-version.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../lib/flow-artifact-contract.js";
import { buildCurrentFlowDefinition } from "./definition.js";
import { isGitSnapshot } from "../lib/git-snapshot.js";
import {
  CurrentFlowSpecRecord,
  CurrentFlowActivitySummary,
  CurrentFlowState,
  CurrentFlowStateValidator,
  AGGREGATE_METRIC_PROVENANCE,
  FlowActivity,
} from "./lib/current-flow-state.js";

export const FLOW_QUERY_LIMITS = Object.freeze({
  MAX_REQUEST_BYTES: 1_048_576,
  MAX_RESPONSE_BYTES: 2_097_152,
  MAX_PAGE_LIMIT: 100,
  MAX_AVAILABLE_FLOW_VERSIONS: 10_000,
  MAX_CONFIRMED_ACTIVITIES: 100_000,
  MAX_STATE_RECORD_BYTES: 16_777_216,
  MAX_SPEC_RECORD_BYTES: 16_777_216,
  MAX_CONFIRMED_LEDGER_BYTES: 33_554_432,
  MAX_ARTIFACT_CATALOG_BYTES: 16_777_216,
  MAX_ARTIFACTS: 10_000,
  MAX_IDS_PER_ARTIFACT: 1_000,
  MAX_PUBLIC_COLLECTION_ITEMS: 10_000,
  MAX_PUBLIC_STRING_BYTES: 4_096,
  MAX_ARTIFACT_ID_CANONICAL_JSON_BYTES: 65_536,
  MAX_CANONICAL_JSON_DEPTH: 32,
});

export const FLOW_QUERY_SCHEMA_REVISION = 1;

const ERROR_CODES = Object.freeze({
  INVALID_JSON: "INVALID_JSON",
  INVALID_REQUEST: "INVALID_REQUEST",
  SPEC_NOT_FOUND: "SPEC_NOT_FOUND",
  FLOW_VERSION_NOT_FOUND: "FLOW_VERSION_NOT_FOUND",
  CANONICAL_RECORD_UNREADABLE: "CANONICAL_RECORD_UNREADABLE",
  CANONICAL_RECORD_INCONSISTENT: "CANONICAL_RECORD_INCONSISTENT",
  INVALID_CURSOR: "INVALID_CURSOR",
  CURSOR_QUERY_MISMATCH: "CURSOR_QUERY_MISMATCH",
});

const ERROR_PATHS = Object.freeze({
  INVALID_JSON: "/request",
  INVALID_REQUEST: null,
  SPEC_NOT_FOUND: "/condition/specId",
  FLOW_VERSION_NOT_FOUND: "/condition/flowVersion",
  CANONICAL_RECORD_UNREADABLE: "/canonical",
  CANONICAL_RECORD_INCONSISTENT: "/canonical",
  INVALID_CURSOR: "/page/after",
  CURSOR_QUERY_MISMATCH: "/page/after",
});

const CURSOR_PAYLOAD_FIELDS = Object.freeze([
  "digest", "flowVersion", "gte", "lt", "order", "resource", "specId", "version",
]);
const CURSOR_PAYLOAD_FIELD_SET = new Set(CURSOR_PAYLOAD_FIELDS);

const ARTIFACT_DESCRIPTOR_FIELDS = new Set([
  "logicalKey", "kind", "relativePath", "hash", "size", "mediaType", "authority",
  "cardinality", "memberId", "publicationStep", "retention", "activityId",
  "migrationMaterialization",
]);

export const FLOW_QUERY_ERROR_CODES = ERROR_CODES;
export const FLOW_QUERY_ERROR_PATHS = ERROR_PATHS;

class QueryError extends Error {
  constructor(code, jsonPath, message, { cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.code = code;
    this.jsonPath = jsonPath;
  }
}

class SelectedFlowVersion {
  constructor(specId, flowVersion) {
    this.specId = new FlowSpecId(specId).toString();
    this.flowVersion = new FlowVersion(flowVersion).value;
    Object.freeze(this);
  }

  toJSON() { return { specId: this.specId, flowVersion: this.flowVersion }; }
}

class QueryPage {
  constructor(value) {
    if (value === undefined) value = {};
    else requireRequestObject(value, ["limit", "after"], "/page", "page");
    const { limit = 100, after = null } = value;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > FLOW_QUERY_LIMITS.MAX_PAGE_LIMIT) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/page/limit", `page.limit must be an integer from 1 to ${FLOW_QUERY_LIMITS.MAX_PAGE_LIMIT}`);
    }
    if (after !== null && (typeof after !== "string"
      || after === ""
      || Buffer.byteLength(after, "utf8") > FLOW_QUERY_LIMITS.MAX_PUBLIC_STRING_BYTES)) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/page/after", "page.after must be an unpadded base64url cursor or null");
    }
    this.limit = limit;
    this.after = after;
    Object.freeze(this);
  }
}

class DateRange {
  constructor(value) {
    if (value === undefined) value = {};
    else requireRequestObject(value, ["gte", "lt"], "/recordedAt", "recordedAt");
    const { gte = null, lt = null } = value;
    for (const [key, value] of [["gte", gte], ["lt", lt]]) {
      if (value !== null && (typeof value !== "string" || !/[Tt].*(?:Z|[+-]\d{2}:?\d{2})$/.test(value) || Number.isNaN(Date.parse(value)))) {
        throw new QueryError(ERROR_CODES.INVALID_REQUEST, `/recordedAt/${key}`, `${key} must be a timezone-bearing ISO 8601 datetime or null`);
      }
    }
    if (gte !== null && lt !== null && Date.parse(gte) >= Date.parse(lt)) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/recordedAt", "recordedAt.gte must be earlier than recordedAt.lt");
    }
    this.gte = gte;
    this.lt = lt;
    Object.freeze(this);
  }
}

class QueryRequest {
  constructor(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/request", "request must be one JSON object");
    }
    const resource = value.resource;
    if (typeof resource !== "string" || !["metadata", "activities"].includes(resource)) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/resource", "resource must be metadata or activities");
    }
    const allowed = resource === "metadata"
      ? new Set(["resource", "condition"])
      : new Set(["resource", "condition", "page", "recordedAt"]);
    rejectUnknownFields(value, allowed, "", "request");
    if (!Object.hasOwn(value, "condition") || value.condition === null || typeof value.condition !== "object" || Array.isArray(value.condition)) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/condition", "condition must be an object");
    }
    rejectUnknownFields(value.condition, ["specId", "flowVersion"], "/condition", "condition");
    if (typeof value.condition.specId !== "string" || value.condition.specId.trim() === "") {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/condition/specId", "condition.specId must be a non-empty identifier");
    }
    try { this.specId = new FlowSpecId(value.condition.specId.trim()).toString(); } catch (error) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/condition/specId", "condition.specId has an invalid identifier", { cause: error });
    }
    const version = value.condition.flowVersion;
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/condition/flowVersion", "condition.flowVersion must be a positive safe integer");
    }
    this.resource = resource;
    this.flowVersion = version ?? 1;
    if (resource === "activities" && Object.hasOwn(value, "page") && !isPlainObject(value.page)) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/page", "page must be an object");
    }
    if (resource === "activities" && Object.hasOwn(value, "recordedAt") && !isPlainObject(value.recordedAt)) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/recordedAt", "recordedAt must be an object");
    }
    this.page = resource === "activities" ? new QueryPage(Object.hasOwn(value, "page") ? value.page : undefined) : null;
    this.recordedAt = resource === "activities" ? new DateRange(Object.hasOwn(value, "recordedAt") ? value.recordedAt : undefined) : null;
    if (resource === "activities" && this.page.after !== null) Cursor.decode(this.page.after, this);
    Object.freeze(this);
  }
}

class CanonicalVersionDirectoryEntry {
  constructor(name) {
    if (typeof name !== "string" || !/^\d+$/.test(name)) {
      throw new Error("canonical Version directory entry must be a numeric identity");
    }
    const version = new FlowVersion(Number(name));
    if (version.pathSegment !== name) throw new Error("canonical Version directory entry is not normalized");
    this.name = name;
    this.version = version.value;
    Object.freeze(this);
  }
}

function canonicalJson(value, depth = 0) {
  if (depth > FLOW_QUERY_LIMITS.MAX_CANONICAL_JSON_DEPTH) throw new Error("canonical JSON depth exceeds the limit");
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonical JSON cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalJson(entry, depth + 1));
  const output = Object.create(null);
  for (const key of Object.keys(value).sort()) output[key] = canonicalJson(value[key], depth + 1);
  return output;
}

function canonicalDigest(value) {
  const text = JSON.stringify(canonicalJson(value));
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > FLOW_QUERY_LIMITS.MAX_ARTIFACT_ID_CANONICAL_JSON_BYTES) throw new Error("artifact identity exceeds the canonical JSON byte limit");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function jsonPointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function rejectUnknownFields(value, allowedFields, jsonPath, label) {
  const allowed = allowedFields instanceof Set ? allowedFields : new Set(allowedFields);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new QueryError(ERROR_CODES.INVALID_REQUEST, `${jsonPath}/${jsonPointerToken(unknown)}`, `${label} contains an unknown field`);
}

function requireRequestObject(value, fields, jsonPath, label) {
  if (!isPlainObject(value)) throw new QueryError(ERROR_CODES.INVALID_REQUEST, jsonPath, `${label} must be an object`);
  rejectUnknownFields(value, fields, jsonPath, label);
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new QueryError(ERROR_CODES.INVALID_REQUEST, jsonPath, `${label} must contain exactly ${fields.join(" and ")}`);
  }
}

function requireExactObject(value, fields, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new Error(`${label} has an invalid shape`);
  }
}

function requirePublicString(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return publicString(value, label);
}

function requirePublicInteger(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function requirePublicStringList(value, label, {
  limit = FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS,
  unique = false,
} = {}) {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`${label} must be a bounded array`);
  }
  if (unique && new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return value.map((entry) => requirePublicString(entry, label));
}

async function readBoundedFile(file, maxBytes, {
  code = ERROR_CODES.CANONICAL_RECORD_UNREADABLE,
  identityCode = ERROR_CODES.CANONICAL_RECORD_INCONSISTENT,
  limitCode = ERROR_CODES.CANONICAL_RECORD_INCONSISTENT,
  jsonPath = "/canonical",
  message = "canonical record could not be read",
} = {}) {
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await fs.promises.realpath(file) !== file) {
      throw new QueryError(identityCode, jsonPath, "canonical record is not a regular real file");
    }
    if (!Number.isSafeInteger(stat.size) || stat.size > maxBytes) {
      throw new QueryError(limitCode, jsonPath, "canonical record exceeds its bounded size");
    }
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new QueryError(limitCode, jsonPath, "canonical record exceeds its bounded size");
    return bytes;
  } catch (error) {
    if (error instanceof QueryError) throw error;
    if (error?.code === "ELOOP") {
      throw new QueryError(identityCode, jsonPath, "canonical record is not a regular real file", { cause: error });
    }
    throw new QueryError(code, jsonPath, message, { cause: error });
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (closeError) {
        throw new QueryError(code, jsonPath, message, { cause: closeError });
      }
    }
  }
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch (error) {
    throw new QueryError(ERROR_CODES.CANONICAL_RECORD_UNREADABLE, "/canonical", `${label} is not valid canonical JSON`, { cause: error });
  }
}

function isCanonicalReadError(error) {
  const seen = new Set();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    if (["EACCES", "EISDIR", "ENOENT", "ENOTDIR", "EPERM"].includes(current.code)
      || current.message?.startsWith("Version authority path does not exist:")) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

const FLOW_ACTIVITIES_RELATIVE_PATH = FLOW_ARTIFACT_CONTRACTS.resolve("flow.activities").relativePath;

function queryCatalogManagedFiles(location, current = location.directory, result = [], scan = { count: 0 }) {
  location.assertAuthority(null, { mustExist: true });
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    scan.count += 1;
    if (scan.count > FLOW_QUERY_LIMITS.MAX_ARTIFACTS) {
      throw new Error("Version storage entry count exceeds the Artifact limit");
    }
    const absolute = path.join(current, entry.name);
    const relative = path.relative(location.directory, absolute).split(path.sep).join("/");
    if (relative === ".runtime") {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Version runtime authority must be a real directory");
      continue;
    }
    if (entry.isSymbolicLink()) throw new Error(`Version storage must not contain symbolic links: ${relative}`);
    if (entry.isDirectory()) {
      queryCatalogManagedFiles(location, absolute, result, scan);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Version storage contains an unsupported entry: ${relative}`);
    const stat = fs.lstatSync(absolute);
    if (stat.nlink !== 1) throw new Error(`Version storage artifact must not be hard linked: ${relative}`);
    if (relative === FLOW_ARTIFACT_CONTRACTS.resolve("artifact.catalog").relativePath) continue;
    if (relative === "flow-migration-report.json" || relative.startsWith("artifacts/migration/")) {
      result.push(relative);
      continue;
    }
    let contract;
    try { contract = FLOW_ARTIFACT_CONTRACTS.classify(relative); } catch (error) {
      throw new Error(`Version storage contains an unclassified artifact: ${relative}`, { cause: error });
    }
    if (contract.cataloged) result.push(relative);
  }
  return result.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

async function verifyQueryCatalog(catalog, location, activities, ledgerBytes) {
  const actual = new Set(queryCatalogManagedFiles(location));
  const cataloged = new Set(catalog.artifacts.map((artifact) => artifact.relativePath));
  for (const file of actual) {
    if (!cataloged.has(file)) throw new Error(`catalog-managed artifact is missing from the catalog: ${file}`);
  }
  const ledger = catalog.artifacts.find((artifact) => artifact.relativePath === FLOW_ACTIVITIES_RELATIVE_PATH) ?? null;
  const activityIndex = new FlowArtifactActivityIndex(activities.map((activity) => new FlowArtifactActivityAssociation({
    id: activity.id,
    nodeId: activity.nodeId,
    nodeKey: activity.nodeKey,
    confirmationOrder: activity.confirmationOrder,
    operation: activity.transition.operation,
  })));
  if (ledger === null) return catalog.verify(location, activityIndex);
  const ledgerDigest = crypto.createHash("sha256").update(ledgerBytes).digest("hex");
  if (ledgerDigest === ledger.hash) return catalog.verify(location, activityIndex);

  // The active ledger can contain an unconfirmed suffix after the cataloged
  // confirmed prefix. Verify every other cataloged artifact while replay and
  // the typed Activity index continue to protect the confirmed prefix.
  for (const artifact of catalog.artifacts) {
    if (artifact.relativePath !== FLOW_ACTIVITIES_RELATIVE_PATH) artifact.verify(location);
  }
  for (const artifact of catalog.artifacts.filter((entry) => entry.activityId !== null)) {
    const activity = activityIndex.require(artifact.activityId).assertRelatedArtifact(artifact);
    if (artifact.logicalKey !== null) {
      const contract = FLOW_ARTIFACT_CONTRACTS.require(artifact.logicalKey);
      contract.contentContract?.assertCatalogAssociation({
        bytes: await readBoundedFile(location.resolve(artifact.relativePath), artifact.size),
        descriptor: artifact,
        activity,
      });
    }
  }
  return catalog;
}

function stateCreatedActivityId(state) {
  const identityDigest = crypto.createHash("sha256")
    .update(JSON.stringify(state.identity.toJSON()), "utf8")
    .digest("hex");
  return `flow-created-${identityDigest}`;
}

function replayCanonicalState(state, activities) {
  if (!(state instanceof CurrentFlowState) || !Array.isArray(activities)) {
    throw new Error("canonical state replay requires typed state and Activities");
  }
  const orders = activities.map((activity) => activity.confirmationOrder);
  const expectedOrders = Array.from({ length: activities.length }, (_, index) => index + 1);
  if (JSON.stringify(orders) !== JSON.stringify(expectedOrders) || state.confirmationOrder !== activities.length) {
    throw new Error("canonical Activity prefix is not a complete contiguous state prefix");
  }
  if (state.history !== null) {
    const created = activities[0] ?? null;
    if (state.history.creation.status === "available") {
      if (created === null || created.transition.operation !== "create_flow"
        || created.type !== "flow_created"
        || created.id !== stateCreatedActivityId(state)
        || created.timing?.startedAt !== state.history.creation.source.timestamp) {
        throw new Error("historical creation authority does not match its create_flow Activity");
      }
    } else if (activities.some((activity) => activity.transition.operation === "create_flow" || activity.type === "flow_created")) {
      throw new Error("historical Flow without creation authority cannot claim a create_flow Activity");
    }
    if (state.history.resumed) {
      const continuation = state.history.continuation;
      const boundary = activities[continuation.confirmationOrder - 1] ?? null;
      if (!boundary?.startsAttempt({
        nodeId: continuation.nodeId,
        id: continuation.attemptId,
        sequence: continuation.attemptSequence,
      })) {
        throw new Error("historical continuation boundary does not match its Activity prefix");
      }
    }
    // A dormant import with no confirmed ledger prefix has no replayable
    // execution history. Once a historical record does claim confirmed
    // Activities, however, validate that prefix through the same transition
    // reducer and resulting-state comparison used by native Flows.
    if (activities.length === 0) return state;
  }
  let replayed = CurrentFlowState.create({
    definition: state.definition,
    execution: state.execution.toJSON(),
    version: state.version,
    ...state.identity.toJSON(),
    request: state.request,
    lifecycle: { state: "active" },
    policy: state.policy.toJSON(),
    artifacts: state.artifacts.toJSON(),
    outbox: state.outbox.toJSON(),
    context: state.context.toJSON(),
  });
  const priorActivities = [];
  for (const activity of activities) {
    const node = replayed.findNode(activity.nodeId);
    if (!node || node.key !== activity.nodeKey) {
      throw new Error("Activity must reference a state node by stable id and semantic key");
    }
    replayed = activity.transition.apply(replayed, activity, { priorActivities })
      .withConfirmationOrder(activity.confirmationOrder);
    priorActivities.push(activity);
  }
  const expectedState = state.toJSON();
  if (state.history !== null) expectedState.history = null;
  if (JSON.stringify(replayed.toJSON()) !== JSON.stringify(expectedState)) {
    throw new Error("flow state content conflicts with its Activity prefix");
  }
  return state;
}

function publicString(value, field) {
  if (value === null) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > FLOW_QUERY_LIMITS.MAX_PUBLIC_STRING_BYTES) {
    throw new Error(`${field} exceeds the public string limit`);
  }
  return value;
}

function uniqueLimited(values, field, limit = FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS) {
  const result = [...new Set(values)];
  if (result.length > limit) throw new Error(`${field} exceeds the public collection limit`);
  return result;
}

function uniqueObjectList(values, field, limit = FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS) {
  const serialized = uniqueLimited(values.map((value) => JSON.stringify(value)), field, limit);
  return serialized.map((value) => JSON.parse(value));
}

function publicArtifactId(descriptor) {
  return canonicalDigest(artifactIdentity(descriptor));
}

function boundedPublic(value, field, depth = 0) {
  if (depth > FLOW_QUERY_LIMITS.MAX_CANONICAL_JSON_DEPTH) throw new Error(`${field} exceeds the public nesting limit`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return publicString(value, field);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS) throw new Error(`${field} exceeds the public collection limit`);
    return value.map((entry, index) => boundedPublic(entry, `${field}[${index}]`, depth + 1));
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length > FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS) throw new Error(`${field} exceeds the public collection limit`);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, boundedPublic(entry, `${field}.${key}`, depth + 1)]));
  }
  throw new Error(`${field} has an unsupported public value`);
}

function validateIdKey(value, label) {
  if (value === null) return;
  requireExactObject(value, ["id", "key"], label);
  requirePublicString(value.id, `${label}.id`);
  requirePublicString(value.key, `${label}.key`);
}

function validateBlocker(value, label) {
  if (value === null) return;
  requireExactObject(value, ["code", "message"], label);
  requirePublicString(value.code, `${label}.code`);
  requirePublicString(value.message, `${label}.message`);
}

function validateNextAction(value) {
  if (value === null) return;
  requireExactObject(value, ["operation", "phase", "stepId", "taskId"], "MetadataItem.lifecycle.nextAction");
  requirePublicString(value.operation, "MetadataItem.lifecycle.nextAction.operation");
  for (const field of ["phase", "stepId", "taskId"]) requirePublicString(value[field], `MetadataItem.lifecycle.nextAction.${field}`, { nullable: true });
}

function validateTimestamp(value, label) {
  requireExactObject(value, ["value", "availability", "reason", "provenance"], label);
  requirePublicString(value.value, `${label}.value`, { nullable: true });
  if (!isPlainObject(value) || !["available", "unavailable"].includes(value.availability)) throw new Error(`${label}.availability is invalid`);
  requirePublicString(value.reason, `${label}.reason`, { nullable: true });
  requirePublicString(value.provenance, `${label}.provenance`, { nullable: true });
  if (value.availability === "available" ? value.value === null || value.reason !== null || value.provenance === null : value.value !== null || value.reason === null || value.provenance === null) throw new Error(`${label} availability is inconsistent`);
}

function validatePairList(value, label, left, right) {
  if (!Array.isArray(value) || value.length > FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS) throw new Error(`${label} is invalid`);
  for (const entry of value) {
    requireExactObject(entry, [left, right], label);
    requirePublicString(entry[left], `${label}.${left}`);
    requirePublicString(entry[right], `${label}.${right}`);
  }
}

function validateTiming(value) {
  if (value === null) return;
  requireExactObject(value, ["startedAt", "finishedAt", "durationMs"], "ActivityItem.timing");
  isoTimestamp(value.startedAt, "ActivityItem.timing.startedAt");
  isoTimestamp(value.finishedAt, "ActivityItem.timing.finishedAt");
  requirePublicInteger(value.durationMs, "ActivityItem.timing.durationMs", { nullable: true });
}

function validateCost(value, label) {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error(`${label} is invalid`);
}

function validateUsage(value) {
  if (value === null) return;
  requireExactObject(value, ["inputTokens", "outputTokens", "cacheReadTokens", "cost"], "ActivityItem.usage");
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens"]) requirePublicInteger(value[field], `ActivityItem.usage.${field}`);
  validateCost(value.cost, "ActivityItem.usage.cost");
}

function validateOutcome(value) {
  if (value === null) return;
  requireExactObject(value, ["outcome", "summary", "confirmedAt", "artifactRefs"], "ActivityItem.outcome");
  if (!["passed", "failed", "skipped", "incomplete"].includes(value.outcome)) throw new Error("ActivityItem.outcome.outcome is invalid");
  requirePublicString(value.summary, "ActivityItem.outcome.summary");
  isoTimestamp(value.confirmedAt, "ActivityItem.outcome.confirmedAt");
  if (!Array.isArray(value.artifactRefs) || value.artifactRefs.length > FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS) throw new Error("ActivityItem.outcome.artifactRefs is invalid");
  for (const ref of value.artifactRefs) { requireExactObject(ref, ["kind", "id"], "ActivityItem.outcome.artifactRef"); requirePublicString(ref.kind, "ActivityItem.outcome.artifactRef.kind"); requirePublicString(ref.id, "ActivityItem.outcome.artifactRef.id"); }
}

function validateFailure(value) {
  if (value === null) return;
  requireExactObject(value, ["category", "code", "message", "retryable", "retryKind"], "ActivityItem.failure");
  for (const field of ["category", "code", "message"]) requirePublicString(value[field], `ActivityItem.failure.${field}`);
  if (typeof value.retryable !== "boolean" || (value.retryKind !== null && !["semantic", "tooling"].includes(value.retryKind))) throw new Error("ActivityItem.failure retry fields are invalid");
}

function validateIncomplete(value) {
  if (value === null) return;
  requireExactObject(value, ["code", "message", "operation", "resources"], "ActivityItem.incomplete");
  requirePublicString(value.code, "ActivityItem.incomplete.code");
  requirePublicString(value.message, "ActivityItem.incomplete.message");
  requirePublicString(value.operation, "ActivityItem.incomplete.operation", { nullable: true });
  requirePublicStringList(value.resources, "ActivityItem.incomplete.resources");
}

function validateMetric(value) {
  if (value === null) return;
  requireExactObject(value, ["phase", "counter", "delta", "reset", "kind", "provider", "profileKey", "callCount", "responseChars", "durationMs", "model", "tokens", "cost", "cachedResponse", "costIncomplete"], "ActivityItem.metric");
  requirePublicString(value.phase, "ActivityItem.metric.phase");
  requirePublicString(value.counter, "ActivityItem.metric.counter", { nullable: true });
  requirePublicInteger(value.delta, "ActivityItem.metric.delta", { nullable: true });
  if (typeof value.reset !== "boolean") throw new Error("ActivityItem.metric.reset must be boolean");
  for (const field of ["kind", "provider", "profileKey", "model"]) requirePublicString(value[field], `ActivityItem.metric.${field}`, { nullable: true });
  for (const field of ["callCount", "responseChars", "durationMs"]) requirePublicInteger(value[field], `ActivityItem.metric.${field}`, { nullable: true });
  if (value.tokens !== null) { requireExactObject(value.tokens, ["input", "output", "cacheRead", "cacheCreation"], "ActivityItem.metric.tokens"); for (const field of Object.keys(value.tokens)) requirePublicInteger(value.tokens[field], `ActivityItem.metric.tokens.${field}`); }
  validateCost(value.cost, "ActivityItem.metric.cost");
  if (typeof value.cachedResponse !== "boolean" || typeof value.costIncomplete !== "boolean") throw new Error("ActivityItem.metric flags are invalid");
}

function artifactIdentity(descriptor) {
  return {
    logicalKey: descriptor.logicalKey,
    kind: descriptor.kind,
    relativePath: descriptor.relativePath,
    hash: descriptor.hash,
    size: descriptor.size,
    mediaType: descriptor.mediaType,
    authority: descriptor.authority,
    cardinality: descriptor.cardinality,
    memberId: descriptor.memberId,
    publicationStep: descriptor.publicationStep,
    retention: descriptor.retention,
    activityId: descriptor.activityId,
    migrationMaterialization: descriptor.migrationMaterialization,
  };
}

class AggregateMetrics {
  constructor(value) {
    const fields = ["activityCount", "artifactCount", "stepCount", "taskCount", "durationMs", "inputTokens", "outputTokens", "cacheReadTokens", "cost", "provenance"];
    if (!isPlainObject(value) || Object.keys(value).some((key) => !fields.includes(key)) || Object.keys(value).length !== fields.length) {
      throw new Error("AggregateMetrics has an invalid shape");
    }
    for (const field of ["activityCount", "artifactCount", "stepCount", "taskCount"]) {
      if (!Number.isSafeInteger(value[field]) || value[field] < 0) throw new Error(`AggregateMetrics.${field} must be a non-negative safe integer`);
    }
    for (const field of ["durationMs", "inputTokens", "outputTokens", "cacheReadTokens", "cost"]) {
      const measurement = value[field];
      if (measurement !== null && (!Number.isFinite(measurement) || measurement < 0 || (field !== "cost" && !Number.isSafeInteger(measurement)))) {
        throw new Error(`AggregateMetrics.${field} is invalid`);
      }
    }
    const provenanceFields = ["activityCount", "artifactCount", "stepCount", "taskCount", "durationMs", "inputTokens", "outputTokens", "cacheReadTokens", "cost"];
    if (!isPlainObject(value.provenance) || Object.keys(value.provenance).length !== provenanceFields.length
      || provenanceFields.some((field) => value.provenance[field] !== AGGREGATE_METRIC_PROVENANCE[field])) {
      throw new Error("AggregateMetrics.provenance is invalid");
    }
    this.value = Object.freeze({ ...value, provenance: Object.freeze({ ...value.provenance }) });
    Object.freeze(this);
  }

  toJSON() { return { ...this.value, provenance: { ...this.value.provenance } }; }
}

class MetadataItem {
  constructor(value) {
    requireExactObject(value, ["identity", "lifecycle", "location", "structure", "relationships", "timestamps", "capabilities", "artifacts", "metrics"], "MetadataItem");
    requireExactObject(value.identity, ["flowId", "flowVersionId", "runId", "specId", "flowVersion"], "MetadataItem.identity");
    for (const field of ["flowId", "flowVersionId", "runId", "specId"]) requirePublicString(value.identity[field], `MetadataItem.identity.${field}`);
    requirePublicInteger(value.identity.flowVersion, "MetadataItem.identity.flowVersion");
    requireExactObject(value.lifecycle, ["lifecycle", "blocked", "blocker", "nextAction"], "MetadataItem.lifecycle");
    if (!["active", "parked", "finalized"].includes(value.lifecycle.lifecycle) || typeof value.lifecycle.blocked !== "boolean") throw new Error("MetadataItem.lifecycle has invalid values");
    validateBlocker(value.lifecycle.blocker, "MetadataItem.lifecycle.blocker");
    validateNextAction(value.lifecycle.nextAction);
    const blockedByNextAction = value.lifecycle.nextAction?.operation === "blocked";
    if (value.lifecycle.blocked !== blockedByNextAction
      || (blockedByNextAction && (value.lifecycle.blocker === null || value.lifecycle.nextAction === null))
      || (!blockedByNextAction && value.lifecycle.blocker !== null)) {
      throw new Error("MetadataItem.lifecycle blocked fields are inconsistent");
    }
    requireExactObject(value.location, ["phase", "stepId", "taskId", "git"], "MetadataItem.location");
    for (const field of ["phase", "stepId", "taskId"]) requirePublicString(value.location[field], `MetadataItem.location.${field}`, { nullable: true });
    requireExactObject(value.location.git, ["available", "commit"], "MetadataItem.location.git");
    if (typeof value.location.git.available !== "boolean") throw new Error("MetadataItem.location.git.available must be boolean");
    if (value.location.git.available) {
      if (typeof value.location.git.commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.location.git.commit)) throw new Error("MetadataItem.location.git.commit is invalid");
    } else if (value.location.git.commit !== null) throw new Error("MetadataItem.location.git.commit must be null when unavailable");
    requireExactObject(value.structure, ["phaseId", "stepIds", "taskIds"], "MetadataItem.structure");
    requirePublicString(value.structure.phaseId, "MetadataItem.structure.phaseId");
    requirePublicStringList(value.structure.stepIds, "MetadataItem.structure.stepIds");
    requirePublicStringList(value.structure.taskIds, "MetadataItem.structure.taskIds");
    requireExactObject(value.relationships, ["stepTasks", "taskNodes", "issues"], "MetadataItem.relationships");
    validatePairList(value.relationships.stepTasks, "MetadataItem.relationships.stepTasks", "stepId", "taskId");
    validatePairList(value.relationships.taskNodes, "MetadataItem.relationships.taskNodes", "taskId", "nodeId");
    if (!Array.isArray(value.relationships.issues) || value.relationships.issues.length > 1) throw new Error("MetadataItem.relationships.issues must contain zero or one issue");
    for (const issue of value.relationships.issues) {
      requireExactObject(issue, ["number", "relationship"], "MetadataItem.relationships.issue");
      if (!Number.isSafeInteger(issue.number) || issue.number < 1 || issue.relationship !== "tracks") throw new Error("MetadataItem.relationships.issue is invalid");
    }
    requireExactObject(value.timestamps, ["createdAt", "updatedAt", "finalizedAt"], "MetadataItem.timestamps");
    for (const field of ["createdAt", "updatedAt", "finalizedAt"]) validateTimestamp(value.timestamps[field], `MetadataItem.timestamps.${field}`);
    if (!isPlainObject(value.capabilities) || Object.keys(value.capabilities).length > FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS
      || Object.entries(value.capabilities).some(([key, entry]) => !/^[A-Za-z][A-Za-z0-9._-]*$/.test(key) || typeof entry !== "boolean")) throw new Error("MetadataItem.capabilities is invalid");
    if (!Array.isArray(value.artifacts) || value.artifacts.length > FLOW_QUERY_LIMITS.MAX_ARTIFACTS || value.artifacts.some((entry) => !(entry instanceof ArtifactDescriptorView))) throw new Error("MetadataItem.artifacts is invalid");
    if (!(value.metrics instanceof AggregateMetrics)) throw new Error("MetadataItem.metrics is invalid");
    this.value = boundedPublic({ ...value, artifacts: value.artifacts.map((entry) => entry.toJSON()), metrics: value.metrics.toJSON() }, "metadata");
    Object.freeze(this.value);
    Object.freeze(this);
  }

  toJSON() { return boundedPublic(this.value, "metadata"); }
}

class ActivityItem {
  constructor(value) {
    const fields = ["activity", "node", "task", "attempt", "sequence", "confirmationOrder", "transition", "timing", "usage", "outcome", "failure", "blocker", "incomplete", "metric", "note", "evaluationIds", "findingIds", "repairIds", "artifactIds"];
    requireExactObject(value, fields, "ActivityItem");
    requireExactObject(value.activity, ["id", "type"], "ActivityItem.activity");
    requirePublicString(value.activity.id, "ActivityItem.activity.id");
    requirePublicString(value.activity.type, "ActivityItem.activity.type");
    requireExactObject(value.node, ["id", "key"], "ActivityItem.node");
    requirePublicString(value.node.id, "ActivityItem.node.id");
    requirePublicString(value.node.key, "ActivityItem.node.key");
    validateIdKey(value.task, "ActivityItem.task");
    if (value.attempt !== null) { requireExactObject(value.attempt, ["id", "sequence"], "ActivityItem.attempt"); requirePublicString(value.attempt.id, "ActivityItem.attempt.id"); requirePublicInteger(value.attempt.sequence, "ActivityItem.attempt.sequence"); if (value.attempt.sequence < 1) throw new Error("ActivityItem.attempt.sequence must be positive"); }
    requirePublicInteger(value.sequence, "ActivityItem.sequence", { nullable: true });
    if (value.sequence !== null && value.sequence < 1) throw new Error("ActivityItem.sequence must be positive");
    requirePublicInteger(value.confirmationOrder, "ActivityItem.confirmationOrder");
    if (value.confirmationOrder < 1) throw new Error("ActivityItem.confirmationOrder must be positive");
    requireExactObject(value.transition, ["operation", "status"], "ActivityItem.transition");
    requirePublicString(value.transition.operation, "ActivityItem.transition.operation");
    requirePublicString(value.transition.status, "ActivityItem.transition.status", { nullable: true });
    validateTiming(value.timing); validateUsage(value.usage); validateOutcome(value.outcome); validateFailure(value.failure); validateBlocker(value.blocker, "ActivityItem.blocker"); validateIncomplete(value.incomplete); validateMetric(value.metric);
    requirePublicString(value.note, "ActivityItem.note", { nullable: true });
    for (const field of ["evaluationIds", "findingIds", "repairIds", "artifactIds"]) requirePublicStringList(value[field], `ActivityItem.${field}`);
    this.value = boundedPublic(value, "activity");
    Object.freeze(this);
  }

  toJSON() { return boundedPublic(this.value, "activity"); }
}

class ArtifactDescriptorView {
  constructor(value) {
    requireExactObject(value, ["artifactId", "metadata", "activityIds", "nodeIds", "taskIds"], "ArtifactDescriptorView");
    requirePublicString(value.artifactId, "ArtifactDescriptorView.artifactId");
    requireExactObject(value.metadata, ["logicalKey", "schemaRevision", "mediaType"], "ArtifactDescriptorView.metadata");
    requirePublicString(value.metadata.logicalKey, "ArtifactDescriptorView.metadata.logicalKey", { nullable: true });
    requirePublicInteger(value.metadata.schemaRevision, "ArtifactDescriptorView.metadata.schemaRevision", { nullable: true });
    if (value.metadata.schemaRevision !== null && value.metadata.schemaRevision < 1) throw new Error("ArtifactDescriptorView.metadata.schemaRevision must be positive");
    requirePublicString(value.metadata.mediaType, "ArtifactDescriptorView.metadata.mediaType", { nullable: true });
    for (const field of ["activityIds", "nodeIds", "taskIds"]) {
      requirePublicStringList(value[field], `ArtifactDescriptorView.${field}`, {
        limit: FLOW_QUERY_LIMITS.MAX_IDS_PER_ARTIFACT,
        unique: true,
      });
    }
    this.value = boundedPublic(value, "artifact");
    Object.freeze(this);
  }

  toJSON() { return boundedPublic(this.value, "artifact"); }
}

/** Resolve a stored ArtifactReference against the validated catalog only. */
class ReferenceResolver {
  constructor(catalog) {
    if (!(catalog instanceof FlowArtifactCatalog)) throw new Error("Artifact reference resolution requires a validated catalog");
    this.catalog = catalog;
    Object.freeze(this);
  }

  matchingDescriptors(reference, label) {
    if (reference === null || typeof reference !== "object") {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", `${label} is invalid`);
    }
    const kind = Object.hasOwn(reference, "kind") ? reference.kind : reference.label;
    if (typeof kind !== "string" || typeof reference.id !== "string") {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", `${label} is invalid`);
    }
    return this.catalog.artifacts.filter((descriptor) => {
      if (kind === "path") return descriptor.relativePath === reference.id;
      if (kind === "logical") return descriptor.logicalKey === reference.id;
      if (descriptor.kind === kind && descriptor.relativePath === reference.id) return true;
      // Canonical result references may bind a validated resource kind to the
      // durable content digest rather than repeating its storage path.
      return /^[a-f0-9]{64}$/.test(reference.id)
        && descriptor.hash === reference.id
        && (descriptor.kind === kind || descriptor.logicalKey === kind);
    });
  }

  resolve(reference, label, { optional = false } = {}) {
    return this.#resolve(reference, label, { optional });
  }

  resolveActivityReference(reference, label, { optional = false } = {}) {
    return this.#resolve(reference, label, { optional });
  }

  #resolve(reference, label, { optional = false } = {}) {
    const matches = this.matchingDescriptors(reference, label);
    if (matches.length !== 1) {
      if (optional && matches.length === 0) return null;
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", `${label} does not resolve to one canonical Artifact`);
    }
    return matches[0];
  }

  validateCanonicalActivityResults(activities) {
    for (const activity of activities) {
      for (const reference of activity.result?.artifactRefs ?? []) {
        this.resolve(reference, "Activity result artifact reference");
      }
    }
  }
}

function isoTimestamp(value, field) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value)
    || Number.isNaN(Date.parse(value))) throw new Error(`${field} is not an ISO datetime`);
  return value;
}

function isQueryDatetime(value) {
  return typeof value === "string"
    && /[Tt].*(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function pageInfo(page, endCursor, hasNext) {
  return { limit: page.limit, endCursor, hasNext };
}

async function requireRealDirectory(directory, {
  code = ERROR_CODES.CANONICAL_RECORD_UNREADABLE,
  jsonPath = "/canonical",
  message = "canonical directory could not be read",
  inconsistentMessage = "canonical directory is not a real directory",
} = {}) {
  let handle;
  try {
    handle = await fs.promises.open(
      directory,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(directory) !== directory) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, jsonPath, inconsistentMessage);
    }
  } catch (error) {
    if (error instanceof QueryError) throw error;
    if (error?.code === "ELOOP") {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, jsonPath, inconsistentMessage, { cause: error });
    }
    throw new QueryError(code, jsonPath, message, { cause: error });
  } finally {
    if (handle !== undefined) await handle.close();
  }
}

async function openRealDirectory(directory, {
  code = ERROR_CODES.CANONICAL_RECORD_UNREADABLE,
  missingCode = null,
  jsonPath = "/canonical",
  message = "canonical directory could not be read",
  inconsistentMessage = "canonical directory is not a real directory",
} = {}) {
  let handle;
  try {
    handle = await fs.promises.open(
      directory,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(directory) !== directory) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, jsonPath, inconsistentMessage);
    }
    return handle;
  } catch (error) {
    if (handle !== undefined) await handle.close();
    if (error instanceof QueryError) throw error;
    if (error?.code === "ELOOP") {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, jsonPath, inconsistentMessage, { cause: error });
    }
    if (missingCode !== null && ["ENOENT", "ENOTDIR"].includes(error?.code)) {
      throw new QueryError(missingCode, jsonPath, message, { cause: error });
    }
    throw new QueryError(code, jsonPath, message, { cause: error });
  }
}

class CanonicalFlowVersionReader {
  constructor({ repositoryRoot, specRoot = "specs" } = {}) {
    if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) throw new Error("repositoryRoot must be absolute");
    if (typeof specRoot !== "string" || specRoot === "" || path.posix.isAbsolute(specRoot)
      || specRoot.includes("\\") || path.posix.normalize(specRoot) !== specRoot
      || specRoot.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("specRoot must be a normalized POSIX-relative path");
    }
    this.repositoryRoot = path.resolve(repositoryRoot);
    this.specRoot = specRoot;
    this.definition = buildCurrentFlowDefinition();
    this.validator = new CurrentFlowStateValidator({ definition: this.definition });
    Object.freeze(this);
  }

  specDirectory(specId) {
    const identity = new FlowSpecId(specId).toString();
    return path.join(this.repositoryRoot, ...this.specRoot.split("/"), identity);
  }

  async readVersionDirectoryEntries(specId) {
    const directory = this.specDirectory(specId);
    const entries = [];
    let enumeratedEntries = 0;
    let directoryHandle;
    try {
      directoryHandle = await openRealDirectory(directory, {
        code: ERROR_CODES.CANONICAL_RECORD_UNREADABLE,
        missingCode: ERROR_CODES.SPEC_NOT_FOUND,
        jsonPath: "/condition/specId",
        message: "requested Spec was not found",
        inconsistentMessage: "canonical Spec directory is not a real directory",
      });
      const directoryEntries = await fs.promises.readdir(`/proc/self/fd/${directoryHandle.fd}`, { withFileTypes: true });
      for (const entry of directoryEntries) {
        enumeratedEntries += 1;
        if (enumeratedEntries > FLOW_QUERY_LIMITS.MAX_AVAILABLE_FLOW_VERSIONS) {
          throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "available Version directory entries exceed the limit");
        }
        if (!/^\d+$/.test(entry.name)) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "canonical Version identity is not a directory");
        }
        try {
          entries.push(new CanonicalVersionDirectoryEntry(entry.name));
        } catch (error) {
          throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "canonical Version identity is invalid", { cause: error });
        }
      }
    } catch (error) {
      if (error instanceof QueryError) throw error;
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_UNREADABLE, "/canonical", "canonical Version directory could not be read", { cause: error });
    } finally {
      if (directoryHandle !== undefined) await directoryHandle.close();
    }
    return Object.freeze(entries);
  }

  async listAvailableVersions(specId) {
    const entries = await this.readVersionDirectoryEntries(specId);
    const versions = [...new Set(entries.map((entry) => entry.version))].sort((a, b) => a - b);
    if (versions.length > FLOW_QUERY_LIMITS.MAX_AVAILABLE_FLOW_VERSIONS) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "available Version count exceeds the limit");
    }
    return Object.freeze(versions);
  }

  readStateRecordBytes(location) {
    return readBoundedFile(location.flowStateFile, FLOW_QUERY_LIMITS.MAX_STATE_RECORD_BYTES);
  }

  readSpecRecordBytes(location) {
    return readBoundedFile(location.specFile, FLOW_QUERY_LIMITS.MAX_SPEC_RECORD_BYTES);
  }

  readConfirmedLedgerPrefix(location, confirmationOrder) {
    return readBoundedFile(location.activitiesFile, FLOW_QUERY_LIMITS.MAX_CONFIRMED_LEDGER_BYTES)
      .then((bytes) => ({ bytes, activities: this.readConfirmedLedger(bytes, confirmationOrder) }));
  }

  readArtifactCatalogBytes(location) {
    return readBoundedFile(location.catalogFile, FLOW_QUERY_LIMITS.MAX_ARTIFACT_CATALOG_BYTES);
  }

  async open(specId, version) {
    const location = new FlowVersionLocation({
      repositoryRoot: this.repositoryRoot,
      authorityScope: FlowVersionAuthorityScope.canonical(),
      specRoot: this.specRoot,
      specId,
      version: new FlowVersion(version),
    });
    await requireRealDirectory(location.directory, {
      message: "selected canonical Version could not be opened",
      inconsistentMessage: "selected canonical Version is not a real directory",
    });
    const [stateBytes, specBytes] = await Promise.all([
      this.readStateRecordBytes(location),
      this.readSpecRecordBytes(location),
    ]);
    const stateEnvelope = parseJson(stateBytes, "state record");
    const specEnvelope = parseJson(specBytes, "Spec record");
    const stateValue = version === 1 ? stateEnvelope : this.unwrap(stateEnvelope, specId, version, "state");
    const stateForValidation = version === 1 ? stateValue : this.unwrapInnerState(stateValue, version);
    const specValue = version === 1 ? specEnvelope : this.unwrap(specEnvelope, specId, version, "content");
    let state;
    let spec;
    try {
      state = this.validator.validate(stateForValidation);
      spec = CurrentFlowSpecRecord.from(specValue, { specId });
    } catch (error) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "canonical state or Spec record is inconsistent", { cause: error });
    }
    if (state.specId !== specId || spec.specId.toString() !== specId) throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "canonical identity does not match the selected Spec");
    const confirmedLedger = await this.readConfirmedLedgerPrefix(location, state.confirmationOrder);
    const activities = confirmedLedger.activities;
    try {
      replayCanonicalState(state, activities);
    } catch (error) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "canonical state and Activity ledger are inconsistent", { cause: error });
    }
    const catalog = await this.readCatalog(await this.readArtifactCatalogBytes(location), location, activities, confirmedLedger.bytes);
    return Object.freeze({ location, state, spec, activities, catalog });
  }

  unwrap(value, specId, version, property) {
    if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "flowVersion,recordRevision,specId,state" && Object.keys(value).sort().join(",") !== "content,flowVersion,recordRevision,specId") {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Versioned canonical record envelope is invalid");
    }
    if (value.recordRevision !== 1 || value.specId !== specId || value.flowVersion !== version) throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Versioned canonical record identity is inconsistent");
    return value[property];
  }

  unwrapInnerState(value, version) {
    if (!isPlainObject(value) || !Object.hasOwn(value, "flowVersion")) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Versioned state identity is missing");
    }
    try {
      if (new FlowVersion(value.flowVersion).value !== version) {
        throw new Error("Versioned state identity does not match its directory");
      }
    } catch (error) {
      if (error instanceof QueryError) throw error;
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Versioned state identity is inconsistent", { cause: error });
    }
    const state = { ...value };
    delete state.flowVersion;
    return state;
  }

  readConfirmedLedger(bytes, confirmationOrder) {
    if (confirmationOrder > FLOW_QUERY_LIMITS.MAX_CONFIRMED_ACTIVITIES) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "confirmed Activity count exceeds the limit");
    }
    const text = bytes.toString("utf8");
    const activities = [];
    const ids = new Set();
    let offset = 0;
    for (let index = 0; index < confirmationOrder; index += 1) {
      const end = text.indexOf("\n", offset);
      if (end < 0) {
        throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Activity ledger is shorter than the confirmed prefix");
      }
      const line = text.slice(offset, end);
      offset = end + 1;
      if (line.length === 0) {
        throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Activity ledger has an invalid entry");
      }
      let serialized;
      try {
        serialized = JSON.parse(line);
      } catch (error) {
        throw new QueryError(ERROR_CODES.CANONICAL_RECORD_UNREADABLE, "/canonical", "Activity ledger contains invalid JSON", { cause: error });
      }
      try {
        const activity = FlowActivity.fromSerialized(serialized);
        if (activity.confirmationOrder !== index + 1) throw new Error("Activity confirmationOrder is not contiguous");
        if (ids.has(activity.id)) throw new Error("Activity id is duplicated");
        ids.add(activity.id);
        activities.push(activity);
      } catch (error) {
        throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Activity ledger validation failed", { cause: error });
      }
    }
    return activities;
  }

  async readCatalog(bytes, location, activities, ledgerBytes) {
    const value = parseJson(bytes, "Artifact catalog");
    if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "artifacts,hash,schemaRevision" || value.schemaRevision !== 2 || !Array.isArray(value.artifacts) || value.artifacts.length > FLOW_QUERY_LIMITS.MAX_ARTIFACTS) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Artifact catalog schema is inconsistent");
    }
    for (const [index, descriptor] of value.artifacts.entries()) {
      if (!isPlainObject(descriptor) || Object.keys(descriptor).some((key) => !ARTIFACT_DESCRIPTOR_FIELDS.has(key))
        || Object.keys(descriptor).length !== ARTIFACT_DESCRIPTOR_FIELDS.size) {
        throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical/artifacts", `Artifact descriptor ${index} has an invalid schema`);
      }
    }
    let catalog;
    try { catalog = new FlowArtifactCatalog(value); } catch (error) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Artifact catalog validation failed", { cause: error });
    }
    if (catalog.hash !== value.hash) throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Artifact catalog digest is inconsistent");
    try {
      await verifyQueryCatalog(catalog, location, activities, ledgerBytes);
    } catch (error) {
      if (error instanceof QueryError) throw error;
      if (isCanonicalReadError(error)) {
        throw new QueryError(ERROR_CODES.CANONICAL_RECORD_UNREADABLE, "/canonical", "canonical Artifact record could not be read", { cause: error });
      }
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Artifact catalog integrity validation failed", { cause: error });
    }
    new ReferenceResolver(catalog).validateCanonicalActivityResults(activities);
    return catalog;
  }
}

class Cursor {
  constructor({ request, order }) {
    Object.assign(this, Cursor.binding(request));
    this.order = order;
    if (!Number.isSafeInteger(order) || order < 1) throw new Error("cursor order must be positive");
    this.digest = Cursor.digest(this.payload({ digest: null }));
    Object.freeze(this);
  }

  payload({ digest = this.digest ?? null } = {}) {
    return {
      digest,
      ...Cursor.binding(this),
      order: this.order,
      version: 1,
    };
  }

  encode() {
    const text = Cursor.canonicalJson(this.payload());
    if (Buffer.byteLength(text, "utf8") > FLOW_QUERY_LIMITS.MAX_RESPONSE_BYTES) {
      throw new Error("cursor payload exceeds the response limit");
    }
    const encoded = Buffer.from(text, "utf8").toString("base64url");
    if (Buffer.byteLength(encoded, "utf8") > FLOW_QUERY_LIMITS.MAX_PUBLIC_STRING_BYTES) {
      throw new Error("cursor exceeds the public string limit");
    }
    return encoded;
  }

  static decode(value, request) {
    let payload;
    try {
      if (typeof value !== "string"
        || value === ""
        || Buffer.byteLength(value, "utf8") > FLOW_QUERY_LIMITS.MAX_PUBLIC_STRING_BYTES
        || !/^[A-Za-z0-9_-]+$/.test(value)
        || value.includes("=")) throw new Error("encoding");
      const decoded = Buffer.from(value, "base64url");
      if (decoded.toString("base64url") !== value) throw new Error("encoding");
      if (decoded.length > FLOW_QUERY_LIMITS.MAX_RESPONSE_BYTES) throw new Error("payload size");
      const text = decoded.toString("utf8");
      payload = JSON.parse(text);
      if (Cursor.canonicalJson(payload) !== text) throw new Error("canonical encoding");
    } catch (error) {
      throw new QueryError(ERROR_CODES.INVALID_CURSOR, "/page/after", "cursor encoding is invalid", { cause: error });
    }
    if (!isPlainObject(payload)
      || Object.keys(payload).some((key) => !CURSOR_PAYLOAD_FIELD_SET.has(key))
      || Object.keys(payload).length !== CURSOR_PAYLOAD_FIELDS.length
      || payload.version !== 1
      || !["metadata", "activities"].includes(payload.resource)
      || typeof payload.specId !== "string"
      || typeof payload.flowVersion !== "number"
      || !Number.isSafeInteger(payload.flowVersion)
      || payload.flowVersion < 1
      || (payload.gte !== null && !isQueryDatetime(payload.gte))
      || (payload.lt !== null && !isQueryDatetime(payload.lt))
      || (payload.gte !== null && payload.lt !== null && Date.parse(payload.gte) >= Date.parse(payload.lt))
      || !Number.isSafeInteger(payload.order)
      || payload.order < 1
      || typeof payload.digest !== "string"
      || !/^[a-f0-9]{64}$/.test(payload.digest)) {
      throw new QueryError(ERROR_CODES.INVALID_CURSOR, "/page/after", "cursor payload is invalid");
    }
    try {
      if (new FlowSpecId(payload.specId).toString() !== payload.specId) throw new Error("cursor Spec identity is not normalized");
    } catch (error) {
      throw new QueryError(ERROR_CODES.INVALID_CURSOR, "/page/after", "cursor payload is invalid", { cause: error });
    }
    const digest = Cursor.digest({ ...payload, digest: null });
    if (payload.digest !== digest) throw new QueryError(ERROR_CODES.INVALID_CURSOR, "/page/after", "cursor digest is invalid");
    const binding = Cursor.binding(request);
    if (payload.resource !== binding.resource
      || payload.specId !== binding.specId
      || payload.flowVersion !== binding.flowVersion
      || payload.gte !== binding.gte
      || payload.lt !== binding.lt) {
      throw new QueryError(ERROR_CODES.CURSOR_QUERY_MISMATCH, "/page/after", "cursor does not match this query");
    }
    return payload.order;
  }

  static binding(request) {
    const recordedAt = request.recordedAt ?? null;
    return {
      flowVersion: request.flowVersion,
      gte: recordedAt?.gte ?? request.gte ?? null,
      lt: recordedAt?.lt ?? request.lt ?? null,
      resource: request.resource,
      specId: request.specId,
    };
  }

  static digest(payload) {
    return crypto.createHash("sha256").update(Cursor.canonicalJson(payload), "utf8").digest("hex");
  }

  static canonicalJson(value) {
    return JSON.stringify(canonicalJson(value));
  }
}

class QueryProjector {
  constructor(reader) { this.reader = reader; }

  async project(request, version) {
    const selected = new SelectedFlowVersion(request.specId, request.flowVersion);
    return request.resource === "metadata"
      ? await this.metadata(request, version, selected)
      : await this.activities(request, version, selected);
  }

  async metadata(request, version, selected) {
    const item = await this.metadataItem(version, selected.flowVersion);
    return { schemaRevision: FLOW_QUERY_SCHEMA_REVISION, ok: true, resource: "metadata", selectedFlowVersion: selected.toJSON(), availableFlowVersions: await this.reader.listAvailableVersions(request.specId), item: item.toJSON() };
  }

  async metadataItem({ state, spec, activities, catalog, location }, flowVersion) {
    const currentPath = state.current ?? [];
    const leaf = currentPath.at(-1) ?? null;
    const taskNode = currentPath.map((id) => state.findNode(id)).find((node) => node?.kind === "task") ?? null;
    const next = state.lifecycle.state === "active" ? state.nextAction() : null;
    const nextTaskNode = next === null
      ? null
      : next.path.map((id) => state.findNode(id)).find((node) => node?.kind === "task") ?? null;
    const blocked = next?.operation === "blocked";
    const blocker = blocked ? this.blockerFor(state, next) : null;
    const steps = [];
    const tasks = [];
    const walk = (node) => {
      if (node.kind === "task") tasks.push(node.id);
      else if (node.kind === "step") steps.push(node.id);
      for (const child of node.steps) walk(child);
    };
    walk(state.root);
    const artifactItems = await Promise.all(catalog.artifacts.map((descriptor) => this.artifactDescriptor(
      descriptor,
      activities,
      catalog,
      { location, state },
    )));
    const stepTasks = [];
    for (const node of this.nodesOf(state.root)) {
      if (node.kind !== "task") continue;
      for (const child of this.nodesOf(node)) {
        if (child.kind === "step") stepTasks.push({ stepId: child.id, taskId: node.id });
      }
    }
    const taskNodes = uniqueObjectList(tasks.map((taskId) => ({ taskId, nodeId: taskId })), "relationships.taskNodes");
    const issue = state.issue == null ? [] : [{ number: state.issue, relationship: "tracks" }];
    const capabilities = {};
    if (isPlainObject(spec.document.capabilities)) {
      for (const [key, value] of Object.entries(spec.document.capabilities)) {
        if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(key) || typeof value !== "boolean") throw new Error("Spec capabilities are inconsistent");
        capabilities[key] = value;
      }
    }
    const git = state.context?.value?.gitSnapshot;
    const gitSnapshot = isGitSnapshot(git) ? { available: git.available, commit: git.commit } : { available: false, commit: null };
    const activitySummary = new CurrentFlowActivitySummary(activities);
    return new MetadataItem({
      identity: { flowId: state.flowId, flowVersionId: state.flowVersionId, runId: state.runId, specId: state.specId, flowVersion },
      lifecycle: { lifecycle: state.lifecycle.state, blocked, blocker, nextAction: next === null ? null : { operation: next.operation, phase: next.path[1] ?? null, stepId: next.path.at(-1) ?? null, taskId: nextTaskNode?.id ?? null } },
      location: { phase: currentPath[1] ?? null, stepId: leaf, taskId: taskNode?.id ?? null, git: gitSnapshot },
      structure: { phaseId: state.root.steps.find((node) => node.steps.some((child) => child.id === currentPath[1]))?.id ?? currentPath[1] ?? "flow", stepIds: uniqueLimited(steps, "structure.stepIds"), taskIds: uniqueLimited(tasks, "structure.taskIds") },
      relationships: { stepTasks: uniqueObjectList(stepTasks, "relationships.stepTasks"), taskNodes, issues: issue },
      timestamps: activitySummary.timestamps(),
      capabilities,
      artifacts: artifactItems,
      metrics: new AggregateMetrics(activitySummary.metrics({
        artifactCount: catalog.artifacts.length,
        stepCount: steps.length,
        taskCount: tasks.length,
      })),
    });
  }

  nodesOf(node, values = []) {
    values.push(node);
    for (const child of node.steps) this.nodesOf(child, values);
    return values;
  }

  blockerFor(state, next) {
    const attempt = state.attempt;
    const source = attempt?.blocker ?? attempt?.failure ?? (next.failureDisposition ? { code: "FLOW_BLOCKED", message: next.failureDisposition.reason } : null);
    if (!source?.code || !source?.message) throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "blocked Flow has no blocker evidence");
    return { code: publicString(source.code, "blocker.code"), message: publicString(source.message, "blocker.message") };
  }

  async artifactDescriptor(descriptor, activities, catalog, version) {
    const activity = descriptor.activityId === null ? null : activities.find((entry) => entry.id === descriptor.activityId) ?? null;
    const taskId = activity === null ? null : this.taskIdForActivity(version.state, activity);
    return new ArtifactDescriptorView({ artifactId: publicArtifactId(descriptor), metadata: { logicalKey: requirePublicString(descriptor.logicalKey, "artifact.logicalKey", { nullable: true }), schemaRevision: await this.artifactSchemaRevision(descriptor, version), mediaType: publicString(descriptor.mediaType, "artifact.mediaType") }, activityIds: activity ? [activity.id] : [], nodeIds: activity?.nodeId ? [activity.nodeId] : [], taskIds: taskId ? [taskId] : [] });
  }

  taskIdForActivity(state, activity) {
    const explicitTaskId = activity.transition.task?.id ?? null;
    if (explicitTaskId !== null) return explicitTaskId;
    const locate = (node, taskId = null) => {
      const currentTaskId = node.kind === "task" ? node.id : taskId;
      if (node.id === activity.nodeId) return currentTaskId;
      for (const child of node.steps) {
        const found = locate(child, currentTaskId);
        if (found !== null) return found;
      }
      return null;
    };
    return locate(state.root);
  }

  async artifactSchemaRevision(descriptor, version) {
    if (descriptor.logicalKey === null) return null;
    const contract = FLOW_ARTIFACT_CONTRACTS.require(descriptor.logicalKey);
    if (contract.contentContract === null) return null;
    const bytes = await readBoundedFile(version.location.resolve(descriptor.relativePath), descriptor.size);
    let value;
    try {
      value = contract.contentContract.parse(bytes);
    } catch (error) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Artifact content contract validation failed", { cause: error });
    }
    return Number.isSafeInteger(value?.schemaRevision) && value.schemaRevision > 0 ? value.schemaRevision : null;
  }

  async activities(request, version, selected) {
    const after = request.page.after === null ? 0 : Cursor.decode(request.page.after, request);
    const filtered = version.activities.filter((entry) => {
      if (entry.confirmationOrder <= after) return false;
      if (request.recordedAt.gte === null && request.recordedAt.lt === null) return true;
      if (entry.timing?.finishedAt === null || entry.timing?.finishedAt === undefined) return false;
      return (request.recordedAt.gte === null || Date.parse(entry.timing.finishedAt) >= Date.parse(request.recordedAt.gte))
        && (request.recordedAt.lt === null || Date.parse(entry.timing.finishedAt) < Date.parse(request.recordedAt.lt));
    });
    const items = filtered.slice(0, request.page.limit).map((entry) => this.activityItem(entry, version.activities, version.catalog).toJSON());
    const hasNext = filtered.length > items.length;
    const endCursor = items.length === 0 ? null : new Cursor({ request, order: items.at(-1).confirmationOrder }).encode();
    return { schemaRevision: FLOW_QUERY_SCHEMA_REVISION, ok: true, resource: "activities", selectedFlowVersion: selected.toJSON(), availableFlowVersions: await this.reader.listAvailableVersions(request.specId), items, pageInfo: pageInfo(request.page, endCursor, hasNext) };
  }

  activityItem(activity, activities, catalog) {
    const resolver = new ReferenceResolver(catalog);
    const resolvePublicArtifactId = (entry, field) => publicArtifactId(resolver.resolve(entry, field));
    const resolveOptionalActivityArtifactId = (entry, field) => {
      const descriptor = resolver.resolveActivityReference(entry, field, { optional: true });
      return descriptor === null ? null : publicArtifactId(descriptor);
    };
    const publicArtifactIds = (values) => uniqueLimited(values
      .map((entry) => resolveOptionalActivityArtifactId(entry, "Activity artifact reference"))
      .filter((id) => id !== null), "activity.artifactIds");
    const attempt = activity.transition.attempt;
    const incomplete = attempt?.incomplete ?? [];
    if (incomplete.length > 1) throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Activity Attempt contains multiple incomplete claims");
    return new ActivityItem({
      activity: { id: activity.id, type: activity.type },
      node: { id: activity.nodeId, key: activity.nodeKey },
      task: activity.transition.task ? { id: activity.transition.task.id, key: activity.transition.task.key } : null,
      attempt: activity.attemptId === null ? null : { id: activity.attemptId, sequence: activity.sequence },
      sequence: activity.sequence,
      confirmationOrder: activity.confirmationOrder,
      transition: { operation: activity.transition.operation, status: activity.transition.status },
      timing: activity.timing?.toJSON() ?? null,
      usage: activity.usage?.toJSON() ?? null,
      outcome: activity.result ? { outcome: activity.result.outcome, summary: publicString(activity.result.summary, "result.summary"), confirmedAt: activity.result.confirmedAt, artifactRefs: uniqueObjectList(activity.result.artifactRefs.map((entry) => ({ kind: entry.kind, id: resolvePublicArtifactId(entry, "Activity result artifact reference") })), "activity.artifactRefs") } : null,
      failure: activity.failure?.toJSON() ?? null,
      blocker: attempt?.blocker ? { code: attempt.blocker.code, message: attempt.blocker.message } : null,
      incomplete: incomplete.length === 0 ? null : incomplete[0].toJSON(),
      metric: activity.metric?.toJSON() ?? null,
      note: activity.note?.text ?? null,
      evaluationIds: uniqueLimited(activity.references.evaluations.map((entry) => entry.id), "activity.evaluationIds"),
      findingIds: uniqueLimited(activity.references.findings.map((entry) => entry.id), "activity.findingIds"),
      repairIds: uniqueLimited(activity.references.repairs.map((entry) => entry.id), "activity.repairIds"),
      artifactIds: publicArtifactIds(activity.references.artifacts),
    });
  }
}

function knownResourceError({ resource, pageLimit = null }, code, jsonPath, message, availableFlowVersions = [], selectedFlowVersion = null) {
  const base = { schemaRevision: FLOW_QUERY_SCHEMA_REVISION, ok: false, resource, selectedFlowVersion, availableFlowVersions, error: { code, path: jsonPath, message } };
  return resource === "metadata"
    ? { ...base, item: null }
    : { ...base, items: [], pageInfo: { limit: pageLimit, endCursor: null, hasNext: false } };
}

function unknownResourceError(code, jsonPath, message, resource = null) {
  const response = { schemaRevision: FLOW_QUERY_SCHEMA_REVISION, ok: false, error: { code, path: jsonPath, message } };
  if (resource === null) return response;
  return { schemaRevision: FLOW_QUERY_SCHEMA_REVISION, ok: false, resource, selectedFlowVersion: null, availableFlowVersions: [], error: response.error };
}

function publicError(error) {
  if (error instanceof QueryError) return error;
  return new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "canonical query could not be completed", { cause: error });
}

function parseRequestBytes(bytes, onResource = () => {}) {
  if (bytes.length > FLOW_QUERY_LIMITS.MAX_REQUEST_BYTES) throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/request", "request exceeds the maximum size");
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    onResource(value?.resource);
    return new QueryRequest(value);
  } catch (error) {
    if (error instanceof QueryError) throw error;
    throw new QueryError(ERROR_CODES.INVALID_JSON, "/request", "request is not valid JSON", { cause: error });
  }
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > FLOW_QUERY_LIMITS.MAX_REQUEST_BYTES) throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/request", "request exceeds the maximum size");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

async function readInput(argv) {
  let requestFile = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--request-file") continue;
    if (requestFile !== null || argv[index + 1] == null || argv[index + 1] === "" || argv[index + 1].startsWith("-")) throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/request", "--request-file must be specified once with one path");
    requestFile = argv[++index];
  }
  const extras = argv.filter((value, index) => value !== "--request-file" && argv[index - 1] !== "--request-file");
  if (extras.length > 0) throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/request", "query accepts only --request-file");
  if (requestFile !== null) {
    if (requestFile.includes("\0")) throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/request", "request-file path contains NUL");
    if (!path.isAbsolute(requestFile) && (requestFile.includes("\\") || path.posix.normalize(requestFile) !== requestFile)) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/request", "request-file path must be absolute or normalized relative");
    }
    const absolute = path.resolve(process.cwd(), requestFile);
    if (!process.stdin.isTTY && (await readStdin()).length > 0) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/request", "provide input through stdin or --request-file, not both");
    }
    return readBoundedFile(absolute, FLOW_QUERY_LIMITS.MAX_REQUEST_BYTES, {
      code: ERROR_CODES.INVALID_REQUEST,
      identityCode: ERROR_CODES.INVALID_REQUEST,
      limitCode: ERROR_CODES.INVALID_REQUEST,
      jsonPath: "/request",
      message: "request-file is not readable",
    });
  }
  const bytes = await readStdin();
  if (bytes.length === 0) throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/request", "query input is required");
  return bytes;
}

export async function prepareFlowQueryInput(argv = []) {
  if (argv.includes("-h") || argv.includes("--help")) return Object.freeze({ bytes: null, request: null, requestedResource: null, error: null });
  let requestedResource = null;
  try {
    const bytes = await readInput(argv);
    const request = parseRequestBytes(bytes, (resource) => { requestedResource = resource; });
    return Object.freeze({ bytes, request, requestedResource, error: null });
  } catch (error) {
    return Object.freeze({ bytes: null, request: null, requestedResource, error });
  }
}

function repositoryRoot() {
  return path.resolve(repoRoot());
}

async function specRoot() {
  const configPath = path.join(repositoryRoot(), ".sennel", "config.json");
  let config;
  try { config = JSON.parse(await fs.promises.readFile(configPath, "utf8")); } catch (error) {
    throw new QueryError(ERROR_CODES.CANONICAL_RECORD_UNREADABLE, "/canonical", "Flow configuration could not be read", { cause: error });
  }
  const value = config?.flow?.specDir;
  if (typeof value === "string" && value.trim() !== "" && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.split("/").includes("..")) return value;
  if (value !== undefined) throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Flow configuration specDir is invalid");
  return "specs";
}

export async function runFlowQueryCli(argv = process.argv.slice(2), { prepared = null } = {}) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write("Usage: sennel flow query [--request-file <path>]\n\nRead canonical Flow Version metadata or confirmed Activities as one JSON response.\nInput is a single JSON request from stdin or --request-file.\n");
    return 0;
  }
  let request = null;
  let requestedResource = null;
  let reader = null;
  let available = [];
  let selectionEstablished = false;
  try {
    if (prepared?.error) {
      requestedResource = prepared.requestedResource ?? null;
      throw prepared.error;
    }
    if (prepared?.request) {
      request = prepared.request;
    } else {
      const inputBytes = prepared?.bytes ?? await readInput(argv);
      request = parseRequestBytes(inputBytes, (resource) => { requestedResource = resource; });
    }
    requestedResource = request.resource;
    reader = new CanonicalFlowVersionReader({ repositoryRoot: repositoryRoot(), specRoot: await specRoot() });
    available = await reader.listAvailableVersions(request.specId);
    if (available.length === 0) throw new QueryError(ERROR_CODES.SPEC_NOT_FOUND, "/condition/specId", "requested Spec was not found");
    if (!available.includes(request.flowVersion)) throw new QueryError(ERROR_CODES.FLOW_VERSION_NOT_FOUND, "/condition/flowVersion", "requested Flow Version was not found");
    const version = await reader.open(request.specId, request.flowVersion);
    selectionEstablished = true;
    const response = await new QueryProjector(reader).project(request, version);
    const output = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(output, "utf8") > FLOW_QUERY_LIMITS.MAX_RESPONSE_BYTES) throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "query response exceeds the maximum size");
    process.stdout.write(output);
    return 0;
  } catch (cause) {
    const error = publicError(cause);
    let response;
    if (request instanceof QueryRequest) {
      const versionDiscovered = error.code === ERROR_CODES.FLOW_VERSION_NOT_FOUND;
      response = knownResourceError(
        { resource: request.resource, pageLimit: request.page?.limit ?? null },
        error.code,
        error.jsonPath,
        error.message,
        selectionEstablished || versionDiscovered ? available : [],
        selectionEstablished ? new SelectedFlowVersion(request.specId, request.flowVersion).toJSON() : null,
      );
    } else if (["metadata", "activities"].includes(requestedResource)) {
      response = knownResourceError({ resource: requestedResource }, error.code, error.jsonPath, error.message);
    } else {
      response = unknownResourceError(
        error.code,
        error.jsonPath,
        error.message,
        ["metadata", "activities"].includes(requestedResource) ? requestedResource : null,
      );
    }
    process.stdout.write(`${JSON.stringify(response)}\n`);
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

export {
  AggregateMetrics,
  ActivityItem,
  ArtifactDescriptorView,
  CanonicalFlowVersionReader,
  Cursor,
  MetadataItem,
  QueryError,
  QueryProjector,
  QueryRequest,
  SelectedFlowVersion,
};
