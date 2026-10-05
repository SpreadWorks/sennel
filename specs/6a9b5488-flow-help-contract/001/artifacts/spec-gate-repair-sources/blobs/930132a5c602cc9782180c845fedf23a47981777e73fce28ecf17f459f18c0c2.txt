/** Exact validated publication and baseline selected by the initial Spec Step. */
export class SpecWorkerCompletionFacts {
  constructor({ publication, baseline } = {}) {
    if (!publication || baseline?.artifact?.logicalKey !== "spec.record") {
      throw new TypeError("Spec worker facts require a publication and canonical Spec baseline");
    }
    this.publication = publication;
    this.baseline = baseline;
    Object.freeze(this);
  }
}
