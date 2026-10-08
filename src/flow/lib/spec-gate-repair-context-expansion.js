import { SpecGateRepairSourceRange } from "./spec-gate-repair-values.js";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff-error.js";
import { SpecGateRepairSelectedContentIdentity, SpecGateRepairSelectedInputIdentity } from "./spec-gate-repair-input-unavailable.js";

/** Worker requests may extend registered canonical ranges, never select checkout sources. */
export class SpecGateRepairContextRequest {
  constructor(value) {
    if (value !== null && typeof value === "object") {
      for (const field of ["sourceOrigins", "sourceQueries"]) {
        if (Object.hasOwn(value, field) && (!Array.isArray(value[field]) || value[field].length !== 0)) {
          throw new WorkerArtifactHandoffError("invalid", "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE",
            "Research missing source facts directly in the execution checkout",
            { data: { failureKind: "step-admission" } });
        }
      }
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).filter((key) => key !== "intent").sort().join(",") !== "additionalRangeIds,baseRevision,stage,unitId,version"
      || Object.hasOwn(value, "intent") && value.intent !== "inspect"
      || value.version !== 1 || value.stage !== "spec-gate-repair-context-request"
      || typeof value.baseRevision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.baseRevision)
      || typeof value.unitId !== "string" || value.unitId.trim() === ""
      || !Array.isArray(value.additionalRangeIds) || value.additionalRangeIds.length === 0
      || value.additionalRangeIds.some((id) => typeof id !== "string" || id.trim() === "")
      || new Set(value.additionalRangeIds).size !== value.additionalRangeIds.length) {
      throw new TypeError("Spec Gate repair context request requires exact canonical range identities");
    }
    this.version = value.version;
    this.stage = value.stage;
    this.baseRevision = value.baseRevision;
    this.unitId = value.unitId;
    this.intent = value.intent ?? "repair";
    this.additionalRangeIds = Object.freeze([...value.additionalRangeIds]);
    Object.freeze(this);
  }
  static fromJSON(value) { return new this(value); }
  toJSON() {
    return { version: this.version, stage: this.stage, baseRevision: this.baseRevision,
      unitId: this.unitId, additionalRangeIds: [...this.additionalRangeIds], ...(this.intent === "inspect" ? { intent: this.intent } : {}) };
  }
  assertSelectedIdentity(identity) {
    if (!(identity instanceof SpecGateRepairSelectedContentIdentity || identity instanceof SpecGateRepairSelectedInputIdentity)
      || identity.baseRevision !== this.baseRevision || !identity.unitIds.includes(this.unitId)) {
      throw new TypeError("Context request differs from its selected input unit or revision");
    }
    return this;
  }
  expand(context, previousRangeIds = [], { selectedIdentity = null } = {}) {
    if (selectedIdentity !== null) this.assertSelectedIdentity(selectedIdentity);
    return new SpecGateRepairContextExpansion({ context, unitId: this.unitId, baseRevision: this.baseRevision,
      requestedRangeIds: this.additionalRangeIds, previousRangeIds,
      selectedIdentity: this.intent === "repair" ? selectedIdentity : null });
  }
}

/** Coverage of source bytes and index pages have distinct progress semantics. */
export class SpecGateRepairContextExpansion {
  constructor({ context, unitId, baseRevision, requestedRangeIds, previousRangeIds = [], selectedIdentity = null }) {
    if (baseRevision !== context.baseRevision) throw new Error("Additional repair context has a stale revision");
    const before = context.select(unitId, { additionalRangeIds: previousRangeIds });
    const requested = context.select(unitId, { additionalRangeIds: requestedRangeIds });
    const available = new Set(before.ranges.map((range) => range.id));
    const covered = (range) => {
      const value = range.value;
      if (!value?.snapshotId) return available.has(range.id);
      return before.ranges.some(({ value: prior }) => SpecGateRepairSourceRange.covers(prior, value));
    };
    const newRanges = requested.ranges.filter((range) => !covered(range));
    const entersRepair = (selectedIdentity instanceof SpecGateRepairSelectedContentIdentity || selectedIdentity instanceof SpecGateRepairSelectedInputIdentity)
      && ["navigate", "inspect"].includes(selectedIdentity.mode)
      && selectedIdentity.baseRevision === baseRevision && selectedIdentity.unitIds.length === 1 && selectedIdentity.unitIds[0] === unitId
      && requestedRangeIds.some((id) => !context.indexManifest().hasPage(id));
    if (!newRanges.length && !entersRepair) throw new Error("Additional repair context request made no progress");
    this.baseRevision = baseRevision;
    this.unitId = unitId;
    this.additionalRangeIds = Object.freeze([...new Set([...previousRangeIds, ...requestedRangeIds])].sort());
    this.selection = context.select(unitId, { additionalRangeIds: this.additionalRangeIds });
    this.indexPageProgress = Object.freeze(newRanges.filter((range) => range.id.startsWith("repair-index:")).map((range) => range.id));
    this.sourceByteProgress = SpecGateRepairSourceRange.uncoveredRangeBytes(
      newRanges.filter((range) => range.value?.snapshotId).map((range) => range.value), before.ranges.map((entry) => entry.value));
    if (this.sourceByteProgress === 0 && !newRanges.some((range) => !range.value?.snapshotId) && !entersRepair) {
      throw new Error("Additional repair context request made no progress");
    }
    Object.freeze(this);
  }
}
