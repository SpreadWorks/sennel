import { StepRegistration } from "./step-registration.js";
import { ArtifactWorkerRecoveryStep } from "../../steps/execution/artifact-worker-recovery.js";
import { ARTIFACT_WORKER_RECOVERY_RESULT_DEFINITIONS } from "../step-result.js";
import { ArtifactWorkerRecoveryService } from "../../services/artifact-worker-recovery-service.js";
import { ArtifactWorkerRecoveryInput } from "../../services/artifact-worker-recovery-input.js";
import { ArtifactWorkerRecoveryWriter } from "../../services/artifact-worker-recovery-settlement-writer.js";
import { workerStepExecutionContract } from "../../lib/worker-step-execution-contract.js";

function prepareArtifactWorkerRecoveryArguments({ selection, writer }, _ConnectorClass, stepId) {
  if (!(writer instanceof ArtifactWorkerRecoveryWriter)) throw new TypeError("Artifact recovery requires its acquired save capability");
  if (selection.stepId !== stepId) throw new TypeError("Artifact recovery input belongs to another registered producer");
  return [new ArtifactWorkerRecoveryInput(selection), writer];
}

/** An execution operation on the existing producer; it adds no canonical Flow node. */
function createArtifactWorkerRecoveryRegistration(definition) {
  return new StepRegistration({ stepId: definition.stepId, StepClass: ArtifactWorkerRecoveryStep,
    ServiceClass: ArtifactWorkerRecoveryService, prepareServiceArguments: prepareArtifactWorkerRecoveryArguments,
    executionContract: workerStepExecutionContract });
}

let artifactWorkerRecoveryRegistrationsCache = null;

/** Build after module initialization; the operation can be imported by worker admission itself. */
export function artifactWorkerRecoveryRegistrations() {
  artifactWorkerRecoveryRegistrationsCache ??= Object.freeze(ARTIFACT_WORKER_RECOVERY_RESULT_DEFINITIONS
    .map(createArtifactWorkerRecoveryRegistration));
  return artifactWorkerRecoveryRegistrationsCache;
}

export function artifactWorkerRecoveryRegistration(stepId) {
  return artifactWorkerRecoveryRegistrations().find((registration) => registration.stepId === stepId) ?? null;
}

/** Execute an acquired operation on its existing producer node. */
export function executeArtifactWorkerRecovery(input) {
  const registration = artifactWorkerRecoveryRegistration(input.stepId);
  if (registration === null) throw new TypeError("Artifact producer has no registered recovery operation");
  const prepared = registration.create(input);
  prepared.step.execute();
  return prepared.dependency(registration.ServiceClass).receipt;
}
