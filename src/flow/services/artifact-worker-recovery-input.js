import { ArtifactWorkerRecoverySelection } from "../lib/artifact-worker-recovery-selection.js";

export class ArtifactWorkerRecoveryInput {
  constructor(evidence) {
    if (!(evidence instanceof ArtifactWorkerRecoverySelection)) throw new TypeError("Artifact recovery input requires its typed selection facts");
    this.evidence = evidence;
    Object.freeze(this);
  }
}
