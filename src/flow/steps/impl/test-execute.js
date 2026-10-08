import { Step } from "../../engine/step.js";
import { TestExecutionRequiredResult, TestExecutionObservedResult, StepErrorResult } from "../../engine/step-result.js";
import { TestChainResultEvidence } from "../../lib/test-chain-values.js";
import { TestChainService } from "../../services/test-chain-service.js";

export function testExecuteResult(input) {
  if (!(input.evidence instanceof TestChainResultEvidence) || input.stepId !== "test-execute") throw new TypeError("Test execution requires typed acquired input");
  const evidence = input.evidence;
  if (evidence.meaning.value === "error") {
    const error = new Error(evidence.meaning.reason);
    error.code = evidence.meaning.reason;
    error.data = { evidence: evidence.toJSON() };
    return new StepErrorResult("test-execute", error);
  }
  const Result = { "test-execute-execution-required": TestExecutionRequiredResult,
    "test-execute-observed": TestExecutionObservedResult }[evidence.resultKind];
  return new Result({ evidence });
}

export class TestExecuteStep extends Step {
  static dependencies = [TestChainService];
  #service;
  constructor(service) { super(); if (!(service instanceof TestChainService)) throw new TypeError("TestChainService is required"); this.#service = service; }
  async _execute() { const result = testExecuteResult(this.#service.inspectInput()); await result.persist(this.#service); return result; }
}
