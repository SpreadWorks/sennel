import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/**
 * Catalog-backed inputs for the report producer.
 *
 * Report rendering predates Flow Version 1 and used to discover sibling
 * files below a mutable spec directory.  This adapter deliberately exposes
 * only typed, consumer-authorized reads.  It gives the report command a
 * small durable view without introducing another report-specific layout or
 * serializer.
 */

import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";

function requiredObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}
function json(bytes, field) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${field} bytes must be a Buffer`);
  try {
    return requiredObject(JSON.parse(bytes.toString("utf8")), field);
  } catch (error) {
    throw new Error(`${field} must be JSON: ${error.message}`);
  }
}

function canonicalState(state) {
  if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof state.specId !== "string" || state.specId === "") {
    throw new Error("CanonicalReportArtifactStore requires a Version-1 Flow state");
  }
  return state;
}

/** One catalog-resolved JSON document, including its authoritative path. */
export class CanonicalReportDocument {
  constructor({ logicalKey, relativePath, value } = {}) {
    if (typeof logicalKey !== "string" || logicalKey === "") {
      throw new Error("canonical report document logicalKey is required");
    }
    if (typeof relativePath !== "string" || relativePath === "") {
      throw new Error("canonical report document relativePath is required");
    }
    this.logicalKey = logicalKey;
    this.relativePath = relativePath;
    this.value = Object.freeze(structuredClone(requiredObject(value, `canonical ${logicalKey}`)));
    Object.freeze(this);
  }
}

/**
 * Deep report-facing adapter over FlowManager.  There is intentionally no
 * legacy branch: callers choose this object only after loading exact V1
 * state, and every returned path originated in the artifact catalog.
 */
export class CanonicalReportArtifactStore {
  constructor({ flowManager, state } = {}) {
    if (!flowManager || typeof flowManager.readArtifact !== "function") {
      throw new Error("CanonicalReportArtifactStore requires FlowManager.readArtifact");
    }
    this.flowManager = flowManager;
    this.state = canonicalState(state);
    this.specId = this.state.specId;
    Object.freeze(this);
  }

  readDocument({ logicalKey, consumerNodeId = "report", parameters = {}, optional = false } = {}) {
    const resolved = this.flowManager.readArtifact({
      specId: this.specId,
      logicalKey,
      parameters,
      consumerNodeId,
      optional,
    });
    if (resolved === null) return null;
    return new CanonicalReportDocument({
      logicalKey,
      relativePath: resolved.relativePath,
      value: json(resolved.bytes, `canonical ${logicalKey}`),
    });
  }

  readCurrentAttempt({ logicalKey, consumerNodeId = "report", parameters = {}, optional = false } = {}) {
    const document = this.readDocument({ logicalKey, consumerNodeId, parameters, optional });
    if (document === null) return null;
    const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
      logicalKey,
      bytes: Buffer.from(`${JSON.stringify(document.value)}\n`, "utf8"),
    });
    return Object.freeze({
      logicalKey,
      relativePath: document.relativePath,
      attempt: history.current.attempt,
      value: history.current.payload,
    });
  }
}
