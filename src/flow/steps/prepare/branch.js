import { Step } from "../../engine/step.js";
import { BranchPreparedResult, BranchNotRequiredResult } from "../../engine/step-result.js";
import { PlanPreparationService } from "../../services/plan-preparation-service.js";

/** Adopt the acquired Git preparation without repeating its external effects. */
export class BranchStep extends Step {
  static dependencies = [PlanPreparationService];
  #service;

  constructor(service) {
    super();
    if (!(service instanceof PlanPreparationService)) throw new TypeError("PlanPreparationService is required");
    this.#service = service;
  }

  async _execute() {
    const preparation = this.#service.inspectPreparation();
    const result = preparation.branch === null
      ? new BranchNotRequiredResult() : new BranchPreparedResult();
    await result.persist(this.#service);
    return result;
  }
}
