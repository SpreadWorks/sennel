import { settleAcceptanceStepResult, implementationNonblockingEligibilityForResult } from "../../definition.js";
import { isDeepStrictEqual } from "node:util";
import { StepExecutionContract } from "./step-execution-contract.js";
import { StepAdmissionRefusal } from "../../lib/step-admission-refusal.js";
import { BlockedDirective } from "../../lib/next-action-directive.js";

import { AcceptanceReceiptReplay } from "../../lib/acceptance-receipt-replay.js";

class AcceptanceProjectionPreparation {
  constructor(saved, projectedResult = null) {
    this.saved = saved;
    this.settlement = projectedResult === null ? saved?.settlement ?? null : settleAcceptanceStepResult(projectedResult.stepId, projectedResult);
    this.eligibility = saved === null ? null : implementationNonblockingEligibilityForResult(saved.result);
    Object.freeze(this);
  }
  get directive() {
    if (this.saved?.result.kind === "acceptance-review-execution-required"
      && this.saved.receipt.executionLifecycle?.phase === "claimed") {
      return new BlockedDirective({ code: "ACCEPTANCE_EXECUTION_CLAIMED",
        reason: "Acceptance execution is claimed and its response has not been published.",
        resumeInstruction: "Await the owning execution or use its explicit recovery boundary; do not start another provider call." });
    }
    if (this.saved?.result.kind !== "acceptance-review-mechanically-blocked") return null;
    return new BlockedDirective({ code: "ACCEPTANCE_MECHANICALLY_BLOCKED",
      reason: "Acceptance requires new canonical producer evidence before another evaluation.",
      resumeInstruction: "Resolve the recorded evidence gap through its producer, then resume the authorized generation." });
  }
}

/** One current registration and acquired observation, never an alternate route owner. */
export class AcceptanceExecutionSelection {
  constructor({ state, stepId, registration, binding, preparation, receipt }) {
    if (registration?.stepId !== stepId
      || registration.executionContract !== acceptanceStepExecutionContract) {
      throw new StepAdmissionRefusal("Acceptance selection requires its registered execution contract");
    }
    this.runId = state.runId;
    this.specId = state.specId;
    this.stepId = stepId;
    this.registration = registration;
    this.binding = binding;
    this.preparation = preparation;
    this.receipt = receipt;
    Object.freeze(this);
  }
  get saved() { return this.preparation instanceof AcceptanceProjectionPreparation ? this.preparation.saved : null; }
  get decision() { return this.preparation instanceof AcceptanceProjectionPreparation
    ? this.preparation.settlement?.application?.decision ?? this.preparation.settlement : null; }
  get eligibility() { return this.preparation instanceof AcceptanceProjectionPreparation ? this.preparation.eligibility : null; }
  get action() { return this.saved?.settlement.application?.decision?.plan.action ?? null; }
  get directive() { return this.preparation instanceof AcceptanceProjectionPreparation ? this.preparation.directive : null; }
}

export function selectAcceptanceExecution(input) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  const specId = input.specId ?? input.ctx?.flowState?.specId ?? input.flowState?.specId
    ?? input.binding?.specId ?? input.preparation?.binding.specId;
  const state = flowManager.canonicalState(specId);
  let preparation = input.preparation ?? null;
  const binding = input.binding ?? preparation?.binding ?? null;
  const dryRun = input.dryRun === true || input.ctx?.dryRun === true;
  const saved = flowManager.readCurrentStepSettlement({ specId, stepId: input.stepId });
  const receipt = input.receipt == null ? null : new AcceptanceReceiptReplay({ flowManager, specId,
    stepId: input.stepId, receipt: input.receipt instanceof AcceptanceReceiptReplay ? input.receipt.receipt : input.receipt });
  if (binding !== null) {
    binding.assertCurrent();
    if (binding.stepId !== input.stepId || preparation?.observed?.stepId !== input.stepId) {
      throw new StepAdmissionRefusal("Acceptance adoption requires its exact acquired publication");
    }
    if (input.stepId === "acceptance-review" && preparation.observed.evidence?.executionRequired) {
      if (saved?.result.kind === "acceptance-review-mechanically-blocked"
        && preparation.observed.evidence.fingerprint === saved.result.evidence.fingerprint) {
        throw new StepAdmissionRefusal("Acceptance evidence remains mechanically blocked; unchanged evidence grants no new provider generation");
      }
      const previous = saved?.receipt.executionLifecycle;
      if (previous?.phase === "claimed" && preparation.executionLifecycle?.phase !== "claimed") {
        throw new StepAdmissionRefusal("Acceptance provider response was not saved; explicit recovery is required");
      }
      if (previous !== null && previous !== undefined && preparation.executionBinding !== null
        && preparation.executionBinding !== undefined && previous.phase === "checkpoint"
        && previous.binding.inputDigest !== preparation.executionBinding.inputDigest) {
        throw new StepAdmissionRefusal("Acceptance execution input changed after its checkpoint");
      }
    }
  } else if (receipt === null && !dryRun && input.command !== undefined) {
    const action = state.nextAction();
    const active = state.current?.at(-1) === input.stepId;
    if (!active && action?.nodeId !== input.stepId) throw new StepAdmissionRefusal("Acceptance direct execution differs from the selected Action");
    if (input.stepId === "acceptance-review" && (saved?.receipt.executionLifecycle?.phase === "claimed"
      || saved?.result.type === "error")) throw new StepAdmissionRefusal("Acceptance provider execution requires explicit recovery of its saved interruption");
  }
  if (dryRun && binding !== null) throw new StepAdmissionRefusal("Acceptance preview cannot adopt a publication");
  if (preparation === null) {
    const projectedResult = saved === null && input.stepId === "acceptance-decision" && state.current?.at(-1) === "acceptance-decision"
      ? acceptanceDecisionResult(prepareAcceptanceDecisionInput({ flowManager, state }).observed) : null;
    preparation = new AcceptanceProjectionPreparation(saved, projectedResult);
  }
  return new AcceptanceExecutionSelection({ state, stepId: input.stepId,
    registration: input.registration, binding, preparation, receipt });
}

