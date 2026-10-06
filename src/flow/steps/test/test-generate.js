import { Step } from "../../engine/step.js";
import {
  TestGenerateCandidateSavedResult, TestGenerateStructuralRejectedResult,
  TestGenerateToolingUnavailableResult, TestGenerateExternalBlockedResult,
} from "../../engine/step-result.js";
import { RequirementTestService } from "../../services/requirement-test-service.js";
import { requirementTestFailureResult } from "./requirement-test-result.js";

/** Adopt the sealed generation candidate; all source validation precedes this Step. */
export class TestGenerateStep extends Step {
  static dependencies = [RequirementTestService];
  #service;
  #selectedResult = null;
  constructor(service) {
    super();
    if (!(service instanceof RequirementTestService) || service.stepId !== "test-generate") throw new TypeError("TestGenerateStep requires its bound RequirementTestService");
    this.#service = service;
  }
  selectResult() {
    if (this.#selectedResult !== null) return this.#selectedResult;
    const input = this.#service.inspectInput();
    const failure = requirementTestFailureResult(input, TestGenerateToolingUnavailableResult, TestGenerateExternalBlockedResult);
    const operands = { ...input.resultOperands(), candidateBundle: input.candidateBundle };
    this.#selectedResult = failure ?? (input.structuralFinding === null
      ? new TestGenerateCandidateSavedResult(operands)
      : new TestGenerateStructuralRejectedResult({ ...operands, semanticFinding: input.structuralFinding }));
    return this.#selectedResult;
  }
  async _execute() {
    const result = this.selectResult();
    await result.persist(this.#service);
    return result;
  }
}
