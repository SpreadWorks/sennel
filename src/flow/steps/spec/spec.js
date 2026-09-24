import { Step } from "../../engine/step.js";
import { SpecService } from "../../services/spec-service.js";
import { SpecWorkerResultSelection } from "./spec-result.js";

/** Publish a Spec candidate and connect it to Spec Review. */
export class SpecStep extends Step {
  static dependencies = [SpecService];

  #specService;

  constructor(specService) {
    super();
    if (!(specService instanceof SpecService)) throw new TypeError("SpecService is required");
    this.#specService = specService;
  }

  async _execute() {
    const facts = this.#specService.inspectWorkerCompletion();
    const selection = new SpecWorkerResultSelection(facts);
    this.#specService.adoptWorkerCandidate(selection);
    await selection.result.persist(this.#specService);
    return selection.result;
  }
}
