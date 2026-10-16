import fs from "node:fs";
import { validateSchema } from "../lib/schema-validate.js";
export { FLOW_QUERY_GATE_FINDING_SPECIFIC_SCHEMA } from "./query-gate-details.js";
export { FLOW_QUERY_REPAIR_CHANGE_SCHEMA } from "./query-repair-change.js";

export const FLOW_QUERY_SCHEMA_REVISION = 3;
export const FLOW_QUERY_HELP = [
  "Usage: sennel flow query [--request-file <path>]",
  "",
  "Read canonical Flow Version metadata, confirmed Activities or execution observations as one JSON response.",
  "Input is a single JSON request from stdin or --request-file.",
].join("\n");
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
  MAX_SNAPSHOT_ATTEMPTS: 3,
  MAX_MANAGED_ARTIFACT_ENTRIES: 10_000,
  MAX_ARTIFACT_BYTES: 16_777_216,
  MAX_TOTAL_ARTIFACT_BYTES: 67_108_864,
});

export const FLOW_QUERY_RESOURCES = Object.freeze(["metadata", "activities", "executions"]);

export const FLOW_QUERY_ERROR_CODES = Object.freeze({
  FLOW_BOOTSTRAP_FAILED: "FLOW_BOOTSTRAP_FAILED",
  INVALID_JSON: "INVALID_JSON",
  INVALID_REQUEST: "INVALID_REQUEST",
  SPEC_NOT_FOUND: "SPEC_NOT_FOUND",
  FLOW_VERSION_NOT_FOUND: "FLOW_VERSION_NOT_FOUND",
  CANONICAL_RECORD_UNREADABLE: "CANONICAL_RECORD_UNREADABLE",
  CANONICAL_RECORD_INCONSISTENT: "CANONICAL_RECORD_INCONSISTENT",
  EXECUTION_RECORD_INCONSISTENT: "EXECUTION_RECORD_INCONSISTENT",
  INVALID_CURSOR: "INVALID_CURSOR",
  CURSOR_QUERY_MISMATCH: "CURSOR_QUERY_MISMATCH",
  SNAPSHOT_CHANGED: "SNAPSHOT_CHANGED",
  SNAPSHOT_UNSTABLE: "SNAPSHOT_UNSTABLE",
  DETAIL_UNAVAILABLE: "DETAIL_UNAVAILABLE",
  RESPONSE_TOO_LARGE: "RESPONSE_TOO_LARGE",
});

export const FLOW_QUERY_ERROR_PATHS = Object.freeze({
  FLOW_BOOTSTRAP_FAILED: "/bootstrap",
  INVALID_JSON: "/request",
  INVALID_REQUEST: null,
  SPEC_NOT_FOUND: "/condition/specId",
  FLOW_VERSION_NOT_FOUND: "/condition/flowVersion",
  CANONICAL_RECORD_UNREADABLE: "/canonical",
  CANONICAL_RECORD_INCONSISTENT: "/canonical",
  EXECUTION_RECORD_INCONSISTENT: "/canonical",
  INVALID_CURSOR: "/page/after",
  CURSOR_QUERY_MISMATCH: "/page/after",
  SNAPSHOT_CHANGED: "/page/after",
  SNAPSHOT_UNSTABLE: "/snapshot",
  DETAIL_UNAVAILABLE: "/canonical",
  RESPONSE_TOO_LARGE: "/response",
});

export function isFlowQueryDatetime(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0", zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > daysInMonth) return false;
  if (zone === "Z") return true;
  const offset = zone.slice(1).replace(":", "");
  const offsetHour = Number(offset.slice(0, 2));
  const offsetMinute = Number(offset.slice(2));
  return offsetMinute <= 59 && (offsetHour < 14 || (offsetHour === 14 && offsetMinute === 0));
}

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const positiveInteger = (maximum = undefined) => Object.freeze({
  type: "integer",
  minimum: 1,
  maximum: maximum ?? MAX_SAFE_INTEGER,
});

const publicString = Object.freeze({ type: "string", maxLength: FLOW_QUERY_LIMITS.MAX_PUBLIC_STRING_BYTES });
const nullable = (schema) => Object.freeze({ ...schema, type: [schema.type, "null"] });

