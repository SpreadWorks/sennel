import { Step } from "../../engine/step.js";
import { TaskImplementationWorkerRequiredResult, TaskImplementationAppliedResult, TaskImplementationNoChangeResult, TaskImplementationQualityIssueResult, StepErrorResult } from "../../engine/step-result.js";
import { SourceStepService } from "../../services/source-step-service.js";
import { SourceStepFacts, SourceStepSelection } from "../../lib/source-effect-values.js";

export function taskImplementationSourceResult(facts) {
  if (!(facts instanceof SourceStepFacts) || facts.stepId !== "task-impl") throw new TypeError("TaskImplementationStep requires its typed source facts");
  if (facts.effect === null) return new TaskImplementationWorkerRequiredResult();
  if (facts.completionFailure !== null) return new StepErrorResult("task-impl", facts.completionFailure);
  const { evidence } = facts;
  const Result = { "task-impl-quality-issue": TaskImplementationQualityIssueResult,
    "task-impl-no-change": TaskImplementationNoChangeResult, "task-impl-applied": TaskImplementationAppliedResult }[evidence.resultKind];
  return new Result({ evidence });
}

export class TaskImplementationStep extends Step {
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
    try { result = taskImplementationSourceResult(facts); }
    catch (error) {
      result = new StepErrorResult("task-impl", error);
      result.persist(this.#service);
      return result;
    }
    this.#service.adoptSourceSelection(facts, new SourceStepSelection({ facts, result }));
    result.persist(this.#service);
    return result;
  }
}
