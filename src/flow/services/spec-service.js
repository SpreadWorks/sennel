import { StepResult } from "../engine/step-result.js";
import { settleSpecStepResult, StepErrorDecision, StepRoute } from "../definition.js";
import { SpecWorkerCompletionFacts } from "../lib/spec-worker-completion-facts.js";
import { SpecWorkerResultSelection } from "../lib/spec-worker-result-selection.js";
import { SpecWorkerInput } from "./spec-worker-input.js";
import { SpecSettlementWriter } from "./spec-settlement-writer.js";

/** Adopt a prepared Spec candidate and save its selected Result. */
export class SpecService {
  static argumentTypes = [SpecWorkerInput, SpecSettlementWriter];
  #input;
  #writer;
  #outcome = null;
  #adoption = null;

  constructor(input, writer) {
    if (!(input instanceof SpecWorkerInput) || input.stepId !== "spec"
      || !(input.facts instanceof SpecWorkerCompletionFacts)
      || !(writer instanceof SpecSettlementWriter)) {
      throw new TypeError("SpecService requires its typed worker input and settlement writer");
    }
    this.#input = input;
    this.#writer = writer;
  }

  inspectWorkerCompletion() {
    if (this.#outcome !== null) throw new Error("prepared Spec adoption is stale after its completed settlement");
    return this.#input.facts;
  }

  adoptWorkerCandidate(selection) {
    if (!(selection instanceof SpecWorkerResultSelection)
      || selection.facts !== this.#input.facts) {
      throw new TypeError("SpecService requires the Step selection for its prepared Spec candidate");
    }
    this.#adoption = selection;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) {
      throw new TypeError("SpecService requires its bound Step's concrete Result");
    }
    const settlement = settleSpecStepResult(this.#input.stepId, stepResult);
    const errorSettlement = settlement instanceof StepErrorDecision;
    if (this.#adoption !== null) this.#adoption.assertResult(stepResult);
    if (!errorSettlement && (!(settlement instanceof StepRoute) || this.#adoption === null)) {
      throw new TypeError("Spec publication requires the Step-adopted candidate and Result");
    }
    this.#outcome = await this.#writer.settleInitial({ stepResult, settlement,
      selection: this.#adoption });
    return this.#outcome.receipt;
  }

  get workerOutcome() { return this.#outcome; }
}
