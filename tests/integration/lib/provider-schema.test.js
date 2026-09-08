import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectFlowLeafIds,
  collectTaskLeafIds,
  deriveNextAction,
} from "../../../src/flow/definition.js";
import { loadSpecJsonSchema } from "../../../src/lib/spec-json.js";
import {
  adaptJsonSchemaForProvider,
  CodexJsonSchema,
} from "../../../src/lib/provider-schema.js";
import {
  sourceWorkerEffectJsonSchema,
  sourceWorkerEffectSchemaRef,
} from "../../../src/flow/lib/source-worker-effect-schema.js";
import { WORKER_SOURCE_HANDOFF_STEPS } from "../../../src/flow/lib/flow-artifact-authority.js";

const FLOW_SCHEMA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/flow/schemas",
);
const UNSUPPORTED_CODEX_KEYWORDS = new Set([
  "allOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
  "unevaluatedProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "contains",
  "minContains",
  "maxContains",
  "uniqueItems",
  "prefixItems",
]);

function hasType(schema, type) {
  return schema.type === type
    || (Array.isArray(schema.type) && schema.type.includes(type));
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (value && typeof value === "object") return "object";
  return typeof value;
}

function typeAccepts(schema, value) {
  const actual = valueType(value);
  return hasType(schema, actual) || (actual === "integer" && hasType(schema, "number"));
}

