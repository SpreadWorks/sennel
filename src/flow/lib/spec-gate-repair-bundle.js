import { createHash } from "node:crypto";
import { SpecGateRepairSourceRange } from "./spec-gate-repair-values.js";
import {
  SpecGateRepairRange, SpecGateRepairFinding, SpecGateRepairUnit, SpecGateRepairSelection, SpecGateRepairIndexManifest,
  freezeSpecGateRepairValue, specGateRepairValueDigest, assertSpecGateRepairFields,
} from "./spec-gate-repair-selection.js";
import { SpecRepairTarget, parseSpecGateRepairPermissions } from "./spec-repair-operations.js";
import { workerArtifactStableStringify } from "./worker-artifact-input-format.js";
import { compareText } from "./text-order.js";

function digest(value) {
  return createHash("sha256").update(workerArtifactStableStringify(value)).digest("hex");
}
/** A shared table owns identity conflicts and reference resolution, never permissions. */
class SpecGateRepairTable {
  #entries = new Map();
  constructor(label) { this.label = label; }
  add(id, value) {
    if (typeof id !== "string" || !id) throw new TypeError(`Missing repair bundle ${this.label} identity`);
    const existing = this.#entries.get(id);
    if (existing && workerArtifactStableStringify(existing) !== workerArtifactStableStringify(value)) {
      throw new Error(`Conflicting repair bundle ${this.label} identity: ${id}`);
    }
    if (!existing) this.#entries.set(id, freezeSpecGateRepairValue(structuredClone(value)));
  }
  get(id) {
    if (!this.#entries.has(id)) throw new Error(`Missing or foreign repair bundle ${this.label} reference: ${id}`);
    return this.#entries.get(id);
  }
  values() { return [...this.#entries].sort(([left], [right]) => compareText(left, right)).map(([, value]) => value); }
  assertUsed(ids) {
    if (ids.size !== this.#entries.size || [...this.#entries.keys()].some((id) => !ids.has(id))) {
      throw new Error(`Foreign unreferenced repair bundle ${this.label} entry`);
    }
  }
}

/** Complete selected context, shared once; each unit retains its own exact capabilities. */
export class SpecGateRepairBundle {
  #document;
  #selections;

  static fromSelections(selections) {
    if (!Array.isArray(selections) || selections.length === 0
      || selections.some((selection) => !(selection instanceof SpecGateRepairSelection))) {
      throw new TypeError("Repair bundle requires complete typed selections");
    }
    const ranges = new SpecGateRepairTable("range");
    const sources = new SpecGateRepairTable("source");
    const guardrails = new SpecGateRepairTable("guardrail");
    const rationales = new SpecGateRepairTable("rationale");
    const units = selections.map((selection) => {
      if (selection.baseRevision !== selections[0].baseRevision) throw new Error("Stale repair bundle selection revision");
      const rangeReferences = selection.ranges.map((range) => {
        const { writable, ...shared } = range;
        if (range.id.startsWith("evidence:")) {
          const { value, ...descriptor } = shared;
          sources.add(range.id, { id: range.id, ...value, digest: range.digest });
          ranges.add(range.id, { ...descriptor, sourceId: range.id });
        } else ranges.add(range.id, shared);
        return { id: range.id, writable };
      });
      for (const rule of selection.guardrails) guardrails.add(rule.id, rule);
      const rationaleId = `rationale:${digest(selection.acknowledgedRationale)}`;
      rationales.add(rationaleId, { id: rationaleId, value: selection.acknowledgedRationale });
      return { unit: selection.unit.toJSON(), ranges: rangeReferences,
        guardrailIds: selection.guardrails.map((rule) => rule.id), rationaleId, indexManifest: selection.indexManifest.toJSON() };
    });
    return new SpecGateRepairBundle({ version: 2, baseRevision: selections[0].baseRevision,
      ranges: ranges.values(), sources: sources.values(), guardrails: guardrails.values(),
      rationales: rationales.values(), units: units.sort((left, right) => compareText(left.unit.id, right.unit.id)) });
  }

  static fromJSON(value) { return new SpecGateRepairBundle(value); }

  constructor(value) {
    assertSpecGateRepairFields(value, ["version", "baseRevision", "ranges", "sources", "guardrails", "rationales", "units"], "Invalid repair bundle document");
    if (value.version !== 2 || !/^sha256:[a-f0-9]{64}$/.test(value.baseRevision)
      || !Array.isArray(value.units) || value.units.length === 0) throw new TypeError("Invalid repair bundle version, revision or units");
    const readTable = (label, values, validate) => {
      if (!Array.isArray(values)) throw new TypeError(`Invalid repair bundle ${label} table`);
      const table = new SpecGateRepairTable(label);
      const seen = new Set();
      for (const entry of values) {
        validate(entry);
        if (seen.has(entry.id)) throw new Error(`Duplicate repair bundle ${label} identity`);
        seen.add(entry.id);
        table.add(entry.id, entry);
      }
      return table;
    };
    const sources = readTable("source", value.sources, (entry) => {
      const { id, digest: sourceDigest, ...source } = entry;
      if (!id?.startsWith("evidence:")) throw new Error("Foreign repair bundle source identity");
      SpecGateRepairSourceRange.validate(source, sourceDigest);
      if (id !== source.snapshotId && id !== `${source.snapshotId}@bytes:${source.byteStart}:${source.byteEnd}:${source.snapshotDigest}`) {
        throw new Error("Conflicting repair bundle source range identity");
      }
      if (id === source.snapshotId && (source.byteStart !== 0 || source.byteEnd !== source.snapshotByteLength || sourceDigest !== source.snapshotDigest)) {
        throw new Error("Conflicting repair bundle source digest");
      }
    });
    const usedSources = new Set();
    const ranges = readTable("range", value.ranges, (entry) => {
      const evidence = entry.id?.startsWith("evidence:");
      assertSpecGateRepairFields(entry, ["id", "path", "entity", "digest", "target", "collectionAnchor", "exists", evidence ? "sourceId" : "value"], "Invalid repair bundle range");
      if (typeof entry.path !== "string" || typeof entry.collectionAnchor !== "boolean" || typeof entry.exists !== "boolean"
        || (entry.digest !== null && !/^[a-f0-9]{64}$/.test(entry.digest))) throw new TypeError("Invalid repair bundle range descriptor");
      if (entry.id.startsWith("repair-index:") && (entry.digest !== specGateRepairValueDigest(workerArtifactStableStringify(entry.value))
        || entry.id !== `repair-index:${entry.value?.revision}:${entry.value?.page}`
        || entry.target !== null || entry.entity !== null || entry.collectionAnchor || !entry.exists
        || entry.value.version !== 1 || !Number.isSafeInteger(entry.value.page) || entry.value.page < 0
        || entry.value.page >= entry.value.pageCount || !Array.isArray(entry.value.descriptors)
        || entry.value.nextPageId !== (entry.value.page + 1 < entry.value.pageCount
          ? `repair-index:${entry.value.revision}:${entry.value.page + 1}` : null))) {
        throw new Error("Conflicting repair index page digest");
      }
      if (entry.target !== null) SpecRepairTarget.fromJSON(entry.target, "repair bundle range target");
      if (evidence) {
        const source = sources.get(entry.sourceId);
        if (entry.id !== entry.sourceId || entry.target !== null || entry.entity !== null
          || entry.collectionAnchor || !entry.exists || entry.digest !== source.digest) {
          throw new Error("Conflicting repair bundle source range");
        }
        usedSources.add(entry.sourceId);
      }
    });
    const guardrails = readTable("guardrail", value.guardrails, (entry) => {
      if (Object.hasOwn(entry, "writable") || Object.hasOwn(entry, "allowedTargets") || Object.hasOwn(entry, "operationKinds")) {
        throw new Error("Repair bundle shared guardrail cannot grant permission");
      }
    });
    const rationales = readTable("rationale", value.rationales, (entry) => {
      assertSpecGateRepairFields(entry, ["id", "value"], "Invalid repair bundle rationale");
      if (entry.id !== `rationale:${digest(entry.value)}`) {
        throw new Error("Conflicting repair bundle rationale identity");
      }
    });
    const usedRanges = new Set(); const usedGuardrails = new Set(); const usedRationales = new Set();
    const seenUnits = new Set(); const seenFindings = new Set();
    const selections = value.units.map((entry) => {
      assertSpecGateRepairFields(entry, ["unit", "ranges", "guardrailIds", "rationaleId", "indexManifest"], "Invalid repair bundle unit references");
      assertSpecGateRepairFields(entry.unit, ["id", "rangeIds", "findings"], "Invalid repair bundle unit");
      if (workerArtifactStableStringify(entry.indexManifest) !== workerArtifactStableStringify(value.units[0].indexManifest)) {
        throw new Error("Conflicting repair bundle canonical index identity");
      }
      if (!Array.isArray(entry.unit.findings) || !entry.unit.findings.length) throw new TypeError("Repair bundle unit requires findings");
      const findings = entry.unit.findings.map((finding) => {
        const restored = new SpecGateRepairFinding(finding, finding.rangeIds);
        const key = restored.identity.toString();
        if (seenFindings.has(key)) throw new Error("Duplicate repair bundle finding identity");
        seenFindings.add(key);
        if (restored.specRevision !== null && restored.specRevision !== value.baseRevision) throw new Error("Stale repair bundle finding revision");
        return restored;
      });
      const unit = new SpecGateRepairUnit(findings);
      if (unit.id !== entry.unit.id || workerArtifactStableStringify(unit.toJSON()) !== workerArtifactStableStringify(entry.unit)
        || seenUnits.has(unit.id)) throw new Error("Conflicting or duplicate repair bundle unit identity");
      seenUnits.add(unit.id);
      const permissions = findings.flatMap((finding) => finding.allowedTargets.length
        ? parseSpecGateRepairPermissions(finding.allowedTargets, "repair bundle finding") : []);
      const permissionTargets = new Set(permissions.map((permission) => workerArtifactStableStringify(permission.target.toJSON())));
      if (!Array.isArray(entry.ranges)) throw new TypeError("Repair bundle unit requires range references");
      const seenRanges = new Set();
      const selected = entry.ranges.map((reference) => {
        assertSpecGateRepairFields(reference, ["id", "writable"], "Invalid repair bundle range reference");
        if (typeof reference.writable !== "boolean" || seenRanges.has(reference.id)) throw new Error("Invalid or duplicate repair bundle range reference");
        seenRanges.add(reference.id); usedRanges.add(reference.id);
        const shared = ranges.get(reference.id);
        const range = new SpecGateRepairRange({ ...shared,
          target: shared.target === null ? null : SpecRepairTarget.fromJSON(shared.target, "repair bundle range target"),
          value: Object.hasOwn(shared, "sourceId") ? (() => {
            const { id, digest: sourceDigest, ...source } = sources.get(shared.sourceId);
            return source;
          })() : shared.value });
        const writable = unit.rangeIds.includes(range.id) && range.target !== null
          && permissionTargets.has(workerArtifactStableStringify(range.target.toJSON()));
        if (reference.writable !== writable) throw new Error("Repair bundle unit range permission leakage");
        return range.toJSON({ writable });
      });
      if (!seenRanges.has(entry.indexManifest?.firstPageId) || selected.some((range) => range.id.startsWith("repair-index:")
        && (range.value.revision !== entry.indexManifest.revision || range.value.pageCount !== entry.indexManifest.pageCount))) {
        throw new Error("Missing or conflicting repair index manifest");
      }
      const index = new SpecGateRepairIndexManifest(entry.indexManifest);
      for (const range of selected.filter((range) => range.id.startsWith("repair-index:"))) {
        if (index.assertPage(range.value).id !== range.id) throw new Error("Conflicting repair index page identity");
      }
      if (unit.rangeIds.some((id) => !seenRanges.has(id)) || permissions.some((permission) => !selected.some((range) => (
        unit.rangeIds.includes(range.id) && workerArtifactStableStringify(range.target) === workerArtifactStableStringify(permission.target.toJSON())
      )))) throw new Error("Missing or foreign repair bundle unit target reference");
      if (!Array.isArray(entry.guardrailIds) || new Set(entry.guardrailIds).size !== entry.guardrailIds.length) {
        throw new Error("Invalid or duplicate repair bundle guardrail reference");
      }
      const rules = entry.guardrailIds.map((id) => { usedGuardrails.add(id); return guardrails.get(id); });
      if (findings.some((finding) => !entry.guardrailIds.includes(finding.requirementRef))
        || entry.guardrailIds.some((id) => !findings.some((finding) => finding.requirementRef === id))) {
        throw new Error("Missing or foreign repair bundle unit guardrail reference");
      }
      usedRationales.add(entry.rationaleId);
      return new SpecGateRepairSelection({ baseRevision: value.baseRevision, unit, ranges: selected,
        guardrails: rules, acknowledgedRationale: rationales.get(entry.rationaleId).value, indexManifest: entry.indexManifest });
    }).sort((left, right) => compareText(left.unit.id, right.unit.id));
    sources.assertUsed(usedSources); ranges.assertUsed(usedRanges);
    guardrails.assertUsed(usedGuardrails); rationales.assertUsed(usedRationales);
    this.baseRevision = value.baseRevision;
    this.#selections = Object.freeze(selections);
    this.#document = freezeSpecGateRepairValue({ version: 2, baseRevision: value.baseRevision,
      ranges: ranges.values(), sources: sources.values(), guardrails: guardrails.values(), rationales: rationales.values(),
      units: [...value.units].sort((left, right) => compareText(left.unit.id, right.unit.id)).map((entry) => structuredClone(entry)) });
    this.digest = digest(this.#document);
    this.byteLength = Buffer.byteLength(workerArtifactStableStringify(this.#document), "utf8");
    Object.freeze(this);
  }

  toJSON() { return this.#document; }
  selections() { return this.#selections.map((selection) => selection.toJSON()); }
  select(unitId) {
    const selection = this.#selections.find((entry) => entry.unit.id === unitId);
    if (!selection) throw new Error("Unknown repair bundle unit");
    return selection;
  }
}
