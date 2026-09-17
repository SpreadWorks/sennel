import { DraftStepBinding, DraftWorkerStepBinding } from "../engine/connectors/draft/draft-step-binding.js";

/** Access the sealed worker request for one Connector-bound Draft Step. */
export class DraftService {
  constructor({ flowManager, binding }) {
    if (!(binding instanceof DraftStepBinding)) {
      throw new TypeError("DraftService requires a typed Draft step binding");
    }
    if (binding.flowManager !== flowManager) {
      throw new Error("DraftService binding belongs to a different FlowManager");
    }
    this.binding = binding;
  }

  /** Return the exact sealed worker capability for this bound Draft Step. */
  workerRequest() {
    if (!(this.binding instanceof DraftWorkerStepBinding)) {
      throw new Error("Draft worker request requires a bound Draft worker Step");
    }
    this.binding.assertCurrent();
    return this.binding.request;
  }
}
