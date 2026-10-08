import { StepBinding, canonicalStepState } from "../../step-binding.js";
import { TaskStepIdentity } from "../../../lib/task-step-identity.js";
import { CurrentFlowStateConflictError } from "../../../lib/current-flow-state-conflict-error.js";

/** Fixed responsibility and materialized node share one exact canonical Attempt. */
export class TaskStepBinding extends StepBinding {
  constructor({ flowManager, specId, definitionStepId, allowFailed = false, continuation = null }) {
    const state = canonicalStepState(flowManager, specId);
    const identity = TaskStepIdentity.fromStateNode(state, state.attempt?.nodeId);
    if (identity === null || identity.definitionId !== definitionStepId) {
      throw new CurrentFlowStateConflictError("Task Step binding does not match its active responsibility");
    }
    super({ flowManager, state, stepId: identity.definitionId,
      nodeId: identity.nodeId, attempt: continuation?.attempt ?? state.attempt, allowFailed, continuation });
    this.definitionStepId = identity.definitionId;
    this.taskIdentity = identity;
    Object.freeze(this);
  }
}
