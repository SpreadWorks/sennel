/** Declares whether one operation may inherit the ambient active Flow. */
export class FlowAttributionPolicy {
  constructor(mode = "ambient") {
    const normalized = mode ?? "ambient";
    if (normalized !== "ambient" && normalized !== "none") {
      throw new Error(`invalid flow attribution mode: ${normalized}`);
    }
    this.mode = normalized;
    Object.freeze(this);
  }

  get usesFlowState() {
    return this.mode === "ambient";
  }

  get logContext() {
    return this.usesFlowState ? undefined : null;
  }
}
