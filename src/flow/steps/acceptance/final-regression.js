import { Step } from "../../engine/step.js";
import { FinalRegressionExecutionRequiredResult, FinalRegressionPassedResult, FinalRegressionPolicySkippedResult, FinalRegressionFailedResult, FinalRegressionFailureAcceptedResult, StepErrorResult } from "../../engine/step-result.js";
import { FinalRegressionService } from "../../services/final-regression-service.js";
import { FinalRegressionResultEvidence } from "./final-regression-result-evidence.js";

export function finalRegressionResult(input) {
  const evidence = input.evidence;
  if (!(evidence instanceof FinalRegressionResultEvidence)) throw new TypeError("Final regression requires acquired evidence");
  if (evidence.integrityFailure !== null) {
    const error = new Error(evidence.integrityFailure);
    error.code = evidence.integrityFailure;
    error.data = { evidence: evidence.toJSON() };
    return new StepErrorResult("final-regression", error);
  }
  const Result = {
    "final-regression-execution-required": FinalRegressionExecutionRequiredResult,
    "final-regression-passed": FinalRegressionPassedResult,
    "final-regression-policy-skipped": FinalRegressionPolicySkippedResult,
    "final-regression-failed": FinalRegressionFailedResult,
    "final-regression-failure-accepted": FinalRegressionFailureAcceptedResult,
  }[evidence.resultKind];
  return new Result({ evidence });
}
export class FinalRegressionStep extends Step {
  static dependencies = [FinalRegressionService];
  #service;
  constructor(service) { super(); if (!(service instanceof FinalRegressionService)) throw new TypeError("FinalRegressionService is required"); this.#service = service; }
  async _execute() { const result = finalRegressionResult(this.#service.inspectInput()); await result.persist(this.#service); return result; }
}
