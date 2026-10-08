import { Step } from "../../engine/step.js";
import { ImplRepairWorkerRequiredResult, ImplRepairAppliedResult, ImplRepairQualityIssueResult, StepErrorResult } from "../../engine/step-result.js";
import { SourceStepService } from "../../services/source-step-service.js";
import { SourceStepFacts, SourceStepSelection } from "../../lib/source-effect-values.js";

export function implRepairSourceResult(facts) {
  if (!(facts instanceof SourceStepFacts) || facts.stepId !== "impl-repair") throw new TypeError("ImplRepairStep requires its typed source facts");
  if (facts.effect === null) return new ImplRepairWorkerRequiredResult();
  const { evidence } = facts;
  const Result = { "impl-repair-quality-issue": ImplRepairQualityIssueResult,
    "impl-repair-applied": ImplRepairAppliedResult }[evidence.resultKind];
  return new Result({ evidence });
}

export class ImplRepairStep extends Step {
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
    try { result = implRepairSourceResult(facts); }
    catch (error) {
      result = new StepErrorResult("impl-repair", error);
      result.persist(this.#service);
      return result;
    }
    this.#service.adoptSourceSelection(facts, new SourceStepSelection({ facts, result }));
    result.persist(this.#service);
    return result;
  }
}
