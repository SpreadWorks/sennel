import crypto from "node:crypto";
import { validateSpecJsonObject } from "../../lib/spec-json.js";
import { FlowFindingSourceIdentity } from "./flow-findings.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_REVISION = /^sha256:([a-f0-9]{64})$/;
const MAX_OPERATIONS = 64;
const MAX_VALUE_BYTES = 32 * 1024;
const MAX_TEXT_EDITS = 64;
const MAX_ATTEMPT_ERROR_BYTES = 1024;
const COLLECTION_TARGETS = new Set([
  "scope.in", "scope.out", "constraints", "design_principles", "acceptance_criteria",
  "clarifications", "alternatives_considered", "open_questions", "overview.modules", "overview.data_flow",
  "overview.decisions", "keywords", "implementationTargets",
]);
const REPLACE_ROOTS = new Set(["goal", "background"]);
const REQUIREMENT_FIELDS = new Set(["desc", "priority", "testable", "preimplementation_test_expectation"]);
const TASK_FIELDS = new Set(["title", "goal", "acceptance", "implementation_notes"]);
const OPTIONAL_REQUIREMENT_FIELDS = new Set(["priority", "testable", "preimplementation_test_expectation"]);
const OPTIONAL_TASK_FIELDS = new Set(["acceptance", "implementation_notes"]);
const OPERATION_TYPES = new Map();
const GATE_OPERATION_TYPES = new Map();

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}
function clone(value) { return structuredClone(value); }
function stableBytes(value) { return Buffer.byteLength(JSON.stringify(value)); }
function valueDigest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Stable audit identity for a rejected Spec repair proposal. */
export function specRepairProposalDigest(proposal) {
  return crypto.createHash("sha256").update(canonicalJson(proposal)).digest("hex");
}
/** Finds the actual edit, independent of worker prose or which finding named it. */
function semanticOperationDigest(operation, resolvedTarget = null) {
  const json = operation.toJSON?.() ?? operation;
  return crypto.createHash("sha256").update(canonicalJson({
    kind: json.kind, target: resolvedTarget ?? json.target, expectedDigest: json.expectedDigest,
    ...(Object.hasOwn(json, "replacement") ? { replacement: json.replacement } : {}),
    ...(Object.hasOwn(json, "edits") ? { edits: json.edits } : {}),
  })).digest("hex");
}
function revisionFor(inputRevision) { return `sha256:${inputRevision}`; }
function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${field} has an invalid schema`);
}
function optionalExactKeys(value, required, optional, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || actual.some((key) => !required.includes(key) && !optional.includes(key))) throw new Error(`${field} has an invalid schema`);
}
function freezeNested(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeNested); Object.freeze(value); }
  return value;
}
function frozen(value) { return freezeNested(clone(value)); }
function boundedErrorMessage(message) {
  const normalized = String(message ?? "spec repair attempt rejected").replace(/[\r\n\t]+/g, " ").trim();
  const bytes = Buffer.from(normalized, "utf8");
  return bytes.length <= MAX_ATTEMPT_ERROR_BYTES
    ? normalized
    : `${bytes.subarray(0, MAX_ATTEMPT_ERROR_BYTES - 3).toString("utf8")}...`;
}
function fallbackAttemptAudit(baseRevision = null) {
  return {
    version: 2, phase: "spec-repair", baseRevision,
    attempts: [], acceptedOperations: [], discardedOperations: [], scopeExpansions: [], appliedFindings: [],
    operationDigest: valueDigest({ accepted: [], discarded: [] }), resultRevision: null,
    audit: {},
  };
}
function commandOwnedAttemptFailure(audit, code, message) {
  const bounded = boundedErrorMessage(message);
  const source = audit ?? fallbackAttemptAudit();
  const validationSummary = code === "FLOW_SPEC_REPAIR_RESULT_SCHEMA_INVALID" || code === "FLOW_SPEC_REPAIR_GATE_READY_INVALID"
    ? bounded
    : null;
  return frozen({
    ...source,
    audit: {
      ...(source.audit ?? {}),
      error: { code, message: bounded },
      ...(validationSummary === null ? {} : { validationSummary }),
    },
  });
}
function auditTarget(value) {
  try { return SpecRepairTarget.fromJSON(value, "discarded operation target").toJSON(); } catch { return null; }
}
/** Never retain a raw worker operation in the command-owned audit.  In
 * particular this prevents rejected replacement text from becoming a second,
 * unbounded canonical worker artifact. */
function discardedOperation(value, reason) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  return Object.freeze({
    findingIds: Array.isArray(source?.findingIds) ? source.findingIds.filter((id) => typeof id === "string") : [],
    kind: typeof source?.kind === "string" ? source.kind : null,
    target: auditTarget(source?.target),
    operationDigest: valueDigest(value),
    reason,
  });
}

export class SpecRepairOperationsError extends Error {
  constructor(code, message, { retryable = false, audit = null } = {}) {
    const bounded = boundedErrorMessage(message);
    super(bounded); this.name = "SpecRepairOperationsError"; this.code = code; this.retryable = retryable;
    this.audit = commandOwnedAttemptFailure(audit, code, bounded);
  }
}
export class SpecRepairOperationValidationError extends SpecRepairOperationsError {
  constructor(message, { audit = null } = {}) { super("FLOW_SPEC_REPAIR_OPERATION_VALIDATION_FAILURE", message, { retryable: false, audit }); this.name = "SpecRepairOperationValidationError"; }
}
/** Structured target classes own decoding and later resolution behavior. */
export class SpecRepairTarget {
  static fromJSON(value, field) {
    if (Object.hasOwn(value ?? {}, "collection")) return new SpecRepairArrayTarget(value, field);
    if (Object.hasOwn(value ?? {}, "id")) return new SpecRepairIdEntityTarget(value, field);
    return new SpecRepairRootTarget(value, field);
  }
}
export class SpecRepairRootTarget extends SpecRepairTarget {
  constructor(value, field) {
    super(); exactKeys(value, ["entity", "field"], field);
    if (value.entity !== "spec" || !REPLACE_ROOTS.has(value.field)) throw new Error(`${field} must name a replaceable spec field`);
    this.entity = value.entity; this.field = value.field; Object.freeze(this);
  }
  permissionKey() { return `root:${this.field}`; }
  conflictKey() { return this.permissionKey(); }
  toJSON() { return { entity: this.entity, field: this.field }; }
  resolve(context) { return context.rootReference(this); }
}
export class SpecRepairIdEntityTarget extends SpecRepairTarget {
  constructor(value, field) {
    super(); exactKeys(value, ["entity", "id", "field"], field);
    if (value.entity !== "requirement" && value.entity !== "task") throw new Error(`${field}.entity is invalid`);
    this.id = requiredText(value.id, `${field}.id`);
    const allowed = value.entity === "requirement" ? REQUIREMENT_FIELDS : TASK_FIELDS;
    if (!allowed.has(value.field)) throw new Error(`${field}.field is invalid`);
    this.entity = value.entity; this.field = value.field; Object.freeze(this);
  }
  get domain() { return `${this.entity}s`; }
  permissionKey() { return `id:${this.entity}:${this.id}:${this.field}`; }
  conflictKey() { return this.permissionKey(); }
  toJSON() { return { entity: this.entity, id: this.id, field: this.field }; }
  resolve(context) { return context.idEntityReference(this); }
}
export class SpecRepairArrayTarget extends SpecRepairTarget {
  constructor(value, field) {
    super(); optionalExactKeys(value, ["collection"], ["position"], field);
    if (!COLLECTION_TARGETS.has(value.collection)) throw new Error(`${field}.collection is invalid`);
    if (Object.hasOwn(value, "position") && (!Number.isInteger(value.position) || value.position < 0)) throw new Error(`${field}.position must be a non-negative integer`);
    this.collection = value.collection; this.position = value.position ?? null; Object.freeze(this);
  }
  permissionKey() { return `array:${this.collection}`; }
  conflictKey(expectedDigest) { return `array:${this.collection}:${this.position ?? expectedDigest}`; }
  toJSON() { return this.position === null ? { collection: this.collection } : { collection: this.collection, position: this.position }; }
  resolve(context, expectedDigest) { return context.arrayElementReference(this, expectedDigest); }
}

/** A triage permission is a capability: a collection location alone cannot
 * accidentally grant array-add or array-delete authority. */
export class SpecRepairPermission {
  constructor(value, field, operationTypes = OPERATION_TYPES) {
    exactKeys(value, ["target", "operationKinds"], field);
    this.target = SpecRepairTarget.fromJSON(value.target, `${field}.target`);
    if (!Array.isArray(value.operationKinds) || value.operationKinds.length === 0 || new Set(value.operationKinds).size !== value.operationKinds.length) throw new Error(`${field}.operationKinds must be a non-empty unique array`);
    for (const kind of value.operationKinds) {
      if (!operationTypes.has(kind)) throw new Error(`${field}.operationKinds contains an invalid kind`);
      if (!operationTypes.get(kind).supportsTarget(this.target)) throw new Error(`${field}.operationKinds is incompatible with its target`);
    }
    this.operationKinds = Object.freeze([...value.operationKinds]);
    if (new.target === SpecRepairPermission) Object.freeze(this);
  }
  allows(operation) { return this.target.permissionKey() === operation.target.permissionKey() && this.operationKinds.includes(operation.kind); }
  toJSON() { return { target: this.target.toJSON(), operationKinds: [...this.operationKinds] }; }
}
/** Gate array permissions can name one immutable-base element precisely. */
export class SpecGateRepairPermission extends SpecRepairPermission {
  constructor(value, field, operationTypes, spec) {
    super(value, field, operationTypes);
    this.expectedDigest = null;
    if (this.target instanceof SpecRepairArrayTarget && this.target.position !== null) {
      const collection = collectionReference(spec, this.target.collection);
      if (!collection || this.target.position >= collection.value.length || this.operationKinds.includes("add-array-element")) {
        throw new Error(`${field} names an impossible array element capability`);
      }
      this.expectedDigest = valueDigest(collection.value[this.target.position]);
    }
    Object.freeze(this);
  }
  allows(operation) {
    if (!super.allows(operation)) return false;
    if (!(this.target instanceof SpecRepairArrayTarget) || this.target.position === null) return true;
    return operation.target instanceof SpecRepairArrayTarget
      && operation.target.position === this.target.position
      && operation.expectedDigest === this.expectedDigest;
  }
}

export class SpecRepairOperation {
  constructor(input, index, { replacementRequired = true, editsRequired = false } = {}) {
    const keys = ["findingIds", "kind", "target", "expectedDigest", "reason"];
    if (replacementRequired) keys.push("replacement");
    if (editsRequired) keys.push("edits");
    exactKeys(input, keys, `spec-repair.operations[${index}]`);
    if (!Array.isArray(input.findingIds) || input.findingIds.length === 0 || new Set(input.findingIds).size !== input.findingIds.length) {
      throw new Error(`spec-repair.operations[${index}].findingIds must be a non-empty unique array`);
    }
    const findingIds = input.findingIds.map((id, findingIndex) => requiredText(id, `spec-repair.operations[${index}].findingIds[${findingIndex}]`));
    if (findingIds.some((id, findingIndex) => findingIndex > 0 && findingIds[findingIndex - 1] > id)) {
      throw new Error(`spec-repair.operations[${index}].findingIds must use canonical stable order`);
    }
    this.findingIds = Object.freeze(findingIds);
    this.kind = requiredText(input.kind, `spec-repair.operations[${index}].kind`);
    this.target = SpecRepairTarget.fromJSON(input.target, `spec-repair.operations[${index}].target`);
    this.reason = requiredText(input.reason, `spec-repair.operations[${index}].reason`);
    if (replacementRequired && stableBytes(input.replacement) > MAX_VALUE_BYTES) throw new Error(`spec-repair.operations[${index}].replacement is oversized`);
    this.replacement = replacementRequired ? frozen(input.replacement) : null;
    this.replacementRequired = replacementRequired;
    if (editsRequired) {
      if (!Array.isArray(input.edits) || input.edits.length === 0 || input.edits.length > MAX_TEXT_EDITS) {
        throw new Error(`spec-repair.operations[${index}].edits must contain at most ${MAX_TEXT_EDITS} edits`);
      }
      const edits = input.edits.map((edit, editIndex) => new SpecRepairTextEdit(edit, `spec-repair.operations[${index}].edits[${editIndex}]`));
      if (stableBytes(input.edits) > MAX_VALUE_BYTES) {
        throw new Error(`spec-repair.operations[${index}].edits replacements are oversized`);
      }
      for (let editIndex = 0; editIndex < edits.length; editIndex += 1) {
        if (editIndex > 0 && (edits[editIndex - 1].startByte > edits[editIndex].startByte
          || (edits[editIndex - 1].startByte === edits[editIndex].startByte && edits[editIndex - 1].endByte > edits[editIndex].endByte))) {
          throw new Error(`spec-repair.operations[${index}].edits must use canonical stable byte order`);
        }
        for (let otherIndex = editIndex + 1; otherIndex < edits.length; otherIndex += 1) {
          if (edits[editIndex].conflictsWith(edits[otherIndex])) {
            throw new Error(`spec-repair.operations[${index}].edits contain overlapping or ambiguous edits`);
          }
        }
      }
      this.edits = Object.freeze(edits);
    } else this.edits = null;
    this.editsRequired = editsRequired;
    if (input.expectedDigest !== null && !SHA256.test(input.expectedDigest)) throw new Error(`spec-repair.operations[${index}].expectedDigest must be SHA-256 or null`);
    this.expectedDigest = input.expectedDigest;
  }
  toJSON() {
    return {
      findingIds: [...this.findingIds], kind: this.kind, target: this.target.toJSON(), expectedDigest: this.expectedDigest,
      ...(this.replacementRequired ? { replacement: clone(this.replacement) } : {}), reason: this.reason,
      ...(this.editsRequired ? { edits: this.edits.map((edit) => edit.toJSON()) } : {}),
    };
  }
  conflictKey() { return this.target.conflictKey(this.expectedDigest); }
  isComposableWith() { return false; }
  resolve(context) { return this.target.resolve(context, this.expectedDigest); }
  apply() { throw new Error("SpecRepairOperation subclasses implement apply"); }
  static supportsTarget() { return false; }
}
/** One byte-addressed edit against an immutable UTF-8 text field. */
export class SpecRepairTextEdit {
  constructor(value, field) {
    exactKeys(value, ["startByte", "endByte", "replacement"], field);
    if (!Number.isSafeInteger(value.startByte) || value.startByte < 0
      || !Number.isSafeInteger(value.endByte) || value.endByte < value.startByte
      || typeof value.replacement !== "string") {
      throw new Error(`${field} has an invalid UTF-8 byte edit`);
    }
    this.startByte = value.startByte;
    this.endByte = value.endByte;
    this.replacement = value.replacement;
    Object.freeze(this);
  }
  conflictsWith(other) {
    if (!(other instanceof SpecRepairTextEdit)) throw new Error("text edit comparison requires a text edit");
    if (this.startByte === this.endByte && other.startByte === other.endByte) return this.startByte === other.startByte;
    if (this.startByte === this.endByte || other.startByte === other.endByte) {
      const insertion = this.startByte === this.endByte ? this : other;
      const range = insertion === this ? other : this;
      return insertion.startByte > range.startByte && insertion.startByte < range.endByte;
    }
    return this.startByte < other.endByte && other.startByte < this.endByte;
  }
  toJSON() { return { startByte: this.startByte, endByte: this.endByte, replacement: this.replacement }; }
}
/** The closed operation classes own semantic application. Batch orchestration
 * has no operation-specific instanceof switching. */
export class SpecRepairFieldReplace extends SpecRepairOperation {
  constructor(input, index) { super(input, index); if (this.kind !== "replace-field" || !SpecRepairFieldReplace.supportsTarget(this.target) || this.expectedDigest === null) throw new Error(`spec-repair.operations[${index}] replace-field target or digest is invalid`); Object.freeze(this); }
  static supportsTarget(target) { return target instanceof SpecRepairRootTarget; }
  apply(context) { return context.replace(this.resolve(context), this); }
}
export class SpecRepairIdEntityFieldReplace extends SpecRepairOperation {
  constructor(input, index) { super(input, index); if (this.kind !== "replace-entity-field" || !SpecRepairIdEntityFieldReplace.supportsTarget(this.target) || this.expectedDigest === null) throw new Error(`spec-repair.operations[${index}] replace-entity-field target or digest is invalid`); Object.freeze(this); }
  static supportsTarget(target) { return target instanceof SpecRepairIdEntityTarget; }
  apply(context) { return context.replace(this.resolve(context), this); }
}
/** Gate groups may remove an optional entity field as part of a coupled fix. */
export class SpecGateRepairIdEntityFieldDelete extends SpecRepairOperation {
  constructor(input, index) {
    super(input, index, { replacementRequired: false });
    if (this.kind !== "delete-entity-field" || !SpecGateRepairIdEntityFieldDelete.supportsTarget(this.target)
      || this.expectedDigest === null) throw new Error(`spec-repair.operations[${index}] delete-entity-field target or digest is invalid`);
    Object.freeze(this);
  }
  static supportsTarget(target) {
    return target instanceof SpecRepairIdEntityTarget
      && (target.entity === "requirement" ? OPTIONAL_REQUIREMENT_FIELDS : OPTIONAL_TASK_FIELDS).has(target.field);
  }
  apply(context) { return context.deleteField(this.resolve(context), this); }
}
export class SpecGateRepairIdEntityFieldAdd extends SpecRepairOperation {
  constructor(input, index) {
    super(input, index);
    if (this.kind !== "add-entity-field" || !SpecGateRepairIdEntityFieldAdd.supportsTarget(this.target)
      || this.expectedDigest !== null) throw new Error(`spec-repair.operations[${index}] add-entity-field target or digest is invalid`);
    Object.freeze(this);
  }
  static supportsTarget(target) { return SpecGateRepairIdEntityFieldDelete.supportsTarget(target); }
  apply(context) { return context.addField(this.resolve(context), this); }
}
/** Applies one or more immutable-base UTF-8 byte edits to a string field. */
export class SpecRepairTextFieldEdit extends SpecRepairOperation {
  constructor(input, index) {
    super(input, index, { replacementRequired: false, editsRequired: true });
    if (this.kind !== "edit-text-field" || !SpecRepairTextFieldEdit.supportsTarget(this.target) || this.expectedDigest === null) {
      throw new Error(`spec-repair.operations[${index}] edit-text-field target or digest is invalid`);
    }
    Object.freeze(this);
  }
  static supportsTarget(target) { return target instanceof SpecRepairRootTarget || target instanceof SpecRepairIdEntityTarget; }
  static requiresStringTarget = true;
  apply(context) { return context.replaceText(this.resolve(context), this); }
}
export class SpecRepairArrayAdd extends SpecRepairOperation {
  constructor(input, index) { super(input, index); if (this.kind !== "add-array-element" || !SpecRepairArrayAdd.supportsTarget(this.target) || this.expectedDigest !== null || this.target.position !== null) throw new Error(`spec-repair.operations[${index}] add-array-element target or digest is invalid`); Object.freeze(this); }
  static supportsTarget(target) { return target instanceof SpecRepairArrayTarget; }
  conflictKey() { return `array-add:${this.target.collection}`; }
  isComposableWith(other) { return other instanceof SpecRepairArrayAdd && other.target.collection === this.target.collection; }
  apply(context) { return context.append(this.target, this.replacement); }
}
export class SpecRepairArrayReplace extends SpecRepairOperation {
  constructor(input, index) { super(input, index); if (this.kind !== "replace-array-element" || !SpecRepairArrayReplace.supportsTarget(this.target) || this.expectedDigest === null) throw new Error(`spec-repair.operations[${index}] replace-array-element target or digest is invalid`); Object.freeze(this); }
  static supportsTarget(target) { return target instanceof SpecRepairArrayTarget; }
  apply(context) { return context.replaceArrayElement(this.resolve(context), this); }
}
export class SpecRepairArrayDelete extends SpecRepairOperation {
  constructor(input, index) { super(input, index, { replacementRequired: false }); if (this.kind !== "delete-array-element" || !SpecRepairArrayDelete.supportsTarget(this.target) || this.expectedDigest === null) throw new Error(`spec-repair.operations[${index}] delete-array-element target or digest is invalid`); Object.freeze(this); }
  static supportsTarget(target) { return target instanceof SpecRepairArrayTarget; }
  apply(context) { return context.deleteArrayElement(this.resolve(context)); }
}
OPERATION_TYPES.set("replace-field", SpecRepairFieldReplace);
OPERATION_TYPES.set("replace-entity-field", SpecRepairIdEntityFieldReplace);
OPERATION_TYPES.set("edit-text-field", SpecRepairTextFieldEdit);
OPERATION_TYPES.set("add-array-element", SpecRepairArrayAdd);
OPERATION_TYPES.set("replace-array-element", SpecRepairArrayReplace);
OPERATION_TYPES.set("delete-array-element", SpecRepairArrayDelete);
for (const [kind, Type] of OPERATION_TYPES) GATE_OPERATION_TYPES.set(kind, Type);
GATE_OPERATION_TYPES.set("delete-entity-field", SpecGateRepairIdEntityFieldDelete);
GATE_OPERATION_TYPES.set("add-entity-field", SpecGateRepairIdEntityFieldAdd);

export class SpecRepairOperationBatch {
  constructor(document) {
    try {
      optionalExactKeys(document, ["version", "stage", "identity", "baseReviewDigest", "findings", "operations"], ["scopeExpansions"], "review.delta.json");
      if (document.version !== 2 || document.stage !== "spec-repair") throw new Error("review.delta.json must be a spec-repair v2 delta");
      if (!document.identity || typeof document.identity !== "object" || !SHA256.test(document.identity.digest ?? "")) throw new Error("review.delta.json identity digest is invalid");
      if (!Array.isArray(document.findings) || document.findings.length !== 0) throw new Error("review.delta.json spec-repair findings must be an empty array");
      if (!Array.isArray(document.operations) || document.operations.length > MAX_OPERATIONS) throw new Error("review.delta.json operations are invalid");
      if (document.scopeExpansions !== undefined && (!Array.isArray(document.scopeExpansions) || document.scopeExpansions.length > MAX_OPERATIONS)) throw new Error("review.delta.json scopeExpansions are invalid");
    } catch (cause) {
      const baseRevision = typeof document?.identity?.digest === "string" && SHA256.test(document.identity.digest)
        ? revisionFor(document.identity.digest)
        : null;
      throw new SpecRepairOperationValidationError(`spec-repair envelope is invalid: ${cause.message}`, { audit: fallbackAttemptAudit(baseRevision) });
    }
    this.baseRevision = revisionFor(document.identity.digest);
    const operations = [];
    const discardedOperations = [];
    document.operations.forEach((operation, index) => {
      try {
        const Type = OPERATION_TYPES.get(operation?.kind);
        if (!Type) throw new Error(`spec-repair.operations[${index}] kind is invalid`);
        operations.push(new Type(operation, index));
      } catch (cause) { discardedOperations.push(discardedOperation(operation, cause.message)); }
    });
    this.operations = Object.freeze(operations);
    this.discardedOperations = Object.freeze(discardedOperations);
    // Scope is definition-owned. A worker may describe a proposed expansion,
    // but it can never make an operation authorised. Keep it only as bounded
    // command-owned audit evidence and continue the independent operations.
    const scopeExpansions = [];
    const discardedScopeExpansions = [];
    (document.scopeExpansions ?? []).forEach((proposal, index) => {
      try {
        const value = frozen(proposal);
        if (stableBytes(value) > MAX_VALUE_BYTES) throw new Error(`spec-repair scope expansion ${index} is oversized`);
        scopeExpansions.push(value);
      } catch (cause) {
        // A scope proposal is audit-only and must not poison independent
        // repair operations. Keep only bounded discard metadata.
        discardedScopeExpansions.push(discardedOperation(proposal, cause.message));
      }
    });
    this.scopeExpansions = Object.freeze(scopeExpansions);
    this.discardedScopeExpansions = Object.freeze(discardedScopeExpansions);
    Object.freeze(this);
  }
}

class SpecRepairArrayLineage {
  constructor(reference, baseReference) {
    this.reference = reference;
    this.entries = reference.value.map((value, position) => Object.freeze({ value, basePosition: position, digest: valueDigest(baseReference.value[position]) }));
  }
  resolve(target, expectedDigest) {
    if (target.position !== null) {
      const entry = this.entries.find((value) => value.basePosition === target.position);
      if (!entry || entry.digest !== expectedDigest) return { status: "stale" };
      return { status: "ok", entry, index: this.entries.indexOf(entry) };
    }
    const matches = this.entries.filter((entry) => entry.digest === expectedDigest && entry.basePosition !== null);
    if (matches.length === 0) return { status: "stale" };
    if (matches.length > 1) return { status: "conflict" };
    return { status: "ok", entry: matches[0], index: this.entries.indexOf(matches[0]) };
  }
  append(value) { const copy = clone(value); this.reference.value.push(copy); this.entries.push(Object.freeze({ value: copy, basePosition: null, digest: null })); }
  replace(resolution, value) { const copy = clone(value); this.reference.value[resolution.index] = copy; this.entries[resolution.index] = Object.freeze({ ...resolution.entry, value: copy }); }
  delete(resolution) { this.reference.value.splice(resolution.index, 1); this.entries.splice(resolution.index, 1); }
}
/** Application context owns staging state and immutable-base array identity. */
class SpecRepairApplicationContext {
  constructor(candidate, immutableBase) { this.candidate = candidate; this.immutableBase = immutableBase; this.collections = new Map(); }
  rootReference(target) { return { status: "ok", object: this.candidate, key: target.field, value: this.candidate[target.field] }; }
  idEntityReference(target) {
    const matches = Array.isArray(this.candidate[target.domain]) ? this.candidate[target.domain].filter((entry) => entry?.id === target.id) : [];
    if (matches.length !== 1) return { status: matches.length === 0 ? "stale" : "conflict" };
    return { status: "ok", object: matches[0], key: target.field, value: matches[0][target.field] };
  }
  arrayLineage(target) {
    let lineage = this.collections.get(target.collection);
    if (lineage) return lineage;
    const reference = collectionReference(this.candidate, target.collection);
    const baseReference = collectionReference(this.immutableBase, target.collection);
    if (!reference || !baseReference) return null;
    lineage = new SpecRepairArrayLineage(reference, baseReference); this.collections.set(target.collection, lineage); return lineage;
  }
  arrayElementReference(target, expectedDigest) { const lineage = this.arrayLineage(target); return lineage ? lineage.resolve(target, expectedDigest) : { status: "stale" }; }
  // Gate compares claims before staging groups; the same base element may be
  // addressed by position or by its unique digest.
  conflictClaim(operation) {
    if (!(operation.target instanceof SpecRepairArrayTarget) || operation instanceof SpecRepairArrayAdd) {
      return { status: "ok", key: operation.conflictKey() };
    }
    const reference = operation.resolve(this);
    return reference.status === "ok"
      ? { status: "ok", key: `array:${operation.target.collection}:${reference.entry.basePosition}` }
      : reference;
  }
  replace(reference, operation) {
    if (reference.status !== "ok") return reference;
    if (valueDigest(reference.value) !== operation.expectedDigest) return { status: "stale" };
    reference.object[reference.key] = clone(operation.replacement); return { status: "ok" };
  }
  deleteField(reference, operation) {
    if (reference.status !== "ok") return reference;
    if (valueDigest(reference.value) !== operation.expectedDigest) return { status: "stale" };
    delete reference.object[reference.key]; return { status: "ok" };
  }
  addField(reference, operation) {
    if (reference.status !== "ok") return reference;
    if (Object.hasOwn(reference.object, reference.key)) return { status: "stale" };
    reference.object[reference.key] = clone(operation.replacement); return { status: "ok" };
  }
  replaceText(reference, operation) {
    if (reference.status !== "ok") return reference;
    if (typeof reference.value !== "string") return { status: "invalid" };
    if (valueDigest(reference.value) !== operation.expectedDigest) return { status: "stale" };
    const source = Buffer.from(reference.value, "utf8");
    if (operation.edits.some((edit) => edit.endByte > source.length
      || (edit.startByte > 0 && (source[edit.startByte] & 0xc0) === 0x80)
      || (edit.endByte > 0 && edit.endByte < source.length && (source[edit.endByte] & 0xc0) === 0x80))) {
      return { status: "invalid" };
    }
    const chunks = [];
    let cursor = 0;
    for (const edit of operation.edits) {
      chunks.push(source.subarray(cursor, edit.startByte), Buffer.from(edit.replacement, "utf8"));
      cursor = edit.endByte;
    }
    chunks.push(source.subarray(cursor));
    const replacement = Buffer.concat(chunks);
    const value = replacement.toString("utf8");
    if (stableBytes(value) > MAX_VALUE_BYTES) return { status: "oversized" };
    reference.object[reference.key] = value;
    return { status: "ok" };
  }
  append(target, replacement) { const lineage = this.arrayLineage(target); if (!lineage) return { status: "stale" }; lineage.append(replacement); return { status: "ok" }; }
  replaceArrayElement(reference, operation) { if (reference.status !== "ok") return reference; this.arrayLineage(operation.target).replace(reference, operation.replacement); return { status: "ok" }; }
  deleteArrayElement(reference) {
    if (reference.status !== "ok") return reference;
    for (const lineage of this.collections.values()) if (lineage.entries.includes(reference.entry)) { lineage.delete(reference); return { status: "ok" }; }
    throw new Error("array resolution is not owned by this application context");
  }
}
function collectionReference(spec, collection) {
  const parts = collection.split("."); let object = spec;
  for (let index = 0; index < parts.length - 1; index += 1) object = object?.[parts[index]];
  const key = parts.at(-1); return Array.isArray(object?.[key]) ? { object, key, value: object[key] } : null;
}
function unique(values) { return new Set(values).size === values.length; }
/** Immutable-spec field lookup shared by triage existence and text capability checks. */
function immutableFieldReference(spec, target) {
  if (target instanceof SpecRepairRootTarget) {
    return Object.hasOwn(spec, target.field) ? { object: spec, key: target.field, value: spec[target.field] } : null;
  }
  if (target instanceof SpecRepairIdEntityTarget) {
    const entries = spec[target.domain];
    const matches = Array.isArray(entries) ? entries.filter((entry) => entry?.id === target.id) : [];
    return matches.length === 1 ? { object: matches[0], key: target.field, value: matches[0][target.field] } : null;
  }
  return null;
}
function targetExists(spec, target) {
  if (target instanceof SpecRepairRootTarget || target instanceof SpecRepairIdEntityTarget) return immutableFieldReference(spec, target) !== null;
  if (target instanceof SpecRepairArrayTarget) return collectionReference(spec, target.collection) !== null;
}
function addFieldTargetExists(spec, target) {
  if (!(target instanceof SpecRepairIdEntityTarget)) return false;
  const matches = Array.isArray(spec[target.domain]) ? spec[target.domain].filter((entry) => entry?.id === target.id) : [];
  return matches.length === 1 && !Object.hasOwn(matches[0], target.field);
}
function textTargetExists(spec, target) {
  return typeof immutableFieldReference(spec, target)?.value === "string";
}
/** Read-only inventory of the locations accepted by the repair grammar. */
export class SpecRepairTargetEntry {
  constructor(target, value, digest, exists = true) {
    if (!(target instanceof SpecRepairTarget)) throw new Error("Spec repair entry requires a typed target");
    this.target = target;
    this.value = exists && digest !== null ? frozen(value) : null;
    this.digest = digest;
    this.exists = exists;
    this.key = target.conflictKey(digest);
    if (target instanceof SpecRepairRootTarget) {
      this.operationKinds = Object.freeze(["replace-field", ...(typeof value === "string" ? ["edit-text-field"] : [])]);
    } else if (target instanceof SpecRepairIdEntityTarget) {
      const optional = SpecGateRepairIdEntityFieldDelete.supportsTarget(target);
      this.operationKinds = Object.freeze(exists
        ? ["replace-entity-field", ...(typeof value === "string" ? ["edit-text-field"] : []), ...(optional ? ["delete-entity-field"] : [])]
        : ["add-entity-field"]);
    } else {
      this.operationKinds = Object.freeze(target.position === null
        ? ["add-array-element", "replace-array-element", "delete-array-element"]
        : ["replace-array-element", "delete-array-element"]);
    }
    Object.freeze(this);
  }
  toJSON() { return { target: this.target.toJSON(), value: clone(this.value), digest: this.digest, exists: this.exists, key: this.key, operationKinds: [...this.operationKinds] }; }
}
export function specRepairTargetEntries(spec) {
  const entries = [];
  for (const field of REPLACE_ROOTS) {
    if (Object.hasOwn(spec, field)) {
      const target = new SpecRepairRootTarget({ entity: "spec", field }, "Spec target inventory");
      entries.push(new SpecRepairTargetEntry(target, spec[field], valueDigest(spec[field])));
    }
  }
  for (const [entity, fields] of [["requirement", REQUIREMENT_FIELDS], ["task", TASK_FIELDS]]) {
    for (const item of spec[`${entity}s`] ?? []) {
      for (const field of fields) {
        const exists = Object.hasOwn(item, field);
        if (!exists && !(entity === "requirement" ? OPTIONAL_REQUIREMENT_FIELDS : OPTIONAL_TASK_FIELDS).has(field)) continue;
        const target = new SpecRepairIdEntityTarget({ entity, id: item.id, field }, "Spec target inventory");
        entries.push(new SpecRepairTargetEntry(target, item[field], exists ? valueDigest(item[field]) : null, exists));
      }
    }
  }
  for (const collection of COLLECTION_TARGETS) {
    const reference = collectionReference(spec, collection);
    if (!reference) continue;
    entries.push(new SpecRepairTargetEntry(new SpecRepairArrayTarget({ collection }, "Spec target inventory"), null, null));
    reference.value.forEach((value, position) => {
      const target = new SpecRepairArrayTarget({ collection, position }, "Spec target inventory");
      entries.push(new SpecRepairTargetEntry(target, value, valueDigest(value)));
    });
  }
  return Object.freeze(entries);
}
function permissionSet(allowedTargets, spec, field, operationTypes = OPERATION_TYPES, PermissionType = SpecRepairPermission) {
  if (!Array.isArray(allowedTargets) || allowedTargets.length === 0) throw new Error("must declare allowedTargets");
  const permissions = allowedTargets.map((permission, index) => new PermissionType(permission, `${field}.allowedTargets[${index}]`, operationTypes, spec));
  if (!unique(permissions.map((permission) => PermissionType === SpecGateRepairPermission
    ? JSON.stringify(permission.target.toJSON()) : permission.target.permissionKey()))) throw new Error("has duplicate allowed target permissions");
  if (spec != null && permissions.some((permission) => permission.operationKinds.some((kind) => (
    kind === "add-entity-field" ? !addFieldTargetExists(spec, permission.target) : !targetExists(spec, permission.target)
  ) || operationTypes.get(kind).requiresStringTarget && !textTargetExists(spec, permission.target)))) {
    throw new Error("declares impossible targets");
  }
  return Object.freeze(permissions);
}
/** Both producers grant the same typed target/kind capability. */
export class SpecRepairAuthority {
  #entries;
  constructor(entries) { this.#entries = entries; }
  has(identifier) { return this.#entries.has(identifier); }
  allowsAny(identifiers, operation) {
    return identifiers.some((identifier) => this.#entries.get(identifier)?.some((permission) => permission.allows(operation)) ?? false);
  }
  allows(identifiers, operation) {
    return identifiers.every((identifier) => this.#entries.get(identifier)?.some((permission) => permission.allows(operation)) ?? false);
  }
}
export class SpecReviewRepairAuthority extends SpecRepairAuthority {
  constructor(triage, spec) {
    const entries = new Map();
    for (const [index, item] of (triage.findings ?? []).entries()) {
      if (item.disposition !== "apply") continue;
      const findingId = requiredText(item.findingId, `spec-triage apply item ${index}.findingId`);
      try { entries.set(findingId, permissionSet(item.allowedTargets, spec, `spec-triage apply item ${findingId}`)); }
      catch (cause) { throw new SpecRepairOperationsError("FLOW_SPEC_REPAIR_TRIAGE_TARGETS_INVALID", `spec-triage apply item ${findingId} ${cause.message}`, { retryable: false }); }
    }
    super(entries);
    Object.freeze(this);
  }
}
function triageMap(triage, spec) { return new SpecReviewRepairAuthority(triage, spec); }
export function validateSpecRepairTriageTargets(triage, spec) { triageMap(triage, spec); }
/** Validate one triage update so an invalid capability cannot poison siblings. */
export function validateSpecRepairTriageFinding(update, spec) {
  if (update?.disposition !== "apply") return;
  triageMap({ findings: [update] }, spec);
}

function operationAudit(operation, attempt) { const json = operation.operation ?? operation.toJSON?.() ?? operation; return Object.freeze({ operation: clone(json), operationDigest: operation.operationDigest ?? valueDigest(json), attempt }); }
function discardedAudit(entry, attempt) {
  return Object.freeze({
    findingIds: entry.findingIds ?? [], kind: entry.kind ?? null, target: entry.target ?? null,
    operationDigest: entry.operationDigest ?? valueDigest(entry), reason: entry.reason ?? "discarded operation", attempt,
  });
}
function commandOwnedAudit(batch, accepted, discarded, scopeExpansions = []) {
  return Object.freeze({
    version: 2, phase: "spec-repair", baseRevision: batch.baseRevision, attempts: Object.freeze([]),
    acceptedOperations: Object.freeze(accepted.map((operation) => operation.toJSON())), discardedOperations: Object.freeze(discarded), scopeExpansions: Object.freeze([...scopeExpansions]),
    appliedFindings: Object.freeze([...new Set(accepted.flatMap((operation) => operation.findingIds))].sort()), operationDigest: valueDigest({ accepted: accepted.map((operation) => operation.toJSON()), discarded }), resultRevision: null,
    audit: Object.freeze({}),
  });
}
function authorized(findings, operation) {
  return findings.allows(operation.findingIds, operation);
}
function currentAttemptConflictKeys(operations, keyFor = (operation) => operation.conflictKey()) {
  const groups = new Map();
  for (const operation of operations) {
    const key = keyFor(operation);
    const group = groups.get(key) ?? [];
    group.push(operation);
    groups.set(key, group);
  }
  return new Set([...groups.entries()]
    .filter(([, group]) => group.some((operation, index) => group.slice(index + 1).some((other) => !operation.isComposableWith(other))))
    .map(([key]) => key));
}

export function applySpecRepairOperations({ spec, triage, repair, inputRevision }) {
  const batch = repair instanceof SpecRepairOperationBatch ? repair : new SpecRepairOperationBatch(repair);
  if (batch.baseRevision !== revisionFor(inputRevision)) throw new SpecRepairOperationsError("FLOW_SPEC_REPAIR_BASE_REVISION_MISMATCH", "spec-repair operations do not match the immutable handoff revision", { retryable: false, audit: commandOwnedAudit(batch, [], []) });
  const permissions = triageMap(triage, spec);
  let candidate = clone(spec); let context = new SpecRepairApplicationContext(candidate, frozen(spec));
  const accepted = []; const acceptedThisAttempt = []; const discarded = [...batch.discardedOperations, ...batch.discardedScopeExpansions]; const touched = new Map();
  const replayAcceptedOperations = () => {
    candidate = clone(spec);
    context = new SpecRepairApplicationContext(candidate, frozen(spec));
    for (const acceptedOperation of accepted) {
      if (acceptedOperation.apply(context).status !== "ok") {
        throw new Error("accepted operation could not be replayed against its immutable base");
      }
    }
  };
  // Authorization is a per-operation decision.  An unauthorized proposal must
  // not poison an otherwise valid operation merely because it names the same
  // location; only authorized operations participate in conflict detection.
  const authorizedCurrentOperations = batch.operations.filter((operation) => {
    if (authorized(permissions, operation)) return true;
    discarded.push(discardedOperation(operation.toJSON(), "unauthorized operation"));
    return false;
  });
  const uniqueCurrentOperations = [];
  const sameContentOperations = new Map();
  for (const operation of authorizedCurrentOperations) {
    const operationDigest = semanticOperationDigest(operation);
    const existing = sameContentOperations.get(operationDigest);
    if (!existing) {
      sameContentOperations.set(operationDigest, operation);
      uniqueCurrentOperations.push(operation);
      continue;
    }
    const findingIds = [...new Set([...existing.findingIds, ...operation.findingIds])].sort();
    const Type = OPERATION_TYPES.get(existing.kind);
    const merged = new Type({ ...existing.toJSON(), findingIds }, 0);
    const index = uniqueCurrentOperations.indexOf(existing);
    uniqueCurrentOperations[index] = merged;
    sameContentOperations.set(operationDigest, merged);
  }
  const conflictingCurrentKeys = currentAttemptConflictKeys(uniqueCurrentOperations);
  for (const operation of uniqueCurrentOperations) {
    if (conflictingCurrentKeys.has(operation.conflictKey())) {
      discarded.push(discardedOperation(operation.toJSON(), "conflicting operation"));
      continue;
    }
    if (!authorized(permissions, operation)) { discarded.push(discardedOperation(operation.toJSON(), "unauthorized operation")); continue; }
    const conflict = touched.get(operation.conflictKey());
    if (conflict && !operation.isComposableWith(conflict)) {
      conflictingCurrentKeys.add(operation.conflictKey());
      discarded.push(discardedOperation(operation.toJSON(), "conflicting operation")); continue;
    }
    const result = operation.apply(context);
    if (result.status !== "ok") {
      const reason = result.status === "conflict" ? "conflicting target resolution"
        : result.status === "invalid" ? "invalid UTF-8 text edit target or range"
          : result.status === "oversized" ? "text edit result is oversized"
            : "stale target digest";
      discarded.push(discardedOperation(operation.toJSON(), reason)); continue;
    }
    try {
      validateSpecJsonObject(candidate);
    } catch {
      // Array lineages carry immutable-base positions. Replaying accepted work
      // rebuilds that lineage; cloning only the candidate would reinterpret
      // later positions after a prior delete.
      replayAcceptedOperations();
      discarded.push(discardedOperation(operation.toJSON(), "operation produces an invalid Spec schema"));
      continue;
    }
    touched.set(operation.conflictKey(), operation); accepted.push(operation); acceptedThisAttempt.push(operation);
  }
  const audit = commandOwnedAudit(batch, acceptedThisAttempt, discarded, batch.scopeExpansions);
  // Repair is a filter, not a completeness solver. A valid partial or empty
  // operation batch remains a successful handoff; the subsequent spec-gate
  // owns readiness/completeness decisions for the resulting canonical Spec.
  const finalAudit = Object.freeze({ ...audit, resultRevision: Object.freeze({ digest: valueDigest(candidate), byteLength: stableBytes(candidate) }), acceptedOperations: Object.freeze(acceptedThisAttempt.map((operation) => operationAudit(operation, 1))), discardedOperations: Object.freeze(discarded.map((entry) => discardedAudit(entry, 1))), scopeExpansions: Object.freeze(batch.scopeExpansions.map((proposal) => Object.freeze({ proposal, attempt: 1 }))) });
  return Object.freeze({ spec: Object.freeze(candidate), audit: finalAudit });
}

/** Gate capabilities come from the canonical Gate producer, never from a worker proposal. */
export class SpecGateRepairAuthority extends SpecRepairAuthority {
  #units;
  constructor({ baseRevision, findings, expectedUnits, spec }) {
    if (typeof baseRevision !== "string" || !SHA256_REVISION.test(baseRevision)) throw new Error("Spec Gate repair authority requires a SHA-256 base revision");
    if (!Array.isArray(findings)) throw new Error("Spec Gate repair authority requires findings");
    if (!Array.isArray(expectedUnits)) throw new Error("Spec Gate repair authority requires expected units");
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("Spec Gate repair authority requires the immutable Spec");
    const entries = new Map();
    for (const [index, finding] of findings.entries()) {
      const identity = new FlowFindingSourceIdentity(finding.identity);
      const key = identity.toString();
      if (entries.has(key)) throw new Error("Spec Gate repair authority has duplicate finding identities");
      entries.set(key, permissionSet(finding.allowedTargets, spec, `Spec Gate repair finding ${index}`, GATE_OPERATION_TYPES, SpecGateRepairPermission));
    }
    super(entries);
    const assigned = new Set();
    const units = new Set();
    for (const [index, unit] of expectedUnits.entries()) {
      exactKeys(unit, ["findingIdentities"], `Spec Gate repair unit ${index}`);
      if (!Array.isArray(unit.findingIdentities) || unit.findingIdentities.length === 0) throw new Error("Spec Gate repair unit requires finding identities");
      const keys = unit.findingIdentities.map((value) => {
        exactKeys(value, ["sourceArtifact", "sourceStep", "sourceFindingId", "fingerprint"], `Spec Gate repair unit ${index} finding identity`);
        return new FlowFindingSourceIdentity(value).toString();
      });
      if (!unique(keys) || keys.some((key) => !entries.has(key) || assigned.has(key))) throw new Error("Spec Gate repair units duplicate or omit authority");
      keys.forEach((key) => assigned.add(key));
      units.add(JSON.stringify([...keys].sort()));
    }
    if (assigned.size !== entries.size) throw new Error("Spec Gate repair units must cover every authorized finding");
    this.#units = units;
    this.baseRevision = baseRevision;
    Object.freeze(this);
  }
  authorizesGroup(group) {
    return this.#units.has(group.unitKey)
      && group.identityKeys.every((key) => this.has(key))
      && group.operations.every((operation) => this.allowsAny(group.identityKeys, operation));
  }
}

function gateOperationJSON(operation) {
  const { findingIds, ...json } = operation.toJSON();
  return json;
}
function gateGroupAudit(group, index) {
  return Object.freeze({
    index,
    findingIdentities: Object.freeze(group.identities.map((identity) => identity.toJSON())),
    operations: Object.freeze(group.operations.map(gateOperationJSON)),
  });
}
function rejectedGateGroup(group, index, reason) {
  return Object.freeze({ index, groupDigest: specRepairProposalDigest(group ?? null), reason: boundedErrorMessage(reason) });
}

/** A worker group is one indivisible semantic correction. */
export class SpecGateRepairOperationGroup {
  constructor(value, index) {
    exactKeys(value, ["findingIdentities", "operations"], `Spec Gate repair group ${index}`);
    if (!Array.isArray(value.findingIdentities) || value.findingIdentities.length === 0) throw new Error("Spec Gate repair group requires finding identities");
    this.identities = Object.freeze(value.findingIdentities.map((entry, identityIndex) => {
      exactKeys(entry, ["sourceArtifact", "sourceStep", "sourceFindingId", "fingerprint"], `Spec Gate repair group ${index} finding identity ${identityIndex}`);
      return new FlowFindingSourceIdentity(entry);
    }));
    this.identityKeys = Object.freeze(this.identities.map((identity) => identity.toString()));
    if (!unique(this.identityKeys)) throw new Error("Spec Gate repair group has duplicate finding identities");
    this.unitKey = JSON.stringify([...this.identityKeys].sort());
    if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > MAX_OPERATIONS) throw new Error("Spec Gate repair group operations are invalid");
    const operations = value.operations.map((operation, operationIndex) => {
      const Type = GATE_OPERATION_TYPES.get(operation?.kind);
      if (!Type) throw new Error(`Spec Gate repair group ${index} operation ${operationIndex} kind is invalid`);
      // The shared edit grammar uses findingIds for Review operations. Gate's
      // full identities live at group level; this key is internal to parsing.
      const keys = Object.keys(operation ?? {});
      if (keys.includes("findingIds")) throw new Error("Spec Gate operation must not declare Review findingIds");
      return new Type({ ...operation, findingIds: ["gate-group"] }, operationIndex);
    });
    const seen = new Set();
    this.operations = Object.freeze(operations.filter((operation) => {
      const digest = semanticOperationDigest(operation);
      if (seen.has(digest)) return false;
      seen.add(digest);
      return true;
    }));
    Object.freeze(this);
  }
}

export class SpecGateRepairOperationBatch {
  constructor(value) {
    exactKeys(value, ["version", "stage", "baseRevision", "groups"], "Spec Gate repair proposal");
    if (value.version !== 1 || value.stage !== "spec-gate-repair" || !SHA256_REVISION.test(value.baseRevision)
      || !Array.isArray(value.groups) || value.groups.length > MAX_OPERATIONS
      || value.groups.reduce((count, group) => count + (Array.isArray(group?.operations) ? group.operations.length : 1), 0) > MAX_OPERATIONS) {
      throw new Error("Spec Gate repair proposal envelope is invalid");
    }
    this.baseRevision = value.baseRevision;
    this.groups = Object.freeze(value.groups.map((group, index) => {
      try { return new SpecGateRepairOperationGroup(group, index); }
      catch (cause) { return rejectedGateGroup(group, index, cause.message); }
    }));
    Object.freeze(this);
  }
}

/** Applies every Gate group against one immutable baseline. One bad operation
 * rejects its entire group, while independent groups can still be adopted. */
export function applySpecGateRepairOperations({ spec, authority, repair, inputRevision }) {
  if (!(authority instanceof SpecGateRepairAuthority)) throw new Error("Spec Gate repair requires typed Gate authority");
  const batch = repair instanceof SpecGateRepairOperationBatch ? repair : new SpecGateRepairOperationBatch(repair);
  const revision = revisionFor(inputRevision);
  if (authority.baseRevision !== revision || batch.baseRevision !== revision) {
    throw new SpecRepairOperationsError("FLOW_SPEC_REPAIR_BASE_REVISION_MISMATCH", "Spec Gate repair does not match the immutable Spec revision");
  }
  const rejected = [];
  const proposed = [];
  const conflictContext = new SpecRepairApplicationContext(clone(spec), frozen(spec));
  for (const [index, group] of batch.groups.entries()) {
    if (!(group instanceof SpecGateRepairOperationGroup)) { rejected.push(group); continue; }
    if (!authority.authorizesGroup(group)) {
      rejected.push(rejectedGateGroup(gateGroupAudit(group, index), index, "unauthorized operation"));
      continue;
    }
    const claims = new Map(group.operations.map((operation) => [operation, conflictContext.conflictClaim(operation)]));
    const unresolved = [...claims.values()].find((claim) => claim.status !== "ok");
    if (unresolved) {
      rejected.push(rejectedGateGroup(gateGroupAudit(group, index), index,
        unresolved.status === "conflict" ? "conflicting target resolution" : "stale target digest"));
      continue;
    }
    const conflictKeys = new Map([...claims].map(([operation, claim]) => [operation, claim.key]));
    const operationDigests = new Map(group.operations.map((operation) => [operation, semanticOperationDigest(operation, conflictKeys.get(operation))]));
    const seenDigests = new Set();
    const operations = group.operations.filter((operation) => {
      const digest = operationDigests.get(operation);
      if (seenDigests.has(digest)) return false;
      seenDigests.add(digest);
      return true;
    });
    const conflicts = currentAttemptConflictKeys(operations, (operation) => conflictKeys.get(operation));
    if (conflicts.size > 0) {
      rejected.push(rejectedGateGroup(gateGroupAudit(group, index), index, "conflicting operation"));
      continue;
    }
    proposed.push({ group, index, operations, conflictKeys, operationDigests });
  }
  const proposalsByUnit = new Map();
  for (const proposal of proposed) {
    const sameUnit = proposalsByUnit.get(proposal.group.unitKey) ?? [];
    sameUnit.push(proposal);
    proposalsByUnit.set(proposal.group.unitKey, sameUnit);
  }
  const duplicateUnits = new Set([...proposalsByUnit.values()].filter((sameUnit) => sameUnit.length > 1).flat());
  // Resolve competing proposals before adoption so no worker or input order
  // can win a target after another group has already changed it.
  const byTarget = new Map();
  for (const proposal of proposed.filter((entry) => !duplicateUnits.has(entry))) {
    for (const operation of proposal.operations) {
      const key = proposal.conflictKeys.get(operation);
      const claims = byTarget.get(key) ?? [];
      claims.push({ proposal, operation, digest: proposal.operationDigests.get(operation) });
      byTarget.set(key, claims);
    }
  }
  const conflictingGroups = new Set();
  for (const claims of byTarget.values()) {
    for (let left = 0; left < claims.length; left += 1) {
      for (let right = left + 1; right < claims.length; right += 1) {
        const first = claims[left]; const second = claims[right];
        if (first.proposal === second.proposal) continue;
        if (first.digest !== second.digest
          && !first.operation.isComposableWith(second.operation)) {
          conflictingGroups.add(first.proposal); conflictingGroups.add(second.proposal);
        }
      }
    }
  }
  const accepted = [];
  const acceptedOperations = [];
  const acceptedDigests = new Set();
  let candidate = clone(spec);
  for (const proposal of proposed) {
    const { group, index } = proposal;
    if (duplicateUnits.has(proposal)) {
      rejected.push(rejectedGateGroup(gateGroupAudit(group, index), index, "duplicate repair unit"));
      continue;
    }
    if (conflictingGroups.has(proposal)) {
      rejected.push(rejectedGateGroup(gateGroupAudit(group, index), index, "conflicting operation"));
      continue;
    }
    const fresh = proposal.operations.filter((operation) => !acceptedDigests.has(proposal.operationDigests.get(operation)));
    // Reconstruct immutable-base array lineage before every staged group. A
    // prior deletion must never reinterpret a later base position.
    const staged = clone(spec);
    const context = new SpecRepairApplicationContext(staged, frozen(spec));
    let failure = null;
    for (const operation of [...acceptedOperations, ...fresh]) {
      const result = operation.apply(context);
      if (result.status !== "ok") {
        failure = result.status === "conflict" ? "conflicting target resolution"
          : result.status === "invalid" ? "invalid UTF-8 text edit target or range"
            : result.status === "oversized" ? "text edit result is oversized"
              : "stale target digest";
        break;
      }
    }
    if (failure === null) {
      try { validateSpecJsonObject(staged); }
      catch { failure = "group produces an invalid Spec schema"; }
    }
    if (failure !== null) {
      rejected.push(rejectedGateGroup(gateGroupAudit(group, index), index, failure));
      continue;
    }
    candidate = staged;
    accepted.push(gateGroupAudit(group, index));
    acceptedOperations.push(...fresh);
    for (const operation of proposal.operations) acceptedDigests.add(proposal.operationDigests.get(operation));
  }
  const audit = Object.freeze({
    version: 1, phase: "spec-gate-repair", baseRevision: revision,
    acceptedGroups: Object.freeze(accepted), discardedGroups: Object.freeze(rejected.sort((a, b) => a.index - b.index)),
    operationDigest: valueDigest({ accepted, rejected }),
    resultRevision: Object.freeze({ digest: valueDigest(candidate), byteLength: stableBytes(candidate) }),
  });
  return Object.freeze({ spec: Object.freeze(candidate), audit });
}
