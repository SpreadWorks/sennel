import { flowStepExecutionRegistration } from "../../../src/flow/engine/composition/registered-step-execution.js";
import { draftStructureManifest, specStructureManifest, futurePhaseManifests } from "./phase-manifest.js";
import { ExecutionCaller, ExecutionLoader, NamedExecutionShape, PhaseProductionRegistrations } from "./production-registrations.js";

export const requirementTestManifest = futurePhaseManifests.find((manifest) => manifest.id === "02");
export const requirementTestScope = requirementTestManifest.entries[0];
const approvalExecutionShape = new NamedExecutionShape(
  "approval",
  requirementTestScope.composition,
  "approvalStepExecutionContract",
  "selectApprovalExecution",
  "projectApprovalExecution",
  "executeApprovalSelection",
  [
    new ExecutionCaller("src/flow/lib/get-next-action.js", "projectApprovalExecutionDirective",
      "requirementTestStepRegistration", "project", null, "select", true),
    new ExecutionCaller(requirementTestScope.composition, "executeApprovalInput",
      "requirementTestStepRegistration", "execute", null, "select", true),
  ],
  [
    new ExecutionLoader("src/flow/registry.js", "loadGetNextActionCommand", "src/flow/lib/get-next-action.js"),
    new ExecutionLoader("src/flow/registry.js", "loadRequirementTestComposition", requirementTestScope.composition),
  ],
);

export function requirementTestStructureContract(registry) {
  return requirementTestScope.contract(registry, [approvalExecutionShape], { approval: "approval" });
}

/** Present official phases form an inspection snapshot, never an execution registry. */
export class RequirementTestProductionRegistrations extends PhaseProductionRegistrations {
  constructor(root) {
    super(root, requirementTestScope, [draftStructureManifest, specStructureManifest, ...futurePhaseManifests]
      .flatMap((manifest) => manifest.entries), flowStepExecutionRegistration);
  }
}
