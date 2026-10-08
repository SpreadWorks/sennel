import { flowStepExecutionRegistration } from "../../../src/flow/engine/composition/registered-step-execution.js";
import { draftStructureManifest, specStructureManifest, futurePhaseManifests } from "./phase-manifest.js";
import { ExecutionCaller, ExecutionLoader, NamedExecutionShape, PhaseProductionRegistrations, SharedExecutionShape } from "./production-registrations.js";

/** Board 37e4 fixes tests for the existing 03 production responsibility manifest. */
export const implPhaseManifest = futurePhaseManifests.find((manifest) => manifest.id === "03");
export const implPhaseScopes = implPhaseManifest.entries;
export const implPhaseExecutionForms = Object.freeze({
  implement: "source-entry", "task-impl": "source-entry",
  "task-review": "semantic-review", "task-triage": "host-filter",
  "task-repair": "source-entry", "task-gate": "aggregate-gate",
  "test-execute": "external-process", "test-result-review": "deterministic-review",
  "impl-review": "semantic-review", "impl-triage": "source-entry",
  "impl-repair": "source-entry", "impl-gate": "aggregate-gate",
});

/** Existing source workers, provider Reviews and Gates reuse their shared adapters.
 * Missing contracts belong to existing common owners:
 * - execution-admission.js must expose the host filter's acquired four-guard
 *   selection/project/execute contract around TaskReviewHostFilter and the
 *   existing confirmTaskReviewHostFilter save boundary.
 * - test-chain-transition-facts.js must expose one registration contract shared
 *   by external test execution and deterministic evidence Review, reusing
 *   admitTestChainDirectExecution/readCurrentTestChainTransitionFacts.
 * Source handoff/capability validation remains in WorkerArtifactHandoffCoordinator;
 * Task mapping extends existing worker admission with TaskStepIdentity.
 * These are declarations, never phase-specific adapter implementations.
 */
export function implPhaseExecutionShapes(entry) {
  const phase = entry.entry.split("/").at(-1);
  const lookup = `${phase}StepRegistration`;
  const forms = new Set(entry.definition.leaves.map((leaf) => implPhaseExecutionForms[leaf.stepId]));
  const shared = [new SharedExecutionShape("worker", "source-entry"),
    new SharedExecutionShape("review", "semantic-review"), new SharedExecutionShape("gate", "aggregate-gate")];
  const loaders = [
    new ExecutionLoader("src/flow/registry.js", "loadGetNextActionCommand", "src/flow/lib/get-next-action.js"),
    new ExecutionLoader("src/flow/registry.js", "loadDispatchCommand", "src/flow/lib/run-dispatch.js"),
    new ExecutionLoader("src/flow/registry.js", "loadGateCommand", "src/flow/lib/run-gate.js"),
    new ExecutionLoader("src/flow/registry.js", "loadReviewCommand", "src/flow/lib/run-review.js"),
  ];
  const additional = [
    new NamedExecutionShape("host-filter", "src/flow/lib/execution-admission.js", "hostFilterStepExecutionContract",
      "selectHostFilterExecution", "projectHostFilterExecution", "executeHostFilterSelection", [
        new ExecutionCaller("src/flow/lib/get-next-action.js", "projectHostFilterExecutionDirective", lookup, "project", null, "select", true),
        new ExecutionCaller("src/flow/lib/run-filter-task-review.js", "executeHostFilterInput", lookup, "execute", null, "select", true),
        new ExecutionCaller(entry.composition, "consumeHostFilterExecution", lookup, "execute", null, "consume", true),
        new ExecutionCaller(entry.composition, "recoverHostFilterExecution", lookup, "execute", "replayHostFilterReceipt", "consume", true),
      ], [...loaders, new ExecutionLoader("src/flow/registry.js", "loadFilterTaskReviewCommand", "src/flow/lib/run-filter-task-review.js", "run", "filter-task-review")]),
    ...["external-process", "deterministic-review"].map((form) => new NamedExecutionShape(form,
      "src/flow/lib/test-chain-transition-facts.js", "testChainStepExecutionContract",
      "selectTestChainExecution", "projectTestChainExecution", "executeTestChainSelection", [
        new ExecutionCaller("src/flow/lib/get-next-action.js", "projectTestChainExecutionDirective", lookup, "project", null, "select", true),
        new ExecutionCaller(form === "external-process" ? "src/flow/lib/run-test-execute.js" : "src/flow/lib/run-test-result-review.js",
          "executeTestChainInput", lookup, "execute", null, "select", true),
        new ExecutionCaller(entry.composition, "consumeTestChainExecution", lookup, "execute", null, "consume", true),
        new ExecutionCaller(entry.composition, "recoverTestChainExecution", lookup, "execute", "replayTestChainReceipt", "consume", true),
      ], [...loaders, new ExecutionLoader("src/flow/registry.js",
        form === "external-process" ? "loadTestExecuteCommand" : "loadTestResultReviewCommand",
        form === "external-process" ? "src/flow/lib/run-test-execute.js" : "src/flow/lib/run-test-result-review.js", "run",
        form === "external-process" ? "test-execute" : "test-result-review") ])),
  ];
  return Object.freeze([...shared, ...additional].filter((shape) => forms.has(shape.form)));
}

export function implPhaseStructureContract(entry, registry) {
  const forms = Object.fromEntries(entry.definition.leaves.map((leaf) => [leaf.stepId, implPhaseExecutionForms[leaf.stepId]]));
  return entry.contract(registry, implPhaseExecutionShapes(entry), forms);
}

/** Inspect only introduced earlier scopes and this phase; 04/05 remain separate. */
export class ImplPhaseProductionRegistrations extends PhaseProductionRegistrations {
  constructor(root, entry) {
    super(root, entry, [draftStructureManifest, specStructureManifest,
      ...futurePhaseManifests.filter((manifest) => ["01", "02", "03"].includes(manifest.id))]
      .flatMap((manifest) => manifest.entries), flowStepExecutionRegistration);
  }
}
