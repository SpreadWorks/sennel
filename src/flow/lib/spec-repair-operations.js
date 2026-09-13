import crypto from "node:crypto";
import { validateSpecJsonObject } from "../../lib/spec-json.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_REVISION = /^sha256:([a-f0-9]{64})$/;
const MAX_OPERATIONS = 64;
const MAX_VALUE_BYTES = 32 * 1024;
const MAX_ATTEMPT_ERROR_BYTES = 1024;
const COLLECTION_TARGETS = new Set([
  "scope.in", "scope.out", "constraints", "design_principles", "acceptance_criteria",
  "clarifications", "alternatives_considered", "open_questions", "overview.modules", "overview.data_flow",
  "overview.decisions", "keywords", "implementationTargets",
]);
const REPLACE_ROOTS = new Set(["goal", "background"]);
const REQUIREMENT_FIELDS = new Set(["desc", "priority", "testable", "preimplementation_test_expectation"]);
const TASK_FIELDS = new Set(["title", "goal", "acceptance", "implementation_notes"]);
const OPERATION_TYPES = new Map();

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
/** Finds the actual edit, independent of worker prose or which finding named it. */
function semanticOperationDigest(operation) {
  const json = operation.toJSON?.() ?? operation;
  return crypto.createHash("sha256").update(canonicalJson({
    kind: json.kind, target: json.target, expectedDigest: json.expectedDigest,
    ...(Object.hasOwn(json, "replacement") ? { replacement: json.replacement } : {}),
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
  constructor(value, field) {
    exactKeys(value, ["target", "operationKinds"], field);
    this.target = SpecRepairTarget.fromJSON(value.target, `${field}.target`);
    if (!Array.isArray(value.operationKinds) || value.operationKinds.length === 0 || new Set(value.operationKinds).size !== value.operationKinds.length) throw new Error(`${field}.operationKinds must be a non-empty unique array`);
    for (const kind of value.operationKinds) {
      if (!OPERATION_TYPES.has(kind)) throw new Error(`${field}.operationKinds contains an invalid kind`);
      if (!OPERATION_TYPES.get(kind).supportsTarget(this.target)) throw new Error(`${field}.operationKinds is incompatible with its target`);
    }
    this.operationKinds = Object.freeze([...value.operationKinds]); Object.freeze(this);
  }
  allows(operation) { return this.target.permissionKey() === operation.target.permissionKey() && this.operationKinds.includes(operation.kind); }
  toJSON() { return { target: this.target.toJSON(), operationKinds: [...this.operationKinds] }; }
}

export class SpecRepairOperation {
  constructor(input, index, { replacementRequired = true } = {}) {
    const keys = ["findingIds", "kind", "target", "expectedDigest", "reason"];
    if (replacementRequired) keys.push("replacement");
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
    if (input.expectedDigest !== null && !SHA256.test(input.expectedDigest)) throw new Error(`spec-repair.operations[${index}].expectedDigest must be SHA-256 or null`);
    this.expectedDigest = input.expectedDigest;
  }
  toJSON() {
    return {
      findingIds: [...this.findingIds], kind: this.kind, target: this.target.toJSON(), expectedDigest: this.expectedDigest,
      ...(this.replacementRequired ? { replacement: clone(this.replacement) } : {}), reason: this.reason,
    };
  }
  conflictKey() { return this.target.conflictKey(this.expectedDigest); }
  isComposableWith() { return false; }
  resolve(context) { return this.target.resolve(context, this.expectedDigest); }
  apply() { throw new Error("SpecRepairOperation subclasses implement apply"); }
  static supportsTarget() { return false; }
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
OPERATION_TYPES.set("add-array-element", SpecRepairArrayAdd);
OPERATION_TYPES.set("replace-array-element", SpecRepairArrayReplace);
OPERATION_TYPES.set("delete-array-element", SpecRepairArrayDelete);

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
  replace(reference, operation) {
    if (reference.status !== "ok") return reference;
    if (valueDigest(reference.value) !== operation.expectedDigest) return { status: "stale" };
    reference.object[reference.key] = clone(operation.replacement); return { status: "ok" };
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
function targetExists(spec, target) {
  if (target instanceof SpecRepairRootTarget) return Object.hasOwn(spec, target.field);
  if (target instanceof SpecRepairArrayTarget) return collectionReference(spec, target.collection) !== null;
  const entries = spec[target.domain]; return Array.isArray(entries) && entries.filter((entry) => entry?.id === target.id).length === 1;
}
function triageMap(triage, spec) {
  const values = new Map();
  for (const [index, item] of (triage.findings ?? []).entries()) {
    if (item.disposition !== "apply") continue;
    const findingId = requiredText(item.findingId, `spec-triage apply item ${index}.findingId`);
    try {
      if (!Array.isArray(item.allowedTargets) || item.allowedTargets.length === 0) throw new Error("must declare allowedTargets");
      const permissions = item.allowedTargets.map((permission, permissionIndex) => new SpecRepairPermission(permission, `spec-triage apply item ${findingId}.allowedTargets[${permissionIndex}]`));
      if (!unique(permissions.map((permission) => permission.target.permissionKey()))) throw new Error("has duplicate allowed target permissions");
      if (spec != null && permissions.map((permission) => permission.target).some((target) => !targetExists(spec, target))) throw new Error("declares impossible targets");
      values.set(findingId, Object.freeze({ permissions: Object.freeze(permissions) }));
    } catch (cause) { throw new SpecRepairOperationsError("FLOW_SPEC_REPAIR_TRIAGE_TARGETS_INVALID", `spec-triage apply item ${findingId} ${cause.message}`, { retryable: false }); }
  }
  return values;
}
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
  return operation.findingIds.every((findingId) => findings.get(findingId)?.permissions.some((permission) => permission.allows(operation)) ?? false);
}
function currentAttemptConflictKeys(operations) {
  const groups = new Map();
  for (const operation of operations) {
    const key = operation.conflictKey();
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
      discarded.push(discardedOperation(operation.toJSON(), result.status === "conflict" ? "conflicting target resolution" : "stale target digest")); continue;
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
