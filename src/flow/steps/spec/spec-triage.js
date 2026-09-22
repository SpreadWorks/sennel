import { Step } from "../../engine/step.js";
import { SpecTriageCompletedResult, StepErrorResult } from "../../engine/step-result.js";
import { SpecReviewWorkerFacts, SpecReviewWorkerSelection, SpecReviewWorkerService } from "../../services/spec-worker-review-service.js";
import { mergeSpecReviewDelta } from "../../lib/spec-review-artifacts.js";
import { validateSpecRepairTriageFinding } from "../../lib/spec-repair-operations.js";

/** Filter each triage permission against the immutable canonical Spec. */
export function specTriageSelection(facts) {
  if (!(facts instanceof SpecReviewWorkerFacts) || facts.stepId !== "spec-triage") {
    throw new TypeError("Spec Triage requires its typed worker facts");
  }
  const validFindings = [];
  const discardedOperations = [];
  for (const update of facts.delta.findings.findings) {
    try {
      validateSpecRepairTriageFinding(update.toJSON(), facts.spec);
      validFindings.push(update.toJSON());
    } catch (cause) {
      discardedOperations.push({ findingId: update.findingId, reason: `invalid triage permission: ${cause.message}` });
    }
  }
  const permitted = facts.delta.withPermittedFindings(validFindings);
  return new SpecReviewWorkerSelection({
    result: new SpecTriageCompletedResult(),
    review: mergeSpecReviewDelta({ review: facts.review, delta: permitted, discardedOperations }),
  });
}

export class SpecTriageStep extends Step {
  static dependencies = [SpecReviewWorkerService];
  #service;
  constructor(service) {
    super();
    if (!(service instanceof SpecReviewWorkerService)) throw new TypeError("Spec Review worker service is required");
    this.#service = service;
  }
  async _execute() {
    const facts = this.#service.inspectWorkerCompletion();
    let selection;
    try { selection = specTriageSelection(facts); }
    catch (error) {
      const result = new StepErrorResult("spec-triage", error);
      await result.persist(this.#service);
      return result;
    }
    this.#service.adoptWorkerSelection(facts, selection);
    await selection.result.persist(this.#service);
    return selection.result;
  }
}
