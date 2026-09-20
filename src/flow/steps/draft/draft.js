import { Step } from "../../engine/step.js";
import { DraftCreatedResult } from "../../engine/step-result.js";
import { DraftService } from "../../services/draft-service.js";

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
    const result = new DraftCreatedResult();
    await result.persist(this.#draftService);
    return result;
  }
}
