const FLOW_SPEC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class FlowSpecId {
  constructor(value) {
    if (
      typeof value !== "string"
      || !FLOW_SPEC_ID_PATTERN.test(value)
      || value.includes("..")
      || value.endsWith(".")
      || value.endsWith(".lock")
    ) {
      throw new Error("flow spec ID must be a literal identifier");
    }
    this.value = value;
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof FlowSpecId ? value : new FlowSpecId(value);
  }

  toString() {
    return this.value;
  }
}