const condition = Object.freeze({
  type: "object",
  required: ["specId"],
  properties: { specId: { ...publicString, minLength: 1 }, flowVersion: positiveInteger() },
  additionalProperties: false,
});

const page = (maxPageLimit) => Object.freeze({
  type: "object",
  required: ["limit", "after"],
  properties: {
    limit: positiveInteger(maxPageLimit),
    after: nullable(publicString),
  },
  additionalProperties: false,
});

const recordedAt = Object.freeze({
  oneOf: [
    { type: "object", required: ["gte"], properties: { gte: { ...publicString, minLength: 1 } }, additionalProperties: false },
    { type: "object", required: ["lt"], properties: { lt: { ...publicString, minLength: 1 } }, additionalProperties: false },
    { type: "object", required: ["gte", "lt"], properties: { gte: { ...publicString, minLength: 1 }, lt: { ...publicString, minLength: 1 } }, additionalProperties: false },
  ],
});

const expectSnapshotId = Object.freeze({ type: "string", pattern: "^sha256:[a-f0-9]{64}$" });
const executionTarget = Object.freeze({ type: "object", required: ["nodeId", "includeDescendants", "attemptId"],
  properties: { nodeId: { ...publicString, minLength: 1 }, includeDescendants: { type: "boolean" }, attemptId: nullable({ ...publicString, minLength: 1 }) }, additionalProperties: false });

export const FLOW_QUERY_REQUEST_SCHEMAS = Object.freeze({
  metadata: Object.freeze({
    type: "object",
    required: ["resource", "condition"],
    properties: { resource: { type: "string", enum: ["metadata"] }, condition, expectSnapshotId },
    additionalProperties: false,
  }),
  activities: Object.freeze({
    type: "object",
    required: ["resource", "condition", "page"],
    properties: { resource: { type: "string", enum: ["activities"] }, condition, page: page(FLOW_QUERY_LIMITS.MAX_PAGE_LIMIT), recordedAt, expectSnapshotId },
    additionalProperties: false,
  }),
  executions: Object.freeze({ type: "object", required: ["resource", "condition", "page"],
    properties: { resource: { type: "string", enum: ["executions"] }, condition, page: page(FLOW_QUERY_LIMITS.MAX_PAGE_LIMIT), target: executionTarget, expectSnapshotId }, additionalProperties: false }),
});

export const FLOW_QUERY_REQUEST_SCHEMA = Object.freeze({ oneOf: Object.values(FLOW_QUERY_REQUEST_SCHEMAS) });

export const FLOW_QUERY_RESPONSE_SCHEMA = Object.freeze(JSON.parse(fs.readFileSync(
  new URL("./schemas/query-response.schema.json", import.meta.url), "utf8",
)));

function responseVariant(value) {
  return FLOW_QUERY_RESPONSE_SCHEMA.oneOf.find((schema) => schema.properties.ok.enum[0] === value?.ok
    && (schema.properties.resource ? schema.properties.resource.enum[0] === value?.resource : !Object.hasOwn(value ?? {}, "resource")))
    ?? FLOW_QUERY_RESPONSE_SCHEMA;
}

export function validateFlowQueryRequest(value) {
  const schema = FLOW_QUERY_REQUEST_SCHEMAS[value?.resource] ?? FLOW_QUERY_REQUEST_SCHEMA;
  return validateSchema(value, schema);
}

export function validateFlowQueryResponse(value) {
  const errors = validateSchema(value, responseVariant(value));
  if (errors.length > 0) return errors;
  return new FlowQueryResponseValidation(value).validate();
}

const DETAIL_GROUPS = Object.freeze(["evaluations", "findings", "repairs"]);
const DETAIL_ID_FIELDS = Object.freeze({ evaluations: "evaluationIds", findings: "findingIds", repairs: "repairIds" });

/** Aggregate the recorded detail coverage of one page; an empty scan is complete. */
export function detailCompletenessFor(items) {
  const coverages = items.flatMap((item) => DETAIL_GROUPS.map((group) => item.detailCoverage[group].availability));
  return coverages.includes("not-recorded") ? "not-recorded"
    : coverages.length > 0 && coverages.every((value) => value === "not-applicable") ? "not-applicable" : "complete";
}

/** Checks facts present in one wire response, without reading canonical state. */
class FlowQueryResponseValidation {
  constructor(response) {
    this.response = response;
    this.errors = [];
  }

