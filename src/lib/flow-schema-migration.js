import { CURRENT_FLOW_SCHEMA_REVISION } from "./flow-schema-revision.js";

/** Explicit migration-only projection; ordinary readers remain current-only. */
export class PreviousFlowSchemaProjection {
  static project(value) {
    if (value.schemaRevision !== 4) return value;
    if (CURRENT_FLOW_SCHEMA_REVISION !== 5) {
      throw new Error("previous Flow projection requires the schema-five migration target");
    }
    const projected = structuredClone(value);
    projected.schemaRevision = CURRENT_FLOW_SCHEMA_REVISION;
    if (projected.migration !== null) {
      if (projected.migration.baseline?.schemaRevision !== 4) {
        throw new Error("UNSAFE_SOURCE_FORMAT: previous Flow has no schema-four migration baseline");
      }
      projected.migration.baseline.schemaRevision = CURRENT_FLOW_SCHEMA_REVISION;
    }
    return projected;
  }
}
