import { SpecRepairOperation } from "./lib/spec-repair-operations.js";

/** Recorded edit content from an already validated, adopted operation. */
export class RecordedRepairChange {
  #value;

  constructor(operation) {
    if (!(operation instanceof SpecRepairOperation)) {
      throw new TypeError("Recorded repair change requires a typed SpecRepairOperation");
    }
    const recorded = operation.toJSON();
    this.#value = Object.freeze({
      replacement: operation.replacementRequired ? recorded.replacement : null,
      edits: operation.editsRequired ? recorded.edits : null,
    });
    Object.freeze(this);
  }

  toJSON() { return structuredClone(this.#value); }
}

const edit = {
  type: "object", required: ["startByte", "endByte", "replacement"], additionalProperties: false,
  properties: {
    startByte: { type: "integer", minimum: 0 },
    endByte: { type: "integer", minimum: 0 },
    replacement: { type: "string" },
  },
};

/** Public content only; operation grammar and application stay producer-owned. */
export const FLOW_QUERY_REPAIR_CHANGE_SCHEMA = Object.freeze({ oneOf: [
  { type: "null" },
  { type: "object", required: ["replacement", "edits"], additionalProperties: false,
    properties: {
      replacement: {},
      edits: { type: ["array", "null"], minItems: 1, items: edit },
    },
    oneOf: [
      { type: "object", properties: { edits: { type: "null" } } },
      { type: "object", properties: { replacement: { type: "null" }, edits: { type: "array" } } },
    ],
  },
] });
