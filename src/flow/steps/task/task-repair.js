import { Step } from "../../engine/step.js";
import { TaskRepairWorkerRequiredResult, TaskRepairReviewRequiredResult, TaskRepairUnreviewedGateResult, StepErrorResult } from "../../engine/step-result.js";
import { SourceStepService } from "../../services/source-step-service.js";
import { SourceStepFacts, SourceStepSelection } from "../../lib/source-effect-values.js";

export function taskRepairSourceResult(facts) {
  if (!(facts instanceof SourceStepFacts) || facts.stepId !== "task-repair") throw new TypeError("TaskRepairStep requires its typed source facts");
  if (facts.effect === null) return new TaskRepairWorkerRequiredResult();
  const { evidence } = facts;
  const Result = { "task-repair-unreviewed-gate": TaskRepairUnreviewedGateResult,
    "task-repair-review-required": TaskRepairReviewRequiredResult }[evidence.resultKind];
  return new Result({ evidence });
}

export class TaskRepairStep extends Step {
  static synchronous = true;
  static dependencies = [SourceStepService];
  #service;
  constructor(service) {
    super();
    if (!(service instanceof SourceStepService)) throw new TypeError("Source Step service is required");
    this.#service = service;
  }
  _execute() {
    const facts = this.#service.inspectSourceCompletion();
    let result;
    try { result = taskRepairSourceResult(facts); }
    catch (error) {
      result = new StepErrorResult("task-repair", error);
      result.persist(this.#service);
      return result;
    }
    this.#service.adoptSourceSelection(facts, new SourceStepSelection({ facts, result }));
    result.persist(this.#service);
    return result;
  }
}
