import { Step } from "../../engine/step.js";
import {
  RequirementTestReviewExecutionEvidence, RequirementTestReviewEvidence,
  TestReviewExecutionRequiredResult, TestReviewPassedResult, TestReviewAdvisoryResult,
  TestReviewRejectedResult, TestReviewToolingUnavailableResult, TestReviewExternalBlockedResult,
} from "../../engine/step-result.js";
import { RequirementTestService } from "../../services/requirement-test-service.js";
import { requirementTestFailureResult } from "./requirement-test-result.js";

/** Classify the acquired unexecuted work unit or accepted sealed Review. */
export class TestReviewStep extends Step {
  static dependencies = [RequirementTestService];
  #service;
  #selectedResult = null;
  constructor(service) {
    super();
    if (!(service instanceof RequirementTestService) || service.stepId !== "test-review") throw new TypeError("TestReviewStep requires its bound RequirementTestService");
    this.#service = service;
  }
  selectResult() {
    if (this.#selectedResult !== null) return this.#selectedResult;
    const input = this.#service.inspectInput();
    let result = requirementTestFailureResult(input, TestReviewToolingUnavailableResult, TestReviewExternalBlockedResult);
    if (result === null) {
      const operands = { ...input.resultOperands(), evidence: input.evidence };
      if (input.evidence instanceof RequirementTestReviewExecutionEvidence) result = new TestReviewExecutionRequiredResult(operands);
      else if (input.evidence instanceof RequirementTestReviewEvidence) {
        if (input.evidence.verdict === "PASS") result = new TestReviewPassedResult(operands);
        else if (input.evidence.verdict === "ADVISORY") result = new TestReviewAdvisoryResult(operands);
        else result = new TestReviewRejectedResult(operands);
      } else throw new TypeError("Test Review requires its acquired work-unit evidence");
    }
    this.#selectedResult = result;
    return result;
  }
  async _execute() {
    const result = this.selectResult();
    await result.persist(this.#service);
    return result;
  }
}
