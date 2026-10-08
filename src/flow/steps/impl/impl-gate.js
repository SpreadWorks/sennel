import { Step } from "../../engine/step.js";
import { ImplGateExecutionRequiredResult, ImplGatePassedResult, ImplGateEvidenceRefreshResult,
  ImplGateSemanticFailureResult, ImplGateAwaitingDecisionResult, StepErrorResult } from "../../engine/step-result.js";
import { ImplementationGateResultEvidence } from "../../lib/gate-observation-values.js";
import { ImplGateService } from "../../services/impl-gate-service.js";

export function implGateResult(input) {
  if (!(input.evidence instanceof ImplementationGateResultEvidence)) throw new TypeError("Implementation Gate requires acquired input");
  const evidence = input.evidence;
  const meaning = evidence.meaning;
  if (meaning.value === "error") {
    const error = new Error(meaning.reason);
    error.code = meaning.reason;
    error.data = { evidence: evidence.toJSON() };
    return new StepErrorResult("impl-gate", error);
  }
  const Result = { "impl-gate-execution-required": ImplGateExecutionRequiredResult,
    "impl-gate-passed": ImplGatePassedResult, "impl-gate-evidence-refresh": ImplGateEvidenceRefreshResult,
    "impl-gate-awaiting-decision": ImplGateAwaitingDecisionResult,
    "impl-gate-semantic-failure": ImplGateSemanticFailureResult }[evidence.resultKind];
  return new Result({ evidence });
}
export class ImplGateStep extends Step {
  static synchronous = true;
  static dependencies = [ImplGateService];
  #service;
  constructor(service) { super(); if (!(service instanceof ImplGateService)) throw new TypeError("ImplGateService is required"); this.#service = service; }
  _execute() { const result = implGateResult(this.#service.inspectInput()); result.persist(this.#service); return result; }
}
