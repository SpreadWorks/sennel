import { Step } from "../../engine/step.js";
import { DraftCreatedResult } from "../../engine/step-result.js";
import { DraftService } from "../../services/draft-service.js";

/** Create and persist one concrete Draft worker Result through its Service. */
export async function executeDraftWorker(draftService, ResultClass) {
  const result = new ResultClass();
  await result.persist(draftService);
  return result;
}

/** Create the initial Draft from facts prepared by the parent handoff. */
export class DraftStep extends Step {
  static dependencies = [DraftService];

  #draftService;

  constructor(draftService) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    this.#draftService = draftService;
  }

  async _execute() {
    return executeDraftWorker(this.#draftService, DraftCreatedResult);
  }
}
