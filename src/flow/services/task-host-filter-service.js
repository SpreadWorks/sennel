import { settleTaskStepResult } from "../definition.js";
import { StepResult } from "../engine/step-result.js";
import { TaskHostFilterInput } from "./task-host-filter-input.js";
import { TaskHostFilterSettlementWriter } from "./task-host-filter-settlement-writer.js";

/** Provides acquired evidence and saves only the Step's selected Result. */
export class TaskHostFilterService {
  static argumentTypes = [TaskHostFilterInput, TaskHostFilterSettlementWriter];
  #input;
  #writer;
  #outcome = null;

  constructor(input, writer) {
    if (!(input instanceof TaskHostFilterInput) || !(writer instanceof TaskHostFilterSettlementWriter)) {
      throw new TypeError("TaskHostFilterService requires its typed input and writer");
    }
    this.#input = input;
    this.#writer = writer;
  }

  get frontier() { return this.#input.frontier; }

  inspectFacts() { return this.#input.facts ?? this.#input.authority; }

  get settlementOutcome() { return this.#outcome; }

  persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) {
      throw new TypeError("TaskHostFilterService requires its own Step Result");
    }
    this.#outcome = this.#writer.settle({ stepResult,
      settlement: settleTaskStepResult(this.#input.stepId, stepResult) });
    return this.#outcome.receipt;
  }
}
