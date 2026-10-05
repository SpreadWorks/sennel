import { SpecGateRepairSourceRange } from "./spec-gate-repair-values.js";

/** Coverage of source bytes and index pages have distinct progress semantics. */
export class SpecGateRepairContextExpansion {
  constructor({ context, unitId, baseRevision, requestedRangeIds, previousRangeIds = [] }) {
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
    if (!newRanges.length) throw new Error("Additional repair context request made no progress");
    this.baseRevision = baseRevision;
    this.unitId = unitId;
    this.additionalRangeIds = Object.freeze([...new Set([...previousRangeIds, ...requestedRangeIds])].sort());
    this.selection = context.select(unitId, { additionalRangeIds: this.additionalRangeIds });
    this.indexPageProgress = Object.freeze(newRanges.filter((range) => range.id.startsWith("repair-index:")).map((range) => range.id));
    this.sourceByteProgress = newRanges.filter((range) => range.value?.snapshotId).reduce((total, range) =>
      total + SpecGateRepairSourceRange.uncoveredBytes(range.value, before.ranges.map((entry) => entry.value)), 0);
    if (this.sourceByteProgress === 0 && !newRanges.some((range) => !range.value?.snapshotId)) {
      throw new Error("Additional repair context request made no progress");
    }
    Object.freeze(this);
  }
}
