/** Read the current canonical evidence once for both action projection and execution. */
import { GateEvaluationAdmission, resolveGateEvaluationAdmission } from "../definition.js";
import { readCurrentGateTransitionFacts } from "./gate-transition-facts.js";
import { resolveCurrentReviewTransition } from "./review-transition-persistence.js";
import { projectGateTransitionDecision } from "./gate-transition-application.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";
import { StepExecutionContract } from "../engine/composition/step-execution-contract.js";
import { isDeepStrictEqual } from "node:util";
import { PreparationEvidence } from "./preparation-evidence.js";
import { StepBinding } from "../engine/step-binding.js";
import { BlockedDirective } from "./next-action-directive.js";

export class GateExecutionAdmissionSelection {
  constructor({ admission, action, state }) {
    if (!(admission instanceof GateEvaluationAdmission) || state?.attempt === undefined) {
      throw new TypeError("Gate execution selection requires Definition admission and current state");
    }
    this.admission = admission;
    this.action = action;
    this.runId = state.runId;
    this.specId = state.specId;
    this.attemptId = state.attempt?.id ?? null;
    this.attemptSequence = state.attempt?.sequence ?? null;
    Object.freeze(this);
  }
}

export function selectGateExecutionAdmission({ flowManager, flowState, phase, typedState, root = undefined }) {
  if (phase === "test") {
    if (typedState?.current?.at(-1) !== "test-gate" || typedState.attempt === null) {
      throw new StepAdmissionRefusal("Requirement Test Gate admission requires its active Definition Attempt");
    }
    return new GateExecutionAdmissionSelection({
      admission: resolveGateEvaluationAdmission(null),
      action: typedState.nextAction(),
      state: typedState,
    });
  }
  const facts = readCurrentGateTransitionFacts({ flowManager, flowState, phase, root });
  return new GateExecutionAdmissionSelection({
    admission: resolveGateEvaluationAdmission(facts),
    action: typedState.nextAction(),
    state: typedState,
  });
}

export function assertCurrentGateExecutionSelection(selection, current) {
  if (!(selection instanceof GateExecutionAdmissionSelection)
    || !(current instanceof GateExecutionAdmissionSelection)) {
    throw new TypeError("Gate execution requires its registered selection");
  }
  const previous = selection.admission.selectedDecision?.plan.action.identity ?? null;
  const latest = current.admission.selectedDecision?.plan.action.identity ?? null;
  if (selection.runId !== current.runId || selection.specId !== current.specId
    || selection.attemptId !== current.attemptId
    || selection.attemptSequence !== current.attemptSequence
    || selection.action?.nodeId !== current.action?.nodeId
    || selection.action?.operation !== current.action?.operation
    || selection.action?.action?.action !== current.action?.action?.action
    || (previous === null) !== (latest === null)
    || previous !== null && !previous.matches(latest)) {
    throw new StepAdmissionRefusal("Gate execution selection changed before use");
  }
  return current;
}

/** Reject a newly published Gate result before the provider receives another call. */
export function assertGateProviderExecutionAdmission(selection, phase) {
  if (!(selection instanceof GateExecutionAdmissionSelection)) {
    throw new TypeError("Gate provider execution requires its registered selection");
  }
  if (selection.admission.facts === null) return selection;
  if (phase === "draft") {
    const error = new Error("Draft Gate provider admission found an already-published bound result");
    error.code = "FLOW_GATE_EVALUATION_ADMISSION_DENIED";
    throw error;
  }
  const decision = selection.admission.selectedDecision;
  const error = new Error(
    `Gate provider admission denied evaluation; Definition selected ${decision.disposition.operation}`,
  );
  error.code = "FLOW_GATE_EVALUATION_ADMISSION_DENIED";
  throw error;
}

export function projectGateExecutionAdmission(selection) {
  if (!(selection instanceof GateExecutionAdmissionSelection)) {
    throw new TypeError("Gate projection requires its registered admission selection");
  }
  const decision = selection.admission.selectedDecision;
  return decision === null ? null : Object.freeze({
    decision,
    action: projectGateTransitionDecision(decision),
  });
}

export function executeGateSelection(selection, input) {
  if (!(selection instanceof GateExecutionAdmissionSelection)) {
    throw new TypeError("Gate execution requires its registered admission selection");
  }
  return input.command.executeSelectedGate(selection, input);
}

export class ReviewExecutionAdmissionSelection {
  constructor({ facts, disposition, action, state }) {
    if (state?.attempt === undefined) {
      throw new TypeError("Review execution selection requires current state");
    }
    this.facts = facts;
    this.disposition = disposition;
    this.action = action;
    this.runId = state.runId;
    this.specId = state.specId;
    this.attemptId = state.attempt?.id ?? null;
    this.attemptSequence = state.attempt?.sequence ?? null;
    Object.freeze(this);
  }
}

export function selectReviewExecutionAdmission({ flowManager, flowState, typedState, scope, stepId }) {
  const selected = resolveCurrentReviewTransition({
    flowManager, flowState, typedState, scope, stepId,
  });
  return new ReviewExecutionAdmissionSelection({
    facts: selected.facts,
    disposition: selected.disposition,
    action: typedState.nextAction(),
    state: typedState,
  });
}

