import { Step } from "../../engine/step.js";
import {
  TestRepairProgressSavedResult, TestRepairCandidateSavedResult, TestRepairStructuralRejectedResult,
  TestRepairToolingUnavailableResult, TestRepairExternalBlockedResult,
} from "../../engine/step-result.js";
import { RequirementTestService } from "../../services/requirement-test-service.js";
import { requirementTestFailureResult } from "./requirement-test-result.js";

/** Adopt one bounded repair checkpoint or the sealed final candidate revision. */
export class TestRepairStep extends Step {
  static dependencies = [RequirementTestService];
  #service;
  #selectedResult = null;
  constructor(service) {
    super();
    if (!(service instanceof RequirementTestService) || service.stepId !== "test-repair") throw new TypeError("TestRepairStep requires its bound RequirementTestService");
    this.#service = service;
  }
  selectResult() {
    if (this.#selectedResult !== null) return this.#selectedResult;
    const input = this.#service.inspectInput();
    let result = requirementTestFailureResult(input, TestRepairToolingUnavailableResult, TestRepairExternalBlockedResult);
    if (result === null) {
      if (input.progressIdentity !== null) result = new TestRepairProgressSavedResult({ ...input.resultOperands(), progressIdentity: input.progressIdentity });
      else {
        const operands = { ...input.resultOperands(), candidateBundle: input.candidateBundle };
        result = input.structuralFinding === null ? new TestRepairCandidateSavedResult(operands)
          : new TestRepairStructuralRejectedResult({ ...operands, semanticFinding: input.structuralFinding });
      }
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
