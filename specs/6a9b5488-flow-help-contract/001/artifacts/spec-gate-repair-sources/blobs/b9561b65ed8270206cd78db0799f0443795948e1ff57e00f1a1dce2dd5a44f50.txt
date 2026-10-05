import { isDeepStrictEqual } from "node:util";

import {
  ActivityItem,
  AggregateMetrics,
  ArtifactDescriptorView,
  MetadataItem,
} from "../../../src/flow/query.js";
import {
  FLOW_QUERY_LIMITS,
  FLOW_QUERY_SCHEMA_REVISION,
  validateFlowQueryResponse,
} from "../../../src/flow/query-contract.js";

function exactKeys(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unsupported shape`);
  }
}

function selectedVersion(value) {
  exactKeys(value, ["specId", "flowVersion"], "selectedFlowVersion");
  if (typeof value.specId !== "string" || !Number.isSafeInteger(value.flowVersion) || value.flowVersion < 1) {
    throw new Error("selectedFlowVersion is invalid");
  }
  return Object.freeze({ specId: value.specId, flowVersion: value.flowVersion });
}

function availableVersions(value) {
  if (!Array.isArray(value) || value.length > FLOW_QUERY_LIMITS.MAX_AVAILABLE_FLOW_VERSIONS) {
    throw new Error("availableFlowVersions is invalid");
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Number.isSafeInteger(value[index]) || value[index] < 1 || (index > 0 && value[index - 1] >= value[index])) {
      throw new Error("availableFlowVersions must be ascending positive safe integers");
    }
  }
  return Object.freeze([...value]);
}

function metadataItem(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("metadata item is invalid");
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.map((artifact) => new ArtifactDescriptorView(artifact))
    : value.artifacts;
  const metrics = value.metrics === null || value.metrics === undefined ? value.metrics : new AggregateMetrics(value.metrics);
  const normalized = new MetadataItem({ ...value, artifacts, metrics }).toJSON();
  if (!isDeepStrictEqual(normalized, value)) throw new Error("metadata item changed during compatibility round-trip");
  return normalized;
}

function activityItems(values) {
  return values.map((item) => new ActivityItem(item).toJSON());
}

/**
 * Minimal Workspace/Connector-style consumer for the public query boundary.
 * It deliberately retains only public response values and never reads a
 * canonical record, filesystem path, or generic Flow envelope.
 */
export class FlowQueryCompatibilityResult {
  constructor({ resource, selectedFlowVersion: selected, availableFlowVersions: available, item = null, items = null, page = null, error = null } = {}) {
    this.resource = resource;
    this.selectedFlowVersion = selected;
    this.availableFlowVersions = available;
    this.item = item;
    this.items = items;
    this.pageInfo = page;
    this.error = error;
    Object.freeze(this);
  }
}

export class FlowQueryConsumer {
  constructor({ supportedSchemaRevision = FLOW_QUERY_SCHEMA_REVISION } = {}) {
    this.supportedSchemaRevision = supportedSchemaRevision;
    Object.freeze(this);
  }

  consumeSerialized(serialized) {
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > FLOW_QUERY_LIMITS.MAX_RESPONSE_BYTES) {
      throw new Error("serialized query response exceeds the response limit");
    }
    try {
      return this.consume(JSON.parse(serialized));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("serialized query response is not JSON", { cause: error });
      throw error;
    }
  }

  consume(response) {
    if (response === null || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("query response must be an object");
    }
    if (response.schemaRevision !== this.supportedSchemaRevision) {
      throw new Error(`unsupported query schema revision: ${response.schemaRevision}`);
    }
    const errors = validateFlowQueryResponse(response);
    if (errors.length > 0) throw new Error(`query response does not match the query contract: ${errors[0]}`);
    if (response.ok === true) return this.success(response);
    if (response.ok === false) return this.error(response);
    throw new Error("query response status is invalid");
  }

  success(response) {
    const selected = selectedVersion(response.selectedFlowVersion);
    const available = availableVersions(response.availableFlowVersions);
    if (response.resource === "metadata") {
      return new FlowQueryCompatibilityResult({ resource: response.resource, selectedFlowVersion: selected, availableFlowVersions: available, item: metadataItem(response.item) });
    }
    if (!Array.isArray(response.items)
      || response.items.length > FLOW_QUERY_LIMITS.MAX_PAGE_LIMIT
      || response.items.length > response.pageInfo.limit) {
      throw new Error("activities response items are invalid");
    }
    return new FlowQueryCompatibilityResult({ resource: response.resource, selectedFlowVersion: selected, availableFlowVersions: available, items: Object.freeze(activityItems(response.items)), page: Object.freeze({ ...response.pageInfo }) });
  }

  error(response) {
    if (!Object.hasOwn(response, "resource")) {
      return new FlowQueryCompatibilityResult({ resource: null, selectedFlowVersion: null, availableFlowVersions: Object.freeze([]), error: response.error });
    }
    const selected = response.selectedFlowVersion === null ? null : selectedVersion(response.selectedFlowVersion);
    const available = availableVersions(response.availableFlowVersions);
    if (response.resource === "metadata") {
      return new FlowQueryCompatibilityResult({ resource: response.resource, selectedFlowVersion: selected, availableFlowVersions: available, error: response.error });
    }
    return new FlowQueryCompatibilityResult({ resource: response.resource, selectedFlowVersion: selected, availableFlowVersions: available, items: Object.freeze([]), page: Object.freeze({ ...response.pageInfo }), error: response.error });
  }
}
