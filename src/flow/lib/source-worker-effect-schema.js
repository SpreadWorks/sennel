import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../schemas/next-action",
);

const SCHEMA_REF_BY_STEP = Object.freeze({
  implement: "next-action/source-worker-effect-implement.schema.json",
  "impl-triage": "next-action/source-worker-effect-impl-triage.schema.json",
  "impl-repair": "next-action/source-worker-effect-impl-repair.schema.json",
  "task-triage": "next-action/source-worker-effect-task-triage.schema.json",
  "task-repair": "next-action/source-worker-effect-task-repair.schema.json",
  "task-impl": "next-action/source-worker-effect-task-impl.schema.json",
});
const schemaCache = new Map();

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The definition-owned output schema reference for one source worker step. */
export function sourceWorkerEffectSchemaRef(stepId) {
  const ref = SCHEMA_REF_BY_STEP[stepId];
  if (!ref) throw new Error(`source worker effect schema is unsupported for ${stepId}`);
  return ref;
}

/**
 * Load the actual schema artifact shared by Definition projection, provider
 * structured output, and parent materialization validation.
 */
export function sourceWorkerEffectJsonSchema(stepId) {
  const ref = sourceWorkerEffectSchemaRef(stepId);
  let schema = schemaCache.get(ref);
  if (!schema) {
    schema = deepFreeze(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIRECTORY, path.basename(ref)), "utf8")));
    schemaCache.set(ref, schema);
  }
  return schema;
}
