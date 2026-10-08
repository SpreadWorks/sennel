import { Step } from "../../engine/step.js";
import { TestEvidenceAcceptedResult, TestEvidenceRejectedResult, StepErrorResult } from "../../engine/step-result.js";
import { TestChainResultEvidence } from "../../lib/test-chain-values.js";
import { TestChainService } from "../../services/test-chain-service.js";

export function testResultReviewResult(input) {
  if (!(input.evidence instanceof TestChainResultEvidence) || input.stepId !== "test-result-review") throw new TypeError("Test evidence Review requires typed acquired input");
  const evidence = input.evidence;
  if (evidence.meaning.value === "error") {
    const error = new Error(evidence.meaning.reason);
    error.code = evidence.meaning.reason;
    error.data = { evidence: evidence.toJSON() };
    return new StepErrorResult("test-result-review", error);
  }
  const Result = { "test-result-review-evidence-accepted": TestEvidenceAcceptedResult,
    "test-result-review-evidence-rejected": TestEvidenceRejectedResult }[evidence.resultKind];
  return new Result({ evidence });
}

export class TestResultReviewStep extends Step {
  static synchronous = true;
  static dependencies = [TestChainService];
  #service;
  constructor(service) { super(); if (!(service instanceof TestChainService)) throw new TypeError("TestChainService is required"); this.#service = service; }
  _execute() {
    const input = this.#service.inspectInput();
    return input.evidence.acceptedDecision === null ? this.#executeOrdinary(input) : this.#executeInput(input);
  }
  async #executeOrdinary(input) { return this.#executeInput(input); }
  #executeInput(input) {
    const result = testResultReviewResult(input);
    const persisted = result.persist(this.#service);
    return persisted !== null && typeof persisted?.then === "function" ? persisted.then(() => result) : result;
  }
}
