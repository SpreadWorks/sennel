import crypto from "node:crypto";

import { validateDraftLifecycleForCompletion } from "./draft-lifecycle.js";
import { GateObservationRepair } from "./gate-observation-convergence.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_REVISION = /^sha256:([a-f0-9]{64})$/;
const MAX_OPERATIONS = 64;
const MAX_ENVELOPE_ERRORS = 3;
const MAX_REPLACEMENT_BYTES = 32 * 1024;
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
const MAX_PATH_SEGMENTS = 24;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const GATE_AUTHORED_PATHS = Object.freeze([
  "devType",
  "goal",
  "analysis",
  "decisionMap.knownFacts",
  "decisionMap.decisionPoints",
  "decisionMap.resolvedByProjectRules",
  "decisionMap.deferredToSpec",
  "scopeVerification",
  "impactOnExisting",
]);

function clone(value) { return structuredClone(value); }
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function byteLength(value) { return Buffer.byteLength(JSON.stringify(value)); }
function canonicalDraftByteLength(value) { return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`); }
function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}
function exactKeys(value, expected, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${field} has an invalid schema`);
}
function findingKey(value) { return `${value.title}\0${value.target}`; }
function frozen(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
function discardedOperation(value, reason) {
  const operation = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return frozen({
    title: typeof operation.title === "string" ? operation.title : null,
    target: typeof operation.target === "string" ? operation.target : null,
    kind: typeof operation.kind === "string" ? operation.kind : null,
    path: typeof operation.path === "string" ? operation.path : null,
    operationDigest: digest(value),
    reason,
  });
}
/** A field path is a bounded, data-only location in the immutable draft. */
export class DraftRepairPath {
  constructor(value, field = "draft repair path") {
    this.value = requiredText(value, field);
    this.segments = Object.freeze(this.#parse(field));
    Object.freeze(this);
  }

  #parse(field) {
    const segments = [];
    let cursor = 0;
    while (cursor < this.value.length) {
      const property = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.value.slice(cursor));
      if (!property) throw new Error(`${field} is invalid`);
      if (FORBIDDEN_PATH_SEGMENTS.has(property[0])) throw new Error(`${field} is invalid`);
      segments.push(property[0]);
      cursor += property[0].length;
      while (this.value[cursor] === "[") {
        const match = /^\[(0|[1-9]\d*)\]/.exec(this.value.slice(cursor));
        if (!match) throw new Error(`${field} is invalid`);
        segments.push(Number(match[1]));
        cursor += match[0].length;
      }
      if (cursor === this.value.length) break;
      if (this.value[cursor] !== ".") throw new Error(`${field} is invalid`);
      cursor += 1;
      if (cursor === this.value.length) throw new Error(`${field} is invalid`);
    }
    if (segments.length > MAX_PATH_SEGMENTS) throw new Error(`${field} is too deep`);
    return segments;
  }

  resolve(root) {
    let object = root;
    for (let index = 0; index < this.segments.length - 1; index += 1) {
      const key = this.segments[index];
      if (object === null || typeof object !== "object" || !Object.hasOwn(object, key)) return null;
      object = object[key];
    }
    const key = this.segments.at(-1);
    if (object === null || typeof object !== "object" || !Object.hasOwn(object, key)) return null;
    return { object, key, value: object[key] };
  }
}

export class DraftRepairOperation {
  constructor(value, index, { includeFindingIdentity = true } = {}) {
    exactKeys(value, [
      ...(includeFindingIdentity ? ["title", "target"] : []),
      "kind", "path", "expectedDigest", "replacement", "reason",
    ], `draft-repair.operations[${index}]`);
    this.title = includeFindingIdentity ? requiredText(value.title, `draft-repair.operations[${index}].title`) : null;
    this.target = includeFindingIdentity ? requiredText(value.target, `draft-repair.operations[${index}].target`) : null;
    this.kind = requiredText(value.kind, `draft-repair.operations[${index}].kind`);
    if (this.kind !== "replace-value") throw new Error(`draft-repair.operations[${index}].kind is invalid`);
    this.path = new DraftRepairPath(value.path, `draft-repair.operations[${index}].path`);
    if (!SHA256.test(value.expectedDigest ?? "")) throw new Error(`draft-repair.operations[${index}].expectedDigest must be a SHA-256 digest`);
    if (byteLength(value.replacement) > MAX_REPLACEMENT_BYTES) throw new Error(`draft-repair.operations[${index}].replacement is oversized`);
    this.expectedDigest = value.expectedDigest;
    this.replacement = frozen(clone(value.replacement));
    this.reason = requiredText(value.reason, `draft-repair.operations[${index}].reason`);
    Object.freeze(this);
  }

  findingKey() {
    if (this.title === null || this.target === null) throw new Error("draft repair operation has no triage finding identity");
    return findingKey(this);
  }
  toJSON() {
    return {
      ...(this.title === null ? {} : { title: this.title, target: this.target }),
      kind: this.kind, path: this.path.value,
      expectedDigest: this.expectedDigest, replacement: clone(this.replacement), reason: this.reason,
    };
  }
}

