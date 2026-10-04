import { isDeepStrictEqual } from "node:util";
import { Step } from "../../engine/step.js";
import {
  SpecGateRepairReviewRequiredResult,
  SpecGateRepairReadyForGateResult,
  SpecGateRepairNoProgressResult, StepErrorResult,
  SpecGateRepairContextRequiredResult, SpecGateRepairDraftReturnRequiredResult,
} from "../../engine/step-result.js";
import { SpecGateRepairAuthority, applySpecGateRepairOperations } from "../../lib/spec-repair-operations.js";
import { SpecGateRepairWorkerFacts, SpecGateRepairSelection, SpecGateRepairCandidate } from "../../lib/spec-gate-repair-worker-facts.js";
import { SpecGateRepairService } from "../../services/spec-gate-repair-service.js";
import { SpecGateRepairReviewFacts } from "../../lib/spec-gate-repair-review.js";
import { specGateRepairObservationResult } from "../../lib/gate-observation-convergence.js";

export function selectSpecGateRepair(facts) {
  if (!(facts instanceof SpecGateRepairWorkerFacts)) throw new TypeError("Spec Gate repair requires its canonical worker facts");
  if (facts.inputUnavailable !== null) return new StepErrorResult("spec-gate-repair", facts.inputUnavailable.toError());
  const authority = new SpecGateRepairAuthority({
    spec: facts.input.spec,
    baseRevision: facts.input.baseRevision,
    findings: facts.input.context.units().flatMap((unit) => unit.findings.map((finding) => finding.toJSON())),
    expectedUnits: facts.input.context.units().map((unit) => ({
      findingIdentities: unit.findings.map((finding) => finding.identity.toJSON()),
    })),
  });
  const applied = applySpecGateRepairOperations({
    spec: facts.input.spec,
    authority,
    repair: facts.proposal,
    inputRevision: facts.input.baseRevision.slice("sha256:".length),
    validator: facts.input.validator,
  });
  if (applied.audit.acceptedGroups.length === 0 || isDeepStrictEqual(applied.spec, facts.input.spec)) {
    return new SpecGateRepairNoProgressResult(new Error("Spec Gate repair made no accepted change"));
  }
  const reviewFacts = new SpecGateRepairReviewFacts({
    sourceReview: facts.input.review,
    baseRevision: facts.input.baseRevision,
    resultSpec: applied.spec,
    resultRevision: applied.audit.resultRevision,
    acceptedGroups: applied.audit.acceptedGroups,
  });
  const result = reviewFacts.requiresReview
    ? new SpecGateRepairReviewRequiredResult()
    : new SpecGateRepairReadyForGateResult();
  const sourceFindingIdentities = facts.input.context.units().flatMap((unit) => (
    unit.findings.map((finding) => finding.identity.toJSON())
  ));
  const observationResults = facts.input.repair.observationRequests.map((request) => {
    const fingerprint = request.fingerprint.toString();
    const observationIndex = facts.input.repair.observationFingerprints.indexOf(fingerprint);
    const identity = facts.input.observationIdentities[observationIndex];
    if (identity === undefined) throw new Error("Gate repair observation has no canonical source identity");
    return specGateRepairObservationResult({ request, identity,
      acceptedGroups: applied.audit.acceptedGroups });
  });
  return new SpecGateRepairSelection({
    result,
    candidate: new SpecGateRepairCandidate(applied.spec, applied.audit.resultRevision),
    audit: {
      ...applied.audit,
      sourceReviewIdentity: facts.input.review?.review.identity.toJSON() ?? null,
      sourceEvidenceIdentity: facts.input.repair.evidenceIdentity.toJSON(),
      sourceFindingIdentities,
      observationIdentities: facts.input.observationIdentities,
      repairId: facts.input.repair.idempotencyKey,
      repairRecordFingerprint: facts.input.repair.fingerprint,
      targetAttempt: facts.input.attempt,
      observationResults,
      reviewFacts: reviewFacts.toJSON(),
    },
    facts,
  });
}

export class SpecGateRepairStep extends Step {
  static dependencies = [SpecGateRepairService];
  #service;
  constructor(service) {
    super();
    if (!(service instanceof SpecGateRepairService)) throw new TypeError("Spec Gate repair service is required");
    this.#service = service;
  }
  async _execute() {
    const facts = this.#service.inspectWorkerCompletion();
    let selection;
    try {
      const continuation = this.#service.inspectContinuation();
      selection = continuation === null ? selectSpecGateRepair(facts)
        : continuation.draftReturnRequired
          ? new SpecGateRepairDraftReturnRequiredResult()
          : continuation.unresolvedLocationCount > 0
            && continuation.completedLocationBatchCount === continuation.locationBatchCount
            ? new StepErrorResult("spec-gate-repair", new Error("Spec Gate repair could not locate the selected finding"))
            : new SpecGateRepairContextRequiredResult();
    }
    catch (error) { selection = new StepErrorResult("spec-gate-repair", error); }
    if (selection instanceof SpecGateRepairSelection) this.#service.adoptWorkerSelection(facts, selection);
    const result = selection instanceof SpecGateRepairSelection ? selection.result : selection;
    await result.persist(this.#service);
    return result;
  }
}
