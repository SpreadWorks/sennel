import {
  SpecGatePassedResult, SpecGateRepairRequiredResult, SpecGateRetryRequiredResult,
  SpecGateDeferredResult, SpecGateAwaitingDecisionResult, SpecGateRecoveredResult,
  TaskSpecGatePassedResult, TaskSpecGateRepairRequiredResult, TaskSpecGateRetryRequiredResult,
  TaskSpecGateDeferredResult, TaskSpecGateAwaitingDecisionResult, TaskSpecGateRecoveredResult,
  SpecGateBlockedResult, TaskSpecGateBlockedResult,
} from "../../engine/step-result.js";
import { SPEC_GATE_MAXIMUM_CYCLE } from "../../lib/spec-gate-policy.js";
import { SpecGateProspectiveFacts } from "../../lib/spec-gate-prospective-facts.js";

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
  if (facts.failureCategory !== "semantic"
    || (facts.phase === "spec" && facts.cycle >= SPEC_GATE_MAXIMUM_CYCLE)
    || facts.sameEvidence) {
    const error = new Error("Spec Gate cannot continue with the current evidence");
    error.code = facts.failureCode ?? "SPEC_GATE_BLOCKED";
    error.data = { reason: facts.failureCategory !== "semantic"
      ? facts.failureCategory : facts.sameEvidence ? "same-evidence" : "cycle-limit",
      ...(facts.phase === "spec" && facts.cycle >= SPEC_GATE_MAXIMUM_CYCLE
        ? { cycle: facts.cycle, maximum: SPEC_GATE_MAXIMUM_CYCLE } : {}),
    };
    return new classes.blocked(error);
  }
  if (facts.nonblockingEnabled && facts.acceptanceBacked) {
    if (facts.phase === "spec" && !facts.repairAvailable) {
      const error = new Error("Spec Gate has no repairable blocking observation in the accepted evidence");
      error.code = facts.failureCode ?? "SPEC_GATE_BLOCKED";
      error.data = { reason: "repair-unavailable" };
      return new classes.blocked(error);
    }
    return new classes.await();
  }
  if (facts.repairAvailable) return new classes.repair();
  if (!facts.retryExhausted) return new classes.retry();
  return new classes.defer();
}
