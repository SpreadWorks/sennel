import { isDeepStrictEqual } from "node:util";
import { ArtifactWorkerRequestSnapshot } from "./artifact-worker-recovery-values.js";
import { FlowExecutionContractRefusal, executionValueDigest } from "./flow-execution-contract.js";

/** The original cataloged claim authorizes one physical execution of this exact request. */
export class OriginalArtifactWorkerAuthorization {
  constructor({ requestSnapshot }) {
    if (!(requestSnapshot instanceof ArtifactWorkerRequestSnapshot)) throw new TypeError("Original worker authorization requires its canonical request snapshot");
    this.requestSnapshot = requestSnapshot;
    this.executionContract = requestSnapshot.executionContract;
    Object.freeze(this);
  }
  get id() { return executionValueDigest(this.toJSON()); }
  get requestDigest() { return this.requestSnapshot.requestDigest; }
  toJSON() { return { requestSnapshot: this.requestSnapshot.toJSON() }; }
  static fromJSON(value) {
    const restored = new this({ requestSnapshot: ArtifactWorkerRequestSnapshot.fromJSON(value.requestSnapshot) });
    if (!isDeepStrictEqual(restored.toJSON(), value)) throw new FlowExecutionContractRefusal("Saved original worker authorization has unknown fields");
    return restored;
  }
}
