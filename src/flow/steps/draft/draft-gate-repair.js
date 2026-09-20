import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import { executeDraftWorker } from "./draft.js";
import {
  DraftGateRepairAppliedResult,
  DraftGateRepairWorkerRequiredResult,
} from "../../engine/step-result.js";

/**
 * Apply the selected Gate repair request to the bound Draft.
 * The bound handoff carries the selected Gate repair plan.
 */
export class DraftGateRepairStep extends Step {
  static dependencies = [DraftService];

  #draftService;

  constructor(draftService) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    this.#draftService = draftService;
  }

  async _execute() {
    if (this.#draftService.requiresWorkerExecution()) {
      const result = new DraftGateRepairWorkerRequiredResult();
      await result.persist(this.#draftService);
      return result;
    }
    return executeDraftWorker(this.#draftService, DraftGateRepairAppliedResult);
  }
}
