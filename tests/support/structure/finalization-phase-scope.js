import { flowStepExecutionRegistration } from "../../../src/flow/engine/composition/registered-step-execution.js";
import { draftStructureManifest, specStructureManifest, futurePhaseManifests } from "./phase-manifest.js";
import { ExecutionCaller, ExecutionLoader, NamedExecutionShape, PhaseProductionRegistrations } from "./production-registrations.js";

export const finalizationPhaseManifest = futurePhaseManifests.find((manifest) => manifest.id === "05");
export const finalizationPhaseScope = finalizationPhaseManifest.entries[0];
export const finalizationPhaseSnapshotEntries = Object.freeze([
  draftStructureManifest, specStructureManifest, ...futurePhaseManifests,
].flatMap((manifest) => manifest.entries));
export const finalizationPhaseExecutionForms = Object.freeze(Object.fromEntries(
  finalizationPhaseManifest.leaves.map((leaf) => [leaf.stepId, leaf.stepId])));

/** Planned names fix assembly wiring for board 5ab3, never a second policy owner.
 * Each existing direct command consumes its registration's acquired selection.
 * Display, dispatch, lifecycle settlement and exact recovery use the same
 * select/project/execute contract. Canonical reads, Git/gh/docs/teardown effects
 * and admission remain outside private typed Services. Definition alone selects
 * Execution, target, Await, Failure and Completion from concrete Step Results.
 * Interrupted sync is an internal recovery helper, not a new public CLI leaf.
 */
export const finalizationPhaseExecutionShapes = Object.freeze(finalizationPhaseManifest.leaves.map((leaf) => {
  const title = leaf.stepId.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("");
  const commandModule = `src/flow/lib/run-${leaf.stepId}.js`;
  const lookup = "finalizationStepRegistration";
  return new NamedExecutionShape(leaf.stepId, finalizationPhaseScope.composition,
    "finalizationStepExecutionContract", "selectFinalizationExecution", "projectFinalizationExecution", "executeFinalizationSelection", [
      new ExecutionCaller("src/flow/lib/get-next-action.js", "projectFinalizationExecutionDirective", lookup, "project", null, "select", true),
      new ExecutionCaller("src/flow/lib/run-dispatch.js", "executeFinalizationDispatch", lookup, "execute", null, "select", true),
      new ExecutionCaller(commandModule, `execute${title}Input`, lookup, "execute", null, "select", true),
      new ExecutionCaller(finalizationPhaseScope.composition, "consumeFinalizationExecution", lookup, "execute", null, "consume", true),
      new ExecutionCaller("src/flow/lib/run-recover-finalization.js", "executeFinalizationRecoveryInput", lookup, "execute", "replayFinalizationReceipt", "consume", true),
      ...(leaf.stepId === "finalize-sync" ? [
        new ExecutionCaller("src/flow/lib/recover-interrupted-finalize-sync.js", "executeInterruptedFinalizeSyncRecoveryInput", lookup,
          "execute", "replayInterruptedFinalizeSyncReceipt", "consume", true),
      ] : []),
    ], [
      new ExecutionLoader("src/flow/registry.js", "loadGetNextActionCommand", "src/flow/lib/get-next-action.js"),
      new ExecutionLoader("src/flow/registry.js", "loadDispatchCommand", "src/flow/lib/run-dispatch.js"),
      new ExecutionLoader("src/flow/registry.js", "loadGateCommand", "src/flow/lib/run-gate.js"),
      new ExecutionLoader("src/flow/registry.js", "loadReviewCommand", "src/flow/lib/run-review.js"),
      new ExecutionLoader("src/flow/registry.js", `load${title}Command`, commandModule, "run", leaf.stepId),
      new ExecutionLoader("src/flow/registry.js", "loadRecoverFinalizationCommand", "src/flow/lib/run-recover-finalization.js", "run", "recover-finalization"),
    ]);
}));

export function finalizationPhaseStructureContract(registry) {
  return finalizationPhaseScope.contract(registry, finalizationPhaseExecutionShapes, finalizationPhaseExecutionForms);
}

/** 05 is required; earlier phases join the one registry when introduced. */
export class FinalizationPhaseProductionRegistrations extends PhaseProductionRegistrations {
  constructor(root) {
    super(root, finalizationPhaseScope, finalizationPhaseSnapshotEntries, flowStepExecutionRegistration);
  }
}
