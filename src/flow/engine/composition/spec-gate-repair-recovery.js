import { resolveSpecGateRepairRecovery, settleSpecStepResult, DraftStepExecutionLifecycle, DraftStepExecutionState } from "../../definition.js";
import { readProgressBoundSpecGateRepairInput } from "../../lib/spec-gate-repair-progress.js";
import { SpecGateRepairPublishedDecision } from "./spec-gate-repair.js";
import { selectSpecGateRepair } from "../../steps/spec/spec-gate-repair.js";
import { SpecGateRepairSelection } from "../../lib/spec-gate-repair-worker-facts.js";
import { SpecGateRepairRecoveryEvidence, SpecGateRepairRecoveryRefusal,
  specGateRepairRecoveryDigest } from "../../lib/spec-gate-repair-recovery.js";

/** Acquired canonical facts shared by preview and lock-time admission. */
export class SpecGateRepairRecoveryInput {
  constructor({ flowManager, state, activities, executionRoot, targetDigest }) {
    this.decision = resolveSpecGateRepairRecovery({ state, activities });
    const retained = activities.find((activity) => activity.result?.draftSettlementReceipt?.id
      === this.decision.publicationReceipt.id);
    this.executionIdentity = new DraftStepExecutionState({
      binding: { runId: state.runId, specId: state.specId, stepId: "spec-gate-repair", attempt: state.attempt },
      receipt: retained.result.draftSettlementReceipt, result: retained.result.stepResult,
    }).executionIdentity();
    const lifecycle = DraftStepExecutionLifecycle.fromJSON(this.decision.publicationReceipt.executionLifecycle);
    const { source, ledger } = readProgressBoundSpecGateRepairInput({ flowManager, state, executionRoot,
      executionLifecycle: lifecycle });
    if (ledger.publication === null || ledger.completion !== null
      || ledger.publication.proposal.stage !== "spec-gate-repair") {
      throw new SpecGateRepairRecoveryRefusal("Gate repair recovery requires an uncompleted saved repair proposal");
    }
    const refreshed = readProgressBoundSpecGateRepairInput({ flowManager, state, executionRoot,
      executionLifecycle: lifecycle, acceptedPublication: true });
    const published = new SpecGateRepairPublishedDecision({ source, ledger, refreshed, proposal: ledger.publication.proposal });
    if (published.continuation !== null) throw new SpecGateRepairRecoveryRefusal("Gate repair proposal still requires worker continuation");
    this.facts = published.facts;
    this.inputDigest = specGateRepairRecoveryDigest({ baseRevision: source.baseRevision,
      evidenceDigest: source.context.evidenceDigest, publication: ledger.publication,
      reviewIdentity: source.review?.review.identity.toJSON() ?? null });
    this.targetDigest = targetDigest;
    Object.freeze(this);
  }
  assertEvidence(evidence) {
    if (!(evidence instanceof SpecGateRepairRecoveryEvidence)
      || evidence.targetDigest !== this.targetDigest || evidence.inputDigest !== this.inputDigest
      || evidence.sourcePublicationReceiptId !== this.decision.publicationReceipt.id
      || evidence.errorReceiptId !== this.decision.errorReceipt.id) {
      throw new SpecGateRepairRecoveryRefusal("Gate repair recovery inputs or authority have changed");
    }
  }
}

/** The same Step factory evaluates preview and ordinary resumed completion. */
export class SpecGateRepairRecoveryPreview {
  constructor(input) {
    if (!(input instanceof SpecGateRepairRecoveryInput)) throw new TypeError("Recovery preview requires acquired input");
    this.decision = input.decision;
    this.executionIdentity = input.executionIdentity;
    let selection;
    try { selection = selectSpecGateRepair(input.facts); }
    catch (error) { throw new SpecGateRepairRecoveryRefusal(`Gate repair candidate remains invalid: ${error.message}`); }
    if (!(selection instanceof SpecGateRepairSelection)) {
      throw new SpecGateRepairRecoveryRefusal("Gate repair candidate makes no valid accepted change");
    }
    this.selection = selection;
    this.settlement = settleSpecStepResult("spec-gate-repair", selection.result);
    this.evidence = new SpecGateRepairRecoveryEvidence({ targetDigest: input.targetDigest,
      sourcePublicationReceiptId: this.decision.publicationReceipt.id, errorReceiptId: this.decision.errorReceipt.id,
      inputDigest: input.inputDigest,
      candidateDigest: selection.candidate.resultRevision.digest,
      selectionDigest: specGateRepairRecoveryDigest(selection.audit),
      resultKind: selection.result.kind, settlementKind: this.settlement.kind, targetStepId: this.settlement.targetStepId });
    if (this.decision.recovered !== null
      && this.evidence.digest !== new SpecGateRepairRecoveryEvidence(
        this.decision.recovered.result.draftSettlementReceipt.specGateRepairRecovery).digest) {
      throw new SpecGateRepairRecoveryRefusal("Gate repair recovered inputs or candidate have changed");
    }
    Object.freeze(this);
  }
  get digest() { return this.evidence.digest; }
  toJSON() { return { ...this.decision.errorReceipt.binding, ...this.evidence.toJSON(), digest: this.digest,
    executionGeneration: this.decision.publicationReceipt.executionLifecycle.binding.executionGeneration }; }
}
