import { StepConnector } from "../../step-connector.js";
import { PreparationEvidence } from "../../../lib/preparation-evidence.js";

/** Carry the adopted Git evidence into mandatory preparation activation. */
export class PlanPreparationConnector extends StepConnector {
  static activateTarget = true;
  #preparation;

  constructor(preparation) {
    super();
    if (!(preparation instanceof PreparationEvidence)) throw new TypeError("PreparationEvidence is required");
    this.#preparation = preparation;
  }

  async connect() { return this.#preparation; }
}
