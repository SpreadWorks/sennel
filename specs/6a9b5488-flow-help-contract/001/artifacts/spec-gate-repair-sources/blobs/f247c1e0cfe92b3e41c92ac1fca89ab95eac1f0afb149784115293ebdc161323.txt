import { isDeepStrictEqual } from "node:util";
import { Step } from "../../engine/step.js";
import { SpecRepairChangedResult, SpecRepairUnchangedResult, StepErrorResult } from "../../engine/step-result.js";
import { SpecReviewWorkerService } from "../../services/spec-worker-review-service.js";
import { SpecReviewWorkerFacts, SpecReviewWorkerSelection, SpecReviewWorkerCandidate } from "../../lib/spec-review-worker-facts.js";
import { mergeSpecReviewDelta } from "../../lib/spec-review-artifacts.js";
import { applySpecRepairOperations, specRepairProposalDigest } from "../../lib/spec-repair-operations.js";

/** Apply only canonical Review permissions, preserving each rejected proposal in the audit. */
export function specRepairSelection(facts) {
  if (!(facts instanceof SpecReviewWorkerFacts) || facts.stepId !== "spec-repair") {
    throw new TypeError("Spec Repair requires its typed worker facts");
  }
  const repairResult = applySpecRepairOperations({
    spec: facts.spec,
    triage: facts.review.toJSON(),
    repair: facts.delta.toJSON(),
    inputRevision: facts.delta.identity.digest,
    validator: facts.validator,
  });
  const acceptedOperations = repairResult.audit.acceptedOperations.map((entry) => entry.operation ?? entry);
  const discardedOperations = [
    ...repairResult.audit.discardedOperations,
    ...repairResult.audit.scopeExpansions.map(({ proposal }) => ({
      findingIds: [], kind: null, target: null,
      operationDigest: specRepairProposalDigest(proposal),
      reason: "scope expansion requires definition-owned admission",
    })),
  ];
  const changed = !isDeepStrictEqual(repairResult.spec, facts.spec);
  return new SpecReviewWorkerSelection({
    result: changed ? new SpecRepairChangedResult() : new SpecRepairUnchangedResult(),
    review: mergeSpecReviewDelta({
      review: facts.review, delta: facts.delta, acceptedOperations, discardedOperations,
    }),
    candidate: changed ? new SpecReviewWorkerCandidate(repairResult.spec) : undefined,
    facts,
  });
}

export class SpecRepairStep extends Step {
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
    try { selection = specRepairSelection(facts); }
    catch (error) {
      const result = new StepErrorResult("spec-repair", error);
      await result.persist(this.#service);
      return result;
    }
    this.#service.adoptWorkerSelection(facts, selection);
    await selection.result.persist(this.#service);
    return selection.result;
  }
}
