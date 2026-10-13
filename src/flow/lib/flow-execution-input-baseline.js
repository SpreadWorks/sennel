import { CanonicalFlowArtifactBaseline } from "./canonical-flow-artifact-baseline.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";
import { CurrentFlowStateConflictError } from "./current-flow-state-conflict-error.js";

/** Content baseline plus exact producer, acquired by the existing input reader. */
export class FlowExecutionInputBaseline {
  constructor({ descriptor }) {
    const value = descriptor.toJSON?.() ?? descriptor;
    this.baseline = new CanonicalFlowArtifactBaseline({ logicalKey: value.logicalKey,
      relativePath: value.relativePath, digest: value.hash, byteLength: value.size });
    if (typeof value.activityId !== "string" || !value.activityId) throw new TypeError("Execution input requires its exact producer Activity");
    this.activityId = value.activityId;
    Object.freeze(this);
  }
  toJSON() { return { logicalKey: this.baseline.artifact.logicalKey,
    relativePath: this.baseline.artifact.relativePath, hash: this.baseline.digest,
    size: this.baseline.byteLength, activityId: this.activityId }; }
  #changed(message, cause = null) {
    const error = new StepAdmissionRefusal(`${message}: ${this.baseline.artifact.logicalKey} (${this.baseline.artifact.relativePath})`, cause);
    error.code = "FLOW_EXECUTION_INPUT_BASELINE_CHANGED";
    error.data = Object.freeze({ logicalKey: this.baseline.artifact.logicalKey,
      relativePath: this.baseline.artifact.relativePath, failureKind: "step-admission" });
    return error;
  }
  assert(view) {
    try { this.baseline.assertCatalog(view.catalog); }
    catch (cause) {
      if (!(cause instanceof CurrentFlowStateConflictError)) throw cause;
      throw this.#changed("Execution input changed after input acquisition", cause);
    }
    const descriptor = view.catalog.artifacts.find((entry) => entry.relativePath === this.baseline.artifact.relativePath);
    if (descriptor.activityId !== this.activityId || !view.activities.some((entry) => entry.id === this.activityId)) {
      throw this.#changed("Execution input producer changed after input acquisition");
    }
    view.readCatalogedArtifact(descriptor);
  }
  static fromJSON(value) { return new FlowExecutionInputBaseline({ descriptor: value }); }
}
