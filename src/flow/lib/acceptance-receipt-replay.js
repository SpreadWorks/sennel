import { isDeepStrictEqual } from "node:util";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";

/** A read-only capability acquired from an exact canonical settlement receipt. */
export class AcceptanceReceiptReplay {
  #flowManager;
  #specId;
  #stepId;
  #completed;
  constructor({ flowManager, specId, stepId, receipt, completed = true }) {
    this.#flowManager = flowManager;
    this.#specId = specId;
    this.#stepId = stepId;
    this.#completed = completed;
    const saved = this.#read(receipt);
    if (saved === null || !isDeepStrictEqual(saved.receipt.toJSON(), (receipt.toJSON?.() ?? receipt))) {
      throw new StepAdmissionRefusal("Acceptance replay requires its exact authenticated receipt");
    }
    this.receipt = saved.receipt;
    Object.freeze(this);
  }
  assertCurrent() {
    const saved = this.#read(this.receipt);
    if (saved === null || !isDeepStrictEqual(saved.receipt.toJSON(), this.receipt.toJSON())) {
      throw new StepAdmissionRefusal("Acceptance replay selection is stale for its canonical receipt");
    }
  }
  #read(receipt) {
    return this.#flowManager.readCurrentStepSettlement({ specId: this.#specId, stepId: this.#stepId,
      completed: this.#completed, ...(this.#completed ? { exactReceipt: receipt } : {}) });
  }
}