function assertCodexCompatible(schema) {
  assert.equal(schema.type, "object", "provider schema root must be an object");
  assert.equal(schema.anyOf, undefined, "provider schema root must not use anyOf");

  function walk(node, location = "$") {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const keyword of UNSUPPORTED_CODEX_KEYWORDS) {
      assert.equal(Object.hasOwn(node, keyword), false, `${location} uses unsupported ${keyword}`);
    }
    if (Object.hasOwn(node, "const")) {
      assert.equal(typeAccepts(node, node.const), true, `${location}.const has no compatible type`);
    }
    if (Array.isArray(node.enum)) {
      assert.ok(node.enum.length > 0, `${location}.enum must not be empty`);
      for (const value of node.enum) {
        assert.equal(typeAccepts(node, value), true, `${location}.enum has no compatible type`);
      }
    }
    if (hasType(node, "object")) {
      const keys = Object.keys(node.properties || {}).sort();
      assert.deepEqual([...(node.required || [])].sort(), keys, `${location} properties must all be required`);
      assert.equal(node.additionalProperties, false, `${location} must reject additional properties`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" || key === "required") continue;
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${location}.${key}[${index}]`));
      } else {
        walk(value, `${location}.${key}`);
      }
    }
  }
  walk(schema);
}

function allowsNull(schema) {
  if (hasType(schema, "null")) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.some(allowsNull);
}

function assertOptionalPropertiesAreNullable(canonical, strict, location = "$") {
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) return;
  if (canonical.properties && typeof canonical.properties === "object") {
    const canonicalRequired = new Set(canonical.required || []);
    for (const [key, child] of Object.entries(canonical.properties)) {
      const strictChild = strict.properties[key];
      if (!canonicalRequired.has(key)) {
        assert.equal(allowsNull(strictChild), true, `${location}.${key} must be nullable`);
      }
      assertOptionalPropertiesAreNullable(child, strictChild, `${location}.${key}`);
    }
  }
  if (canonical.items && strict.items) {
    assertOptionalPropertiesAreNullable(canonical.items, strict.items, `${location}[]`);
  }
}

function productionOutputSchemaRefs() {
  const refs = new Set();
  for (const [scope, stepIds] of [
    ["flow", collectFlowLeafIds()],
    ["task", collectTaskLeafIds()],
  ]) {
    for (const stepId of stepIds) {
      const ref = deriveNextAction({ scope, stepId }).outputSchemaRef;
      if (ref) refs.add(ref);
    }
  }
  return [...refs].sort();
}

function loadFlowSchema(ref) {
  return JSON.parse(fs.readFileSync(path.join(FLOW_SCHEMA_DIR, ref), "utf8"));
}

describe("provider JSON schema adaptation", () => {
  it("makes the canonical spec schema compatible with Codex strict output", () => {
    const canonical = loadSpecJsonSchema();
    const strict = adaptJsonSchemaForProvider("codex", canonical);

    assertCodexCompatible(strict);
    const modules = strict.properties.overview.properties.modules.items;
    assert.ok(modules.required.includes("added_by_task"));
    assert.deepEqual(modules.properties.added_by_task.type, ["string", "null"]);
    assert.deepEqual(canonical.properties.overview.properties.modules.items.required, ["text"]);
  });

  it("normalizes every production output schema referenced by definition.js", () => {
    const refs = productionOutputSchemaRefs();
    assert.ok(refs.length > 0, "definition.js must declare production output schemas");

    for (const ref of refs) {
      const canonical = loadFlowSchema(ref);
      const before = JSON.stringify(canonical);
      const strict = adaptJsonSchemaForProvider("codex", canonical);
      assertCodexCompatible(strict);
      assertOptionalPropertiesAreNullable(canonical, strict);
      assert.equal(JSON.stringify(canonical), before, `${ref} canonical schema mutated`);
    }
  });

  it("types the sealed worker report const and preserves optional runtimeLog with null", () => {
    const canonical = loadFlowSchema("next-action/worker-artifact-handoff.schema.json");
    const strict = adaptJsonSchemaForProvider("codex", canonical);

    assert.deepEqual(strict.properties.sealed, { const: true, type: "boolean" });
    assert.ok(strict.required.includes("runtimeLog"));
    assert.deepEqual(strict.properties.runtimeLog.type, ["object", "null"]);
    assert.equal(strict.properties.runtimeLog.additionalProperties, false);
  });

  it("keeps every source worker response schema artifact aligned with the registry", () => {
    const steps = ["implement", "impl-triage", "impl-repair", "task-impl", "task-triage", "task-repair"];
    const rootKeys = ["completionStatus", "files", "issues", "noChangeReason", "overview", "repair", "stepId", "triage", "version"];
    for (const stepId of steps) {
      const ref = sourceWorkerEffectSchemaRef(stepId);
      const artifact = loadFlowSchema(ref);
      const schema = sourceWorkerEffectJsonSchema(stepId);
      assert.deepEqual(schema, artifact, `${stepId} registry must load its definition artifact`);
      assert.deepEqual([...schema.required].sort(), rootKeys, `${stepId} must preserve the common effect envelope`);
      assertCodexCompatible(adaptJsonSchemaForProvider("codex", schema));
    }
  });

  it("uses one source step set for authority, definition, and response schemas", () => {
    const sourceSteps = [...WORKER_SOURCE_HANDOFF_STEPS].sort();
    assert.deepEqual(sourceSteps, ["impl-repair", "impl-triage", "implement", "task-impl", "task-repair", "task-triage"]);
    for (const stepId of sourceSteps) {
      const scope = stepId.startsWith("task-") ? "task" : "flow";
      assert.equal(
        deriveNextAction({ scope, stepId }).outputSchemaRef,
        sourceWorkerEffectSchemaRef(stepId),
        `${stepId} definition must use the registry-owned schema reference`,
      );
    }
  });

  it("recursively normalizes constrained optional values and supported combinators", () => {
    const canonical = {
      type: "object",
      required: ["sealed", "choice"],
      properties: {
        sealed: { const: true },
        choice: { enum: ["one", "two"] },
        optionalConst: { const: "present" },
        optionalPretypedConst: { type: ["string", "null"], const: "present" },
        optionalEnum: { enum: ["red", "blue"] },
        optionalPretypedEnum: { type: ["string", "null"], enum: ["red", "blue"] },
        optionalAny: { anyOf: [{ const: "text" }, { enum: [1, 2] }] },
        optionalSiblingAny: { type: "string", anyOf: [{ enum: ["text"] }] },
        optionalOne: { oneOf: [{ const: "exclusive" }, { const: 7 }] },
        optionalAll: { allOf: [{ type: "string", minLength: 1 }, { type: "string", maxLength: 10 }] },
      },
    };
    const before = structuredClone(canonical);
    const strict = new CodexJsonSchema(canonical).toJSON();

    assertCodexCompatible(strict);
    assert.deepEqual(strict.properties.sealed, { const: true, type: "boolean" });
    assert.deepEqual(strict.properties.choice, { enum: ["one", "two"], type: "string" });
    for (const key of [
      "optionalConst",
      "optionalPretypedConst",
      "optionalEnum",
      "optionalPretypedEnum",
      "optionalAny",
      "optionalSiblingAny",
      "optionalOne",
      "optionalAll",
    ]) {
      assert.ok(strict.required.includes(key));
      assert.equal(allowsNull(strict.properties[key]), true, `${key} must accept null`);
    }
    assert.equal(strict.properties.optionalPretypedConst.anyOf.at(-1).type, "null");
    assert.ok(strict.properties.optionalPretypedEnum.enum.includes(null));
    assert.equal(strict.properties.optionalSiblingAny.anyOf.at(-1).type, "null");
    assert.equal(strict.properties.optionalOne.oneOf, undefined);
    assert.equal(strict.properties.optionalOne.anyOf.length, 2);
    assert.equal(strict.properties.optionalOne.anyOf[0].anyOf.length, 2);
    assert.equal(strict.properties.optionalAll.allOf, undefined);
    assert.deepEqual(canonical, before);
  });

  it("omits unsupported dependency constraints from the provider variant", () => {
    const canonical = {
      type: "object",
      properties: {
        mode: { type: "string" },
        detail: { type: "string" },
      },
      dependentRequired: { mode: ["detail"] },
      dependentSchemas: {
        mode: {
          type: "object",
          properties: { detail: { type: "string" } },
        },
      },
    };
    const strict = adaptJsonSchemaForProvider("codex", canonical);

    assertCodexCompatible(strict);
    assert.equal(strict.dependentRequired, undefined);
    assert.equal(strict.dependentSchemas, undefined);
    assert.ok(strict.required.includes("mode"));
    assert.ok(strict.required.includes("detail"));
    assert.equal(allowsNull(strict.properties.mode), true);
    assert.equal(allowsNull(strict.properties.detail), true);
  });

  it("rejects an untyped empty schema node before provider invocation", () => {
    assert.throws(
      () => adaptJsonSchemaForProvider("codex", {
        type: "object",
        required: ["unknown"],
        properties: { unknown: {} },
      }),
      /must have type, anyOf, or \$ref/,
    );
  });

  it("rejects root anyOf before sending an invalid Codex request", () => {
    assert.throws(
      () => adaptJsonSchemaForProvider("codex", {
        anyOf: [{ type: "object", properties: {} }, { type: "object", properties: {} }],
      }),
      /root must have type object/,
    );
    assert.throws(
      () => adaptJsonSchemaForProvider("codex", {
        type: "object",
        properties: {},
        anyOf: [{ type: "object", properties: {} }],
      }),
      /root must not use anyOf/,
    );
  });

  it("does not mutate the canonical schema", () => {
    const canonical = loadSpecJsonSchema();
    const before = JSON.stringify(canonical);
    adaptJsonSchemaForProvider("codex", canonical);
    assert.equal(JSON.stringify(canonical), before);
  });

  it("does not expose mutable access to the normalized schema invariant", () => {
    const value = new CodexJsonSchema({
      type: "object",
      required: ["sealed"],
      properties: { sealed: { const: true } },
    });
    const first = value.toJSON();
    first.properties.sealed.type = "string";

    assert.equal(Object.isFrozen(value), true);
    assert.deepEqual(value.toJSON().properties.sealed, { const: true, type: "boolean" });
  });

  it("preserves ordinary JSON Schema semantics for non-Codex providers", () => {
    const canonical = loadSpecJsonSchema();
    const prepared = adaptJsonSchemaForProvider("claude", canonical);
    assert.notStrictEqual(prepared, canonical);
    assert.deepEqual(prepared, canonical);
  });
});