export class DraftRepairOperationBatch {
  constructor(document, { strict = false, includeFindingIdentity = true, envelopeFields = [] } = {}) {
    const source = document && typeof document === "object" && !Array.isArray(document) ? document : {};
    this.baseRevision = typeof source.baseRevision === "string" && SHA256_REVISION.test(source.baseRevision)
      ? source.baseRevision
      : null;
    this.envelopeErrors = Object.freeze([
      ...(source.version === 1 ? [] : ["draft repair version is invalid"]),
      ...(this.baseRevision === null ? ["draft repair baseRevision is invalid"] : []),
      ...(Array.isArray(source.operations) && source.operations.length <= MAX_OPERATIONS ? [] : ["draft repair operations are invalid"]),
      ...(strict ? (() => {
        try {
          exactKeys(source, ["version", "baseRevision", "operations", ...envelopeFields], "draft repair");
          return [];
        } catch (error) { return [error.message]; }
      })() : []),
    ].slice(0, MAX_ENVELOPE_ERRORS));
    const operations = [];
    const discarded = [];
    if (Array.isArray(source.operations) && source.operations.length <= MAX_OPERATIONS) {
      source.operations.forEach((operation, index) => {
        try { operations.push(new DraftRepairOperation(operation, index, { includeFindingIdentity })); }
        catch (error) { discarded.push(discardedOperation(operation, error.message)); }
      });
    }
    this.operations = Object.freeze(operations);
    this.discardedOperations = Object.freeze(discarded);
    Object.freeze(this);
  }
}

export class DraftGateRepairAuthority {
  constructor(repair) {
    if (!(repair instanceof GateObservationRepair)) {
      throw new Error("draft Gate repair authority requires a typed Gate observation repair");
    }
    this.repair = repair;
    this.allowedPaths = Object.freeze(GATE_AUTHORED_PATHS.map((value) => new DraftRepairPath(value)));
    Object.freeze(this);
  }

  permits(path) {
    if (!(path instanceof DraftRepairPath)) throw new Error("draft Gate repair authority requires a typed path");
    return this.allowedPaths.some((allowed) => {
      if (path.segments.length < allowed.segments.length) return false;
      return allowed.segments.every((segment, index) => path.segments[index] === segment);
    });
  }

  static authoringPaths() { return Object.freeze([...GATE_AUTHORED_PATHS]); }
}

export class DraftRepairOperationsError extends Error {
  constructor(code, message, audit) {
    super(message);
    this.name = "DraftRepairOperationsError";
    this.code = code;
    this.audit = audit;
  }
}

function triagePermissions(triage) {
  const values = new Map();
  for (const item of triage?.items ?? []) {
    if (item?.decision !== "apply") continue;
    const key = findingKey(item);
    const allowed = Array.isArray(item.allowedFieldPaths) ? item.allowedFieldPaths : [];
    const required = Array.isArray(item.requiredFieldPaths) ? item.requiredFieldPaths : [];
    try {
      const allowedPaths = allowed.map((path, index) => new DraftRepairPath(path, `triage ${key} allowedFieldPaths[${index}]`));
      const requiredPaths = required.map((path, index) => new DraftRepairPath(path, `triage ${key} requiredFieldPaths[${index}]`));
      if (allowedPaths.length === 0 || requiredPaths.length === 0) throw new Error("does not declare allowed and required field paths");
      if (new Set(allowedPaths.map((path) => path.value)).size !== allowedPaths.length) throw new Error("duplicates allowed field paths");
      if (new Set(requiredPaths.map((path) => path.value)).size !== requiredPaths.length) throw new Error("duplicates required field paths");
      if (requiredPaths.some((path) => !allowedPaths.some((allowedPath) => allowedPath.value === path.value))) throw new Error("declares a required field path outside allowed field paths");
      values.set(key, frozen({ allowedPaths, requiredPaths }));
    } catch (error) {
      values.set(key, frozen({ allowedPaths: [], requiredPaths: [], error: error.message }));
    }
  }
  return values;
}

export function validateDraftRepairTriage(triage) {
  const permissions = triagePermissions(triage);
  const issues = [];
  for (const [key, permission] of permissions) {
    if (permission.error) issues.push(`draft triage apply item ${key} ${permission.error}`);
  }
  return Object.freeze(issues);
}

/**
 * Applies only triage-granted replacements to a clone of the immutable draft.
 * Every worker failure is a discarded proposal: publishing the untouched draft
 * remains safe and leaves lifecycle judgment to the downstream draft gate.
 */
