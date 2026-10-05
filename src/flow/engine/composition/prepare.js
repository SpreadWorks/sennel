import { StepRegistration } from "./step-registration.js";
import { StepBinding, canonicalStepState } from "../step-binding.js";
import { BranchStep } from "../../steps/prepare/branch.js";
import { PrepareSpecStep } from "../../steps/prepare/prepare-spec.js";
import { PlanPreparationInput } from "../../services/plan-preparation-input.js";
import { PlanPreparationService } from "../../services/plan-preparation-service.js";
import { PlanPreparationSettlementWriter } from "../../services/plan-preparation-settlement-writer.js";
import { prepareStepExecutionContract } from "../../lib/execution-admission.js";

/** Bind adoption to a normal canonical preparation Attempt. */
export class PrepareStepBinding extends StepBinding {
  constructor({ flowManager, specId, stepId, state = null, attempt = null }) {
    if (!["branch", "prepare-spec"].includes(stepId)) {
      throw new TypeError("Preparation binding requires a preparation leaf");
    }
    const current = state ?? canonicalStepState(flowManager, specId);
    super({ flowManager, state: current, stepId, attempt: attempt ?? current.attempt });
    Object.freeze(this);
  }
}

export function preparePlanPreparationServiceArguments(input, ConnectorClass, stepId) {
  const binding = input.binding;
  if (!(binding instanceof PrepareStepBinding) || binding.stepId !== stepId) {
    throw new TypeError("Preparation requires its registered Step binding");
  }
  binding.assertCurrent();
  return [new PlanPreparationInput({ stepId, preparation: input.preparation }),
    new PlanPreparationSettlementWriter({ flowManager: input.flowManager, binding,
      commandResult: input.commandResult ?? null })];
}

export const prepareStepRegistrations = [
  new StepRegistration({
    stepId: "branch", StepClass: BranchStep, ServiceClass: PlanPreparationService,
    prepareServiceArguments: preparePlanPreparationServiceArguments,
    executionContract: prepareStepExecutionContract,
  }),
  new StepRegistration({
    stepId: "prepare-spec", StepClass: PrepareSpecStep, ServiceClass: PlanPreparationService,
    prepareServiceArguments: preparePlanPreparationServiceArguments,
    executionContract: prepareStepExecutionContract,
  }),
];

const byId = new Map(prepareStepRegistrations.map((registration) => [registration.stepId, registration]));
export function prepareStepRegistration(stepId) { return byId.get(stepId) ?? null; }
