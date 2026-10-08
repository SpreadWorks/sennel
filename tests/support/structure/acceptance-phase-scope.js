import { flowStepExecutionRegistration } from "../../../src/flow/engine/composition/registered-step-execution.js";
import { draftStructureManifest, specStructureManifest, futurePhaseManifests } from "./phase-manifest.js";
import { ExecutionCaller, ExecutionLoader, NamedExecutionShape, PhaseProductionRegistrations } from "./production-registrations.js";

export const acceptancePhaseManifest = futurePhaseManifests.find((manifest) => manifest.id === "04");
export const acceptancePhaseScope = acceptancePhaseManifest.entries[0];
export const acceptancePhaseSnapshotEntries = Object.freeze([draftStructureManifest, specStructureManifest,
  ...futurePhaseManifests.filter((manifest) => ["01", "02", "03", "04"].includes(manifest.id))]
  .flatMap((manifest) => manifest.entries));
export const acceptancePhaseExecutionForms = Object.freeze(Object.fromEntries(
  acceptancePhaseManifest.leaves.map((leaf) => [leaf.stepId, leaf.stepId])));

/** These names fix assembly wiring, never a second admission/route/TestChain policy.
 * Existing readers acquire facts outside Services; the common owners continue to
 * select routes, NonGate budgets, TestChain evidence and settlement receipts.
 * Each leaf has a direct caller; retro/report also preserve their preview path.
 */
export const acceptancePhaseExecutionShapes = Object.freeze(acceptancePhaseManifest.leaves.map((leaf) => {
  const title = leaf.stepId.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("");
  const commandGroup = leaf.stepId === "acceptance-decision" ? "set" : "run";
  const commandModule = `src/flow/lib/${commandGroup}-${leaf.stepId}.js`;
  const lookup = "acceptanceStepRegistration";
  return new NamedExecutionShape(leaf.stepId, acceptancePhaseScope.composition,
    "acceptanceStepExecutionContract", "selectAcceptanceExecution", "projectAcceptanceExecution", "executeAcceptanceSelection", [
      new ExecutionCaller("src/flow/lib/get-next-action.js", "projectAcceptanceExecutionDirective", lookup, "project", null, "select", true),
      new ExecutionCaller("src/flow/lib/run-dispatch.js", "executeAcceptanceDispatch", lookup, "execute", null, "select", true),
      new ExecutionCaller(commandModule, `execute${title}Input`, lookup, "execute", null, "select", true),
      ...(["retro", "report"].includes(leaf.stepId) ? [
        new ExecutionCaller(commandModule, `preview${title}Input`, lookup, "project", null, "select", true),
      ] : []),
      new ExecutionCaller(acceptancePhaseScope.composition, "consumeAcceptanceExecution", lookup, "execute", null, "consume", true),
      new ExecutionCaller(acceptancePhaseScope.composition, "recoverAcceptanceExecution", lookup, "execute", "replayAcceptanceReceipt", "consume", true),
    ], [
      new ExecutionLoader("src/flow/registry.js", "loadGetNextActionCommand", "src/flow/lib/get-next-action.js"),
      new ExecutionLoader("src/flow/registry.js", "loadDispatchCommand", "src/flow/lib/run-dispatch.js"),
      new ExecutionLoader("src/flow/registry.js", "loadGateCommand", "src/flow/lib/run-gate.js"),
      new ExecutionLoader("src/flow/registry.js", "loadReviewCommand", "src/flow/lib/run-review.js"),
      new ExecutionLoader("src/flow/registry.js", `load${title}Command`, commandModule, commandGroup, leaf.stepId),
    ]);
}));

export function acceptancePhaseStructureContract(registry) {
  return acceptancePhaseScope.contract(registry, acceptancePhaseExecutionShapes, acceptancePhaseExecutionForms);
}

/** 04 is required; only present earlier phases are included, and 05 is excluded. */
export class AcceptancePhaseProductionRegistrations extends PhaseProductionRegistrations {
  constructor(root) {
    super(root, acceptancePhaseScope, acceptancePhaseSnapshotEntries, flowStepExecutionRegistration);
  }
}
