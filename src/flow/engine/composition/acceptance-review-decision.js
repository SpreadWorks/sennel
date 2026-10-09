import { AcceptanceReviewInput } from "../../services/acceptance-review-input.js";
import { AcceptanceDecisionInput } from "../../services/acceptance-decision-input.js";
import { AcceptanceSettlementWriter } from "../../services/acceptance-settlement-writer.js";
import { ImplStepBinding } from "../connectors/impl/impl-step-binding.js";
import { CanonicalAcceptanceArtifactStore, readAcceptanceReviewResultEvidence,
  readAcceptanceDecisionResultEvidence } from "../../lib/canonical-acceptance-artifacts.js";

/** Acquired input plus its one prospective canonical save operation. */
export class AcceptanceReviewPreparation {
  constructor({ binding, observed, context, commandResult = null, acceptancePublication = null,
    executionBinding = null, executionLifecycle = null, sourceCatalogHash = context.sourceCatalogHash }) {
    if (!(binding instanceof ImplStepBinding) || binding.stepId !== "acceptance-review"
      || !(observed instanceof AcceptanceReviewInput)) throw new TypeError("Acceptance Review requires acquired preparation");
    Object.assign(this, { binding, observed, context, commandResult, acceptancePublication, executionBinding, executionLifecycle, sourceCatalogHash });
    Object.freeze(this);
  }
}
export class AcceptanceDecisionPreparation {
  constructor({ binding, observed, commandResult = null, acceptancePublication = null }) {
    if (!(binding instanceof ImplStepBinding) || binding.stepId !== "acceptance-decision"
      || !(observed instanceof AcceptanceDecisionInput)) throw new TypeError("Acceptance decision requires acquired preparation");
    Object.assign(this, { binding, observed, commandResult, acceptancePublication });
    Object.freeze(this);
  }
}

export async function prepareAcceptanceReviewInput({ flowManager, state, executionRoot, context = null,
  commandResult = null, executionBinding = null, executionLifecycle = null, failure = null }) {
  const binding = new ImplStepBinding({ flowManager, specId: state.specId, stepId: "acceptance-review" });
  const acquiredContext = context ?? await new CanonicalAcceptanceArtifactStore({ flowManager,
    state: flowManager.loadReadOnly(state.specId) }).buildContext({ executionRoot });
  const publication = commandResult === null ? null : flowManager.prepareAcceptanceCommandPublication({ binding, commandResult,
    sourceCatalogHash: acquiredContext.sourceCatalogHash });
  const observed = failure === null ? new AcceptanceReviewInput({ evidence: readAcceptanceReviewResultEvidence({
    state, context: acquiredContext, binding, publication, commandResult,
    executionGeneration: executionBinding?.executionGeneration ?? 0 }) }) : new AcceptanceReviewInput({ failure });
  return new AcceptanceReviewPreparation({ binding, observed, context: acquiredContext, commandResult,
    acceptancePublication: publication, executionBinding, executionLifecycle });
}

export function prepareAcceptanceDecisionInput({ flowManager, state, commandResult = null, failure = null }) {
  const binding = new ImplStepBinding({ flowManager, specId: state.specId, stepId: "acceptance-decision" });
  const publication = commandResult === null ? null : flowManager.prepareAcceptanceCommandPublication({ binding, commandResult });
  const observed = failure === null ? new AcceptanceDecisionInput({ evidence: readAcceptanceDecisionResultEvidence({
    flowManager, state, binding, publication, commandResult }) }) : new AcceptanceDecisionInput({ failure });
  return new AcceptanceDecisionPreparation({ binding, observed, commandResult, acceptancePublication: publication });
}

export async function prepareAcceptanceReviewServiceArguments(input) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  const preparation = input.preparation ?? await prepareAcceptanceReviewInput({ ...input, flowManager,
    state: flowManager.canonicalState(input.specId ?? input.binding?.specId ?? input.ctx?.flowState?.specId),
    executionRoot: input.executionRoot ?? input.ctx?.executionRoot ?? input.ctx?.root ?? flowManager.executionRoot() });
  if (!(preparation instanceof AcceptanceReviewPreparation)) throw new TypeError("Acceptance Review requires its acquired preparation");
  return [new AcceptanceReviewInput(preparation.observed), new AcceptanceSettlementWriter({ flowManager, ...preparation })];
}
export function prepareAcceptanceDecisionServiceArguments(input) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  const preparation = input.preparation ?? prepareAcceptanceDecisionInput({ ...input, flowManager,
    state: flowManager.canonicalState(input.specId ?? input.binding?.specId ?? input.ctx?.flowState?.specId) });
  if (!(preparation instanceof AcceptanceDecisionPreparation)) throw new TypeError("Acceptance decision requires its acquired preparation");
  return [new AcceptanceDecisionInput(preparation.observed), new AcceptanceSettlementWriter({ flowManager, ...preparation })];
}
