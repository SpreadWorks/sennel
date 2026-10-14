import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ProcessExecutionCheckoutIdentity } from "../lib/process-execution-values.js";
import { captureProcessExecutionCheckoutIdentity } from "../lib/process-execution-runtime.js";

import { FlowSpecId } from "../lib/flow-spec-id.js";
import { PRODUCT } from "../lib/product.js";
import { flowSpecRootFromConfig } from "../lib/flow-workspace.js";
import {
  FlowArtifactCatalog,
  FlowArtifactActivityIndex,
  FlowArtifactCatalogSnapshotEvidence,
  FlowArtifactCatalogSnapshotReader,
  FlowArtifactCatalogSnapshotUnstableError,
  FlowVersion,
  FlowVersionAuthorityScope,
  FlowVersionLocation,
} from "../lib/flow-version.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../lib/flow-artifact-contract.js";
import { buildCurrentFlowDefinition, getFlowNode, getTaskNode } from "./definition.js";
import { TaskStepIdentity } from "./lib/task-step-identity.js";
import { QueryDetailIndex, QueryDetailArtifactRequired } from "./query-details.js";
import { GitSnapshot } from "../lib/git-snapshot.js";
import {
  FLOW_QUERY_ERROR_CODES,
  FLOW_QUERY_ERROR_PATHS,
  FLOW_QUERY_HELP,
  FLOW_QUERY_LIMITS,
  FLOW_QUERY_RESOURCES,
  FLOW_QUERY_SCHEMA_REVISION,
  isFlowQueryDatetime,
  validateFlowQueryRequest,
  validateFlowQueryResponse,
  detailCompletenessFor,
} from "./query-contract.js";
import {
  CurrentFlowSpecRecord,
  CurrentFlowActivitySummary,
  CurrentFlowState,
  CurrentFlowStateValidator,
  AGGREGATE_METRIC_PROVENANCE,
  FlowActivity,
} from "./lib/current-flow-state.js";

import { QueryError, canonicalJson, canonicalDigest, isPlainObject, requireExactObject, requirePublicString, requirePublicInteger, requirePublicStringList, publicString, uniqueLimited, uniqueObjectList, publicArtifactId, publicArtifactKey, boundedPublic, artifactIdentity, ReferenceResolver } from "./query-values.js";

const ERROR_CODES = FLOW_QUERY_ERROR_CODES;

const CURSOR_PAYLOAD_FIELDS = Object.freeze([
  "digest", "flowVersion", "gte", "lt", "order", "resource", "schemaRevision", "snapshotId", "specId", "version",
]);
const CURSOR_PAYLOAD_FIELD_SET = new Set(CURSOR_PAYLOAD_FIELDS);

class ArtifactSchemaRevisionEvidence {
  #revisions;

