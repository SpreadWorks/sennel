import { Step } from "../../engine/step.js";
import { artifactWorkerRecoveryResult } from "../../engine/step-result.js";
import { ArtifactWorkerRecoveryService } from "../../services/artifact-worker-recovery-service.js";

/** The acquired recovery evidence fixes the meaning before Definition selects its effect. */
export class ArtifactWorkerRecoveryStep extends Step {
  static synchronous = true;
  static dependencies = [ArtifactWorkerRecoveryService];
  #service;
  constructor(service) {
    super();
    if (!(service instanceof ArtifactWorkerRecoveryService)) throw new TypeError("Artifact recovery Step requires its Service");
    this.#service = service;
    Object.freeze(this);
  }
  _execute() {
    const evidence = this.#service.evidence;
    const result = artifactWorkerRecoveryResult(evidence.stepId, evidence);
    result.persist(this.#service);
    return result;
  }
}
