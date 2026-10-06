import {
  RequirementTestResultBinding, RequirementTestResultFrontier, RequirementTestRetryState,
  RequirementTestReviewExecutionEvidence, RequirementTestReviewEvidence,
  RequirementTestGateEvidence, RequirementTestToolingEvidence,
  RequirementTestRepairProgressIdentity,
} from "../engine/step-result.js";
import { RequirementTestCandidateBundle } from "../lib/requirement-test-artifacts.js";
import { RequirementTestSemanticFinding, RequirementTestWorkItem } from "../lib/requirement-test-lifecycle.js";

/** Acquired, typed semantic inputs; materialization and canonical reads stay outside the Service. */
export class RequirementTestInput {
  constructor({ binding, frontier, retryState, workItem, candidateBundle = null,
    structuralFinding = null, evidence = null, progressIdentity = null, error = null } = {}) {
    if (!(binding instanceof RequirementTestResultBinding)
      || !(frontier instanceof RequirementTestResultFrontier)
      || !(retryState instanceof RequirementTestRetryState)
      || !(workItem instanceof RequirementTestWorkItem)
      || workItem.requirementId !== binding.requirementId || !workItem.specRevision.equals(binding.specRevision)
      || workItem.status !== binding.status) throw new TypeError("Requirement test input requires its exact typed source work item and Result operands");
    if (candidateBundle !== null && !(candidateBundle instanceof RequirementTestCandidateBundle)) throw new TypeError("Requirement test input candidate must be canonical");
    if (structuralFinding !== null && (!(structuralFinding instanceof RequirementTestSemanticFinding)
      || candidateBundle === null || structuralFinding.requirementId !== binding.requirementId
      || structuralFinding.bundleRevision !== candidateBundle.bundle.revision)) throw new TypeError("Requirement structural finding must bind its adopted candidate");
    if (evidence !== null && !(evidence instanceof RequirementTestReviewExecutionEvidence
      || evidence instanceof RequirementTestReviewEvidence || evidence instanceof RequirementTestGateEvidence
      || evidence instanceof RequirementTestToolingEvidence)) throw new TypeError("Requirement test input evidence must use its dedicated canonical codec");
    if (progressIdentity !== null && !(progressIdentity instanceof RequirementTestRepairProgressIdentity)) throw new TypeError("Requirement repair progress requires its metadata identity");
    if (error !== null && !(error instanceof Error)) throw new TypeError("Requirement test input error must be typed");
    const observations = [candidateBundle, evidence, progressIdentity, error].filter((value) => value !== null);
    // External classification uses both its typed Error and tooling observation.
    if (observations.length !== 1 && !(observations.length === 2 && error !== null && evidence instanceof RequirementTestToolingEvidence)) throw new TypeError("Requirement test input must bind one acquired observation");
    this.stepId = binding.leaf;
    this.binding = binding;
    this.frontier = frontier;
    this.retryState = retryState;
    this.workItem = workItem;
    this.candidateBundle = candidateBundle;
    this.structuralFinding = structuralFinding;
    this.evidence = evidence;
    this.progressIdentity = progressIdentity;
    this.error = error;
    Object.freeze(this);
  }

  resultOperands() { return { binding: this.binding, frontier: this.frontier, retryState: this.retryState }; }
}
