/** Positive revision identity for the immutable canonical Spec collection. */
export class FlowSpecRevision {
  constructor(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("Spec revision must be a positive safe integer");
    }
    this.value = value;
    Object.freeze(this);
  }
  static from(value) { return value instanceof FlowSpecRevision ? value : new FlowSpecRevision(value); }
  get pathSegment() { return String(this.value).padStart(3, "0"); }
  toJSON() { return this.value; }
  toString() { return this.pathSegment; }
}
