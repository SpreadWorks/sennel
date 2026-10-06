import { Step } from "../../engine/step.js";
import {
  RequirementTestGateEvidence, TestGateCompatibleResult, TestGateIncompatibleResult,
  TestGateToolingUnavailableResult,
} from "../../engine/step-result.js";
import { RequirementTestService } from "../../services/requirement-test-service.js";
import { requirementTestFailureResult } from "./requirement-test-result.js";

/** Compare the exact named runner observation with this Requirement's expectation. */
export class TestGateStep extends Step {
  static dependencies = [RequirementTestService];
  #service;
  #selectedResult = null;
  constructor(service) {
    super();
    if (!(service instanceof RequirementTestService) || service.stepId !== "test-gate") throw new TypeError("TestGateStep requires its bound RequirementTestService");
    this.#service = service;
  }
  selectResult() {
    if (this.#selectedResult !== null) return this.#selectedResult;
    const input = this.#service.inspectInput();
    let result = requirementTestFailureResult(input, TestGateToolingUnavailableResult, null);
    if (result === null) {
      if (!(input.evidence instanceof RequirementTestGateEvidence)) throw new TypeError("Test Gate requires its actual named observation publication");
      const kind = input.evidence.observation.kind;
      const expected = input.workItem.expectation.value === "fail" ? "assertion_failed" : "assertion_passed";
      const operands = { ...input.resultOperands(), evidence: input.evidence };
      result = kind === "tooling_failure" ? new TestGateToolingUnavailableResult(operands)
        : kind === expected ? new TestGateCompatibleResult(operands) : new TestGateIncompatibleResult(operands);
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
