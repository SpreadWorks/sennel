import { StepConnector } from "../../step-connector.js";

const CONNECTABLE_STEPS = new Set([
  "test-generate", "test-review", "test-repair", "test-gate", "implement",
]);

/** Validates the canonical target already selected by Requirement-test lifecycle policy. */
export class RequirementTestConnector extends StepConnector {
  async connect({ flowManager, specId, targetStepId } = {}) {
    if (flowManager === null || typeof flowManager !== "object"
      || typeof specId !== "string" || !CONNECTABLE_STEPS.has(targetStepId)) {
      throw new TypeError("Requirement test connector requires its selected canonical target");
    }
    const state = flowManager.canonicalState(specId);
    if (state.current?.at(-1) !== targetStepId) {
      throw new Error("Requirement test connector target is not the active canonical Step");
    }
    return state;
  }
}
