import {
  SpecGatePassedResult, SpecGateRepairRequiredResult, SpecGateRetryRequiredResult,
  SpecGateDeferredResult, SpecGateAwaitingDecisionResult, SpecGateRecoveredResult,
  TaskSpecGatePassedResult, TaskSpecGateRepairRequiredResult, TaskSpecGateRetryRequiredResult,
  TaskSpecGateDeferredResult, TaskSpecGateAwaitingDecisionResult, TaskSpecGateRecoveredResult,
  SpecGateBlockedResult, TaskSpecGateBlockedResult, stepResultDigest,
} from "../../engine/step-result.js";
import { SPEC_GATE_MAXIMUM_CYCLE } from "../../definition.js";
import { SpecGateProspectiveFacts, SpecGatePublicationIntent } from "../../lib/spec-gate-prospective.js";
import { CurrentFlowStateConflictError } from "../../lib/current-flow-state.js";

const RESULT_CLASSES = Object.freeze({
  spec: Object.freeze({
    pass: SpecGatePassedResult, repair: SpecGateRepairRequiredResult,
    retry: SpecGateRetryRequiredResult, defer: SpecGateDeferredResult,
    await: SpecGateAwaitingDecisionResult, recovered: SpecGateRecoveredResult,
    blocked: SpecGateBlockedResult,
  }),
  "task-spec": Object.freeze({
    pass: TaskSpecGatePassedResult, repair: TaskSpecGateRepairRequiredResult,
    retry: TaskSpecGateRetryRequiredResult, defer: TaskSpecGateDeferredResult,
    await: TaskSpecGateAwaitingDecisionResult, recovered: TaskSpecGateRecoveredResult,
    blocked: TaskSpecGateBlockedResult,
  }),
});

/** Choose one semantic Result from a validated prospective Gate observation. */
export function specGateResult(facts) {
  if (!(facts instanceof SpecGateProspectiveFacts)) {
    throw new TypeError("Spec Gate Result requires typed prospective facts");
  }
  const classes = RESULT_CLASSES[facts.phase];
  if (facts.integrityFailure !== null) {
    const error = new Error("Spec Gate evidence integrity failed");
    error.code = facts.integrityFailure;
    error.data = { reason: "integrity" };
    return new classes.blocked(error);
  }
  if (facts.result === "pass") return new classes.pass();
  if (facts.result === "recovered") return new classes.recovered();
  if (facts.failureCategory === "semantic" && !facts.sameEvidence
    && facts.nonblockingEnabled && facts.acceptanceBacked) return new classes.await();
  if (facts.failureCategory !== "semantic"
    || (facts.phase === "spec" && facts.cycle >= SPEC_GATE_MAXIMUM_CYCLE)
    || facts.sameEvidence) {
    const error = new Error("Spec Gate cannot continue with the current evidence");
    error.code = facts.failureCode ?? "SPEC_GATE_BLOCKED";
    error.data = { reason: facts.failureCategory !== "semantic"
      ? facts.failureCategory : facts.sameEvidence ? "same-evidence" : "cycle-limit" };
    return new classes.blocked(error);
  }
  if (facts.repairAvailable) return new classes.repair();
  if (!facts.retryExhausted) return new classes.retry();
  return new classes.defer();
}

/** The Step-owned semantic choice sealed to its exact prospective publication. */
export class SpecGateResultSelection {
  constructor(publication) {
    if (!(publication instanceof SpecGatePublicationIntent)) {
      throw new TypeError("Spec Gate Result selection requires its prospective publication");
    }
    this.publication = publication;
    this.result = specGateResult(publication.facts);
    this.resultKind = this.result.kind;
    this.resultDigest = stepResultDigest(this.result);
    Object.freeze(this);
  }

  get facts() { return this.publication.facts; }
  get issue() { return this.publication.issue; }

  assertResult(stepResult) {
    if (stepResult?.stepId !== "spec-gate" || stepResult?.kind !== this.resultKind
      || stepResultDigest(stepResult) !== this.resultDigest) {
      throw new CurrentFlowStateConflictError("Spec Gate Result differs from its sealed Step selection");
    }
  }

  assertPublication({ binding, commandResult, stepResult }) {
    this.assertResult(stepResult);
    this.publication.assertPublication({ binding, commandResult });
  }

  assert(view) { this.publication.assert(view); }

  toJSON() {
    return {
      ...this.publication.toJSON(),
      resultKind: this.resultKind,
      resultDigest: this.resultDigest,
    };
  }
}