export function applyDraftRepairOperations({ draft, triage = null, repair, inputRevision, phase, authority = null }) {
  if (authority !== null && !(authority instanceof DraftGateRepairAuthority)) {
    throw new Error("draft repair requires a typed Gate authority");
  }
  const gateOwned = authority !== null;
  const batch = repair instanceof DraftRepairOperationBatch ? repair : new DraftRepairOperationBatch(repair, gateOwned ? {
    strict: true,
    includeFindingIdentity: false,
    envelopeFields: ["report"],
  } : {});
  const candidate = clone(draft);
  const permissions = gateOwned ? new Map() : triagePermissions(triage);
  const accepted = [];
  const discarded = [...batch.discardedOperations];
  const required = new Map();
  for (const [key, permission] of permissions) {
    for (const path of permission.requiredPaths) required.set(`${key}\0${path.value}`, { key, path: path.value });
  }
  const baseMatches = batch.baseRevision === `sha256:${inputRevision}`;
  const duplicatePaths = new Set();
  const seenPaths = new Set();
  for (const operation of batch.operations) {
    if (seenPaths.has(operation.path.value)) duplicatePaths.add(operation.path.value);
    seenPaths.add(operation.path.value);
  }
  const overlappingPaths = gateOwned ? batch.operations.flatMap((operation, index) => (
    batch.operations.slice(index + 1).flatMap((other) => {
      const common = Math.min(operation.path.segments.length, other.path.segments.length);
      const overlaps = operation.path.segments.slice(0, common)
        .every((segment, segmentIndex) => segment === other.path.segments[segmentIndex]);
      return overlaps ? [operation.path.value, other.path.value] : [];
    })
  )) : [];
  const conflictingPaths = new Set([...duplicatePaths, ...overlappingPaths]);
  for (const operation of batch.operations) {
    if (batch.envelopeErrors.length > 0) {
      discarded.push(discardedOperation(operation.toJSON(), "invalid repair envelope"));
      continue;
    }
    if (!baseMatches) { discarded.push(discardedOperation(operation.toJSON(), "base revision mismatch")); continue; }
    if (gateOwned && conflictingPaths.has(operation.path.value)) {
      discarded.push(discardedOperation(operation.toJSON(), "duplicate or overlapping target path")); continue;
    }
    const permitted = gateOwned
      ? authority.permits(operation.path)
      : (() => {
          const permission = permissions.get(operation.findingKey());
          return permission !== undefined && !permission.error
            && permission.allowedPaths.some((path) => path.value === operation.path.value);
        })();
    if (!permitted) {
      discarded.push(discardedOperation(operation.toJSON(), "unauthorized operation")); continue;
    }
    const sourceReference = operation.path.resolve(gateOwned ? draft : candidate);
    const targetReference = operation.path.resolve(candidate);
    if (sourceReference === null || targetReference === null || digest(sourceReference.value) !== operation.expectedDigest) {
      discarded.push(discardedOperation(operation.toJSON(), "stale target")); continue;
    }
    targetReference.object[targetReference.key] = clone(operation.replacement);
    accepted.push(operation);
  }
  const acceptedKeys = new Set(gateOwned ? [] : accepted.map((operation) => `${operation.findingKey()}\0${operation.path.value}`));
  const missingRequiredTargets = [...required.entries()]
    .filter(([key]) => !acceptedKeys.has(key))
    .map(([, value]) => value);
  const lifecycleIssues = validateDraftLifecycleForCompletion(candidate);
  const outputByteLength = canonicalDraftByteLength(candidate);
  const audit = frozen({
    version: 2,
    phase,
    ...(gateOwned ? {
      sourceAuthority: {
        kind: "plan-gate-repair",
        repairId: authority.repair.repairId,
        recordFingerprint: authority.repair.recordFingerprint,
      },
    } : { sourceTriage: `${phase.replace(/-repair$/, "")}-triage.json` }),
    baseRevision: batch.baseRevision,
    acceptedOperations: accepted.map((operation) => operation.toJSON()),
    discardedOperations: discarded,
    appliedFindingKeys: gateOwned ? [] : [...new Set(accepted.map((operation) => operation.findingKey()))],
    operationDigest: digest({ accepted: accepted.map((operation) => operation.toJSON()), discarded }),
    audit: {
      envelopeErrors: [...batch.envelopeErrors],
      baseRevisionMatches: baseMatches,
      missingRequiredTargets,
      lifecycleIssues,
      duplicatePaths: [...duplicatePaths],
      overlappingPaths: [...new Set(overlappingPaths)],
      outputByteLength,
    },
  });
  if (gateOwned) {
    const errors = [
      ...batch.envelopeErrors,
      ...(!baseMatches ? ["draft Gate repair base revision mismatch"] : []),
      ...(discarded.length > 0 ? ["draft Gate repair contains rejected operations"] : []),
      ...(outputByteLength > MAX_DRAFT_BYTES ? ["draft Gate repair output is oversized"] : []),
      ...lifecycleIssues,
    ];
    if (errors.length > 0) {
      throw new DraftRepairOperationsError(
        "FLOW_DRAFT_GATE_REPAIR_INVALID",
        `draft Gate repair batch is invalid: ${errors.join("; ")}`,
        audit,
      );
    }
  }
  return frozen({ draft: candidate, audit });
}
