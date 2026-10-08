import { Step } from "../../engine/step.js";
import { ImplReviewExecutionRequiredResult, ImplReviewPassedResult, ImplReviewAdvisoryResult,
  ImplReviewRejectedResult, ImplReviewToolingResult, StepErrorResult } from "../../engine/step-result.js";
import { ReviewStepFailureObservation } from "../../lib/review-step-failure-values.js";
import { ImplReviewResultEvidence } from "../../lib/impl-review-values.js";
import { ImplReviewService } from "../../services/impl-review-service.js";

export function implReviewResult(input) {
  if (input.failure instanceof ReviewStepFailureObservation) return new StepErrorResult("impl-review", input.failure.toError());
  if (!(input.evidence instanceof ImplReviewResultEvidence)) throw new TypeError("Implementation Review requires acquired input");
  const evidence = input.evidence;
  const Result = { "impl-review-execution-required": ImplReviewExecutionRequiredResult,
    "impl-review-passed": ImplReviewPassedResult, "impl-review-advisory": ImplReviewAdvisoryResult,
    "impl-review-rejected": ImplReviewRejectedResult, "impl-review-tooling": ImplReviewToolingResult }[evidence.resultKind];
  return new Result({ evidence });
}
export class ImplReviewStep extends Step {
  static synchronous = true;
  static dependencies = [ImplReviewService];
  #service;
  constructor(service) { super(); if (!(service instanceof ImplReviewService)) throw new TypeError("ImplReviewService is required"); this.#service = service; }
  _execute() {
    const input = this.#service.inspectInput();
    return input.evidence?.acceptedDecision == null ? this.#executeOrdinary(input) : this.#executeInput(input);
  }
  async #executeOrdinary(input) { return this.#executeInput(input); }
  #executeInput(input) {
    const result = implReviewResult(input);
    const persisted = result.persist(this.#service);
    return persisted instanceof Promise ? persisted.then(() => result) : result;
  }
}
