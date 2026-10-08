import { StepConnector } from "../../step-connector.js";
import { ImplStepBinding } from "./impl-step-binding.js";
import { TaskStepBinding } from "../task/task-step-binding.js";

/** Attach an acquired source handoff to its exact current source Attempt. */
export class SourceEntryConnector extends StepConnector {
  constructor({ flowManager, specId, stepId }) {
    super();
    this.flowManager = flowManager;
    this.specId = specId;
    this.stepId = stepId;
  }
  connect() {
    const binding = this.stepId.startsWith("task-")
      ? new TaskStepBinding({ flowManager: this.flowManager, specId: this.specId, definitionStepId: this.stepId })
      : new ImplStepBinding({ flowManager: this.flowManager, specId: this.specId, stepId: this.stepId });
    binding.assertCurrent();
    return binding;
  }
}