export function projectAcceptanceExecution(selection) { return selection; }

export async function executeAcceptanceSelection(selection, input) {
  if (!(selection instanceof AcceptanceExecutionSelection)
    || selection.registration !== input.registration
    || selection.stepId !== input.registration.stepId) {
    throw new StepAdmissionRefusal("Acceptance execution requires its exact executable registration");
  }
  if (selection.receipt !== null) { selection.receipt.assertCurrent(); return selection.receipt.receipt; }
  if (selection.binding === null || selection.preparation === null) {
    throw new StepAdmissionRefusal("Acceptance settlement requires its bound preparation");
  }
  selection.binding.assertCurrent();
  const prepared = await input.registration.create({
    flowManager: input.flowManager, binding: selection.binding,
    preparation: selection.preparation, commandResult: input.commandResult,
  });
  await prepared.step.execute();
  return prepared.dependency(input.registration.ServiceClass).settlementOutcome;
}

export const acceptanceStepExecutionContract = new StepExecutionContract({
  select: selectAcceptanceExecution, project: projectAcceptanceExecution, execute: executeAcceptanceSelection,
});

import { StepRegistration } from "./step-registration.js";
import { RetroStep } from "../../steps/acceptance/retro.js";
import { RetroService } from "../../services/retro-service.js";
import { RetroInput } from "../../services/retro-input.js";
import { AcceptanceSettlementWriter } from "../../services/acceptance-settlement-writer.js";
import { ImplStepBinding } from "../connectors/impl/impl-step-binding.js";
import { RetroResultEvidence } from "../../lib/retro-values.js";
import { NonGateTargetBinding, NonGateCatalogPublication } from "../../lib/non-gate-transition.js";
import { prepareAcceptanceReviewServiceArguments, prepareAcceptanceDecisionServiceArguments, prepareAcceptanceDecisionInput } from "./acceptance-review-decision.js";
import { AcceptanceReviewStep } from "../../steps/acceptance/acceptance-review.js";
import { AcceptanceDecisionStep, acceptanceDecisionResult } from "../../steps/acceptance/acceptance-decision.js";
import { AcceptanceReviewService } from "../../services/acceptance-review-service.js";
import { AcceptanceDecisionService } from "../../services/acceptance-decision-service.js";
import { prepareFinalRegressionServiceArguments, prepareReportServiceArguments } from "./acceptance-finalization.js";
import { FinalRegressionStep } from "../../steps/acceptance/final-regression.js";
import { ReportStep } from "../../steps/acceptance/report.js";
import { FinalRegressionService } from "../../services/final-regression-service.js";
import { ReportService } from "../../services/report-service.js";

export class RetroPreparation {
  constructor({ binding, observed, commandResult, acceptancePublication = null, nonblockingPublication = null }) {
    if (!(binding instanceof ImplStepBinding) || binding.stepId !== "retro" || !(observed instanceof RetroInput)) {
      throw new TypeError("Retro preparation requires acquired typed input");
    }
    Object.assign(this, { binding, observed, commandResult, acceptancePublication, nonblockingPublication });
    Object.freeze(this);
  }
}

