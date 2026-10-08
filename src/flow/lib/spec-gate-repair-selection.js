import { createHash } from "node:crypto";
import { FlowFindingSourceIdentity } from "./flow-finding-source.js";
import { compareText } from "./text-order.js";
import { isDeepStrictEqual } from "node:util";
import { workerArtifactStableStringify } from "./worker-artifact-input-format.js";
import { SpecRepairTarget, parseSpecGateRepairPermissions } from "./spec-repair-operations.js";
import { SpecGateRepairSourceRange } from "./spec-gate-repair-values.js";

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

/** Repair wire boundaries share exact-field admission while retaining their error contract. */
export function assertSpecGateRepairFields(value, keys, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) throw new TypeError(message);
}

/** A route commits the descriptor bounds and contents of one canonical page. */
export class SpecGateRepairIndexPageRoute {
  constructor(value) {
    assertSpecGateRepairFields(value, ["id", "page", "descriptorCount", "firstDescriptorId", "lastDescriptorId", "sourceOrigins", "digest"], "Invalid repair index page route");
    if (typeof value.id !== "string" || !Number.isSafeInteger(value.page) || value.page < 0
      || !Number.isSafeInteger(value.descriptorCount) || value.descriptorCount < 1 || value.descriptorCount > SPEC_GATE_REPAIR_INDEX_PAGE_SIZE
      || typeof value.firstDescriptorId !== "string" || !value.firstDescriptorId
      || typeof value.lastDescriptorId !== "string" || compareText(value.firstDescriptorId, value.lastDescriptorId) > 0
      || !/^[a-f0-9]{64}$/.test(value.digest)
      || !Array.isArray(value.sourceOrigins) || value.sourceOrigins.some((origin, index) => typeof origin !== "string" || !origin
        || index > 0 && compareText(value.sourceOrigins[index - 1], origin) >= 0)) throw new TypeError("Invalid repair index page route");
    Object.assign(this, value, { sourceOrigins: Object.freeze([...value.sourceOrigins]) });
    Object.freeze(this);
  }
  static fromPage(page) {
    return new this({ id: `repair-index:${page.revision}:${page.page}`, page: page.page,
      descriptorCount: page.descriptors.length, firstDescriptorId: page.descriptors[0].id,
      lastDescriptorId: page.descriptors.at(-1).id,
      sourceOrigins: [...new Set(page.descriptors.flatMap((entry) => entry.source ? [entry.source.origin] : []))].sort(compareText),
      digest: specGateRepairValueDigest(workerArtifactStableStringify(page)) });
  }
  toJSON() { return { ...this, sourceOrigins: [...this.sourceOrigins] }; }
}

