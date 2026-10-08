import { Step } from "../../engine/step.js";
import { TaskReviewExecutionRequiredResult, TaskReviewFindingsResult, TaskReviewGateRequiredResult,
  TaskReviewNoChangeCompletedResult, TaskReviewUnavailableResult, StepErrorResult } from "../../engine/step-result.js";
import { TaskReviewService } from "../../services/task-review-service.js";
import { ReviewWorkUnitManifest } from "../../lib/review-work-unit-values.js";
import { TaskReviewStageFacts } from "../../lib/task-review-stage-transition.js";
import { ReviewStepFailureObservation } from "../../lib/review-step-failure-values.js";
import { TaskStageResultEvidence } from "../../lib/task-stage-result-values.js";

export function taskReviewResult(facts, frontier) {
  if (facts instanceof ReviewStepFailureObservation) return new StepErrorResult("task-review", facts.toError());
  if (facts instanceof ReviewWorkUnitManifest) return new TaskReviewExecutionRequiredResult();
  if (!(facts instanceof TaskReviewStageFacts) || facts.binding.stage !== "review") {
    throw new TypeError("Task Review Result requires its acquired canonical stage facts");
  }
  const evidence = new TaskStageResultEvidence({ facts, frontier });
  if (evidence.resultKind === "task-review-findings") return new TaskReviewFindingsResult({ evidence });
  if (evidence.resultKind === "task-review-gate-required") return new TaskReviewGateRequiredResult({ evidence });
  if (evidence.resultKind === "task-review-no-change-completed") return new TaskReviewNoChangeCompletedResult({ evidence });
  if (evidence.resultKind === "task-review-unavailable") return new TaskReviewUnavailableResult({ evidence });
  throw new TypeError("Task Review selected an unsupported stage operation");
}

export class TaskReviewStep extends Step {
  static dependencies = [TaskReviewService];
  #service;
  constructor(service) {
    super();
    if (!(service instanceof TaskReviewService)) throw new TypeError("TaskReviewService is required");
    this.#service = service;
  }
  async _execute() {
    const facts = this.#service.inspectFacts();
    let result;
    if (facts instanceof ReviewWorkUnitManifest) result = taskReviewResult(facts, this.#service.frontier);
    else {
      try { result = taskReviewResult(facts, this.#service.frontier); }
      catch (error) { result = new StepErrorResult("task-review", error); }
    }
    await result.persist(this.#service);
    return result;
  }
}
