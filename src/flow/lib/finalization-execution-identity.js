import { NonGateTargetBinding } from "./non-gate-transition.js";
import { FlowOutboxIdentity } from "./flow-outbox-identity.js";
import { isDeepStrictEqual } from "node:util";
import { deepFreeze } from "./review-observation-values.js";

function snapshot(value) {
  if (value === null) return null;
  return deepFreeze(structuredClone(value.toJSON?.() ?? value));
}

function restoreExact(Value, value) {
  if (value instanceof Value) return value;
  const restored = new Value(value);
  if (!isDeepStrictEqual(restored.toJSON(), value)) throw new TypeError("Stored finalization authority has an invalid shape");
  return restored;
}

/** Acquired finalization authority; contains no readers or execution handles. */
export class FinalizationExecutionIdentity {
  constructor({ identity, outboxIdentity = null, approval = null, expectedBaseSha = null,
    expectedFeatureSha = null, mainAuthority = null, journal = null, authorization = null,
    claim = null, publication = null }) {
    this.identity = identity instanceof NonGateTargetBinding ? identity : new NonGateTargetBinding(identity);
    this.stepId = this.identity.stepId;
    if (!["finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup"].includes(this.stepId)) {
      throw new TypeError("Finalization execution requires a finalization source Attempt");
    }
    this.outboxIdentity = outboxIdentity === null ? null : outboxIdentity instanceof FlowOutboxIdentity
      ? outboxIdentity : FlowOutboxIdentity.fromStored(outboxIdentity);
    if (this.outboxIdentity !== null && (this.outboxIdentity.runId !== this.identity.runId
      || this.outboxIdentity.stepId !== this.stepId)) throw new TypeError("Finalization outbox belongs to another source");
    this.approval = snapshot(approval);
    this.expectedBaseSha = expectedBaseSha;
    this.expectedFeatureSha = expectedFeatureSha;
    this.mainAuthority = snapshot(mainAuthority);
    this.journal = snapshot(journal);
    this.authorization = snapshot(authorization);
    this.claim = snapshot(claim);
    this.publication = snapshot(publication);
    Object.freeze(this);
  }
  toJSON() {
    return { identity: this.identity.toJSON(), outboxIdentity: this.outboxIdentity?.toJSON() ?? null,
      approval: this.approval, expectedBaseSha: this.expectedBaseSha, expectedFeatureSha: this.expectedFeatureSha,
      mainAuthority: this.mainAuthority, journal: this.journal, authorization: this.authorization,
      claim: this.claim, publication: this.publication };
  }
  static fromJSON(value) { return restoreExact(FinalizationExecutionIdentity, value); }
}

/** Durable observation carried by terminal receipts whose Result has no operands. */
export class FinalizationSettlementReceiptEvidence {
  constructor({ evidence, commandResult = null, candidate = null }) {
    this.evidence = snapshot(evidence);
    this.commandResult = snapshot(commandResult);
    this.candidate = snapshot(candidate);
    if (!isDeepStrictEqual(this.evidence?.commandResult, this.commandResult)) {
      throw new TypeError("Finalization receipt command differs from its observation");
    }
    const identity = this.evidence?.identity ?? this.evidence?.execution?.identity;
    this.identity = new NonGateTargetBinding(identity);
    if (this.evidence?.execution != null) {
      const execution = FinalizationExecutionIdentity.fromJSON(this.evidence.execution);
      if (!isDeepStrictEqual(execution.identity.toJSON(), this.identity.toJSON())) {
        throw new TypeError("Finalization receipt execution and observation belong to different Attempts");
      }
    }
    Object.freeze(this);
  }
  assertBinding(binding) {
    const identity = this.identity;
    if (identity.runId !== binding.runId || identity.specId !== binding.specId || identity.stepId !== binding.stepId
      || identity.attempt.id !== (binding.attempt?.id ?? binding.attemptId)
      || identity.attempt.sequence !== (binding.attempt?.sequence ?? binding.attemptSequence)) {
      throw new TypeError("Finalization receipt belongs to another source Attempt");
    }
    return this;
  }
  toJSON() { return { evidence: this.evidence, commandResult: this.commandResult, candidate: this.candidate }; }
  static fromJSON(value) { return restoreExact(FinalizationSettlementReceiptEvidence, value); }
}