/** Deterministic navigation of the complete registered descriptor inventory. */
export class SpecGateRepairIndexManifest {
  constructor(value) {
    assertSpecGateRepairFields(value, ["version", "revision", "descriptorCount", "pageCount", "firstPageId", "pageRoutes"], "Invalid repair index manifest");
    const { version, revision, descriptorCount, pageCount, firstPageId, pageRoutes } = value;
    if (version !== 2 || !/^sha256:[a-f0-9]{64}$/.test(revision)
      || !Number.isSafeInteger(descriptorCount) || descriptorCount < 1
      || !Number.isSafeInteger(pageCount) || pageCount !== Math.ceil(descriptorCount / SPEC_GATE_REPAIR_INDEX_PAGE_SIZE)
      || firstPageId !== `repair-index:${revision}:0` || !Array.isArray(pageRoutes) || pageRoutes.length !== pageCount) throw new TypeError("Invalid repair index manifest");
    this.pageRoutes = Object.freeze(pageRoutes.map((route) => new SpecGateRepairIndexPageRoute(route)));
    if (this.pageRoutes.some((route, page) => route.page !== page || route.id !== `repair-index:${revision}:${page}`
      || route.descriptorCount !== Math.min(SPEC_GATE_REPAIR_INDEX_PAGE_SIZE, descriptorCount - page * SPEC_GATE_REPAIR_INDEX_PAGE_SIZE)
      || page > 0 && compareText(this.pageRoutes[page - 1].lastDescriptorId, route.firstDescriptorId) >= 0)) {
      throw new Error("Invalid repair index route ordering or revision");
    }
    this.version = version; this.revision = revision; this.descriptorCount = descriptorCount;
    this.pageCount = pageCount; this.firstPageId = firstPageId;
    Object.freeze(this);
  }
  toJSON() { return { version: this.version, revision: this.revision, descriptorCount: this.descriptorCount,
    pageCount: this.pageCount, firstPageId: this.firstPageId, pageRoutes: this.pageRoutes.map((route) => route.toJSON()) }; }
  hasPage(id) { return this.pageRoutes.some((route) => route.id === id); }
  pagesForSource(origin) { return this.pageRoutes.filter((route) => route.sourceOrigins.includes(origin)); }
  routesForPrefix(prefix) {
    if (typeof prefix !== "string" || !prefix) throw new TypeError("Repair index requires a nonempty prefix");
    return this.pageRoutes.filter((route) => compareText(route.lastDescriptorId, prefix) >= 0
      && (route.firstDescriptorId.startsWith(prefix) || compareText(route.firstDescriptorId, prefix) <= 0));
  }
  assertPage(page) {
    const route = this.pageRoutes[page?.page];
    if (!route || page.revision !== this.revision || page.pageCount !== this.pageCount || page.version !== 1
      || !Array.isArray(page.descriptors) || page.descriptors.length !== route.descriptorCount
      || page.nextPageId !== (this.pageRoutes[page.page + 1]?.id ?? null)) throw new Error("Missing or conflicting repair index page identity");
    if (page.descriptors.some((entry, index) => typeof entry.id !== "string" || !entry.id
      || index > 0 && compareText(page.descriptors[index - 1].id, entry.id) >= 0)
      || page.descriptors[0].id !== route.firstDescriptorId || page.descriptors.at(-1).id !== route.lastDescriptorId
      || !isDeepStrictEqual([...new Set(page.descriptors.flatMap((entry) => entry.source ? [entry.source.origin] : []))].sort(compareText), route.sourceOrigins)) {
      throw new Error("Repair index route bounds differ from its canonical page");
    }
    if (specGateRepairValueDigest(workerArtifactStableStringify(page)) !== route.digest) throw new Error("Conflicting repair index page digest");
    return route;
  }
}

