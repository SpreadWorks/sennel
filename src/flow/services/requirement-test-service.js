import { StepResult } from "../engine/step-result.js";
import { settleRequirementTestStepResult } from "../definition.js";
import { RequirementTestInput } from "./requirement-test-input.js";
import {
  RequirementTestSettlementPublication, RequirementTestSettlementWriter,
} from "./requirement-test-settlement-writer.js";

/** Supply acquired Requirement inputs and persist one Step-selected Result. */
export class RequirementTestService {
  static argumentTypes = [RequirementTestInput, RequirementTestSettlementWriter];
  #input;
  #writer;
  #outcome = null;
  #publication = new RequirementTestSettlementPublication();
  #publicationSelected = false;
  #selectedResult = null;
  #selectedSettlement = null;

  constructor(input, writer) {
    if (!(input instanceof RequirementTestInput) || !(writer instanceof RequirementTestSettlementWriter)) throw new TypeError("RequirementTestService requires typed input and settlement writer");
    this.#input = input;
    this.#writer = writer;
  }
  get stepId() { return this.#input.stepId; }
  inspectInput() { return this.#input; }
  selectSettlementPublication(publication) {
    if (this.#outcome !== null || this.#publicationSelected
      || !(publication instanceof RequirementTestSettlementPublication)) {
      throw new TypeError("Requirement settlement publication must be selected once before persistence");
    }
    this.#publication = publication;
    this.#publicationSelected = true;
    return this;
  }
  selectSettlement(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) throw new TypeError("Requirement Service requires its bound Step Result");
    if (this.#selectedResult !== null && this.#selectedResult !== stepResult) throw new TypeError("Requirement Service cannot change its selected Result");
    if (this.#selectedResult === null) {
      this.#selectedResult = stepResult;
      this.#selectedSettlement = settleRequirementTestStepResult(this.#input.stepId, stepResult);
    }
    return this.#selectedSettlement;
  }
  persistStepResult(stepResult) {
    const settlement = this.selectSettlement(stepResult);
    if (this.#outcome !== null) throw new TypeError("Requirement Service Result is already persisted");
    this.#outcome = this.#writer.settle({ stepResult, settlement, publication: this.#publication });
    return this.#outcome.receipt;
  }
  get settlementOutcome() { return this.#outcome; }
}
