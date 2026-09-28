/** The Draft Step's immutable view of a canonical Gate repair binding. */
export class DraftGateRepairBinding {
  constructor(record) {
    if (record?.phase !== "draft" || record?.targetStepId !== "draft-gate-repair") {
      throw new TypeError("Draft Gate repair binding does not target its Step");
    }
    this.phase = record.phase;
    this.targetStepId = record.targetStepId;
    Object.freeze(this);
  }
}
