import { Step } from "../../engine/step.js";
import { StepErrorResult } from "../../engine/step-result.js";
import { FinalizeCleanupService } from "../../services/finalize-cleanup-service.js";
import { FinalizeCleanupResultEvidence } from "./finalization-values.js";
import { finalizationResultForEvidence } from "./finalization-result-factory.js";

export function finalizeCleanupResult(input) {
  if (input.failure !== null) return new StepErrorResult("finalize-cleanup", input.failure);
  if (!(input.evidence instanceof FinalizeCleanupResultEvidence)) throw new TypeError("FinalizeCleanup requires acquired typed evidence");
  return finalizationResultForEvidence(input.evidence);
}

export class FinalizeCleanupStep extends Step {
  static dependencies = [FinalizeCleanupService];
  #service;
  constructor(service) {
    super();
    if (!(service instanceof FinalizeCleanupService)) throw new TypeError("FinalizeCleanupService is required");
    this.#service = service;
  }
  async _execute() {
    const result = finalizeCleanupResult(this.#service.inspectInput());
    await result.persist(this.#service);
    return result;
  }
}
