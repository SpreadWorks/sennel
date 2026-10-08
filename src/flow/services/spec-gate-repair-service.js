import { CanonicalFlowArtifactBaseline, CanonicalWorkerSpecPublication } from "../lib/current-flow-state.js";
import { StepResult, StepErrorResult, SpecGateRepairNoProgressResult,
  SpecGateRepairContextRequiredResult, SpecGateRepairDraftReturnRequiredResult } from "../engine/step-result.js";
import { settleSpecStepResult, StepErrorDecision, StepRoute } from "../definition.js";
import { SpecGateRepairWorkerFacts, SpecGateRepairSelection,
  SpecGateRepairContinuationFacts } from "../lib/spec-gate-repair-worker-facts.js";
import { DraftReopenContext } from "../lib/draft-reopen-context.js";
import { SpecGateRepairSettlementWriter } from "./spec-gate-repair-settlement-writer.js";

export class SpecGateRepairServiceInput {
  constructor({ facts, continuation, attemptId, attemptSequence }) {
    if (!(facts instanceof SpecGateRepairWorkerFacts)
      || continuation !== null && !(continuation instanceof SpecGateRepairContinuationFacts)
      || typeof attemptId !== "string" || !Number.isInteger(attemptSequence)) {
      throw new TypeError("Gate repair input requires exact worker facts and Attempt identity");
    }
    this.facts = facts;
    this.continuation = continuation;
    this.attemptId = attemptId;
    this.attemptSequence = attemptSequence;
    Object.freeze(this);
  }
}

/** Uses captured worker facts and selected save operations only. */
export class SpecGateRepairService {
  static argumentTypes = [SpecGateRepairServiceInput, SpecGateRepairSettlementWriter];
  #input;
  #writer;
  #facts;
  #continuation;
  #selection = null;
  #outcome = null;
  #publication = null;

  constructor(input, writer) {
    if (!(input instanceof SpecGateRepairServiceInput)
      || !(writer instanceof SpecGateRepairSettlementWriter)) {
      throw new TypeError("Spec Gate repair requires typed input and settlement writer");
    }
    this.#input = input;
    this.#writer = writer;
    this.#facts = input.facts;
    this.#continuation = input.continuation;
  }

  inspectContinuation() { return this.#continuation; }

  inspectWorkerCompletion() {
    if (this.#outcome !== null) throw new Error("prepared Spec Gate repair adoption is stale after its completed settlement");
    return this.#facts;
  }

  adoptWorkerSelection(facts, selection) {
    if (facts !== this.#facts || !(selection instanceof SpecGateRepairSelection)
      || selection.facts !== facts) throw new TypeError("Spec Gate repair selection changed after handoff");
    this.#selection = selection;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== "spec-gate-repair"
      || (!(stepResult instanceof StepErrorResult || stepResult instanceof SpecGateRepairNoProgressResult
        || stepResult instanceof SpecGateRepairContextRequiredResult
        || stepResult instanceof SpecGateRepairDraftReturnRequiredResult)
        && this.#selection?.result !== stepResult)) {
      throw new TypeError("Spec Gate repair settlement requires its Step-selected Result");
    }
    const settlement = settleSpecStepResult("spec-gate-repair", stepResult);
    if (this.#continuation !== null && !(stepResult instanceof StepErrorResult)) {
      if (!(stepResult instanceof SpecGateRepairContextRequiredResult
        || stepResult instanceof SpecGateRepairDraftReturnRequiredResult)) {
        throw new TypeError("Gate repair continuation requires a Step-selected Result");
      }
      let committed;
      if (stepResult instanceof SpecGateRepairDraftReturnRequiredResult) {
        if (!(settlement instanceof StepRoute) || settlement.targetStepId !== "draft"
          || await new settlement.connector().connect() !== "draft") {
          throw new TypeError("Spec Gate repair Draft return requires its Definition route");
        }
        committed = this.#writer.settleDraftReturn({
          stepResult, settlement,
          artifactBaselines: [new CanonicalFlowArtifactBaseline({
            logicalKey: "spec.record",
            digest: this.#facts.input.baseRevision.slice("sha256:".length),
            byteLength: this.#facts.input.specByteLength,
          })],
          draftReturn: new DraftReopenContext({
            route: "preimplementation",
            reason: this.#facts.proposal.decision,
            source: { stepId: "spec-gate-repair", attemptId: this.#input.attemptId,
              attemptSequence: this.#input.attemptSequence,
              baseRevision: this.#facts.input.baseRevision,
              specByteLength: this.#facts.input.specByteLength,
              repairId: this.#facts.input.repair.idempotencyKey,
              selectedUnitIds: this.#facts.input.context.units().map((unit) => unit.id),
              findingIdentities: this.#facts.input.context.units().flatMap((unit) => (
                unit.findings.map((finding) => finding.identity.toJSON())
              )),
              evidence: this.#facts.proposal.evidence,
              unresolvedBecause: this.#facts.proposal.unresolvedBecause,
            },
          }) });
      } else {
        committed = this.#writer.completeProgress({
          stepResult, settlement });
      }
      const receipt = committed.receipt;
      const outcome = this.#writer.completeHandoff(stepResult, receipt, false);
      this.#outcome = { ...outcome, partialProgressReceipt: committed.newlyCompleted ? receipt : null };
      return this.#outcome.receipt;
    }
    const error = settlement instanceof StepErrorDecision;
    if (!error && !(settlement instanceof StepRoute)) throw new TypeError("Spec Gate repair requires its selected route");
    if (!error && await new settlement.connector().connect() !== settlement.targetStepId) {
      throw new TypeError("Spec Gate repair connector disagrees with its route");
    }
    const input = this.#facts.input;
    this.#publication ??= error ? {
      lifecycleResult: null, references: undefined, artifactWrites: [], artifactBaselines: [],
    } : {
      specRecord: new CanonicalWorkerSpecPublication(this.#selection.candidate.spec),
      artifactWrites: [{
        logicalKey: "spec.gate.repair.audit",
        parameters: { attemptId: this.#input.attemptId },
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(this.#selection.audit, null, 2)}\n`, "utf8"),
      }],
      artifactBaselines: [new CanonicalFlowArtifactBaseline({
        logicalKey: "spec.record",
        digest: input.baseRevision.slice("sha256:".length),
        byteLength: input.specByteLength,
      })],
    };
    const settlementInput = {
      stepResult, settlement,
      specGateRepairSelection: this.#selection,
      ...this.#publication,
    };
    const replayed = this.#outcome !== null;
    const committed = this.#writer.settle(settlementInput, replayed);
    this.#outcome = this.#writer.completeHandoff(stepResult, committed.receipt, replayed);
    return this.#outcome.receipt;
  }

  get workerOutcome() { return this.#outcome; }
  get partialProgressReceipt() { return this.#outcome?.partialProgressReceipt ?? null; }
}
