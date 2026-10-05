import { validateSchema } from "../lib/schema-validate.js";

export const FLOW_QUERY_SCHEMA_REVISION = 1;
export const FLOW_QUERY_HELP = [
  "Usage: sennel flow query [--request-file <path>]",
  "",
  "Read canonical Flow Version metadata or confirmed Activities as one JSON response.",
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

export const FLOW_QUERY_RESOURCES = Object.freeze(["metadata", "activities"]);

export const FLOW_QUERY_ERROR_CODES = Object.freeze({
  INVALID_JSON: "INVALID_JSON",
  INVALID_REQUEST: "INVALID_REQUEST",
  SPEC_NOT_FOUND: "SPEC_NOT_FOUND",
  FLOW_VERSION_NOT_FOUND: "FLOW_VERSION_NOT_FOUND",
  CANONICAL_RECORD_UNREADABLE: "CANONICAL_RECORD_UNREADABLE",
  CANONICAL_RECORD_INCONSISTENT: "CANONICAL_RECORD_INCONSISTENT",
  INVALID_CURSOR: "INVALID_CURSOR",
  CURSOR_QUERY_MISMATCH: "CURSOR_QUERY_MISMATCH",
});

export const FLOW_QUERY_ERROR_PATHS = Object.freeze({
  INVALID_JSON: "/request",
  INVALID_REQUEST: null,
  SPEC_NOT_FOUND: "/condition/specId",
  FLOW_VERSION_NOT_FOUND: "/condition/flowVersion",
  CANONICAL_RECORD_UNREADABLE: "/canonical",
  CANONICAL_RECORD_INCONSISTENT: "/canonical",
  INVALID_CURSOR: "/page/after",
  CURSOR_QUERY_MISMATCH: "/page/after",
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

const nonNegativeInteger = () => Object.freeze({ type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER });
const publicString = Object.freeze({ type: "string", maxLength: FLOW_QUERY_LIMITS.MAX_PUBLIC_STRING_BYTES });
const nullable = (schema) => Object.freeze({ ...schema, type: [schema.type, "null"] });
const exactObject = (properties) => Object.freeze({
  type: "object",
  required: Object.keys(properties),
  properties,
  additionalProperties: false,
});
const publicStringList = (maxItems = FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS) => Object.freeze({ type: "array", maxItems, items: publicString });

const selectedFlowVersion = Object.freeze({
  type: "object",
  required: ["specId", "flowVersion"],
  properties: { specId: { ...publicString, minLength: 1 }, flowVersion: positiveInteger() },
  additionalProperties: false,
});

const availableFlowVersions = Object.freeze({ type: "array", maxItems: FLOW_QUERY_LIMITS.MAX_AVAILABLE_FLOW_VERSIONS, items: positiveInteger() });

const queryError = Object.freeze({
  type: "object",
  required: ["code", "path", "message"],
  properties: {
    code: { type: "string", enum: Object.values(FLOW_QUERY_ERROR_CODES) },
    path: { ...publicString, minLength: 1, pattern: "^/" },
    message: publicString,
  },
  additionalProperties: false,
});

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

const idKey = exactObject({ id: publicString, key: publicString });
const blocker = exactObject({ code: publicString, message: publicString });
const timestamp = exactObject({
  value: nullable(publicString), availability: { type: "string", enum: ["available", "unavailable"] }, reason: nullable(publicString), provenance: nullable(publicString),
});
const artifactDescriptorView = exactObject({
  artifactId: publicString,
  metadata: exactObject({ logicalKey: nullable(publicString), schemaRevision: nullable(positiveInteger()), mediaType: nullable(publicString) }),
  activityIds: publicStringList(FLOW_QUERY_LIMITS.MAX_IDS_PER_ARTIFACT),
  nodeIds: publicStringList(FLOW_QUERY_LIMITS.MAX_IDS_PER_ARTIFACT),
  taskIds: publicStringList(FLOW_QUERY_LIMITS.MAX_IDS_PER_ARTIFACT),
});
const aggregateMetrics = exactObject({
  activityCount: nonNegativeInteger(), artifactCount: nonNegativeInteger(), stepCount: nonNegativeInteger(), taskCount: nonNegativeInteger(),
  durationMs: nullable(nonNegativeInteger()), inputTokens: nullable(nonNegativeInteger()), outputTokens: nullable(nonNegativeInteger()), cacheReadTokens: nullable(nonNegativeInteger()), cost: { type: ["number", "null"], minimum: 0 },
  provenance: exactObject({
    activityCount: publicString, artifactCount: publicString, stepCount: publicString, taskCount: publicString,
    durationMs: publicString, inputTokens: publicString, outputTokens: publicString, cacheReadTokens: publicString, cost: publicString,
  }),
});
const metadataItem = exactObject({
  identity: exactObject({ flowId: publicString, flowVersionId: publicString, runId: publicString, specId: publicString, flowVersion: positiveInteger() }),
  lifecycle: exactObject({
    lifecycle: { type: "string", enum: ["active", "parked", "finalized"] },
    blocked: { type: "boolean" }, blocker: nullable(blocker),
    nextAction: nullable(exactObject({ operation: publicString, phase: nullable(publicString), stepId: nullable(publicString), taskId: nullable(publicString) })),
  }),
  location: exactObject({
    phase: nullable(publicString), stepId: nullable(publicString), taskId: nullable(publicString),
    git: exactObject({ available: { type: "boolean" }, commit: nullable(publicString) }),
  }),
  structure: exactObject({ phaseId: publicString, stepIds: publicStringList(), taskIds: publicStringList() }),
  relationships: exactObject({
    stepTasks: { type: "array", maxItems: FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS, items: exactObject({ stepId: publicString, taskId: publicString }) },
    taskNodes: { type: "array", maxItems: FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS, items: exactObject({ taskId: publicString, nodeId: publicString }) },
    issues: { type: "array", maxItems: 1, items: exactObject({ number: positiveInteger(), relationship: { type: "string", enum: ["tracks"] } }) },
  }),
  timestamps: exactObject({ createdAt: timestamp, updatedAt: timestamp, finalizedAt: timestamp }),
  capabilities: { type: "object", additionalProperties: { type: "boolean" } },
  artifacts: { type: "array", maxItems: FLOW_QUERY_LIMITS.MAX_ARTIFACTS, items: artifactDescriptorView },
  metrics: aggregateMetrics,
});
const activityItem = exactObject({
  activity: exactObject({ id: publicString, type: publicString }),
  node: exactObject({ id: publicString, key: publicString }),
  task: nullable(idKey), attempt: nullable(exactObject({ id: publicString, sequence: positiveInteger() })),
  sequence: nullable(positiveInteger()), confirmationOrder: positiveInteger(),
  transition: exactObject({ operation: publicString, status: nullable(publicString) }),
  timing: nullable(exactObject({ startedAt: publicString, finishedAt: publicString, durationMs: nullable(nonNegativeInteger()) })),
  usage: nullable(exactObject({ inputTokens: nonNegativeInteger(), outputTokens: nonNegativeInteger(), cacheReadTokens: nonNegativeInteger(), cost: { type: ["number", "null"], minimum: 0 } })),
  outcome: nullable(exactObject({
    outcome: { type: "string", enum: ["passed", "failed", "skipped", "incomplete"] }, confirmedAt: publicString, summary: publicString,
    artifactRefs: { type: "array", maxItems: FLOW_QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS, items: exactObject({ kind: publicString, id: publicString }) },
  })),
  failure: nullable(exactObject({ category: publicString, code: publicString, message: publicString, retryable: { type: "boolean" }, retryKind: { ...nullable(publicString), enum: ["semantic", "tooling", null] } })),
  blocker: nullable(blocker),
  incomplete: nullable(exactObject({ code: publicString, message: publicString, operation: nullable(publicString), resources: publicStringList() })),
  metric: nullable(exactObject({
    phase: publicString, counter: nullable(publicString), delta: nullable(nonNegativeInteger()), reset: { type: "boolean" },
    kind: nullable(publicString), provider: nullable(publicString), profileKey: nullable(publicString), callCount: nullable(nonNegativeInteger()), responseChars: nullable(nonNegativeInteger()), durationMs: nullable(nonNegativeInteger()), model: nullable(publicString),
    tokens: nullable(exactObject({ input: nonNegativeInteger(), output: nonNegativeInteger(), cacheRead: nonNegativeInteger(), cacheCreation: nonNegativeInteger() })),
    cost: { type: ["number", "null"], minimum: 0 }, cachedResponse: { type: "boolean" }, costIncomplete: { type: "boolean" },
  })),
  note: nullable(publicString), evaluationIds: publicStringList(), findingIds: publicStringList(), repairIds: publicStringList(), artifactIds: publicStringList(),
});

export const FLOW_QUERY_REQUEST_SCHEMAS = Object.freeze({
  metadata: Object.freeze({
    type: "object",
    required: ["resource", "condition"],
    properties: { resource: { type: "string", enum: ["metadata"] }, condition },
    additionalProperties: false,
  }),
  activities: Object.freeze({
    type: "object",
    required: ["resource", "condition", "page"],
    properties: { resource: { type: "string", enum: ["activities"] }, condition, page: page(FLOW_QUERY_LIMITS.MAX_PAGE_LIMIT), recordedAt },
    additionalProperties: false,
  }),
});

export const FLOW_QUERY_REQUEST_SCHEMA = Object.freeze({ oneOf: Object.values(FLOW_QUERY_REQUEST_SCHEMAS) });

function commonResponseProperties() {
  return {
    schemaRevision: { type: "integer", enum: [FLOW_QUERY_SCHEMA_REVISION] },
    ok: { type: "boolean" },
  };
}

const responsePageInfo = (allowNullLimit) => Object.freeze({
  type: "object",
  required: ["limit", "endCursor", "hasNext"],
  properties: {
    limit: allowNullLimit ? { type: ["integer", "null"], minimum: 1, maximum: FLOW_QUERY_LIMITS.MAX_PAGE_LIMIT } : positiveInteger(FLOW_QUERY_LIMITS.MAX_PAGE_LIMIT),
    endCursor: nullable(publicString),
    hasNext: { type: "boolean" },
  },
  additionalProperties: false,
});

function knownResponseProperties(resource, payload) {
  return {
    ...commonResponseProperties(),
    resource: { type: "string", enum: [resource] },
    selectedFlowVersion: { ...selectedFlowVersion, type: ["object", "null"] },
    availableFlowVersions,
    ...payload,
  };
}

const metadataSuccess = Object.freeze({
  type: "object",
  required: ["schemaRevision", "ok", "resource", "selectedFlowVersion", "availableFlowVersions", "item"],
  properties: knownResponseProperties("metadata", {
    ok: { type: "boolean", enum: [true] }, selectedFlowVersion, item: metadataItem,
  }),
  additionalProperties: false,
});

const activitiesSuccess = Object.freeze({
  type: "object",
  required: ["schemaRevision", "ok", "resource", "selectedFlowVersion", "availableFlowVersions", "items", "pageInfo"],
  properties: knownResponseProperties("activities", {
    ok: { type: "boolean", enum: [true] }, selectedFlowVersion, items: { type: "array", maxItems: FLOW_QUERY_LIMITS.MAX_PAGE_LIMIT, items: activityItem }, pageInfo: responsePageInfo(false),
  }),
  additionalProperties: false,
});

const metadataError = Object.freeze({
  type: "object",
  required: ["schemaRevision", "ok", "resource", "selectedFlowVersion", "availableFlowVersions", "error", "item"],
  properties: knownResponseProperties("metadata", {
    ok: { type: "boolean", enum: [false] }, error: queryError, item: { type: "null" },
  }),
  additionalProperties: false,
});

const activitiesError = Object.freeze({
  type: "object",
  required: ["schemaRevision", "ok", "resource", "selectedFlowVersion", "availableFlowVersions", "error", "items", "pageInfo"],
  properties: knownResponseProperties("activities", {
    ok: { type: "boolean", enum: [false] }, error: queryError, items: { type: "array", maxItems: 0 }, pageInfo: responsePageInfo(true),
  }),
  additionalProperties: false,
});

const unknownResourceError = Object.freeze({
  type: "object",
  required: ["schemaRevision", "ok", "error"],
  properties: { ...commonResponseProperties(), ok: { type: "boolean", enum: [false] }, error: queryError },
  additionalProperties: false,
});

export const FLOW_QUERY_RESPONSE_SCHEMA = Object.freeze({
  oneOf: [metadataSuccess, activitiesSuccess, metadataError, activitiesError, unknownResourceError],
});

function responseVariant(value) {
  if (value?.ok === true && value.resource === "metadata") return metadataSuccess;
  if (value?.ok === true && value.resource === "activities") return activitiesSuccess;
  if (value?.ok === false && value.resource === "metadata") return metadataError;
  if (value?.ok === false && value.resource === "activities") return activitiesError;
  if (value?.ok === false && !Object.hasOwn(value ?? {}, "resource")) return unknownResourceError;
  return FLOW_QUERY_RESPONSE_SCHEMA;
}

export function validateFlowQueryRequest(value) {
  const schema = FLOW_QUERY_REQUEST_SCHEMAS[value?.resource] ?? FLOW_QUERY_REQUEST_SCHEMA;
  return validateSchema(value, schema);
}

export function validateFlowQueryResponse(value) {
  const errors = validateSchema(value, responseVariant(value));
  if (errors.length > 0 || value?.ok !== false) return errors;
  const expectedPath = FLOW_QUERY_ERROR_PATHS[value.error?.code];
  if (expectedPath !== null && expectedPath !== undefined && value.error.path !== expectedPath) {
    errors.push(`error.path: must be ${expectedPath} for ${value.error.code}`);
  }
  return errors;
}
