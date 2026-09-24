import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
import { CanonicalRequirementDefinitions } from "./canonical-requirement-definitions.js";

/**
 * Catalog-authorized view of the canonical spec record for one Flow Version.
 * Consumers receive a detached document and never reconstruct a filesystem
 * path to spec.json.
 */
export class CanonicalSpecRecord {
  constructor({ flowManager, state, consumerNodeId = "system" } = {}) {
    if (!flowManager || typeof flowManager.readArtifact !== "function") {
      throw new Error("canonical spec record requires FlowManager.readArtifact");
    }
    if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof state.specId !== "string" || state.specId === "") {
      throw new Error("canonical spec record requires a Version-1 Flow state");
    }
    if (typeof consumerNodeId !== "string" || consumerNodeId === "") {
      throw new Error("canonical spec record consumer nodeId must be a non-empty string");
    }
    this.flowManager = flowManager;
    this.specId = state.specId;
    this.consumerNodeId = consumerNodeId;
    Object.freeze(this);
  }

  document() {
    const resolved = this.flowManager.readArtifact({
      specId: this.specId,
      logicalKey: "spec.record",
      consumerNodeId: this.consumerNodeId,
    });
    const document = JSON.parse(resolved.bytes.toString("utf8"));
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("canonical spec record must contain an object");
    }
    return structuredClone(document);
  }

  requirements() {
    const { requirements } = this.document();
    if (!Array.isArray(requirements)) return [];
    return new CanonicalRequirementDefinitions(requirements).toJSON();
  }
}
