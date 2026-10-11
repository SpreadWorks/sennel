import { Step } from "../../engine/step.js";
import { StepErrorResult } from "../../engine/step-result.js";
import { FinalizeMergeService } from "../../services/finalize-merge-service.js";
import { FinalizeMergeResultEvidence } from "./finalization-values.js";
import { finalizationResultForEvidence } from "./finalization-result-factory.js";

export function finalizeMergeResult(input) {
  if (input.failure !== null) return new StepErrorResult("finalize-merge", input.failure);
  if (!(input.evidence instanceof FinalizeMergeResultEvidence)) throw new TypeError("FinalizeMerge requires acquired typed evidence");
  return finalizationResultForEvidence(input.evidence);
}

export class FinalizeMergeStep extends Step {
  static dependencies = [FinalizeMergeService];
  #service;
  constructor(service) {
    super();
    if (!(service instanceof FinalizeMergeService)) throw new TypeError("FinalizeMergeService is required");
    this.#service = service;
  }
  async _execute() {
    const result = finalizeMergeResult(this.#service.inspectInput());
    await result.persist(this.#service);
    return result;
  }
}
