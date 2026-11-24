import { StepExecutionContract } from "../../../src/flow/engine/composition/step-execution-contract.js";
import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { STEP_RESULT_REGISTRY } from "../../../src/flow/engine/step-result.js";
import { TaskStepIdentity } from "../../../src/flow/lib/task-step-identity.js";
import { ExecutionCaller, NamedExecutionShape, ProductionRegistrations, SharedExecutionShape, StructureScopeContract } from "./production-registrations.js";
import { SourceRepository } from "./source-repository.js";
import { SourceStructureChecker, SourceStructureScope } from "./source-structure-checker.js";

export { StructureReport } from "./source-structure-checker.js";
export { StructureDiagnostic } from "./source-graph.js";

/** Runtime identities belong to the registered Flow suite, never the audit. */
class ProductionStructureRuntime {
  constructor() {
    Object.assign(this, {
      StepExecutionContract, StepRegistration, STEP_RESULT_REGISTRY, TaskStepIdentity,
      ExecutionCaller, NamedExecutionShape, ProductionRegistrations, SharedExecutionShape,
    });
    Object.freeze(this);
  }
}

const runtime = new ProductionStructureRuntime();

export class StructureScope extends SourceStructureScope {
  constructor(root, entry, registrations, registrationModule, contract = null) {
    if (contract !== null && !(contract instanceof StructureScopeContract)) throw new TypeError("invalid structure scope");
    super(root, entry, registrations, registrationModule, contract);
  }
}

/** Existing Flow API adds real registration types to the shared source core. */
export class StructureChecker extends SourceStructureChecker {
  constructor(scope, repository = new SourceRepository(scope.root)) {
    if (!(scope instanceof StructureScope)) throw new TypeError("StructureScope required");
    super(scope, repository, runtime);
  }
}

export function checkStructure({ root, entry, registrations, registrationModule, contract }) {
  return new StructureChecker(new StructureScope(root, entry, registrations, registrationModule, contract)).check();
}
