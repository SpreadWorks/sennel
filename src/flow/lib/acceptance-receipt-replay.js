import { isDeepStrictEqual } from "node:util";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";

/** A read-only capability acquired from the exact completed canonical receipt. */
export class AcceptanceReceiptReplay {
  #flowManager;
  #specId;
  #stepId;
  constructor({ flowManager, specId, stepId, receipt }) {
    const saved = flowManager.readCurrentStepSettlement({ specId, stepId, completed: true, exactReceipt: receipt });
    if (saved === null || !isDeepStrictEqual(saved.receipt.toJSON(), (receipt.toJSON?.() ?? receipt))) {
      throw new StepAdmissionRefusal("Acceptance replay requires its exact authenticated receipt");
    }
    this.#flowManager = flowManager;
    this.#specId = specId;
    this.#stepId = stepId;
    this.receipt = saved.receipt;
    Object.freeze(this);
  }
  assertCurrent() {
    const saved = this.#flowManager.readCurrentStepSettlement({ specId: this.#specId,
      stepId: this.#stepId, completed: true, exactReceipt: this.receipt });
    if (saved === null || !isDeepStrictEqual(saved.receipt.toJSON(), this.receipt.toJSON())) {
      throw new StepAdmissionRefusal("Acceptance replay selection is stale for its canonical receipt");
    }
  }
}