/** Read-only inquiry retains the complete unit and read inventory without granting edits. */
export class SpecGateRepairNavigationSelection {
  constructor(value) {
    assertSpecGateRepairFields(value, ["version", "mode", "baseRevision", "unit", "ranges", "readRangeIds", "guardrails", "acknowledgedRationale", "indexManifest"], "Invalid repair navigation selection");
    if (value.version !== 1 || !["navigate", "inspect"].includes(value.mode)
      || !/^sha256:[a-f0-9]{64}$/.test(value.baseRevision)) throw new TypeError("Invalid repair navigation identity");
    assertSpecGateRepairFields(value.unit, ["id", "rangeIds", "findings"], "Invalid repair navigation unit");
    if (!Array.isArray(value.unit.findings) || value.unit.findings.length === 0) throw new TypeError("Repair navigation requires complete findings");
    const findings = value.unit.findings.map((finding) => new SpecGateRepairFinding(finding, finding.rangeIds));
    if (new Set(findings.map((finding) => finding.identity.toString())).size !== findings.length) throw new Error("Duplicate repair navigation finding identity");
    if (findings.some((finding) => finding.specRevision !== null && finding.specRevision !== value.baseRevision)) throw new Error("Stale repair navigation finding revision");
    findings.forEach((finding) => { if (finding.allowedTargets.length) parseSpecGateRepairPermissions(finding.allowedTargets, "navigation finding"); });
    const unit = new SpecGateRepairUnit(findings);
    if (!isDeepStrictEqual(unit.toJSON(), value.unit)) throw new Error("Foreign repair navigation unit identity");
    this.indexManifest = new SpecGateRepairIndexManifest(value.indexManifest);
    if (!Array.isArray(value.readRangeIds) || new Set(value.readRangeIds).size !== value.readRangeIds.length
      || value.readRangeIds.some((id) => typeof id !== "string" || !id) || !value.readRangeIds.includes(this.indexManifest.firstPageId)
      || unit.rangeIds.some((id) => !value.readRangeIds.includes(id))) throw new Error("Missing or duplicate navigation read identity");
    const seen = new Set();
    this.ranges = Object.freeze(value.ranges.map((range) => {
      assertSpecGateRepairFields(range, ["id", "path", "entity", "digest", "target", "collectionAnchor", "exists", "writable", "value"], "Invalid repair navigation range");
      if (range.writable !== false) throw new Error("Repair navigation cannot grant mutation authority");
      if (seen.has(range.id) || !value.readRangeIds.includes(range.id)) throw new Error("Foreign or duplicate navigation range identity");
      seen.add(range.id);
      if (this.indexManifest.hasPage(range.id)) {
        if (range.target !== null || range.entity !== null || range.collectionAnchor || !range.exists) throw new Error("Repair index page must remain read-only");
        const route = this.indexManifest.assertPage(range.value);
        if (route.id !== range.id || route.digest !== range.digest) throw new Error("Conflicting repair index page digest or identity");
      } else if (range.id.startsWith("repair-index:")) throw new Error("Foreign repair navigation page identity");
      else if (range.id.startsWith("evidence:")) {
        if (value.mode !== "inspect" || range.target !== null || range.entity !== null || range.collectionAnchor || !range.exists) throw new Error("Repair navigation evidence must remain read-only");
        SpecGateRepairSourceRange.validate(range.value, range.digest);
        if (range.id !== range.value.snapshotId && range.id !== `${range.value.snapshotId}@bytes:${range.value.byteStart}:${range.value.byteEnd}:${range.value.snapshotDigest}`) throw new Error("Foreign inspection source byte identity");
      }
      return new SpecGateRepairRange({ ...range, target: range.target === null ? null : SpecRepairTarget.fromJSON(range.target, "navigation target") });
    }));
    if (!seen.has(this.indexManifest.firstPageId) || unit.rangeIds.some((id) => !seen.has(id))) throw new Error("Missing canonical navigation ranges");
    if (!Array.isArray(value.guardrails) || findings.some((finding) => !value.guardrails.some((rule) => rule.id === finding.requirementRef))
      || value.guardrails.some((rule) => !findings.some((finding) => finding.requirementRef === rule.id))
      || new Set(value.guardrails.map((rule) => rule.id)).size !== value.guardrails.length) throw new Error("Missing or foreign navigation guardrail");
    this.version = value.version; this.mode = value.mode; this.baseRevision = value.baseRevision; this.unit = unit;
    this.readRangeIds = Object.freeze([...value.readRangeIds].sort(compareText));
    this.guardrails = freezeSpecGateRepairValue(structuredClone(value.guardrails));
    this.acknowledgedRationale = freezeSpecGateRepairValue(structuredClone(value.acknowledgedRationale));
    Object.freeze(this);
  }
  static fromJSON(value) { return new this(value); }
  pageRangeIds() { return this.ranges.filter((range) => this.indexManifest.hasPage(range.id)).map((range) => range.id); }
  toJSON() { return { version: this.version, mode: this.mode, baseRevision: this.baseRevision, unit: this.unit.toJSON(),
    ranges: this.ranges.map((range) => range.toJSON()), readRangeIds: this.readRangeIds,
    guardrails: this.guardrails, acknowledgedRationale: this.acknowledgedRationale, indexManifest: this.indexManifest.toJSON() }; }
}
