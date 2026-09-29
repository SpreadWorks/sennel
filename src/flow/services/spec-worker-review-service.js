import { StepResult, StepErrorResult } from "../engine/step-result.js";
import { settleSpecStepResult, StepRoute, StepErrorDecision } from "../definition.js";
import { SpecReviewWorkerFacts, SpecReviewWorkerSelection } from "../lib/spec-review-worker-facts.js";
import { SpecWorkerInput } from "./spec-worker-input.js";
import { SpecSettlementWriter } from "./spec-settlement-writer.js";

/** Adopt a Spec Triage or Repair result and save its exact handoff. */
export class SpecReviewWorkerService {
  static argumentTypes = [SpecWorkerInput, SpecSettlementWriter];
  #input;
  #writer;
  #selection = null;
  #outcome = null;

  constructor(input, writer) {
    if (!(input instanceof SpecWorkerInput) || input.stepId === "spec"
      || !(input.facts instanceof SpecReviewWorkerFacts)
      || !(writer instanceof SpecSettlementWriter)) {
      throw new TypeError("Spec Review worker service requires its prepared input and writer");
    }
    this.#input = input;
    this.#writer = writer;
  }

  inspectWorkerCompletion() { return this.#input.facts; }

  adoptWorkerSelection(facts, selection) {
    if (facts !== this.#input.facts || !(selection instanceof SpecReviewWorkerSelection)
      || selection.facts !== facts || selection.result.stepId !== this.#input.stepId
      || !selection.review.identity.equals(facts.review.identity)) {
      throw new TypeError("Spec Review worker selection does not match its handoff");
    }
    this.#selection = selection;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId
      || (!(stepResult instanceof StepErrorResult) && this.#selection?.result !== stepResult)) {
      throw new TypeError("Spec Review worker publication requires its Step-selected Result");
    }
    const settlement = settleSpecStepResult(this.#input.stepId, stepResult);
    if (!(settlement instanceof StepErrorDecision || settlement instanceof StepRoute)) {
      throw new TypeError("Spec Review worker requires its selected route");
    }
    this.#outcome = await this.#writer.settleReviewWorker({ stepResult, settlement,
      selection: this.#selection });
    return this.#outcome.receipt;
  }

  get workerOutcome() { return this.#outcome; }
}
