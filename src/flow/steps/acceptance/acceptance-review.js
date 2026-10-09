import { Step } from "../../engine/step.js";
import { AcceptanceReviewExecutionRequiredResult, AcceptanceReviewPassedResult, AcceptanceReviewRepairRequiredResult,
  AcceptanceReviewDecisionRequiredResult, AcceptanceReviewMechanicallyBlockedResult, StepErrorResult } from "../../engine/step-result.js";
import { AcceptanceReviewService } from "../../services/acceptance-review-service.js";
import { AcceptanceReviewResultEvidence } from "./acceptance-review-values.js";
export function acceptanceReviewResult(input) {
  if (input.failure !== null) return new StepErrorResult("acceptance-review", input.failure);
  if (!(input.evidence instanceof AcceptanceReviewResultEvidence)) throw new TypeError("Acceptance Review requires acquired evidence");
  const Result = { "acceptance-review-execution-required": AcceptanceReviewExecutionRequiredResult,
    "acceptance-review-passed": AcceptanceReviewPassedResult, "acceptance-review-repair-required": AcceptanceReviewRepairRequiredResult,
    "acceptance-review-decision-required": AcceptanceReviewDecisionRequiredResult,
    "acceptance-review-mechanically-blocked": AcceptanceReviewMechanicallyBlockedResult }[input.evidence.resultKind];
  return new Result({ evidence: input.evidence });
}
export class AcceptanceReviewStep extends Step {
  static synchronous = true;
  static dependencies = [AcceptanceReviewService];
  #service;
  constructor(service) { super(); if (!(service instanceof AcceptanceReviewService)) throw new TypeError("AcceptanceReviewService is required"); this.#service = service; }
  _execute() {
    const result = acceptanceReviewResult(this.#service.inspectInput());
    const persisted = result.persist(this.#service);
    return persisted instanceof Promise ? persisted.then(() => result) : result;
  }
}
