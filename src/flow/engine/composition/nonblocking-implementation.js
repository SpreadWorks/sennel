import { implementationGateStepRegistration } from "./implementation-gate.js";
import { implReviewStepRegistration } from "./impl-review-gate.js";
import { ImplStepBinding } from "../connectors/impl/impl-step-binding.js";
import { TaskStepBinding } from "../connectors/task/task-step-binding.js";
import { AcceptedNonblockingBindingContinuation } from "../connectors/impl/accepted-nonblocking-binding.js";
import { ImplReviewInput } from "../../services/impl-review-input.js";
import { ImplGateInput } from "../../services/impl-gate-input.js";
import { GateStepObservation } from "../../lib/gate-observation-values.js";
import { testChainStepRegistration } from "./test-chain.js";
import { TestChainInput } from "../../services/test-chain-input.js";

/** Execute the same registered Step for one acquired, explicit acceptance. */
export function completeAcceptedNonblockingDecision(flowManager, input) {
  const sourceBinding = input.record.sourceStep === "task-gate"
    ? new TaskStepBinding({ flowManager, specId: input.specId, definitionStepId: "task-gate", allowFailed: true })
    : new ImplStepBinding({ flowManager, specId: input.specId, stepId: input.record.sourceStep, allowFailed: true });
  const publication = flowManager.prepareAcceptedNonblockingPublication({ ...input, binding: sourceBinding });
  const continuation = new AcceptedNonblockingBindingContinuation({ sourceBinding, attempt: publication.attempt,
    continuation: publication.evidence.acceptedDecision, sourceResult: publication.source.result,
    sourceReceipt: publication.source.receipt, confirmationOrder: publication.confirmationOrder });
  const binding = sourceBinding.stepId === "task-gate"
    ? new TaskStepBinding({ flowManager, specId: input.specId, definitionStepId: sourceBinding.stepId, continuation })
    : new ImplStepBinding({ flowManager, specId: input.specId, stepId: sourceBinding.stepId, continuation });
  const review = sourceBinding.stepId === "impl-review";
  const testReview = sourceBinding.stepId === "test-result-review";
  const registration = testReview ? testChainStepRegistration(sourceBinding.stepId)
    : review ? implReviewStepRegistration : implementationGateStepRegistration(sourceBinding.stepId);
  const prepared = registration.create({ flowManager, binding, nonblockingPublication: publication,
    evidence: publication.evidence,
    ...(testReview ? { observed: new TestChainInput({ evidence: publication.evidence }) }
      : review ? { observed: new ImplReviewInput({ evidence: publication.evidence }) }
      : sourceBinding.stepId === "impl-gate" ? { observed: new ImplGateInput(new GateStepObservation(publication.evidence)) } : {}) });
  prepared.step.execute();
  return { receipt: prepared.dependency(registration.ServiceClass).settlementOutcome.receipt,
    record: publication.record.toJSON() };
}
