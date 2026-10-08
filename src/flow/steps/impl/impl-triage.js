import { Step } from "../../engine/step.js";
import { ImplTriageWorkerRequiredResult, ImplTriageRepairRequiredResult, ImplTriageGateRequiredResult, StepErrorResult } from "../../engine/step-result.js";
import { SourceStepService } from "../../services/source-step-service.js";
import { SourceStepFacts, SourceStepSelection } from "../../lib/source-effect-values.js";

export function implTriageSourceResult(facts) {
  if (!(facts instanceof SourceStepFacts) || facts.stepId !== "impl-triage") throw new TypeError("ImplTriageStep requires its typed source facts");
  if (facts.effect === null) return new ImplTriageWorkerRequiredResult();
  const { evidence } = facts;
  const Result = { "impl-triage-repair-required": ImplTriageRepairRequiredResult,
    "impl-triage-gate-required": ImplTriageGateRequiredResult }[evidence.resultKind];
  return new Result({ evidence });
}

export class ImplTriageStep extends Step {
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
    try { result = implTriageSourceResult(facts); }
    catch (error) {
      result = new StepErrorResult("impl-triage", error);
      result.persist(this.#service);
      return result;
    }
    this.#service.adoptSourceSelection(facts, new SourceStepSelection({ facts, result }));
    result.persist(this.#service);
    return result;
  }
}
