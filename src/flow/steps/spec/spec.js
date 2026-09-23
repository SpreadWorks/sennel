import { Step } from "../../engine/step.js";
import {
  SpecCreatedResult,
  SpecPlanGateRepairAppliedResult,
  SpecPlanGateRepairNoProgressResult,
  StepErrorResult,
} from "../../engine/step-result.js";
import { SpecService } from "../../services/spec-service.js";
import { SpecWorkerCompletionFacts } from "../../lib/spec-step-connection.js";

/** Pure mapping from validated Spec completion facts to its Result. */
export function specResult(facts) {
  if (facts instanceof Error) return new StepErrorResult("spec", facts);
  if (!(facts instanceof SpecWorkerCompletionFacts)) {
    throw new TypeError("Spec Result requires its typed completion facts");
  }
  if (facts.planGateRepairOutcome?.disposition === "applied") {
    return new SpecPlanGateRepairAppliedResult();
  }
  if (facts.planGateRepairOutcome?.disposition === "rejected-no-progress") {
    const error = new Error("Spec plan Gate repair produced no progress");
    error.code = "FLOW_PLAN_GATE_REPAIR_NO_PROGRESS";
    return new SpecPlanGateRepairNoProgressResult(error);
  }
  return new SpecCreatedResult();
}

/** Publish a Spec candidate and connect it to Spec Review. */
export class SpecStep extends Step {
  static dependencies = [SpecService];

  #specService;

  constructor(specService) {
    super();
    if (!(specService instanceof SpecService)) throw new TypeError("SpecService is required");
    this.#specService = specService;
  }

  async _execute() {
    const facts = this.#specService.inspectWorkerCompletion();
    const result = specResult(facts);
    this.#specService.adoptWorkerCandidate(facts, result);
    await result.persist(this.#specService);
    return result;
  }
}