  check(condition, path, message) {
    if (!condition) this.errors.push(`${path}: ${message}`);
  }

  unique(values, path) {
    const set = new Set(values);
    this.check(set.size === values.length, path, "must not contain duplicate identities");
    return set;
  }

  sameIds(actual, expected, path) {
    const actualSet = this.unique(actual, path);
    const expectedSet = new Set(expected);
    this.check(actualSet.size === expectedSet.size && [...actualSet].every((id) => expectedSet.has(id)), path, "must match the corresponding identities");
  }

  validate() {
    const value = this.response;
    this.jsonValues(value);
    if (Object.hasOwn(value, "availableFlowVersions")) {
      this.unique(value.availableFlowVersions, "availableFlowVersions");
      this.check(value.availableFlowVersions.every((version, index, versions) => index === 0 || versions[index - 1] < version), "availableFlowVersions", "must be ascending");
      if (value.selectedFlowVersion !== null) this.check(value.availableFlowVersions.includes(value.selectedFlowVersion.flowVersion), "selectedFlowVersion", "must select an available Version");
    }
    if (value.snapshot !== null) {
      this.check(isFlowQueryDatetime(value.snapshot.capturedAt) && value.snapshot.capturedAt.endsWith("Z"), "snapshot.capturedAt", "must be a UTC datetime");
      this.check(value.selectedFlowVersion !== null && value.selectedFlowVersion !== undefined, "snapshot", "requires a selected Flow Version");
    }
    if (!value.ok) {
      const expected = FLOW_QUERY_ERROR_PATHS[value.error.code];
      if (expected !== null && expected !== undefined) this.check(value.error.path === expected, "error.path", `must be ${expected} for ${value.error.code}`);
      return this.errors;
    }
    if (value.resource === "metadata") this.metadata();
    else if (value.resource === "activities") this.activities();
    else this.executions();
    return this.errors;
  }

