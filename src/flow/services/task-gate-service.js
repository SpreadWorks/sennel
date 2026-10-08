import { StepResult } from "../engine/step-result.js";
import { settleTaskStepResult } from "../definition.js";
import { TaskGateInput } from "./task-gate-input.js";
import { TaskGateSettlementWriter } from "./task-gate-settlement-writer.js";

/** Provides the acquired observation and persists the Step's concrete meaning. */
export class TaskGateService {
  static argumentTypes = [TaskGateInput, TaskGateSettlementWriter];
  #input;
  #writer;
  #outcome = null;
  #settlement = null;
  constructor(input, writer) {
    if (!(input instanceof TaskGateInput) || !(writer instanceof TaskGateSettlementWriter)) {
      throw new TypeError("TaskGateService requires its typed input and writer");
    }
    this.#input = input;
    this.#writer = writer;
  }
  inspectGateObservation() { return this.#input.observation; }
  get settlementOutcome() { return this.#outcome; }
  get selectedSettlement() { return this.#settlement; }

  persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) {
      throw new TypeError("TaskGateService requires its own Step Result");
    }
    this.#settlement = settleTaskStepResult(this.#input.stepId, stepResult);
    this.#outcome = this.#writer.settle({ stepResult, settlement: this.#settlement });
    return this.#outcome.receipt;
  }
}
