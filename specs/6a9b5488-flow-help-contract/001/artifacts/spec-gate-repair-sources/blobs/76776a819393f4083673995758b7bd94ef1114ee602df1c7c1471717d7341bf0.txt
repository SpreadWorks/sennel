/**
 * sennel/lib/schema-validate.js
 *
 * Generic JSON Schema subset validator.
 * Supports: type, required, properties, additionalProperties, enum,
 * oneOf, items, minimum, maximum, minLength, maxLength, pattern, minItems, maxItems,
 * deprecated.
 */

/**
 * Validate a value against a JSON Schema subset definition.
 *
 * @param {*} value - The value to validate
 * @param {Object} schema - Schema definition
 * @param {string} [path=""] - Current property path (for error messages)
 * @returns {string[]} Array of error messages (empty = valid)
 */
export function validateSchema(value, schema, path = "") {
  const errors = [];

  // oneOf — exactly one alternative must match. JSON Schema keywords are
  // conjunctive, so a matching alternative does not skip sibling keywords.
  if (schema.oneOf) {
    const matching = schema.oneOf.filter((sub) => validateSchema(value, sub, path).length === 0);
    if (matching.length !== 1) {
      errors.push(`${path || "(root)"}: must match exactly one schema in oneOf — ${matching.length} schemas matched`);
    }
  }

  // deprecated — report error if value is present (caller handles presence check)
  if (schema.deprecated) {
    errors.push(`${path || "(root)"}: deprecated field`);
    return errors;
  }

  // type check
  if (schema.type) {
    if (!checkType(value, schema.type)) {
      errors.push(`${path || "(root)"}: must be ${schema.type}, got ${typeOf(value)}`);
      return errors; // no point checking further
    }
  }

  // enum
  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path || "(root)"}: must be one of enum [${schema.enum.join(", ")}], got "${value}"`);
    }
  }

  // string constraints
  if (schemaHasType(schema, "string") && typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${path || "(root)"}: minLength ${schema.minLength}, got ${value.length}`);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push(`${path || "(root)"}: maxLength ${schema.maxLength}, got ${value.length}`);
    }
    if (schema.pattern != null) {
      const pattern = new RegExp(schema.pattern);
      const match = pattern.exec(value);
      const anchored = hasExplicitFullStringAnchors(schema.pattern);
      if (match === null || (anchored && (match.index !== 0 || match[0] !== value))) {
        errors.push(`${path || "(root)"}: must match pattern ${schema.pattern}`);
      }
    }
  }

  // number / integer constraints
  if ((schemaHasType(schema, "number") || schemaHasType(schema, "integer")) && typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(`${path || "(root)"}: minimum ${schema.minimum}, got ${value}`);
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push(`${path || "(root)"}: maximum ${schema.maximum}, got ${value}`);
    }
  }

  // array constraints
  if (schemaHasType(schema, "array") && Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${path || "(root)"}: minItems ${schema.minItems}, got ${value.length}`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(`${path || "(root)"}: maxItems ${schema.maxItems}, got ${value.length}`);
      return errors;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        errors.push(...validateSchema(value[i], schema.items, `${path}[${i}]`));
      }
    }
  }

  // object constraints
  if (schemaHasType(schema, "object") && value !== null && typeof value === "object" && !Array.isArray(value)) {
    // required
    if (schema.required) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
          errors.push(`${path ? path + "." : ""}${key}: required field is missing`);
        }
      }
    }

    // properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const propPath = path ? `${path}.${key}` : key;
        if (value[key] === undefined) continue; // absent optional

        if (propSchema.deprecated) {
          errors.push(`${propPath}: deprecated field`);
          continue;
        }

        errors.push(...validateSchema(value[key], propSchema, propPath));
      }
    }

    // additionalProperties
    if (schema.additionalProperties !== undefined) {
      const known = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (known.has(key)) continue;
        const propPath = path ? `${path}.${key}` : key;
        if (schema.additionalProperties === false) {
          errors.push(`${propPath}: unknown field`);
        } else if (typeof schema.additionalProperties === "object") {
          errors.push(...validateSchema(value[key], schema.additionalProperties, propPath));
        }
      }
    }
  }

  return errors;
}

function checkType(value, type) {
  if (Array.isArray(type)) return type.some((oneType) => checkType(value, oneType));
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}

function schemaHasType(schema, type) {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function hasExplicitFullStringAnchors(pattern) {
  if (typeof pattern !== "string" || pattern[0] !== "^" || !pattern.endsWith("$")) {
    return false;
  }
  let precedingBackslashes = 0;
  for (let index = pattern.length - 2; index >= 0 && pattern[index] === "\\"; index -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 0;
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
