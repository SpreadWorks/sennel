import { Step } from "../../engine/step.js";
import { ImplementWorkerRequiredResult, ImplementAppliedResult, ImplementExistingCompletionResult, ImplementQualityIssueResult, StepErrorResult } from "../../engine/step-result.js";
import { SourceStepService } from "../../services/source-step-service.js";
import { SourceStepFacts, SourceStepSelection } from "../../lib/source-effect-values.js";

export function implementSourceResult(facts) {
  if (!(facts instanceof SourceStepFacts) || facts.stepId !== "implement") throw new TypeError("ImplementStep requires its typed source facts");
  if (facts.effect === null) return new ImplementWorkerRequiredResult();
  const { evidence } = facts;
  const Result = { "implement-existing-completion": ImplementExistingCompletionResult,
    "implement-quality-issue": ImplementQualityIssueResult, "implement-applied": ImplementAppliedResult }[evidence.resultKind];
  return new Result({ evidence });
}

export class ImplementStep extends Step {
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
    try { result = implementSourceResult(facts); }
    catch (error) {
      result = new StepErrorResult("implement", error);
      result.persist(this.#service);
      return result;
    }
    this.#service.adoptSourceSelection(facts, new SourceStepSelection({ facts, result }));
    result.persist(this.#service);
    return result;
  }
}
