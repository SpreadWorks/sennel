/**
 * Provider-specific JSON Schema preparation.
 *
 * Canonical application schemas use ordinary JSON Schema semantics. Codex
 * structured output accepts a smaller strict dialect: the root is an object,
 * every declared object property is required, optional values are represented
 * as nullable, and objects reject undeclared properties. Keep that adaptation
 * at the provider boundary so application validation continues to use the
 * canonical schema.
 *
 * The Codex dialect does not support `oneOf`, `allOf`, or conditionals. The
 * provider representation maps absent optional fields to required nullable
 * fields and closes objects, so it is not a drop-in canonical validator.
 * Unsupported logical constraints are deliberately relaxed: `oneOf` becomes
 * `anyOf`, while `allOf` and its conditional branches are omitted. Callers
 * remain responsible for canonical validation; Flow worker reports are
 * independently reconciled by the parent dispatcher and are never completion
 * authority.
 */

const CODEX_UNSUPPORTED_KEYWORDS = new Set([
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

const SCHEMA_VALUE_KEYS = new Set([
  "additionalProperties",
  "items",
]);

const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
]);

function isSchemaObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasType(schema, type) {
  return schema.type === type
    || (Array.isArray(schema.type) && schema.type.includes(type));
}

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (isSchemaObject(value)) return "object";
  return typeof value;
}

