import { Step } from "../../engine/step.js";
import { StepErrorResult } from "../../engine/step-result.js";
import { FinalizeSyncService } from "../../services/finalize-sync-service.js";
import { FinalizeSyncResultEvidence } from "./finalization-values.js";
import { finalizationResultForEvidence } from "./finalization-result-factory.js";

export function finalizeSyncResult(input) {
  if (input.failure !== null) return new StepErrorResult("finalize-sync", input.failure);
  if (!(input.evidence instanceof FinalizeSyncResultEvidence)) throw new TypeError("FinalizeSync requires acquired typed evidence");
  return finalizationResultForEvidence(input.evidence);
}

export class FinalizeSyncStep extends Step {
  static dependencies = [FinalizeSyncService];
  #service;
  constructor(service) {
    super();
    if (!(service instanceof FinalizeSyncService)) throw new TypeError("FinalizeSyncService is required");
    this.#service = service;
  }
  async _execute() {
    const result = finalizeSyncResult(this.#service.inspectInput());
    await result.persist(this.#service);
    return result;
  }
}
