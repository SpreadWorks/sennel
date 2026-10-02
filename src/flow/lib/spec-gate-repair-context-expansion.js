/** An additional read must change the available canonical context at the same revision. */
export class SpecGateRepairContextExpansion {
  constructor({ context, unitId, baseRevision, requestedRangeIds, previousRangeIds = [] }) {
    if (baseRevision !== context.baseRevision) throw new Error("Additional repair context has a stale revision");
    const before = context.select(unitId, { additionalRangeIds: previousRangeIds });
    context.select(unitId, { additionalRangeIds: requestedRangeIds });
    const available = new Set(before.ranges.map((range) => range.id));
    if (!requestedRangeIds.some((id) => !available.has(id))) {
      throw new Error("Additional repair context request made no progress");
    }
    this.baseRevision = baseRevision;
    this.unitId = unitId;
    this.additionalRangeIds = Object.freeze([...new Set([...previousRangeIds, ...requestedRangeIds])].sort());
    this.selection = context.select(unitId, { additionalRangeIds: this.additionalRangeIds });
    Object.freeze(this);
  }
}
