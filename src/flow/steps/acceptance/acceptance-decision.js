import { Step } from "../../engine/step.js";
import { AcceptanceDecisionAwaitingChoiceResult, AcceptanceDecisionRiskAcceptedResult, AcceptanceDecisionAbortedResult,
  StepErrorResult } from "../../engine/step-result.js";
import { AcceptanceDecisionService } from "../../services/acceptance-decision-service.js";
import { AcceptanceDecisionResultEvidence } from "./acceptance-review-values.js";
export function acceptanceDecisionResult(input) {
  if (input.failure !== null) return new StepErrorResult("acceptance-decision", input.failure);
  if (!(input.evidence instanceof AcceptanceDecisionResultEvidence)) throw new TypeError("Acceptance decision requires acquired evidence");
  const Result = { "acceptance-decision-awaiting-choice": AcceptanceDecisionAwaitingChoiceResult,
    "acceptance-decision-risk-accepted": AcceptanceDecisionRiskAcceptedResult,
    "acceptance-decision-aborted": AcceptanceDecisionAbortedResult }[input.evidence.resultKind];
  return new Result({ evidence: input.evidence });
}
export class AcceptanceDecisionStep extends Step {
  static synchronous = true;
  static dependencies = [AcceptanceDecisionService];
  #service;
  constructor(service) { super(); if (!(service instanceof AcceptanceDecisionService)) throw new TypeError("AcceptanceDecisionService is required"); this.#service = service; }
  _execute() {
    const result = acceptanceDecisionResult(this.#service.inspectInput());
    const persisted = result.persist(this.#service);
    return persisted instanceof Promise ? persisted.then(() => result) : result;
  }
}