  jsonValues(value, path = "response", depth = 0) {
    this.check(depth <= FLOW_QUERY_LIMITS.MAX_CANONICAL_JSON_DEPTH, path, "exceeds the public nesting limit");
    if (depth > FLOW_QUERY_LIMITS.MAX_CANONICAL_JSON_DEPTH) return;
    if (typeof value === "number") this.check(Number.isFinite(value), path, "must be finite");
    else if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) this.jsonValues(entry, `${path}.${key}`, depth + 1);
    }
  }

  metadata() {
    const { item, selectedFlowVersion, completeness } = this.response;
    this.check(item.identity.specId === selectedFlowVersion.specId && item.identity.flowVersion === selectedFlowVersion.flowVersion, "item.identity", "must match the selected Flow Version");
    this.check(completeness.sourceHistory === item.history.ledgerCoverage, "completeness.sourceHistory", "must match saved history coverage");
    const { structure } = item;
    const nodes = new Map(structure.nodes.map((node) => [node.id, node]));
    this.check(nodes.size === structure.nodes.length, "item.structure.nodes", "must have unique node identities");
    const root = nodes.get(structure.rootNodeId);
    this.check(root?.kind === "flow" && root.parentId === null, "item.structure.rootNodeId", "must identify the unique Flow root");
    this.check(structure.nodes.filter((node) => node.kind === "flow").length === 1, "item.structure.nodes", "must have one Flow root");
    this.sameIds(structure.stepIds, structure.nodes.filter((node) => node.kind === "step").map((node) => node.id), "item.structure.stepIds");
    this.sameIds(structure.taskIds, structure.nodes.filter((node) => node.kind === "task").map((node) => node.id), "item.structure.taskIds");
    this.sameIds(structure.phaseIds, structure.nodes.filter((node) => node.role === "phase").map((node) => node.id), "item.structure.phaseIds");
    this.check(nodes.has(structure.phaseId), "item.structure.phaseId", "must identify a saved node");
    const visited = new Set();
    const pending = root ? [root] : [];
    while (pending.length > 0) {
      const node = pending.pop();
      if (visited.has(node.id)) {
        this.check(false, "item.structure.nodes", "must not contain a cycle or shared child");
        continue;
      }
      visited.add(node.id);
      this.unique(node.childIds, `node(${node.id}).childIds`);
      for (const id of node.childIds) {
        const child = nodes.get(id);
        this.check(child !== undefined && child.parentId === node.id, `node(${node.id}).childIds`, "must resolve to children with the same parent");
        if (child) pending.push(child);
      }
    }
    this.check(visited.size === nodes.size, "item.structure.nodes", "must form one connected tree");
    const stepTasks = [];
    for (const node of structure.nodes) {
      const path = `node(${node.id})`;
      const roleMatches = node.kind === "step" ? ["phase", "group", "step"].includes(node.role) : node.role === node.kind;
      this.check(roleMatches, `${path}.role`, "must match the saved node kind");
      this.check((node.displayNameSource === "key") === (node.coverage.displayName === "key-fallback"), `${path}.coverage.displayName`, "must describe the display-name source");
      if (node.displayNameSource === "key") this.check(node.displayName === node.key, `${path}.displayName`, "key fallback must retain the saved key");
      this.check(node.kind === "step" ? node.coverage.phaseClassification !== "not-applicable" : node.coverage.phaseClassification === "not-applicable", `${path}.coverage.phaseClassification`, "must apply only to Step nodes");
      if (node.coverage.phaseClassification === "not-recorded") this.check(node.role === "group", `${path}.role`, "unclassified Steps must be groups");
      if (node.kind !== "step" || node.role !== "step") this.check(node.definitionStepId === null, `${path}.definitionStepId`, "only concrete Steps may identify a Definition Step");
      const ancestors = [];
      const seen = new Set();
      let ancestor = node;
      while (ancestor && !seen.has(ancestor.id)) {
        seen.add(ancestor.id);
        ancestors.push(ancestor);
        ancestor = ancestor.parentId === null ? null : nodes.get(ancestor.parentId);
      }
      const task = ancestors.find((entry) => entry.kind === "task");
      const phase = ancestors.find((entry) => entry.role === "phase");
      this.check(node.taskId === (task?.id ?? null), `${path}.taskId`, "must identify the containing Task");
      this.check(node.phaseId === (phase?.id ?? null), `${path}.phaseId`, "must identify the containing phase");
      if (task && node.kind === "step") stepTasks.push(`${node.id}\0${task.id}`);
      if (node.result !== null) this.check(isFlowQueryDatetime(node.result.confirmedAt), `${path}.result.confirmedAt`, "must be a recorded datetime");
    }
    this.sameIds(item.relationships.stepTasks.map((entry) => `${entry.stepId}\0${entry.taskId}`), stepTasks, "item.relationships.stepTasks");
    this.sameIds(item.relationships.taskNodes.map((entry) => `${entry.taskId}\0${entry.nodeId}`), structure.taskIds.map((id) => `${id}\0${id}`), "item.relationships.taskNodes");
    for (const [field, id] of Object.entries(item.location)) {
      if (field !== "git" && id !== null) this.check(nodes.has(id), `item.location.${field}`, "must identify a saved node");
    }
    this.unique(item.artifacts.map((artifact) => artifact.artifactId), "item.artifacts.artifactId");
    this.unique(item.artifacts.map((artifact) => artifact.artifactKey), "item.artifacts.artifactKey");
    for (const artifact of item.artifacts) this.artifact(artifact, nodes);
  }

  relativePath(value, path) {
    const segments = value.split("/");
    this.check(!value.includes("\\") && !value.includes("\0") && !/^[A-Za-z]:/.test(value)
      && segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."), path, "must be a normalized Version-relative POSIX path");
  }

  artifact(artifact, nodes) {
    const path = `artifact(${artifact.artifactId})`;
    this.relativePath(artifact.relativePath, `${path}.relativePath`);
    this.check((artifact.cardinality === "singleton") === (artifact.memberId === null), `${path}.memberId`, "must match artifact cardinality");
    this.check((artifact.hashScope === "confirmed-prefix") === (artifact.metadata.logicalKey === "flow.activities"), `${path}.hashScope`, "flow.activities requires confirmed-prefix; other artifacts require file-bytes");
    for (const field of ["activityIds", "nodeIds", "taskIds", "referencingActivityIds"]) this.unique(artifact[field], `${path}.${field}`);
    if (artifact.producerActivityId !== null) this.check(artifact.activityIds.includes(artifact.producerActivityId), `${path}.activityIds`, "must include the recorded producer Activity");
    for (const id of artifact.nodeIds) this.check(nodes.has(id), `${path}.nodeIds`, "must identify saved nodes");
    for (const id of artifact.taskIds) this.check(nodes.get(id)?.kind === "task", `${path}.taskIds`, "must identify saved Tasks");
  }

  source(source, path) {
    this.relativePath(source.relativePath, `${path}.relativePath`);
    this.check((source.format === "jsonl") === (source.jsonPointer === null), `${path}.jsonPointer`, "JSON requires a pointer; JSONL requires null");
  }

  entity(entity, path) {
    this.source(entity.source, `${path}.source`);
    for (const source of entity.supportingSources) this.source(source, `${path}.supportingSources`);
    for (const field of ["activityIds", "evaluationIds", "findingIds", "repairIds"]) this.unique(entity[field], `${path}.${field}`);
    this.check(entity.activityIds.includes(entity.source.producerActivityId), `${path}.activityIds`, "must include the producer Activity");
    if (entity.currentState !== undefined && entity.currentState !== null) {
      this.check(entity.currentState.asOfSnapshotId === this.response.snapshot.id, `${path}.currentState.asOfSnapshotId`, "must identify this snapshot");
      for (const source of entity.currentState.sources) this.source(source, `${path}.currentState.sources`);
    }
    if (entity.identity) this.relativePath(entity.identity.sourceArtifact, `${path}.identity.sourceArtifact`);
    if (entity.kind === "repair" || entity.kind === "lifecycle-skip") {
      this.unique(entity.items.map((item) => item.id), `${path}.items`);
      for (const item of entity.items) {
        this.unique(item.findingIds, `${path}.items.findingIds`);
        this.check(item.findingIds.every((id) => entity.findingIds.includes(id)), `${path}.items.findingIds`, "must be included in the Repair finding references");
        if (item.target.relativePath !== null) this.relativePath(item.target.relativePath, `${path}.items.target.relativePath`);
        for (const evidence of item.evidence) this.source(evidence.source, `${path}.items.evidence.source`);
      }
    }
  }

  page(items, pageInfo) {
    this.check(pageInfo.returnedItems === items.length && items.length <= pageInfo.limit, "pageInfo.returnedItems", "must equal items length and fit the requested limit");
    this.check(pageInfo.totalItems >= items.length, "pageInfo.totalItems", "must cover the returned items");
    this.check(items.length > 0 || !pageInfo.hasNext, "pageInfo.hasNext", "an empty page must be final");
    this.check(!pageInfo.hasNext || pageInfo.endCursor !== null, "pageInfo.endCursor", "a non-final page requires a cursor");
    this.check(!pageInfo.hasNext || pageInfo.totalItems > items.length, "pageInfo.totalItems", "a non-final page requires remaining items");
  }

  executions() {
    const { items, relations, endpoints, measurements, pageInfo, selectedFlowVersion } = this.response;
    this.page(items, pageInfo);
    this.unique(items.map((item) => item.id), "items.id");
    this.unique(relations.map((relation) => relation.id), "relations.id");
    this.unique(endpoints.map((endpoint) => endpoint.ref.id), "endpoints.ref.id");
    const measured = new Map(measurements.map((measurement) => [measurement.measurementId, measurement]));
    this.check(measured.size === measurements.length, "measurements", "measurement identities must be unique");
    const references = new Map([...items.map((item) => [item.id, item.kind]), ...endpoints.map((endpoint) => [endpoint.ref.id, endpoint.ref.kind])]);
    for (const relation of relations) for (const reference of [relation.from, relation.to]) {
      this.check(references.get(reference.id) === reference.kind, "relations", "each endpoint must resolve to an item or endpoint of the same kind");
      this.check(items.some((item) => item.id === relation.from.id || item.id === relation.to.id), "relations", "a relation must touch a page item");
    }
    this.check(items.every((item, index) => index === 0 || Buffer.compare(Buffer.from(items[index - 1].id), Buffer.from(item.id)) < 0), "items.id", "must be in ascending UTF-8 byte order");
    for (const item of items) {
      this.check(item.binding.specId === selectedFlowVersion.specId, "items.binding.specId", "must match the selected Spec");
      if (item.kind === "provider-attempt" && item.usageRef !== null) {
        const measurement = measured.get(item.usageRef);
        this.check(measurement?.subjectRef.kind === item.kind && measurement?.subjectRef.id === item.id, "items.usageRef", "must resolve to this provider attempt's measurement");
      }
      if (item.kind === "agent-invocation") {
        this.check(item.status !== "received" || item.response.receivedAt !== null && item.response.receiverObservationRef !== null, "items.response", "received requires durable receiver evidence");
      }
    }
  }

  activities() {
    const { items, entities, pageInfo, snapshot, completeness } = this.response;
    this.unique(items.map((item) => item.activity.id), "items.activity.id");
    this.unique(items.map((item) => item.confirmationOrder), "items.confirmationOrder");
    this.check(items.every((item, index) => index === 0 || items[index - 1].confirmationOrder < item.confirmationOrder), "items.confirmationOrder", "must be ascending");
    this.check(items.every((item) => item.confirmationOrder <= snapshot.confirmationOrder), "items.confirmationOrder", "must not exceed the snapshot confirmed prefix");
    this.page(items, pageInfo);
    const groupIds = new Map(DETAIL_GROUPS.map((group) => [group, this.unique(entities[group].map((entity) => entity.id), `entities.${group}`)]));
    const all = new Map();
    for (const group of DETAIL_GROUPS) {
      for (const entity of entities[group]) {
        this.check(!all.has(entity.id), `entities.${group}`, "identity must be unique across detail groups");
        all.set(entity.id, entity);
        this.entity(entity, `${group}(${entity.id})`);
        for (const targetGroup of DETAIL_GROUPS) {
          for (const id of entity[DETAIL_ID_FIELDS[targetGroup]]) this.check(groupIds.get(targetGroup).has(id), `${group}(${entity.id}).${DETAIL_ID_FIELDS[targetGroup]}`, "must resolve in the corresponding entity group");
        }
      }
    }
    const roots = [];
    for (const item of items) {
      const path = `activity(${item.activity.id})`;
      if (item.timing !== null) for (const field of ["startedAt", "finishedAt"]) this.check(isFlowQueryDatetime(item.timing[field]), `${path}.timing.${field}`, "must be a recorded datetime");
      if (item.outcome !== null) this.check(isFlowQueryDatetime(item.outcome.confirmedAt), `${path}.outcome.confirmedAt`, "must be a recorded datetime");
      this.unique(item.artifactIds, `${path}.artifactIds`);
      for (const group of DETAIL_GROUPS) {
        const refs = item.detailRefs[group];
        const coverage = item.detailCoverage[group];
        const bindings = item.referenceBindings[group];
        this.unique(refs, `${path}.detailRefs.${group}`);
        this.unique(item[DETAIL_ID_FIELDS[group]], `${path}.${DETAIL_ID_FIELDS[group]}`);
        this.sameIds(bindings.map((binding) => binding.reference.id), item[DETAIL_ID_FIELDS[group]], `${path}.referenceBindings.${group}`);
        this.check(coverage.count === refs.length, `${path}.detailCoverage.${group}.count`, "must equal the direct detail reference count");
        for (const id of refs) this.check(groupIds.get(group).has(id), `${path}.detailRefs.${group}`, "must resolve in the corresponding entity group");
        for (const binding of bindings) {
          this.unique(binding.detailIds, `${path}.referenceBindings.${group}.detailIds`);
          this.check(binding.detailIds.length > 0 && binding.detailIds.every((id) => refs.includes(id)), `${path}.referenceBindings.${group}.detailIds`, "must resolve to direct detail references");
        }
        if (coverage.availability !== "available") this.check(refs.length === 0 && bindings.length === 0, `${path}.detailCoverage.${group}`, "unrecorded or inapplicable detail must not carry references");
        roots.push(...refs);
      }
    }
    const reached = new Set();
    while (roots.length > 0) {
      const id = roots.pop();
      if (reached.has(id)) continue;
      const entity = all.get(id);
      if (!entity) continue;
      reached.add(id);
      for (const field of Object.values(DETAIL_ID_FIELDS)) roots.push(...entity[field]);
    }
    this.check(reached.size === all.size, "entities", "must equal the transitive detail reference closure");
    this.check(completeness.details === detailCompletenessFor(items), "completeness.details", "must describe the returned detail coverage");
  }
}
