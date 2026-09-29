/** Read the current canonical evidence once for both action projection and execution. */
import { GateEvaluationAdmission, resolveGateEvaluationAdmission } from "../definition.js";
import { readCurrentGateTransitionFacts } from "./gate-transition-facts.js";
import { resolveCurrentReviewTransition } from "./review-transition-persistence.js";
import { projectGateTransitionDecision } from "./gate-transition-application.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";
import { StepExecutionContract } from "../engine/composition/step-execution-contract.js";
import { isDeepStrictEqual } from "node:util";

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