  constructor(revisions) {
    if (!(revisions instanceof Map) || [...revisions].some(([relativePath, revision]) => typeof relativePath !== "string"
      || (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)))) {
      throw new Error("artifact schema evidence requires bounded canonical revisions");
    }
    this.#revisions = new Map(revisions);
    Object.freeze(this);
  }

  revisionFor(descriptor) {
    if (!this.#revisions.has(descriptor.relativePath)) throw new Error("artifact snapshot schema evidence is missing");
    return this.#revisions.get(descriptor.relativePath);
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

class QueryProjectionSignature {
  constructor(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("projection signature requires a SHA-256 digest");
    this.hash = hash;
    Object.freeze(this);
  }

  static async read() {
    const root = new URL("../", import.meta.url);
    const entries = [];
    let totalBytes = 0;
    const visit = async (directory, prefix) => {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        if (entry.name === "tests") continue;
        const relative = `${prefix}${entry.name}`;
        if (entry.isDirectory()) await visit(new URL(`${entry.name}/`, directory), `${relative}/`);
        else if (entry.isFile() && /\.(?:js|json)$/.test(entry.name)) {
          if (entries.length >= FLOW_QUERY_LIMITS.MAX_MANAGED_ARTIFACT_ENTRIES) throw new Error("projection source count exceeds the limit");
          const bytes = await fs.promises.readFile(new URL(entry.name, directory));
          totalBytes += bytes.length;
          if (totalBytes > FLOW_QUERY_LIMITS.MAX_TOTAL_ARTIFACT_BYTES) throw new Error("projection source bytes exceed the limit");
          entries.push({ path: relative, hash: crypto.createHash("sha256").update(bytes).digest("hex") });
        }
      }
    };
    await visit(root, "");
    entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return new QueryProjectionSignature(canonicalDigest(entries, { maxBytes: FLOW_QUERY_LIMITS.MAX_RESPONSE_BYTES }));
  }
}

class QuerySnapshot {
  constructor(version, selected, available, projection) {
    if (!(projection instanceof QueryProjectionSignature)) throw new Error("snapshot requires projection evidence");
    const inputs = {
      schemaRevision: FLOW_QUERY_SCHEMA_REVISION,
      flowVersionId: version.state.flowVersionId,
      specId: selected.specId,
      flowVersion: selected.flowVersion,
      catalogHash: version.catalog.hash,
      confirmedLedgerHash: version.confirmedLedgerHash,
      confirmationOrder: version.state.confirmationOrder,
      stateHash: version.stateHash,
      specHash: version.specHash,
      projectionHash: projection.hash,
      availableFlowVersionsHash: canonicalDigest(available),
    };
    this.id = `sha256:${canonicalDigest(inputs)}`;
    this.value = Object.freeze({ id: this.id, algorithm: "sha256", capturedAt: new Date().toISOString(), confirmationOrder: inputs.confirmationOrder,
      catalogHash: inputs.catalogHash, projectionHash: inputs.projectionHash, availableFlowVersionsHash: inputs.availableFlowVersionsHash });
    Object.freeze(this);
  }

  toJSON() { return { ...this.value }; }
}

class QueryCaptureContext {
  constructor(request, available, projection) {
    if (!(request instanceof QueryRequest) || !(projection instanceof QueryProjectionSignature)) throw new Error("query capture requires typed request and projection evidence");
    this.request = request;
    this.available = Object.freeze([...available]);
    this.projection = projection;
    Object.freeze(this);
  }
}

class QueryCapturedVersion {
  constructor({ state, spec, activities, artifactSchemaRevisions, artifactBytes, catalog, stateBytes, specBytes, confirmedLedgerBytes, repositoryIdentity }) {
    if (!(state instanceof CurrentFlowState) || !(spec instanceof CurrentFlowSpecRecord)
      || !(artifactSchemaRevisions instanceof ArtifactSchemaRevisionEvidence) || !(artifactBytes instanceof Map)) {
      throw new Error("query capture requires validated canonical records");
    }
    if (!(repositoryIdentity instanceof ProcessExecutionCheckoutIdentity)) throw new TypeError("Query requires its captured canonical repository identity");
    Object.assign(this, { state, spec, activities, artifactSchemaRevisions, artifactBytes, catalog, repositoryIdentity });
    this.stateHash = crypto.createHash("sha256").update(stateBytes).digest("hex");
    this.specHash = crypto.createHash("sha256").update(specBytes).digest("hex");
    this.confirmedLedgerHash = crypto.createHash("sha256").update(confirmedLedgerBytes).digest("hex");
    this.response = null;
    this.projectionError = null;
  }

  rememberProjection(response, error = null) {
    this.response = response;
    this.projectionError = error;
    Object.freeze(this);
  }
}

class QueryReadSnapshot {
  constructor(version, available, projection) {
    if (!(projection instanceof QueryProjectionSignature)) throw new Error("query read requires projection evidence");
    this.version = version;
    this.available = Object.freeze([...available]);
    this.projection = projection;
    Object.freeze(this);
  }
}

class QueryNodeResultView {
  constructor(result, resolver, { legacySummary = false } = {}) {
    this.value = result === null ? null : Object.freeze({
      outcome: result.outcome,
      confirmedAt: result.confirmedAt,
      summary: legacySummary ? publicString(result.summary, "result.summary") : result.summary,
      artifactRefs: uniqueObjectList(result.artifactRefs.map((entry) => {
        const descriptor = resolver.resolveResultReference(entry, "Node result artifact reference");
        return descriptor === null ? null : { kind: entry.kind, id: publicArtifactId(descriptor) };
      }).filter((entry) => entry !== null), "result.artifactRefs"),
    });
    Object.freeze(this);
  }

  toJSON() { return this.value === null ? null : { ...this.value, artifactRefs: this.value.artifactRefs.map((entry) => ({ ...entry })) }; }
}

class QueryNodeView {
  constructor({ state, spec, node, parentId, phaseId, taskId, catalog }) {
    const historical = state.history !== null;
    const taskIdentity = !historical && node.kind === "step" && taskId !== null
      ? TaskStepIdentity.fromTaskNode(state.findNode(taskId), node.id) : null;
    const definitionStepId = taskIdentity?.definitionId ?? (node.kind === "step" && node.steps.length === 0 ? node.id : null);
    const definition = historical ? null : (taskIdentity ? getTaskNode(taskIdentity.definitionId) : getFlowNode(node.id));
    const role = node.kind === "flow" ? "flow" : node.kind === "task" ? "task"
      : definition === null ? "group" : parentId === state.root.id ? "phase" : node.steps.length > 0 ? "group" : "step";
    const title = node.kind === "task" ? spec.document.tasks?.find((task) => task.id === node.id)?.title ?? null : null;
    const displayNameSource = title !== null ? "spec-title" : definition?.label ? "definition-label" : "key";
    this.phaseId = role === "phase" ? node.id : phaseId;
    this.taskId = node.kind === "task" ? node.id : taskId;
    this.value = Object.freeze({ id: node.id, key: node.key, kind: node.kind, role,
      displayName: title ?? definition?.label ?? node.key, displayNameSource, status: node.status, parentId,
      childIds: node.steps.map((child) => child.id), phaseId: this.phaseId, taskId: this.taskId,
      definitionStepId: definition === null ? null : definitionStepId, attemptSequence: node.attemptSequence,
      result: new QueryNodeResultView(node.result, new ReferenceResolver(catalog)).toJSON(),
      coverage: { phaseClassification: node.kind !== "step" ? "not-applicable" : definition === null ? "not-recorded" : "available", displayName: displayNameSource === "key" ? "key-fallback" : "available" },
    });
    Object.freeze(this);
  }

  toJSON() { return { ...this.value, childIds: [...this.value.childIds], coverage: { ...this.value.coverage } }; }
}

class QueryStructure {
  constructor({ state, spec, catalog, phaseId }) {
    this.nodes = [];
    const walk = (node, parentId, inheritedPhaseId = null, taskId = null) => {
      const view = new QueryNodeView({ state, spec, node, parentId, phaseId: inheritedPhaseId, taskId, catalog });
      this.nodes.push(view);
      for (const child of node.steps) walk(child, node.id, view.phaseId, view.taskId);
    };
    walk(state.root, null);
    this.phaseId = phaseId;
    this.rootNodeId = state.root.id;
    Object.freeze(this.nodes);
    Object.freeze(this);
  }

  toJSON() {
    const nodes = this.nodes.map((node) => node.toJSON());
    return { phaseId: this.phaseId, stepIds: nodes.filter((node) => node.kind === "step").map((node) => node.id), taskIds: nodes.filter((node) => node.kind === "task").map((node) => node.id),
      rootNodeId: this.rootNodeId, phaseIds: nodes.filter((node) => node.role === "phase").map((node) => node.id), nodes };
  }
}

class QueryPage {
  constructor(value) {
    const { limit, after } = value;
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
    const { gte = null, lt = null } = value ?? {};
    for (const [key, value] of [["gte", gte], ["lt", lt]]) {
      if (value !== null && !isQueryDatetime(value)) {
        throw new QueryError(ERROR_CODES.INVALID_REQUEST, `/recordedAt/${key}`, `${key} must be a timezone-bearing ISO 8601 datetime`);
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
    if (typeof resource !== "string" || !FLOW_QUERY_RESOURCES.includes(resource)) {
      throw new QueryError(ERROR_CODES.INVALID_REQUEST, "/resource", "resource must be metadata or activities");
    }
    assertRequestSchema(value);
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
    this.page = resource === "activities" ? new QueryPage(value.page) : null;
    this.recordedAt = resource === "activities" ? new DateRange(value.recordedAt) : null;
    Object.freeze(this);
  }

  validateCursor() {
    if (this.resource === "activities" && this.page.after !== null) Cursor.decode(this.page.after, this);
    return this;
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

function schemaErrorPath(errors, fallback = "/request") {
  const path = /^([^:]+):/.exec(errors[0] ?? "")?.[1];
  if (path === undefined || path === "(root)") return fallback;
  const pointer = `/${path.replaceAll(".", "/")}`;
  return Buffer.byteLength(pointer, "utf8") <= FLOW_QUERY_LIMITS.MAX_PUBLIC_STRING_BYTES ? pointer : fallback;
}

function assertRequestSchema(value) {
  const errors = validateFlowQueryRequest(value);
  if (errors.length > 0) {
    throw new QueryError(ERROR_CODES.INVALID_REQUEST, schemaErrorPath(errors), "request does not match the query contract");
  }
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
    if ((typeof current.code === "string" && typeof current.syscall === "string")
      || current.message?.startsWith("Version authority path does not exist:")) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

function isJsonParseError(error) {
  const seen = new Set();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    if (current instanceof SyntaxError) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
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
  if (value.provenance === "" || (value.availability === "unavailable" && value.reason === "")) {
    throw new Error(`${label} evidence must be non-empty`);
  }
  if (value.value !== null) isoTimestamp(value.value, `${label}.value`);
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
    requireExactObject(value, ["identity", "lifecycle", "location", "structure", "relationships", "timestamps", "capabilities", "artifacts", "metrics", "history"], "MetadataItem");
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
    try {
      GitSnapshot.from(value.location.git);
    } catch (error) {
      throw new Error("MetadataItem.location.git is invalid", { cause: error });
    }
    requireExactObject(value.structure, ["phaseId", "stepIds", "taskIds", "rootNodeId", "phaseIds", "nodes"], "MetadataItem.structure");
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
    const { history, structure, artifacts, metrics, ...base } = value;
    const originalArtifacts = artifacts.map((entry) => { const { artifactId, metadata, activityIds, nodeIds, taskIds } = entry.toJSON(); return { artifactId, metadata, activityIds, nodeIds, taskIds }; });
    this.value = { ...boundedPublic({ ...base, structure: { phaseId: structure.phaseId, stepIds: structure.stepIds, taskIds: structure.taskIds }, artifacts: originalArtifacts, metrics: metrics.toJSON() }, "metadata"), history: structuredClone(history), structure: structuredClone(structure), artifacts: artifacts.map((entry) => entry.toJSON()) };
    Object.freeze(this.value);
    Object.freeze(this);
  }

  toJSON() { return structuredClone(this.value); }
}

class ActivityItem {
  constructor(value) {
    const fields = ["activity", "node", "task", "attempt", "sequence", "confirmationOrder", "transition", "timing", "usage", "outcome", "failure", "blocker", "incomplete", "metric", "note", "evaluationIds", "findingIds", "repairIds", "artifactIds", "detailRefs", "referenceBindings", "detailCoverage"];
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
    const { detailRefs, referenceBindings, detailCoverage, ...base } = value;
    this.value = { ...boundedPublic(base, "activity"), detailRefs: structuredClone(detailRefs), referenceBindings: structuredClone(referenceBindings), detailCoverage: structuredClone(detailCoverage) };
    Object.freeze(this);
  }

  toJSON() { return structuredClone(this.value); }
}

class ArtifactDescriptorView {
  constructor(value) {
    requireExactObject(value, ["artifactId", "metadata", "activityIds", "nodeIds", "taskIds", "artifactKey", "kind", "relativePath", "hash", "algorithm", "hashScope", "size", "authority", "cardinality", "memberId", "publicationStep", "retention", "producerActivityId", "referencingActivityIds"], "ArtifactDescriptorView");
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
    const { artifactId, metadata, activityIds, nodeIds, taskIds, ...extended } = value;
    this.value = { ...boundedPublic({ artifactId, metadata, activityIds, nodeIds, taskIds }, "artifact"), ...structuredClone(extended) };
    Object.freeze(this);
  }

  toJSON() { return structuredClone(this.value); }
}

/** Resolve a stored ArtifactReference against the validated catalog only. */
function isoTimestamp(value, field) {
  if (!isFlowQueryDatetime(value)) throw new Error(`${field} is not a timezone-bearing ISO datetime`);
  return value;
}

function isQueryDatetime(value) {
  return isFlowQueryDatetime(value);
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
    try {
      await requireRealDirectory(directory, {
        code: ERROR_CODES.SPEC_NOT_FOUND,
        jsonPath: "/condition/specId",
        message: "requested Spec was not found",
        inconsistentMessage: "canonical Spec directory is not a real directory",
      });
      const directoryEntries = await fs.promises.opendir(directory);
      for await (const entry of directoryEntries) {
        enumeratedEntries += 1;
        if (enumeratedEntries > FLOW_QUERY_LIMITS.MAX_AVAILABLE_FLOW_VERSIONS) {
          throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "available Version directory entries exceed the limit");
        }
        if (!/^\d+$/.test(entry.name)) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "canonical Version identity is not a directory");
        }
        await requireRealDirectory(path.join(directory, entry.name), {
          code: ERROR_CODES.CANONICAL_RECORD_INCONSISTENT,
          message: "canonical Version directory could not be read",
          inconsistentMessage: "canonical Version identity is not a real directory",
        });
        try {
          entries.push(new CanonicalVersionDirectoryEntry(entry.name));
        } catch (error) {
          throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "canonical Version identity is invalid", { cause: error });
        }
      }
    } catch (error) {
      if (error instanceof QueryError) throw error;
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_UNREADABLE, "/canonical", "canonical Version directory could not be read", { cause: error });
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

  async open(specId, version, context = null) {
    const location = new FlowVersionLocation({
      repositoryRoot: this.repositoryRoot,
      authorityScope: FlowVersionAuthorityScope.canonical(),
      specRoot: this.specRoot,
      specId,
      version: new FlowVersion(version),
    });
    let snapshot;
    try {
      snapshot = await new FlowArtifactCatalogSnapshotReader({ location }).readCommittedSnapshot({
        limits: {
          maxAttempts: FLOW_QUERY_LIMITS.MAX_SNAPSHOT_ATTEMPTS,
          maxCatalogBytes: FLOW_QUERY_LIMITS.MAX_ARTIFACT_CATALOG_BYTES,
          maxArtifacts: FLOW_QUERY_LIMITS.MAX_ARTIFACTS,
          maxManagedEntries: FLOW_QUERY_LIMITS.MAX_MANAGED_ARTIFACT_ENTRIES,
          maxArtifactBytes: FLOW_QUERY_LIMITS.MAX_ARTIFACT_BYTES,
          maxConfirmedLedgerBytes: FLOW_QUERY_LIMITS.MAX_CONFIRMED_LEDGER_BYTES,
          maxTotalArtifactBytes: FLOW_QUERY_LIMITS.MAX_TOTAL_ARTIFACT_BYTES,
        },
        capture: ({ catalog, readArtifact, inspectArtifact }) => this.captureCommittedSnapshot({
          catalog, readArtifact, inspectArtifact, specId, version, context,
        }),
      });
    } catch (error) {
      if (error instanceof QueryError) throw error;
      if (error instanceof FlowArtifactCatalogSnapshotUnstableError) {
        throw new QueryError(ERROR_CODES.SNAPSHOT_UNSTABLE, "/snapshot", "canonical snapshot did not stabilize", { reason: "SNAPSHOT_RETRY_EXHAUSTED", cause: error });
      }
      if (isCanonicalReadError(error) || isJsonParseError(error)) {
        throw new QueryError(ERROR_CODES.CANONICAL_RECORD_UNREADABLE, "/canonical", "canonical Artifact record could not be read", { cause: error });
      }
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Artifact catalog integrity validation failed", { cause: error });
    }
    return Object.freeze({ ...snapshot.value, catalog: snapshot.catalog, location });
  }

  async read(specId, version, request) {
    for (let attempt = 0; attempt < FLOW_QUERY_LIMITS.MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const available = await this.listAvailableVersions(specId);
      if (available.length === 0) throw new QueryError(ERROR_CODES.SPEC_NOT_FOUND, "/condition/specId", "requested Spec was not found");
      if (!available.includes(version)) throw new QueryError(ERROR_CODES.FLOW_VERSION_NOT_FOUND, "/condition/flowVersion", "requested Flow Version was not found");
      const projection = await QueryProjectionSignature.read();
      const selected = await this.open(specId, version, new QueryCaptureContext(request, available, projection));
      const after = await this.listAvailableVersions(specId);
      const endingProjection = await QueryProjectionSignature.read();
      if (JSON.stringify(available) === JSON.stringify(after) && projection.hash === endingProjection.hash) {
        return new QueryReadSnapshot(selected, available, projection);
      }
    }
    throw new QueryError(ERROR_CODES.SNAPSHOT_UNSTABLE, "/snapshot", "Version inventory or projection changed during capture", { reason: "SNAPSHOT_RETRY_EXHAUSTED" });
  }

  async captureCommittedSnapshot({ catalog, readArtifact, inspectArtifact, specId, version, context }) {
    const stateDescriptor = catalog.resolve(FLOW_ARTIFACT_CONTRACTS.resolve("flow.state").relativePath);
    const specDescriptor = catalog.resolve(FLOW_ARTIFACT_CONTRACTS.resolve("spec.record").relativePath);
    const ledgerDescriptor = catalog.resolve(FLOW_ARTIFACT_CONTRACTS.resolve("flow.activities").relativePath);
    const [stateBytes, specBytes, ledgerBytes] = await Promise.all([
      readArtifact(stateDescriptor),
      readArtifact(specDescriptor),
      readArtifact(ledgerDescriptor),
    ]);
    if (stateBytes.length > FLOW_QUERY_LIMITS.MAX_STATE_RECORD_BYTES
      || specBytes.length > FLOW_QUERY_LIMITS.MAX_SPEC_RECORD_BYTES
      || ledgerBytes.length > FLOW_QUERY_LIMITS.MAX_CONFIRMED_LEDGER_BYTES) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "canonical record exceeds its bounded size");
    }
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
    const confirmedLedger = this.readConfirmedLedger(ledgerBytes, state.confirmationOrder);
    const activities = confirmedLedger.activities;
    try {
      replayCanonicalState(state, activities);
    } catch (error) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "canonical state and Activity ledger are inconsistent", { cause: error });
    }
    let activityIndex;
    try {
      activityIndex = FlowArtifactActivityIndex.fromBytes(confirmedLedger.bytes);
      new ReferenceResolver(catalog).validateCanonicalActivityResults(activities);
    } catch (error) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "canonical Activity references are inconsistent", { cause: error });
    }
    const artifactSchemaRevisions = await this.captureArtifactSchemaRevisions(catalog, ledgerDescriptor, confirmedLedger.bytes, inspectArtifact);
    const artifactBytes = new Map();
    artifactBytes.set(ledgerDescriptor.relativePath, confirmedLedger.bytes);
    const value = new QueryCapturedVersion({ state, spec, activities, artifactSchemaRevisions, artifactBytes, catalog,
      stateBytes, specBytes, confirmedLedgerBytes: confirmedLedger.bytes,
      repositoryIdentity: captureProcessExecutionCheckoutIdentity({ mainRoot: this.repositoryRoot }) });
    if (context?.request) {
      while (true) {
        try {
          value.rememberProjection(await new QueryProjector(context.available, context.projection).project(context.request, value));
          break;
        } catch (error) {
          if (!(error instanceof QueryDetailArtifactRequired)) {
            value.rememberProjection(null, error);
            break;
          }
          if (artifactBytes.has(error.descriptor.relativePath)) throw new Error("detail hydration repeated a captured input");
          artifactBytes.set(error.descriptor.relativePath, await readArtifact(error.descriptor));
        }
      }
    }
    return new FlowArtifactCatalogSnapshotEvidence({
      value: Object.freeze(value),
      activityIndex,
      confirmedLedgerBytes: confirmedLedger.bytes,
    });
  }

  async captureArtifactSchemaRevisions(catalog, ledgerDescriptor, confirmedLedgerBytes, inspectArtifact) {
    const revisions = new Map();
    for (const descriptor of catalog.artifacts) {
      if (descriptor.logicalKey === null) {
        revisions.set(descriptor.relativePath, null);
        continue;
      }
      const contract = FLOW_ARTIFACT_CONTRACTS.require(descriptor.logicalKey);
      if (contract.contentContract === null) {
        revisions.set(descriptor.relativePath, null);
        continue;
      }
      const bytes = descriptor === ledgerDescriptor ? confirmedLedgerBytes : await inspectArtifact(descriptor);
      try {
        const value = contract.contentContract.parse(bytes);
        revisions.set(descriptor.relativePath, Number.isSafeInteger(value?.schemaRevision) && value.schemaRevision > 0 ? value.schemaRevision : null);
      } catch (error) {
        throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Artifact content contract validation failed", { cause: error });
      }
    }
    return new ArtifactSchemaRevisionEvidence(revisions);
  }

  unwrap(value, specId, version, property) {
    const fields = property === "state"
      ? "flowVersion,recordRevision,specId,state"
      : "content,recordRevision,specId";
    if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== fields) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Versioned canonical record envelope is invalid");
    }
    if (value.recordRevision !== 1 || value.specId !== specId || (property === "state" && value.flowVersion !== version)) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Versioned canonical record identity is inconsistent");
    }
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
    const activities = [];
    const ids = new Set();
    let offset = 0;
    for (let index = 0; index < confirmationOrder; index += 1) {
      const end = bytes.indexOf(0x0A, offset);
      if (end < 0) {
        throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Activity ledger is shorter than the confirmed prefix");
      }
      const line = bytes.subarray(offset, end);
      offset = end + 1;
      if (line.length === 0) {
        throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Activity ledger has an invalid entry");
      }
      let serialized;
      try {
        serialized = JSON.parse(line.toString("utf8"));
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
    return Object.freeze({ activities: Object.freeze(activities), bytes: Buffer.from(bytes.subarray(0, offset)) });
  }
}

