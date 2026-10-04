import { createHash } from "node:crypto";
import { FlowFindingSourceIdentity } from "./flow-finding-source.js";
import { compareText } from "./text-order.js";

export function specGateRepairValueDigest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function freezeSpecGateRepairValue(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeSpecGateRepairValue); Object.freeze(value); }
  return value;
}
export function specGateRepairFindingIdentity(value) { return value instanceof FlowFindingSourceIdentity ? value : new FlowFindingSourceIdentity(value); }
/** A canonical field, with stable entity identity rather than an array ordinal. */
export class SpecGateRepairRange {
  constructor({ id, path, value, entity = null, target = null, digest = specGateRepairValueDigest(value), collectionAnchor = false, exists = true }) {
    this.id = id;
    this.path = path;
    this.value = freezeSpecGateRepairValue(structuredClone(value));
    this.entity = entity;
    this.target = target;
    this.digest = digest;
    this.collectionAnchor = collectionAnchor;
    this.exists = exists;
    Object.freeze(this);
  }
  descriptor() {
    return { id: this.id, path: this.path, entity: this.entity, digest: this.digest,
      target: this.target?.toJSON() ?? null, collectionAnchor: this.collectionAnchor, exists: this.exists };
  }
  toJSON({ writable = false } = {}) { return { ...this.descriptor(), writable, value: this.value }; }
}

export class SpecGateRepairFinding {
  constructor(value, rangeIds = []) {
    this.identity = specGateRepairFindingIdentity(value.identity);
    if (typeof value.requirementRef !== "string" || !value.requirementRef
      || typeof value.observed !== "string" || !value.observed) {
      throw new TypeError("Gate repair finding requires its rule and complete reason");
    }
    this.requirementRef = value.requirementRef;
    this.observed = value.observed;
    this.where = freezeSpecGateRepairValue(structuredClone(value.where ?? null));
    this.targets = freezeSpecGateRepairValue(structuredClone(value.targets ?? []));
    this.allowedTargets = freezeSpecGateRepairValue(structuredClone(value.allowedTargets ?? []));
    this.specRevision = value.specRevision ?? null;
    this.rangeIds = Object.freeze([...rangeIds].sort());
    Object.freeze(this);
  }
  toJSON() {
    return { identity: this.identity.toJSON(), requirementRef: this.requirementRef,
      observed: this.observed, where: this.where, targets: this.targets,
      allowedTargets: this.allowedTargets, ...(this.specRevision === null ? {} : { specRevision: this.specRevision }),
      rangeIds: this.rangeIds };
  }
}

/** Connected findings form one indivisible proposal, even across several fields. */
export class SpecGateRepairUnit {
  constructor(findings) {
    this.findings = Object.freeze([...findings].sort((a, b) => compareText(a.identity.toString(), b.identity.toString())));
    this.rangeIds = Object.freeze([...new Set(findings.flatMap((item) => item.rangeIds))].sort());
    this.id = `repair-unit:${specGateRepairValueDigest(this.findings.map((item) => item.identity.toJSON()))}`;
    Object.freeze(this);
  }
  toJSON() { return { id: this.id, rangeIds: this.rangeIds, findings: this.findings.map((item) => item.toJSON()) }; }
}

export class SpecGateRepairSelection {
  constructor({ baseRevision, unit, ranges, guardrails, acknowledgedRationale, indexManifest }) {
    this.baseRevision = baseRevision;
    this.unit = unit;
    this.indexManifest = indexManifest instanceof SpecGateRepairIndexManifest ? indexManifest : new SpecGateRepairIndexManifest(indexManifest);
    this.ranges = freezeSpecGateRepairValue(ranges);
    this.guardrails = freezeSpecGateRepairValue(structuredClone(guardrails));
    this.acknowledgedRationale = acknowledgedRationale;
    Object.freeze(this);
  }
  toJSON() {
    return { baseRevision: this.baseRevision, unit: this.unit.toJSON(), ranges: this.ranges,
      guardrails: this.guardrails, acknowledgedRationale: this.acknowledgedRationale, indexManifest: this.indexManifest.toJSON() };
  }
}

export const SPEC_GATE_REPAIR_INDEX_PAGE_SIZE = 32;

/** Deterministic navigation of the complete registered descriptor inventory. */
export class SpecGateRepairIndexManifest {
  constructor(value) {
    if (!value || Object.keys(value).sort().join(",") !== "descriptorCount,firstPageId,pageCount,revision,version") {
      throw new TypeError("Invalid repair index manifest");
    }
    const { version, revision, descriptorCount, pageCount, firstPageId } = value;
    if (version !== 1 || !/^sha256:[a-f0-9]{64}$/.test(revision)
      || !Number.isSafeInteger(descriptorCount) || descriptorCount < 1
      || !Number.isSafeInteger(pageCount) || pageCount !== Math.ceil(descriptorCount / SPEC_GATE_REPAIR_INDEX_PAGE_SIZE)
      || firstPageId !== `repair-index:${revision}:0`) throw new TypeError("Invalid repair index manifest");
    this.version = version; this.revision = revision; this.descriptorCount = descriptorCount;
    this.pageCount = pageCount; this.firstPageId = firstPageId;
    Object.freeze(this);
  }
  toJSON() { return { version: this.version, revision: this.revision, descriptorCount: this.descriptorCount,
    pageCount: this.pageCount, firstPageId: this.firstPageId }; }
}
