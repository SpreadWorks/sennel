import { FlowExecutionInputBaseline } from "./flow-execution-input-baseline.js";
import { latestRepairBudget, readProgressBoundSpecGateRepairInput } from "./spec-gate-repair-progress.js";

/** Acquire the existing repair source and Attempt budget without another counter. */
export function acquireSpecGateRepairExecutionContractOptions({ request, generation }) {
  const flowManager = request.flowManager;
  const state = flowManager.canonicalState(request.specId);
  const context = request.inputs.find((input) => input.name === "spec-gate-repair-context.json").document;
  const execution = flowManager.draftStepExecutionState({ binding: request.executionBinding() });
  const sameGeneration = execution.lifecycle?.executionGeneration === generation;
  const { source } = readProgressBoundSpecGateRepairInput({ flowManager, state,
    executionRoot: request.executionRoot, executionLifecycle: execution.lifecycle });
  const { limit } = latestRepairBudget({ flowManager, specId: request.specId,
    attemptId: state.attempt.id, baseRevision: context.baseRevision, consumerNodeId: request.stepId,
    forNewGeneration: !sameGeneration });
  const spec = flowManager.readArtifact({ specId: request.specId, logicalKey: "spec.record", consumerNodeId: request.stepId });
  const issue = flowManager.readArtifact({ specId: request.specId, logicalKey: "issue.log", consumerNodeId: request.stepId, optional: true });
  const descriptors = [spec.descriptor, source.sourceDescriptor, source.review?.descriptor, issue?.descriptor].filter(Boolean);
  return { budgetOwner: context.baseRevision, executionLimit: { ...limit }, executionMode: context.mode,
    inputBaselines: descriptors.map((descriptor) => new FlowExecutionInputBaseline({ descriptor })) };
}
