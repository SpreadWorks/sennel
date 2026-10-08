import { StepBinding, canonicalStepState } from "../../step-binding.js";

/** Exact source Attempt for a registered implementation-phase Flow leaf. */
export class ImplStepBinding extends StepBinding {
  constructor({ flowManager, specId, stepId, allowFailed = false, continuation = null }) {
    const state = canonicalStepState(flowManager, specId);
    super({ flowManager, state, stepId, attempt: continuation?.attempt ?? state.attempt, allowFailed, continuation });
    Object.freeze(this);
  }
}