export function prepareRetroInput({ flowManager, state, commandResult, fingerprint, staleFacts = null }) {
  const binding = new ImplStepBinding({ flowManager, specId: state.specId, stepId: "retro" });
  const candidate = staleFacts === null ? flowManager.prepareAcceptanceCommandPublication({ binding, commandResult }) : null;
  const descriptor = candidate?.catalog.artifacts.find((entry) => entry.logicalKey === "retro") ?? null;
  const producer = descriptor === null ? null : candidate.activities.find((entry) => entry.id === descriptor.activityId);
  const publication = descriptor === null ? null : new NonGateCatalogPublication({ runId: state.runId,
    specId: state.specId, stepId: "retro", attemptId: producer.attemptId, sequence: producer.sequence,
    producerActivityId: producer.id, artifactId: descriptor.relativePath, fingerprint: descriptor.hash });
  const observed = new RetroInput({ evidence: new RetroResultEvidence({ identity: new NonGateTargetBinding({
    runId: state.runId, specId: state.specId, stepId: "retro", attempt: state.attempt }), publication,
    fingerprint, staleFacts, notDone: commandResult.artifacts?.summary?.not_done ?? 0,
    nonblocking: state.policy?.nonblocking?.enabled === true }) });
  return new RetroPreparation({ binding, observed, commandResult, acceptancePublication: candidate });
}
export function prepareRetroServiceArguments(input) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  const preparation = input.preparation ?? (input.nonblockingPublication === undefined ? null : new RetroPreparation({
    binding: input.binding, observed: new RetroInput({ evidence: input.evidence }), commandResult: null,
    nonblockingPublication: input.nonblockingPublication }));
  if (!(preparation instanceof RetroPreparation)) throw new TypeError("Retro requires its acquired preparation");
  return [new RetroInput(preparation.observed), new AcceptanceSettlementWriter({ flowManager, ...preparation })];
}
export const acceptanceStepRegistrations = Object.freeze([
  new StepRegistration({ stepId: "retro", StepClass: RetroStep, ServiceClass: RetroService,
    prepareServiceArguments: prepareRetroServiceArguments, executionContract: acceptanceStepExecutionContract }),
  new StepRegistration({ stepId: "acceptance-review", StepClass: AcceptanceReviewStep, ServiceClass: AcceptanceReviewService,
    prepareServiceArguments: prepareAcceptanceReviewServiceArguments, executionContract: acceptanceStepExecutionContract }),
  new StepRegistration({ stepId: "acceptance-decision", StepClass: AcceptanceDecisionStep, ServiceClass: AcceptanceDecisionService,
    prepareServiceArguments: prepareAcceptanceDecisionServiceArguments, executionContract: acceptanceStepExecutionContract }),
  new StepRegistration({ stepId: "final-regression", StepClass: FinalRegressionStep, ServiceClass: FinalRegressionService,
    prepareServiceArguments: prepareFinalRegressionServiceArguments, executionContract: acceptanceStepExecutionContract }),
  new StepRegistration({ stepId: "report", StepClass: ReportStep, ServiceClass: ReportService,
    prepareServiceArguments: prepareReportServiceArguments, executionContract: acceptanceStepExecutionContract }),
]);
const byId = new Map(acceptanceStepRegistrations.map((registration) => [registration.stepId, registration]));
export function acceptanceStepRegistration(stepId) { return byId.get(stepId) ?? null; }

/** Persist the selected decision scene through its own Step; exact Store replay is read-only. */
export function initializeAcceptanceDecisionAwait(input) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  const state = flowManager.canonicalState(input.specId ?? input.ctx?.flowState?.specId);
  if (state.current?.at(-1) !== "acceptance-decision") return null;
  const stepId = "acceptance-decision";
  const registration = acceptanceStepRegistration("acceptance-decision");
  const preparation = prepareAcceptanceDecisionInput({ flowManager, state });
  const selection = registration.executionContract.select({ ...input, flowManager, stepId, preparation, registration });
  return registration.executionContract.execute(selection, { ...input, flowManager, stepId, preparation, registration });
}

export function consumeAcceptanceExecution(input) {
  const registration = acceptanceStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Acceptance consumption requires its registered Step");
  const selection = input.selection;
  return registration.executionContract.execute(selection, { ...input, registration });
}
function replayAcceptanceReceipt(receipt) {
  if (!(receipt instanceof AcceptanceReceiptReplay)) throw new TypeError("Acceptance replay requires its authenticated capability");
  receipt.assertCurrent();
  return receipt.receipt;
}
export function recoverAcceptanceExecution(input) {
  const registration = acceptanceStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Acceptance recovery requires its registered Step");
  const selection = input.selection;
  if (selection.registration !== registration) throw new TypeError("Acceptance recovery requires its exact registration");
  if (selection.receipt !== null) return replayAcceptanceReceipt(selection.receipt);
  return registration.executionContract.execute(selection, { ...input, registration });
}
