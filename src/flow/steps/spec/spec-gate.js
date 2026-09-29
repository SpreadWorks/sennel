import { Step } from "../../engine/step.js";
import { SpecGateService } from "../../services/spec-gate-service.js";
import { specGateResult } from "./spec-gate-result.js";
import { SpecGateResultSelection } from "../../lib/spec-gate-result-selection.js";
export { specGateResult } from "./spec-gate-result.js";

export class SpecGateStep extends Step {
  static dependencies = [SpecGateService];
  #service;

  constructor(service) {
    super();
    if (!(service instanceof SpecGateService)) throw new TypeError("SpecGateService is required");
    this.#service = service;
  }

  selectResult() {
    this.#service.assertGateResultAdmission();
    const facts = this.#service.inspectGateFacts();
    const selection = new SpecGateResultSelection({ facts, result: specGateResult(facts) });
    this.#service.acceptGateResultSelection(selection);
    return selection.result;
  }

  async _execute() {
    const result = this.selectResult();
    await result.persist(this.#service);
    return result;
  }
}
