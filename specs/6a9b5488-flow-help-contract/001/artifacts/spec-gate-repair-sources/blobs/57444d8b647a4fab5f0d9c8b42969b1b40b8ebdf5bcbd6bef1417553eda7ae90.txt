import { findActiveNode, resolveLifecyclePlan } from "../definition.js";
import { findStepById } from "./step-tree.js";
import { DefinitionLifecycleTransition, StepTransitionError } from "./step-transition-policy.js";

export function createLifecycleStepTransition({
  flowState,
  stepId,
  status,
  event,
  taskId,
  currentStepId = null,
}) {
  const resolvedTaskId = taskId === undefined
    && flowState?.currentTaskId != null
    && flowState.tasks?.find((task) => task.id === flowState.currentTaskId)?.steps?.some((step) => step.id === stepId)
    ? flowState.currentTaskId
    : taskId ?? null;
  const scope = resolvedTaskId == null
    ? flowState
    : flowState?.tasks?.find((task) => task.id === resolvedTaskId);
  const step = findStepById(scope?.steps || [], stepId);
  if (!step) throw new StepTransitionError(`unknown lifecycle transition step: ${stepId}`);
  if (step.status === status) return null;
  const plan = resolveLifecyclePlan({
    event,
    currentStepId: currentStepId || findActiveNode(flowState)?.stepId || stepId,
    targetStepId: stepId,
    status,
  });
  const action = plan.actions.find((candidate) => candidate.step === stepId && candidate.status === status);
  if (!action) throw new StepTransitionError(`definition lifecycle did not emit ${stepId}=${status}`);
  return new DefinitionLifecycleTransition({
    action,
    plan,
    currentStatus: step.status,
  });
}
