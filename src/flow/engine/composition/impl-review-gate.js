import { StepRegistration } from "./step-registration.js";
import { ImplReviewStep } from "../../steps/impl/impl-review.js";
import { ImplReviewService } from "../../services/impl-review-service.js";
import { reviewStepExecutionContract } from "../../lib/execution-admission.js";
import { ImplReviewInput } from "../../services/impl-review-input.js";
import { ImplReviewGateSettlementWriter } from "../../services/impl-review-gate-settlement-writer.js";
import { ImplStepBinding } from "../connectors/impl/impl-step-binding.js";
import { readImplReviewRequestEvidence, readProspectiveImplReviewEvidence } from "../../lib/canonical-review-artifacts.js";
import { prepareReviewExecutionClaim } from "../../lib/spec-review-operations.js";
import { ReviewExecutionClaimPreparation } from "../../lib/spec-review-operations-values.js";
import { ImplReviewExecutionRequiredResult } from "../step-result.js";
import { PreparedStepReplay } from "./step-registration.js";

export function prepareImplReviewServiceArguments(input) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  const specId = input.specId ?? input.ctx?.specId ?? input.state?.specId
    ?? input.binding?.specId ?? input.ctx?.flowState?.specId;
  if (input.commandResult != null) {
    const replay = flowManager.readReviewPublicationReplay({
      specId,
      commandResult: input.commandResult });
    if (replay !== null) return new PreparedStepReplay(replay);
  }
  const acquired = input.reviewFailurePublication != null ? { ...input,
    observed: new ImplReviewInput({ failure: input.reviewFailurePublication.observation }) }
    : input.observed === undefined ? prepareImplReviewPublication({ ...input, flowManager,
    state: flowManager.canonicalState(specId) }) : input;
  if (!(acquired.observed instanceof ImplReviewInput)) throw new TypeError("Implementation Review composition requires acquired input");
  return [new ImplReviewInput(acquired.observed), new ImplReviewGateSettlementWriter({
    flowManager, binding: acquired.binding,
    commandResult: acquired.commandResult, reviewPublication: acquired.reviewPublication,
    executionBinding: acquired.executionBinding, manifest: acquired.observed.evidence?.manifest ?? null,
    reviewFailurePublication: acquired.reviewFailurePublication ?? null,
    nonblockingPublication: acquired.nonblockingPublication ?? null,
  })];
}

/** Acquire the Step's exact work-unit request before provider execution. */
export function prepareImplReviewExecutionClaim({ flowManager, state, manifest, skipConfirm = false }) {
  const binding = new ImplStepBinding({ flowManager, specId: state.specId, stepId: "impl-review" });
  const claim = prepareReviewExecutionClaim({ flowManager, binding, state, manifest, skipConfirm,
    ResultClass: ImplReviewExecutionRequiredResult });
  const observed = new ImplReviewInput({ evidence: readImplReviewRequestEvidence({ flowManager, state, manifest }) });
  return new ImplReviewExecutionPreparation({ claim, binding, observed });
}

class ImplReviewExecutionPreparation {
  constructor({ claim, binding, observed }) {
    if (!(claim instanceof ReviewExecutionClaimPreparation) || !(binding instanceof ImplStepBinding)
      || !(observed instanceof ImplReviewInput) || claim.binding !== binding) {
      throw new TypeError("Implementation Review preparation requires one acquired claim and input");
    }
    this.claim = claim;
    this.binding = binding;
    this.observed = observed;
    Object.freeze(this);
  }
}

export class ImplReviewPublicationPreparation {
  constructor({ binding, observed, reviewPublication, commandResult }) {
    if (!(binding instanceof ImplStepBinding) || !(observed instanceof ImplReviewInput)
      || observed.evidence.publication?.producerActivityId !== reviewPublication.selectedActivityId) {
      throw new TypeError("Implementation Review publication requires its exact acquired producer");
    }
    Object.assign(this, { binding, observed, reviewPublication, commandResult });
    Object.freeze(this);
  }
}


/** Acquire sealed output and the exact future canonical producer before settlement. */
export function prepareImplReviewPublication({ flowManager, state, commandResult }) {
  const binding = new ImplStepBinding({ flowManager, specId: state.specId, stepId: "impl-review" });
  const publication = flowManager.prepareImplCommandPublication({ binding, commandResult });
  const evidence = readProspectiveImplReviewEvidence({ flowManager, binding, commandResult, publication });
  return new ImplReviewPublicationPreparation({ binding, observed: new ImplReviewInput({ evidence }),
    reviewPublication: publication, commandResult });
}


export { prepareImplGateServiceArguments, ImplGatePublicationPreparation,
  ImplementationGatePublicationPreparation, prepareImplementationGatePublication,
  prepareImplGatePublication } from "./implementation-gate.js";

/** The same production Review registration is reused by explicit acceptance. */
export const implReviewStepRegistration = new StepRegistration({ stepId: "impl-review", StepClass: ImplReviewStep,
  ServiceClass: ImplReviewService, prepareServiceArguments: prepareImplReviewServiceArguments,
  executionContract: reviewStepExecutionContract });