export function assertCurrentReviewExecutionSelection(selection, current) {
  if (!(selection instanceof ReviewExecutionAdmissionSelection)
    || !(current instanceof ReviewExecutionAdmissionSelection)) {
    throw new TypeError("Review execution requires its registered selection");
  }
  if (selection.runId !== current.runId || selection.specId !== current.specId
    || selection.attemptId !== current.attemptId
    || selection.attemptSequence !== current.attemptSequence
    || selection.action?.nodeId !== current.action?.nodeId
    || selection.action?.operation !== current.action?.operation
    || selection.action?.action?.action !== current.action?.action?.action
    || !isDeepStrictEqual(selection.facts, current.facts)
    || !isDeepStrictEqual(selection.disposition, current.disposition)) {
    throw new StepAdmissionRefusal("Review execution selection changed before use");
  }
  return current;
}

export function projectReviewExecutionAdmission(selection) {
  if (!(selection instanceof ReviewExecutionAdmissionSelection)) {
    throw new TypeError("Review projection requires its registered admission selection");
  }
  return selection.disposition;
}

export function executeReviewSelection(selection, input) {
  if (!(selection instanceof ReviewExecutionAdmissionSelection)) {
    throw new TypeError("Review execution requires its registered admission selection");
  }
  return input.command.executeSelectedReview(selection, input);
}

export const gateStepExecutionContract = new StepExecutionContract({
  select: selectGateExecutionAdmission,
  project: projectGateExecutionAdmission,
  execute: executeGateSelection,
});

export const reviewStepExecutionContract = new StepExecutionContract({
  select: selectReviewExecutionAdmission,
  project: projectReviewExecutionAdmission,
  execute: executeReviewSelection,
});

/** One canonical preparation adoption, or an acquired completed receipt. */
export class PrepareExecutionAdmissionSelection {
  constructor({ state, stepId, registration, binding, preparation, receipt }) {
    if (registration?.stepId !== stepId
      || registration.executionContract !== prepareStepExecutionContract) {
      throw new StepAdmissionRefusal("Preparation admission requires the selected registration");
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
}

export function selectPrepareExecutionAdmission(input) {
  const flowManager = input.flowManager ?? input.ctx.flowManager;
  const specId = input.specId ?? input.ctx?.specId ?? input.ctx?.flowState?.specId;
  const state = flowManager.canonicalState(specId);
  if (!["branch", "prepare-spec"].includes(input.stepId)) {
    throw new StepAdmissionRefusal("Preparation admission requires its registered leaf");
  }
  const binding = input.binding ?? null;
  const preparation = input.preparation ?? null;
  const receipt = input.receipt ?? null;
  if (receipt !== null) {
    const saved = flowManager.readCurrentStepSettlement({ specId, stepId: input.stepId, completed: true });
    if (saved === null || !isDeepStrictEqual(saved.receipt.toJSON(), receipt.toJSON())) {
      throw new StepAdmissionRefusal("Preparation replay requires its current authenticated receipt");
    }
  }
  if (binding !== null) {
    if (!(binding instanceof StepBinding) || binding.stepId !== input.stepId
      || !(preparation instanceof PreparationEvidence)) {
      throw new StepAdmissionRefusal("Preparation adoption requires its acquired evidence and Attempt");
    }
    binding.assertCurrent();
    preparation.assertStep(input.stepId);
  }
  return new PrepareExecutionAdmissionSelection({ state, stepId: input.stepId, registration: input.registration,
    binding, preparation, receipt });
}

export function projectPrepareExecutionAdmission(selection) {
  if (!(selection instanceof PrepareExecutionAdmissionSelection)) {
    throw new TypeError("Preparation projection requires its registered selection");
  }
  return new BlockedDirective({
    code: "FLOW_PREPARATION_REQUIRED",
    reason: "The preparation protocol must complete before a Flow worker can start.",
    resumeInstruction: "Resume the exact flow prepare operation with its original run ID and inputs.",
  });
}

export async function executePrepareSelection(selection, input) {
  if (!(selection instanceof PrepareExecutionAdmissionSelection)
    || selection.registration !== input.registration
    || selection.stepId !== input.registration.stepId) {
    throw new StepAdmissionRefusal("Preparation execution requires the selected registration");
  }
  if (selection.receipt !== null) return selection.receipt;
  if (selection.binding === null || selection.preparation === null) {
    throw new StepAdmissionRefusal("Preparation evidence cannot be produced by a Flow worker");
  }
  selection.binding.assertCurrent();
  const prepared = await input.registration.create({
    flowManager: input.flowManager, binding: selection.binding,
    preparation: selection.preparation, commandResult: input.commandResult,
  });
  await prepared.step.execute();
  return prepared.dependency(input.registration.ServiceClass).preparationOutcome;
}

export const prepareStepExecutionContract = new StepExecutionContract({
  select: selectPrepareExecutionAdmission,
  project: projectPrepareExecutionAdmission,
  execute: executePrepareSelection,
});
