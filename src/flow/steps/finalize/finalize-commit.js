import { Step } from "../../engine/step.js";
import { StepErrorResult } from "../../engine/step-result.js";
import { FinalizeCommitService } from "../../services/finalize-commit-service.js";
import { FinalizeCommitResultEvidence } from "./finalization-values.js";
import { finalizationResultForEvidence } from "./finalization-result-factory.js";

export function finalizeCommitResult(input) {
  if (input.failure !== null) return new StepErrorResult("finalize-commit", input.failure);
  if (!(input.evidence instanceof FinalizeCommitResultEvidence)) throw new TypeError("FinalizeCommit requires acquired typed evidence");
  return finalizationResultForEvidence(input.evidence);
}

export class FinalizeCommitStep extends Step {
  static dependencies = [FinalizeCommitService];
  #service;
  constructor(service) {
    super();
    if (!(service instanceof FinalizeCommitService)) throw new TypeError("FinalizeCommitService is required");
    this.#service = service;
  }
  async _execute() {
    const result = finalizeCommitResult(this.#service.inspectInput());
    await result.persist(this.#service);
    return result;
  }
}
