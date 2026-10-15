import { settleArtifactWorkerRecoveryResult } from "../definition.js";
import { ArtifactWorkerRecoveryInput } from "./artifact-worker-recovery-input.js";
import { ArtifactWorkerRecoveryWriter } from "./artifact-worker-recovery-settlement-writer.js";

/** Provide acquired facts and persist the Step/Definition's selected operation. */
export class ArtifactWorkerRecoveryService {
  static argumentTypes = [ArtifactWorkerRecoveryInput, ArtifactWorkerRecoveryWriter];
  #input;
  #writer;
  #receipt = null;
  constructor(input, writer) {
    if (!(input instanceof ArtifactWorkerRecoveryInput) || !(writer instanceof ArtifactWorkerRecoveryWriter)) {
      throw new TypeError("Artifact recovery Service requires typed acquired input and a save-only writer");
    }
    this.#input = input;
    this.#writer = writer;
  }
  get evidence() { return this.#input.evidence; }
  get receipt() { return this.#receipt; }
  persistStepResult(result) {
    if (result.evidence !== this.#input.evidence) throw new TypeError("Artifact recovery Result differs from its acquired evidence");
    const settlement = settleArtifactWorkerRecoveryResult(result.stepId, result);
    this.#receipt = this.#writer.save({ result, settlement });
    return this.#receipt;
  }
}
