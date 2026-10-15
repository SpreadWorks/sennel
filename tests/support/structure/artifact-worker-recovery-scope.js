import { ARTIFACT_WORKER_RECOVERY_RESULT_DEFINITIONS } from "../../../src/flow/engine/step-result.js";
import { artifactWorkerRecoveryRegistrations } from "../../../src/flow/engine/composition/artifact-worker-recovery.js";
import { StructureScope } from "./checker.js";
import { DefinitionLeafScope, ExecutionOperationLoader, ExecutionOperationScope, StructureLeaf, StructureScopeContract } from "./production-registrations.js";

/** The operation runs on existing producer nodes; its Result family owns the target set. */
export function artifactWorkerRecoveryStructureScope(root, registrations = artifactWorkerRecoveryRegistrations()) {
  const operation = new ExecutionOperationScope({ resultKindSuffix: "-execution-recovery-required",
    resultDefinitionsName: "ARTIFACT_WORKER_RECOVERY_RESULT_DEFINITIONS",
    registryName: "artifactWorkerRecoveryRegistrations", factoryName: "createArtifactWorkerRecoveryRegistration",
    lookupName: "artifactWorkerRecoveryRegistration", executeName: "executeArtifactWorkerRecovery",
    loaders: [new ExecutionOperationLoader("src/flow/lib/worker-artifact-handoff.js",
      "recoverArtifactGeneration", "ProcessExecutionRuntime.withRecoveryEvidence")] });
  const leaves = ARTIFACT_WORKER_RECOVERY_RESULT_DEFINITIONS
    .map((entry) => new StructureLeaf(entry.stepId));
  const definition = new DefinitionLeafScope("src/flow/definition.js", "FLOW_DEFINITION", leaves);
  return new StructureScope(root, "src/flow/steps/execution", registrations,
    "src/flow/engine/composition/artifact-worker-recovery.js",
    new StructureScopeContract(definition, [], artifactWorkerRecoveryRegistrations(), operation));
}
