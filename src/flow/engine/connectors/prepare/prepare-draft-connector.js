import { StepConnector } from "../../step-connector.js";
import { PreparationEvidence } from "../../../lib/preparation-evidence.js";

/** Bind Draft activation to the exact completed preparation publication. */
export class PrepareDraftConnector extends StepConnector {
  #preparation;

  constructor(preparation) {
    super();
    if (!(preparation instanceof PreparationEvidence)) throw new TypeError("PreparationEvidence is required");
    this.#preparation = preparation;
  }

  async connect() { return this.#preparation; }
}
