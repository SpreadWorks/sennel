import { settleTaskStepResult } from "../definition.js";
import { StepResult } from "../engine/step-result.js";
import { TaskReviewInput } from "./task-review-input.js";
import { TaskReviewSettlementWriter } from "./task-review-settlement-writer.js";

/** Provides acquired evidence and saves only the Step's selected Result. */
export class TaskReviewService {
  static argumentTypes = [TaskReviewInput, TaskReviewSettlementWriter];
  #input;
  #writer;
  #outcome = null;

  constructor(input, writer) {
    if (!(input instanceof TaskReviewInput) || !(writer instanceof TaskReviewSettlementWriter)) {
      throw new TypeError("TaskReviewService requires its typed input and writer");
    }
    this.#input = input;
    this.#writer = writer;
  }

  get frontier() { return this.#input.frontier; }

  inspectFacts() { return this.#input.failure ?? this.#input.facts ?? this.#input.manifest; }

  get settlementOutcome() { return this.#outcome; }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) {
      throw new TypeError("TaskReviewService requires its own Step Result");
    }
    this.#outcome = await this.#writer.settle({ stepResult,
      settlement: settleTaskStepResult(this.#input.stepId, stepResult) });
    return this.#outcome.receipt;
  }
}