class Cursor {
  constructor({ request, order, snapshotId }) {
    Object.assign(this, Cursor.binding(request));
    if (!/^sha256:[a-f0-9]{64}$/.test(snapshotId)) throw new Error("cursor requires a snapshot identity");
    this.snapshotId = snapshotId;
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
      version: 2,
      schemaRevision: FLOW_QUERY_SCHEMA_REVISION,
      snapshotId: this.snapshotId,
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

  static decode(value, request, { snapshotId = null } = {}) {
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
      || payload.version !== 2
      || payload.schemaRevision !== FLOW_QUERY_SCHEMA_REVISION
      || typeof payload.snapshotId !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(payload.snapshotId)
      || !FLOW_QUERY_RESOURCES.includes(payload.resource)
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
    if (snapshotId !== null && payload.snapshotId !== snapshotId) {
      throw new QueryError(ERROR_CODES.SNAPSHOT_CHANGED, "/page/after", "cursor snapshot changed", { reason: "SNAPSHOT_ID_MISMATCH", referenceId: payload.snapshotId });
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
    const { digest, ...identity } = payload;
    return canonicalDigest(identity);
  }

  static canonicalJson(value) {
    return JSON.stringify(canonicalJson(value));
  }
}

class QueryProjector {
  constructor(availableFlowVersions, projection = null) {
    if (!Array.isArray(availableFlowVersions)) throw new Error("Query projector requires available Flow Versions");
    this.availableFlowVersions = Object.freeze([...availableFlowVersions]);
    this.projection = projection;
    Object.freeze(this);
  }

  async project(request, version) {
    const selected = new SelectedFlowVersion(request.specId, request.flowVersion);
    const snapshot = new QuerySnapshot(version, selected, this.availableFlowVersions, this.projection ?? await QueryProjectionSignature.read());
    return request.resource === "metadata"
      ? this.metadata(request, version, selected, snapshot)
      : this.activities(request, version, selected, snapshot);
  }

  metadata(request, version, selected, snapshot) {
    const item = this.metadataItem(version, selected.flowVersion);
    return { schemaRevision: FLOW_QUERY_SCHEMA_REVISION, ok: true, resource: "metadata", selectedFlowVersion: selected.toJSON(), availableFlowVersions: this.availableFlowVersions,
      snapshot: snapshot.toJSON(), completeness: { scope: "flow-version", enumeration: "complete", details: "not-applicable", sourceHistory: version.state.history === null ? "complete" : "partial" }, item: item.toJSON() };
  }

  metadataItem({ state, spec, activities, catalog, artifactSchemaRevisions }, flowVersion) {
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
    const artifactRelations = new ReferenceResolver(catalog).activityRelations(activities);
    const artifactItems = catalog.artifacts.map((descriptor) => this.artifactDescriptor(
      descriptor,
      activities,
      catalog,
      { state, artifactSchemaRevisions },
      artifactRelations,
    ));
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
    const gitSnapshot = git === undefined
      ? new GitSnapshot({ available: false, commit: null }).toJSON()
      : GitSnapshot.from(git).toJSON();
    const activitySummary = new CurrentFlowActivitySummary(activities);
    return new MetadataItem({
      identity: { flowId: state.flowId, flowVersionId: state.flowVersionId, runId: state.runId, specId: state.specId, flowVersion },
      lifecycle: { lifecycle: state.lifecycle.state, blocked, blocker, nextAction: next === null ? null : { operation: next.operation, phase: next.path[1] ?? null, stepId: next.path.at(-1) ?? null, taskId: nextTaskNode?.id ?? null } },
      location: { phase: currentPath[1] ?? null, stepId: leaf, taskId: taskNode?.id ?? null, git: gitSnapshot },
      structure: new QueryStructure({ state, spec, catalog, phaseId: state.root.steps.find((node) => node.steps.some((child) => child.id === currentPath[1]))?.id ?? currentPath[1] ?? "flow" }).toJSON(),
      history: { origin: state.history === null ? "native" : "historical", ledgerCoverage: state.history === null ? "complete" : "partial", execution: state.history?.execution ?? "native", continuation: state.history?.continuation?.toJSON() ?? null },
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

  /**
   * ActivityFailure is the canonical, durable diagnostic record.  Its process
   * stop evidence is deliberately not a Flow query field: it can contain
   * supervisor-only process observations, while the public Activity contract
   * has a stable five-field failure summary.  Project rather than serialize
   * the canonical value wholesale so new internal diagnostics cannot widen
   * the query API accidentally.
   */
  publicFailure(failure) {
    if (failure === null || failure === undefined) return null;
    return {
      category: failure.category,
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      retryKind: failure.retryKind,
    };
  }

  artifactDescriptor(descriptor, activities, catalog, version, relations = new ReferenceResolver(catalog).activityRelations(activities)) {
    const stored = descriptor.toJSON();
    const activity = descriptor.activityId === null ? null : activities.find((entry) => entry.id === descriptor.activityId) ?? null;
    const taskId = activity === null ? null : this.taskIdForActivity(version.state, activity);
    const referencingActivityIds = relations.activityIdsFor(descriptor);
    return new ArtifactDescriptorView({ artifactId: publicArtifactId(descriptor), metadata: { logicalKey: requirePublicString(descriptor.logicalKey, "artifact.logicalKey", { nullable: true }), schemaRevision: this.artifactSchemaRevision(descriptor, version), mediaType: publicString(descriptor.mediaType, "artifact.mediaType") }, activityIds: activity ? [activity.id] : [], nodeIds: activity?.nodeId ? [activity.nodeId] : [], taskIds: taskId ? [taskId] : [],
      artifactKey: publicArtifactKey(descriptor, version.state.flowVersionId),
      kind: descriptor.kind, relativePath: descriptor.relativePath, hash: descriptor.hash, algorithm: "sha256", hashScope: descriptor.logicalKey === "flow.activities" ? "confirmed-prefix" : "file-bytes", size: descriptor.size,
      authority: stored.authority, cardinality: stored.cardinality, memberId: stored.memberId, publicationStep: stored.publicationStep, retention: stored.retention,
      producerActivityId: descriptor.activityId, referencingActivityIds,
    });
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

  artifactSchemaRevision(descriptor, version) {
    try { return version.artifactSchemaRevisions.revisionFor(descriptor); } catch (error) {
      throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Artifact snapshot schema evidence is missing", { cause: error });
    }
  }

  activities(request, version, selected, snapshot) {
    const after = request.page.after === null ? 0 : Cursor.decode(request.page.after, request, { snapshotId: snapshot.id });
    if (after > snapshot.value.confirmationOrder) throw new QueryError(ERROR_CODES.INVALID_CURSOR, "/page/after", "cursor order exceeds its snapshot prefix");
    const matching = version.activities.filter((entry) => {
      if (request.recordedAt.gte === null && request.recordedAt.lt === null) return true;
      if (entry.timing?.finishedAt === null || entry.timing?.finishedAt === undefined) return false;
      return (request.recordedAt.gte === null || Date.parse(entry.timing.finishedAt) >= Date.parse(request.recordedAt.gte))
        && (request.recordedAt.lt === null || Date.parse(entry.timing.finishedAt) < Date.parse(request.recordedAt.lt));
    });
    const remaining = matching.filter((entry) => entry.confirmationOrder > after);
    const index = new QueryDetailIndex({ state: version.state, activities: version.activities, catalog: version.catalog, artifactBytes: version.artifactBytes, snapshotId: snapshot.id,
      repositoryIdentity: version.repositoryIdentity });
    const items = [];
    const details = [];
    const response = () => {
      const detailCompleteness = detailCompletenessFor(items);
      return { schemaRevision: FLOW_QUERY_SCHEMA_REVISION, ok: true, resource: "activities", selectedFlowVersion: selected.toJSON(), availableFlowVersions: this.availableFlowVersions,
        snapshot: snapshot.toJSON(), completeness: { scope: request.recordedAt.gte === null && request.recordedAt.lt === null ? "flow-version" : "filtered-activities", enumeration: "complete", details: detailCompleteness, sourceHistory: version.state.history === null ? "complete" : "partial" },
        items: [...items], entities: index.closureFor(details), pageInfo: { limit: request.page.limit,
          endCursor: items.length === 0 ? null : new Cursor({ request, order: items.at(-1).confirmationOrder, snapshotId: snapshot.id }).encode(),
          hasNext: remaining.length > items.length, returnedItems: items.length, totalItems: matching.length } };
    };
    for (const activity of remaining.slice(0, request.page.limit)) {
      const detail = index.forActivity(activity);
      items.push(this.activityItem(activity, version.state, version.catalog, detail).toJSON());
      details.push(detail);
      const candidate = response();
      if (Buffer.byteLength(JSON.stringify(candidate) + "\n", "utf8") > FLOW_QUERY_LIMITS.MAX_RESPONSE_BYTES) {
        items.pop(); details.pop();
        if (items.length === 0) throw new QueryError(ERROR_CODES.RESPONSE_TOO_LARGE, "/response", "one Activity and its detail closure exceed the response byte limit", { reason: "RESPONSE_BYTE_LIMIT", referenceId: activity.id });
        break;
      }
    }
    return response();
  }

  activityItem(activity, state, catalog, details) {
    const resolver = new ReferenceResolver(catalog);
    const taskId = this.taskIdForActivity(state, activity);
    const task = activity.transition.task ?? (taskId === null
      ? null
      : { id: taskId, key: state.findNode(taskId)?.key ?? taskId });
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
      task: task === null ? null : { id: task.id, key: task.key },
      attempt: activity.attemptId === null ? null : { id: activity.attemptId, sequence: activity.sequence },
      sequence: activity.sequence,
      confirmationOrder: activity.confirmationOrder,
      transition: { operation: activity.transition.operation, status: activity.transition.status },
      timing: activity.timing?.toJSON() ?? null,
      usage: activity.usage?.toJSON() ?? null,
      outcome: new QueryNodeResultView(activity.result, resolver, { legacySummary: true }).toJSON(),
      failure: this.publicFailure(activity.failure),
      blocker: attempt?.blocker ? { code: attempt.blocker.code, message: attempt.blocker.message } : null,
      incomplete: incomplete.length === 0 ? null : incomplete[0].toJSON(),
      metric: activity.metric?.toJSON() ?? null,
      note: activity.note?.text ?? null,
      evaluationIds: uniqueLimited(activity.references.evaluations.map((entry) => entry.id), "activity.evaluationIds"),
      findingIds: uniqueLimited(activity.references.findings.map((entry) => entry.id), "activity.findingIds"),
      repairIds: uniqueLimited(activity.references.repairs.map((entry) => entry.id), "activity.repairIds"),
      artifactIds: publicArtifactIds(activity.references.artifacts),
      ...details.toJSON(),
    });
  }
}

function knownResourceError({ resource, pageLimit = null }, code, jsonPath, message, availableFlowVersions = [], selectedFlowVersion = null, { snapshot = null, reason = null, referenceId = null } = {}) {
  const base = { schemaRevision: FLOW_QUERY_SCHEMA_REVISION, ok: false, resource, selectedFlowVersion, availableFlowVersions, snapshot, completeness: null, error: { code, path: jsonPath, message, reason, referenceId } };
  return resource === "metadata"
    ? { ...base, item: null }
    : { ...base, items: [], entities: { evaluations: [], findings: [], repairs: [] }, pageInfo: { limit: pageLimit, endCursor: null, hasNext: false, returnedItems: 0, totalItems: null } };
}

function unknownResourceError(code, jsonPath, message, resource = null) {
  const response = { schemaRevision: FLOW_QUERY_SCHEMA_REVISION, ok: false, snapshot: null, completeness: null, error: { code, path: jsonPath, message, reason: null, referenceId: null } };
  if (resource === null) return response;
  return { schemaRevision: FLOW_QUERY_SCHEMA_REVISION, ok: false, resource, selectedFlowVersion: null, availableFlowVersions: [], snapshot: null, completeness: null, error: response.error };
}

function publicError(error) {
  if (error instanceof QueryError) return error;
  return new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "canonical query could not be completed", { cause: error });
}

function serializeQueryResponse(response) {
  const errors = validateFlowQueryResponse(response);
  if (errors.length > 0) throw new Error(`query response does not match the query contract: ${errors[0]}`);
  return JSON.stringify(response);
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
  let request = null;
  try {
    const bytes = await readInput(argv);
    request = parseRequestBytes(bytes, (resource) => { requestedResource = resource; });
    request.validateCursor();
    return Object.freeze({ bytes, request, requestedResource, error: null });
  } catch (error) {
    return Object.freeze({ bytes: null, request, requestedResource, error });
  }
}

export async function bootstrapFlowQueryCli(argv = []) {
  const prepared = await prepareFlowQueryInput(argv);
  return runFlowQueryCli(argv, { prepared });
}

function repositoryRoot() {
  return path.resolve(process.env[PRODUCT.env("WORK_ROOT")] ?? process.cwd());
}

async function specRoot() {
  const configPath = path.join(repositoryRoot(), ".sennel", "config.json");
  let config;
  try { config = JSON.parse(await fs.promises.readFile(configPath, "utf8")); } catch (error) {
    throw new QueryError(ERROR_CODES.CANONICAL_RECORD_UNREADABLE, "/canonical", "Flow configuration could not be read", { cause: error });
  }
  try {
    return flowSpecRootFromConfig(config).toString();
  } catch (error) {
    throw new QueryError(ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", "Flow configuration specDir is invalid", { cause: error });
  }
}

function writeStream(stream, value) {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => error ? reject(error) : resolve());
  });
}

export async function runFlowQueryCli(argv = process.argv.slice(2), { prepared = null } = {}) {
  if (argv.includes("-h") || argv.includes("--help")) {
    await writeStream(process.stdout, `${FLOW_QUERY_HELP}\n`);
    return 0;
  }
  let request = null;
  let requestedResource = null;
  let reader = null;
  let available = [];
  let selectionEstablished = false;
  let snapshot = null;
  try {
    if (prepared?.request) request = prepared.request;
    if (prepared?.error) {
      requestedResource = prepared.requestedResource ?? null;
      throw prepared.error;
    }
    if (request === null) {
      const inputBytes = prepared?.bytes ?? await readInput(argv);
      request = parseRequestBytes(inputBytes, (resource) => { requestedResource = resource; });
    }
    requestedResource = request.resource;
    request.validateCursor();
    reader = new CanonicalFlowVersionReader({ repositoryRoot: repositoryRoot(), specRoot: await specRoot() });
    available = await reader.listAvailableVersions(request.specId);
    if (available.length === 0) throw new QueryError(ERROR_CODES.SPEC_NOT_FOUND, "/condition/specId", "requested Spec was not found");
    if (!available.includes(request.flowVersion)) throw new QueryError(ERROR_CODES.FLOW_VERSION_NOT_FOUND, "/condition/flowVersion", "requested Flow Version was not found");
    const captured = await reader.read(request.specId, request.flowVersion, request);
    const version = captured.version;
    available = captured.available;
    selectionEstablished = true;
    snapshot = new QuerySnapshot(version, new SelectedFlowVersion(request.specId, request.flowVersion), available, captured.projection);
    if (version.projectionError) throw version.projectionError;
    const response = version.response;
    const output = `${serializeQueryResponse(response)}\n`;
    if (Buffer.byteLength(output, "utf8") > FLOW_QUERY_LIMITS.MAX_RESPONSE_BYTES) throw new QueryError(ERROR_CODES.RESPONSE_TOO_LARGE, "/response", "query response exceeds the maximum size", { reason: "RESPONSE_BYTE_LIMIT" });
    await writeStream(process.stdout, output);
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
        { snapshot: snapshot?.toJSON() ?? null, reason: error.reason ?? null, referenceId: error.referenceId ?? null },
      );
    } else if (FLOW_QUERY_RESOURCES.includes(requestedResource)) {
      response = knownResourceError({ resource: requestedResource }, error.code, error.jsonPath, error.message);
    } else {
      response = unknownResourceError(
        error.code,
        error.jsonPath,
        error.message,
        FLOW_QUERY_RESOURCES.includes(requestedResource) ? requestedResource : null,
      );
    }
    await writeStream(process.stdout, `${serializeQueryResponse(response)}\n`);
    await writeStream(process.stderr, `${error.message}\n`);
    return 1;
  }
}

export {
  AggregateMetrics,
  ActivityItem,
  ArtifactDescriptorView,
  CanonicalFlowVersionReader,
  Cursor,
  FLOW_QUERY_ERROR_CODES,
  FLOW_QUERY_ERROR_PATHS,
  FLOW_QUERY_LIMITS,
  FLOW_QUERY_RESOURCES,
  FLOW_QUERY_SCHEMA_REVISION,
  MetadataItem,
  QueryError,
  QueryProjector,
  QueryRequest,
  SelectedFlowVersion,
};
