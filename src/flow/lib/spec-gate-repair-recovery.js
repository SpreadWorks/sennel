import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SpecGateRepairSelection } from "./spec-gate-repair-worker-facts.js";

export const SPEC_GATE_REPAIR_RECOVERY_OPERATION = "recover_spec_gate_repair";
const json = (value) => value?.toJSON?.() ?? value;
export const specGateRepairRecoveryDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class SpecGateRepairRecoveryRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "SpecGateRepairRecoveryRefusal";
    this.code = "FLOW_SPEC_GATE_REPAIR_RECOVERY_INELIGIBLE";
  }
}

/** Persisted proof authorizes only the saved publication's normal Step replay. */
export class SpecGateRepairRecoveryEvidence {
  constructor(value) {
    const fields = ["targetDigest", "sourcePublicationReceiptId", "errorReceiptId", "inputDigest",
      "candidateDigest", "selectionDigest", "resultKind", "settlementKind", "targetStepId"];
    if (value === null || typeof value !== "object"
      || Object.keys(value).sort().join() !== fields.sort().join()
      || fields.some((field) => typeof value[field] !== "string" || !value[field])
      || fields.filter((field) => field.endsWith("Digest") || field.endsWith("ReceiptId"))
        .some((field) => !/^[a-f0-9]{64}$/.test(value[field]))
      || value.settlementKind !== "target-connection"
      || !["spec-gate", "spec-review"].includes(value.targetStepId)) {
      throw new SpecGateRepairRecoveryRefusal("Gate repair recovery evidence is invalid");
    }
    for (const field of fields) this[field] = value[field];
    Object.freeze(this);
  }
  toJSON() {
    return { targetDigest: this.targetDigest, sourcePublicationReceiptId: this.sourcePublicationReceiptId,
      errorReceiptId: this.errorReceiptId, inputDigest: this.inputDigest, candidateDigest: this.candidateDigest,
      selectionDigest: this.selectionDigest, resultKind: this.resultKind,
      settlementKind: this.settlementKind, targetStepId: this.targetStepId };
  }
  get digest() { return specGateRepairRecoveryDigest(this.toJSON()); }
  assertSelection(selection, settlement) {
    if (!(selection instanceof SpecGateRepairSelection)
      || selection.candidate.resultRevision.digest !== this.candidateDigest
      || specGateRepairRecoveryDigest(selection.candidate.spec) !== this.candidateDigest
      || specGateRepairRecoveryDigest(selection.audit) !== this.selectionDigest
      || selection.result.kind !== this.resultKind || settlement.kind !== this.settlementKind
      || settlement.targetStepId !== this.targetStepId) {
      throw new SpecGateRepairRecoveryRefusal("Gate repair candidate differs from the recovered selection");
    }
  }
}

/** Definition admission over retained Activities; no input acquisition or candidate calculation. */
export class SpecGateRepairRecoveryDecision {
  constructor({ state, activities }) {
    if (state.current?.at(-1) !== "spec-gate-repair" || state.attempt?.nodeId !== "spec-gate-repair"
      || state.lifecycle.state !== "active" || state.history?.execution === "dormant") {
      throw new SpecGateRepairRecoveryRefusal("Gate repair recovery requires its active failed Attempt");
    }
    const history = activities.map(json).filter((entry) => entry.nodeId === "spec-gate-repair"
      && entry.attemptId === state.attempt.id && entry.sequence === state.attempt.sequence);
    const settlements = history.filter((entry) => entry.result?.draftSettlementReceipt != null);
    const recovered = history.find((entry) => entry.transition.operation === SPEC_GATE_REPAIR_RECOVERY_OPERATION);
    const error = recovered === undefined ? settlements.at(-1)
      : settlements.find((entry) => entry.result.draftSettlementReceipt.id
        === recovered.result.draftSettlementReceipt.specGateRepairRecovery.errorReceiptId);
    const receipt = error?.result.draftSettlementReceipt;
    const publication = settlements.findLast((entry) => entry.confirmationOrder < (error?.confirmationOrder ?? 0)
      && entry.result.draftSettlementReceipt.executionLifecycle?.phase === "publication");
    const published = publication?.result.draftSettlementReceipt;
    if (error?.transition.operation !== "fail_attempt" || error.result.stepResult.type !== "error"
      || receipt?.settlementKind !== "failure" || receipt.executionLifecycle?.phase !== "terminal"
      || published?.settlementKind !== "execution" || published.resultKind !== "spec-gate-repair-context-required"
      || !isDeepStrictEqual(published.binding, receipt.binding)
      || !isDeepStrictEqual(published.executionLifecycle.binding, receipt.executionLifecycle.binding)
      || !isDeepStrictEqual(published.executionLifecycle.claim, receipt.executionLifecycle.claim)
      || (recovered === undefined ? state.attempt.failure === null
        || !isDeepStrictEqual(json(state.attempt.failure), error.failure)
        : settlements.at(-1)?.id !== recovered.id || state.attempt.failure !== null)) {
      throw new SpecGateRepairRecoveryRefusal("Gate repair recovery requires one exact terminal Error and its retained publication");
    }
    this.errorReceipt = receipt;
    this.publicationReceipt = published;
    this.recovered = recovered ?? null;
    this.activityId = `spec-gate-repair-recovery-${specGateRepairRecoveryDigest([published.id, receipt.id])}`;
    Object.freeze(this);
  }
  assertTransition({ activity, previousAttempt, attempt }) {
    const receipt = json(activity.result?.draftSettlementReceipt);
    const evidence = new SpecGateRepairRecoveryEvidence(receipt?.specGateRepairRecovery);
    if (this.recovered !== null || activity.id !== this.activityId
      || !isDeepStrictEqual(json(attempt), { ...json(previousAttempt), failure: null })
      || !isDeepStrictEqual(receipt.binding, this.publicationReceipt.binding)
      || !isDeepStrictEqual(receipt.executionLifecycle, this.publicationReceipt.executionLifecycle)
      || receipt.resultKind !== "spec-gate-repair-context-required" || receipt.settlementKind !== "execution"
      || receipt.targetStepId !== null || receipt.connector !== null || receipt.effects !== null
      || receipt.resultType !== this.publicationReceipt.resultType || receipt.resultDigest !== this.publicationReceipt.resultDigest
      || receipt.publicationDigest !== specGateRepairRecoveryDigest({ specGateRepairRecovery: evidence.digest })
      || evidence.sourcePublicationReceiptId !== this.publicationReceipt.id
      || evidence.errorReceiptId !== this.errorReceipt.id) {
      throw new SpecGateRepairRecoveryRefusal("Gate repair recovery must preserve its exact Attempt and saved publication");
    }
  }
}
export function resolveSpecGateRepairRecovery(facts) { return new SpecGateRepairRecoveryDecision(facts); }
