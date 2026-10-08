import { StepConnector } from "../../step-connector.js";

/** Connect a Flow leaf to the target already selected and saved by Definition. */
export class ImplPhaseConnector extends StepConnector {
  connect({ flowManager, specId, targetStepId }) {
    const state = flowManager.canonicalState(specId);
    if ((state.current?.at(-1) ?? state.nextAction()?.nodeId) !== targetStepId) {
      throw new Error("Implementation connection does not expose its saved target");
    }
    return state;
  }
}

export class ImplSourceRepairConnector extends ImplPhaseConnector {
  static activateTarget = true;
}

export class TaskStageConnector extends ImplPhaseConnector {
  static activateTarget = true;
}
