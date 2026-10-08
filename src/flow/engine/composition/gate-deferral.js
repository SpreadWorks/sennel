import { implementationGateStepRegistration } from "./implementation-gate.js";
import { TaskStepBinding } from "../connectors/task/task-step-binding.js";
import { ImplStepBinding } from "../connectors/impl/impl-step-binding.js";
import { AcceptedGateDeferralBindingContinuation } from "../connectors/impl/accepted-gate-deferral-binding.js";
import { TaskGateService } from "../../services/task-gate-service.js";
import { ImplGateService } from "../../services/impl-gate-service.js";
import { ImplGateInput } from "../../services/impl-gate-input.js";
import { GateStepObservation } from "../../lib/gate-observation-values.js";

/** The explicit decision uses the same registered Gate Step as evaluation publication. */
export function completeAcceptedGateDeferral(flowManager, input) {
  const stepId = input.stepResult?.stepId;
  const task = stepId === "task-gate";
  if (!task && stepId !== "impl-gate") throw new TypeError("Gate acceptance requires its saved implementation Result");
  const sourceBinding = task
    ? new TaskStepBinding({ flowManager, specId: input.specId, definitionStepId: stepId, allowFailed: true })
    : new ImplStepBinding({ flowManager, specId: input.specId, stepId, allowFailed: true });
  const publication = flowManager.prepareGateDeferralPublication({ ...input, binding: sourceBinding });
  const continuation = new AcceptedGateDeferralBindingContinuation({ sourceBinding,
    attempt: publication.attempt, continuation: publication.evidence.continuation,
    sourceResult: publication.source.result, sourceReceipt: publication.source.receipt,
    confirmationOrder: publication.confirmationOrder });
  const binding = task
    ? new TaskStepBinding({ flowManager, specId: input.specId, definitionStepId: stepId, continuation })
    : new ImplStepBinding({ flowManager, specId: input.specId, stepId, continuation });
  const registration = implementationGateStepRegistration(stepId);
  const prepared = registration.create({ flowManager, binding, evidence: publication.evidence,
    gateDeferralPublication: publication,
    ...(task ? {} : { observed: new ImplGateInput(new GateStepObservation(publication.evidence)) }) });
  prepared.step.execute();
  const outcome = prepared.dependency(task ? TaskGateService : ImplGateService).settlementOutcome;
  return outcome.state ?? flowManager.canonicalState(sourceBinding.specId);
}
