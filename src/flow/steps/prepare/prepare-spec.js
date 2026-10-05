import { Step } from "../../engine/step.js";
import { PrepareSpecReadyResult } from "../../engine/step-result.js";
import { PlanPreparationService } from "../../services/plan-preparation-service.js";

/** Adopt completed mandatory preparation and durably activate Draft. */
export class PrepareSpecStep extends Step {
  static dependencies = [PlanPreparationService];
  #service;

  constructor(service) {
    super();
    if (!(service instanceof PlanPreparationService)) throw new TypeError("PlanPreparationService is required");
    this.#service = service;
  }

  async _execute() {
    const result = new PrepareSpecReadyResult();
    await result.persist(this.#service);
    return result;
  }
}
