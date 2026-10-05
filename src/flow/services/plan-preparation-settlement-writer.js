import { StepRoute } from "../definition.js";

/** Save-only access to the existing canonical settlement transaction. */
export class PlanPreparationSettlementWriter {
  #flowManager;
  #binding;
  #commandResult;

  constructor({ flowManager, binding, commandResult = null }) {
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#commandResult = commandResult;
  }

  async settle({ stepResult, settlement, preparation }) {
    const adopted = settlement instanceof StepRoute
      ? await new settlement.connector(preparation).connect() : null;
    return this.#flowManager.commitDraftStepResult({
      binding: this.#binding, stepResult, settlement, preparation: adopted,
      commandResult: this.#commandResult,
    });
  }
}
