import { NonGateTargetBinding, NonGateRetryMetrics, NonGateTransitionFacts } from "../../lib/non-gate-transition.js";
import { FinalRegressionStepFacts } from "../../lib/final-regression-transition.js";
import { AcceptedNonblockingDecision } from "../../lib/accepted-nonblocking-decision.js";

/** Immutable process observation and its exact canonical publication. */
export class FinalRegressionResultEvidence {
  constructor({ identity, retry, facts = null, acceptedDecision = null, sourceCurrent = true }) {
    if (!(identity instanceof NonGateTargetBinding) || identity.stepId !== "final-regression"
      || !(retry instanceof NonGateRetryMetrics) || typeof sourceCurrent !== "boolean"
      || facts !== null && (!(facts instanceof NonGateTransitionFacts) || !(facts.stepFacts instanceof FinalRegressionStepFacts))) {
      throw new TypeError("Final regression requires its typed identity, retry and observation");
    }
    if (facts !== null && (facts.stepId !== identity.stepId || facts.retry.used !== retry.used || facts.retry.maximum !== retry.maximum
      || facts.target.runId !== identity.runId || facts.target.specId !== identity.specId
      || !facts.target.attempt.matches(identity.attempt))) throw new TypeError("Final regression observation belongs to another Attempt");
    this.identity = identity;
    this.retry = retry;
    this.facts = facts;
    if (acceptedDecision !== null && (!(acceptedDecision instanceof AcceptedNonblockingDecision)
      || facts === null || facts.stepFacts.result !== "fail" || facts.stepFacts.recordAndProceed.accepted
      || facts.integrityFailure !== null || !facts.stepFacts.changedFileSnapshot.current)) {
      throw new TypeError("Final regression acceptance requires its original failed process evidence");
    }
    this.acceptedDecision = acceptedDecision;
    this.sourceCurrent = sourceCurrent;
    acceptedDecision?.assertEvidence(this);
    Object.freeze(this);
  }
  get stepId() { return "final-regression"; }
  get transitionFacts() { return this.facts; }
  get observation() { return this.facts?.stepFacts ?? null; }
  get publication() { return this.facts?.catalogPublication ?? null; }
  get executionRequired() { return this.facts === null; }
  get integrityFailure() {
    return this.facts?.integrityFailure ?? (this.observation !== null && !this.observation.changedFileSnapshot.current
      ? "FINAL_REGRESSION_CHANGED_SNAPSHOT_STALE" : null);
  }
  get resultKind() {
    if (this.integrityFailure !== null) return "final-regression-error";
    if (this.executionRequired) return "final-regression-execution-required";
    if (this.observation.result === "pass") return "final-regression-passed";
    if (this.observation.result === "skipped") return "final-regression-policy-skipped";
    return this.acceptedDecision !== null || this.observation.recordAndProceed.accepted ? "final-regression-failure-accepted" : "final-regression-failed";
  }
  assertResultKind(kind) {
    if (kind !== this.resultKind) throw new TypeError("Final regression Result contradicts its process observation");
  }
  withSourceAdmission(admission) {
    if (!(admission instanceof FinalRegressionSourceAdmission) || admission.evidence !== this) {
      throw new TypeError("Final regression source projection requires its exact original evidence");
    }
    return new FinalRegressionResultEvidence({ ...this, sourceCurrent: admission.current });
  }
  withAcceptedDecision(acceptedDecision) { return new FinalRegressionResultEvidence({ ...this, acceptedDecision }); }
  toJSON() { return { identity: this.identity.toJSON(), retry: this.retry.toJSON(), facts: this.facts?.toJSON() ?? null,
    acceptedDecision: this.acceptedDecision?.toJSON() ?? null, sourceCurrent: this.sourceCurrent }; }
  static fromJSON(value) {
    return new FinalRegressionResultEvidence({ identity: new NonGateTargetBinding(value.identity),
      retry: new NonGateRetryMetrics(value.retry), sourceCurrent: value.sourceCurrent, acceptedDecision: value.acceptedDecision === null ? null
        : AcceptedNonblockingDecision.fromJSON(value.acceptedDecision), facts: value.facts === null ? null
        : NonGateTransitionFacts.fromPersisted(value.facts, { stepFacts: FinalRegressionStepFacts.fromPersisted }) });
  }
  static fromTransitionFacts(facts) { return new FinalRegressionResultEvidence({ identity: facts.target, retry: facts.retry, facts }); }
}

/** Read-only source admission for one unchanged, already selected observation. */
export class FinalRegressionSourceAdmission {
  constructor({ evidence, current }) {
    if (!(evidence instanceof FinalRegressionResultEvidence) || evidence.executionRequired
      || typeof current !== "boolean") throw new TypeError("Final regression source admission requires its saved process evidence");
    this.evidence = evidence;
    this.current = current;
    Object.freeze(this);
  }
}