function normalizeInferredTypes(types) {
  const result = [];
  for (const type of types) {
    const normalized = type === "integer" && types.includes("number") ? "number" : type;
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result.length === 1 ? result[0] : result;
}

function inferredTypeFromValues(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return normalizeInferredTypes(values.map(jsonType));
}

function inferredTypeFromAllOf(schema) {
  if (!Array.isArray(schema.allOf)) return null;
  const types = schema.allOf
    .map((entry) => inferredType(entry))
    .filter((type) => type != null)
    .flat();
  if (types.length === 0) return null;
  const unique = [...new Set(types)];
  return unique.length === 1 ? unique[0] : null;
}

function inferredType(schema) {
  if (schema.type != null) return structuredClone(schema.type);
  if (Object.hasOwn(schema, "const")) return jsonType(schema.const);
  if (Array.isArray(schema.enum)) return inferredTypeFromValues(schema.enum);
  if (
    isSchemaObject(schema.properties)
    || Array.isArray(schema.required)
    || Object.hasOwn(schema, "additionalProperties")
  ) return "object";
  if (
    Object.hasOwn(schema, "items")
    || Object.hasOwn(schema, "prefixItems")
    || Object.hasOwn(schema, "minItems")
    || Object.hasOwn(schema, "maxItems")
  ) return "array";
  if (
    Object.hasOwn(schema, "pattern")
    || Object.hasOwn(schema, "minLength")
    || Object.hasOwn(schema, "maxLength")
  ) return "string";
  if (
    Object.hasOwn(schema, "minimum")
    || Object.hasOwn(schema, "maximum")
    || Object.hasOwn(schema, "exclusiveMinimum")
    || Object.hasOwn(schema, "exclusiveMaximum")
    || Object.hasOwn(schema, "multipleOf")
  ) return "number";
  return inferredTypeFromAllOf(schema);
}

function schemaAllowsNull(schema) {
  let constrained = false;
  let allowed = true;
  if (schema.type != null) {
    constrained = true;
    allowed = allowed && hasType(schema, "null");
  }
  if (Object.hasOwn(schema, "const")) {
    constrained = true;
    allowed = allowed && schema.const === null;
  }
  if (Array.isArray(schema.enum)) {
    constrained = true;
    allowed = allowed && schema.enum.includes(null);
  }
  if (Array.isArray(schema.anyOf)) {
    constrained = true;
    allowed = allowed && schema.anyOf.some((entry) => (
      isSchemaObject(entry) && schemaAllowsNull(entry)
    ));
  }
  return constrained && allowed;
}

function addNullType(type) {
  if (Array.isArray(type)) return type.includes("null") ? type : [...type, "null"];
  return type === "null" ? type : [type, "null"];
}

function makeNullable(schema) {
  if (schemaAllowsNull(schema)) return schema;

  if (
    Array.isArray(schema.enum)
    && !Object.hasOwn(schema, "const")
    && !Array.isArray(schema.anyOf)
  ) {
    return {
      ...schema,
      type: addNullType(schema.type),
      enum: [...schema.enum, null],
    };
  }
  if (Object.hasOwn(schema, "const") || Array.isArray(schema.anyOf)) {
    return { anyOf: [schema, { type: "null" }] };
  }
  if (schema.type != null) {
    return { ...schema, type: addNullType(schema.type) };
  }
  return { anyOf: [schema, { type: "null" }] };
}

function typeAcceptsValue(type, value) {
  const types = Array.isArray(type) ? type : [type];
  const actual = jsonType(value);
  return types.includes(actual) || (actual === "integer" && types.includes("number"));
}

class CodexJsonSchemaContract {
  assert(schema) {
    if (schema.type !== "object") {
      throw new Error("Codex JSON schema root must have type object");
    }
    if (Array.isArray(schema.anyOf)) {
      throw new Error("Codex JSON schema root must not use anyOf");
    }
    this.assertNode(schema, "$");
    return schema;
  }

  assertNode(schema, path) {
    if (!isSchemaObject(schema)) {
      throw new Error(`Codex JSON schema node ${path} must be an object`);
    }
    for (const keyword of CODEX_UNSUPPORTED_KEYWORDS) {
      if (Object.hasOwn(schema, keyword)) {
        throw new Error(`Codex JSON schema node ${path} uses unsupported ${keyword}`);
      }
    }
    if (
      schema.type == null
      && !Array.isArray(schema.anyOf)
      && typeof schema.$ref !== "string"
    ) {
      throw new Error(`Codex JSON schema node ${path} must have type, anyOf, or $ref`);
    }
    if (Object.hasOwn(schema, "const") && !typeAcceptsValue(schema.type, schema.const)) {
      throw new Error(`Codex JSON schema const ${path} must have an explicit compatible type`);
    }
    if (Array.isArray(schema.enum)) {
      if (schema.enum.length === 0 || schema.enum.some((value) => !typeAcceptsValue(schema.type, value))) {
        throw new Error(`Codex JSON schema enum ${path} must have explicit compatible types`);
      }
    }

    if (hasType(schema, "object")) {
      const properties = isSchemaObject(schema.properties) ? schema.properties : {};
      const propertyKeys = Object.keys(properties).sort();
      const required = Array.isArray(schema.required) ? [...schema.required].sort() : null;
      if (!required || JSON.stringify(required) !== JSON.stringify(propertyKeys)) {
        throw new Error(`Codex JSON schema object ${path} must require every property`);
      }
      if (schema.additionalProperties !== false) {
        throw new Error(`Codex JSON schema object ${path} must set additionalProperties false`);
      }
      for (const [key, child] of Object.entries(properties)) {
        this.assertNode(child, `${path}.properties.${key}`);
      }
    }

    if (Array.isArray(schema.anyOf)) {
      if (schema.anyOf.length === 0) throw new Error(`Codex JSON schema anyOf ${path} must not be empty`);
      schema.anyOf.forEach((child, index) => this.assertNode(child, `${path}.anyOf[${index}]`));
    }
    if (isSchemaObject(schema.items)) this.assertNode(schema.items, `${path}.items`);
    for (const key of SCHEMA_VALUE_KEYS) {
      if (key !== "items" && isSchemaObject(schema[key])) {
        this.assertNode(schema[key], `${path}.${key}`);
      }
    }
    for (const key of SCHEMA_MAP_KEYS) {
      if (!isSchemaObject(schema[key])) continue;
      for (const [name, child] of Object.entries(schema[key])) {
        this.assertNode(child, `${path}.${key}.${name}`);
      }
    }
  }
}

class CodexJsonSchemaNormalizer {
  normalize(schema) {
    return this.normalizeNode(schema, { optional: false });
  }

  normalizeNode(node, { optional }) {
    if (!isSchemaObject(node)) {
      throw new Error("Codex JSON schema nodes must be objects");
    }
    const result = {};
    const inferred = inferredType(node);
    for (const [key, value] of Object.entries(node)) {
      if (
        key === "type"
        || key === "required"
        || key === "properties"
        || key === "additionalProperties"
        || key === "anyOf"
        || CODEX_UNSUPPORTED_KEYWORDS.has(key)
        || SCHEMA_VALUE_KEYS.has(key)
        || SCHEMA_MAP_KEYS.has(key)
      ) continue;
      result[key] = structuredClone(value);
    }
    if (inferred != null) result.type = inferred;

    const alternatives = [
      ...(Array.isArray(node.anyOf) ? node.anyOf : []),
      ...(Array.isArray(node.oneOf) ? node.oneOf : []),
    ];
    if (alternatives.length > 0) {
      result.anyOf = alternatives.map((entry) => this.normalizeNode(entry, { optional: false }));
    }

    for (const key of SCHEMA_VALUE_KEYS) {
      if (key === "additionalProperties" || !Object.hasOwn(node, key)) continue;
      const value = node[key];
      result[key] = isSchemaObject(value)
        ? this.normalizeNode(value, { optional: false })
        : structuredClone(value);
    }
    for (const key of SCHEMA_MAP_KEYS) {
      if (!isSchemaObject(node[key])) continue;
      result[key] = Object.fromEntries(
        Object.entries(node[key]).map(([name, entry]) => [
          name,
          this.normalizeNode(entry, { optional: false }),
        ]),
      );
    }

    if (hasType(result, "object")) {
      const properties = isSchemaObject(node.properties) ? node.properties : {};
      const canonicalRequired = new Set(Array.isArray(node.required) ? node.required : []);
      result.properties = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [
          key,
          this.normalizeNode(value, { optional: !canonicalRequired.has(key) }),
        ]),
      );
      result.required = Object.keys(properties);
      result.additionalProperties = false;
    }

    return optional ? makeNullable(result) : result;
  }
}

/**
 * Immutable provider-facing schema value whose constructor enforces the Codex
 * structured-output dialect before it reaches the agent CLI.
 */
export class CodexJsonSchema {
  #schema;

  constructor(canonicalSchema) {
    if (!isSchemaObject(canonicalSchema)) {
      throw new Error("provider JSON schema must be an object");
    }
    const normalized = new CodexJsonSchemaNormalizer().normalize(structuredClone(canonicalSchema));
    // This contract deliberately covers the schema-shape restrictions the
    // adapter owns. Provider service limits such as total properties, depth,
    // and aggregate enum/string sizes remain service-side limits.
    this.#schema = new CodexJsonSchemaContract().assert(normalized);
    Object.freeze(this);
  }

  toJSON() {
    return structuredClone(this.#schema);
  }
}

/**
 * Adapt an application JSON Schema to the selected provider's output dialect.
 * Non-Codex providers receive an isolated canonical copy.
 */
export function adaptJsonSchemaForProvider(providerKey, schema) {
  if (schema == null) return null;
  if (!isSchemaObject(schema)) throw new Error("provider JSON schema must be an object");
  return providerKey === "codex"
    ? new CodexJsonSchema(schema).toJSON()
    : structuredClone(schema);
}
