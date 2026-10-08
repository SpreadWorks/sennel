import { AcceptedNonblockingDecision } from "./accepted-nonblocking-decision.js";
import { AcceptedGateDeferral } from "./accepted-gate-deferral.js";
export { AcceptedGateDeferral, AcceptedGateFindingsPublication } from "./accepted-gate-deferral.js";
import {
  GateTargetBinding, GateProducerOwnership, GateCatalogPublication, GateLineage,
  GateRetryMetrics, GateTaskBudget, GateReviewFindingReadiness,
  GateObservationConvergenceFacts, GateFailureCategory,
  GateRecoveryEvidence, GatePostPublicationState, TaskGateSettlementProgress,
  GateTransitionFacts,
} from "./gate-transition.js";
import { TaskStepIdentity } from "./task-step-identity.js";
import { ImplementationTaskFrontier } from "./source-effect-values.js";

const OPTIONAL_VALUES = Object.freeze({ producer: GateProducerOwnership,
  publication: GateCatalogPublication, lineage: GateLineage, taskBudget: GateTaskBudget,
  reviewReadiness: GateReviewFindingReadiness, observationConvergence: GateObservationConvergenceFacts,
  taskFrontier: ImplementationTaskFrontier, failure: GateFailureCategory,
  recoveryEvidence: GateRecoveryEvidence, publicationStatus: GatePostPublicationState,
  taskProgress: TaskGateSettlementProgress });

/** Immutable implementation Gate observations; no transition or execution capability. */
export class ImplementationGateResultEvidence {
  #meaning;
  constructor({ identity, retry, result = null, snapshotRevision = null, nonblocking = false,
    integrityFailure = null, continuation = null, acceptedDecision = null, ...observations } = {}) {
    if (!(identity instanceof GateTargetBinding) || !(retry instanceof GateRetryMetrics)
      || ![null, "pass", "fail", "recovered"].includes(result)
      || typeof nonblocking !== "boolean"
      || snapshotRevision !== null && (typeof snapshotRevision !== "string" || snapshotRevision === "")
      || integrityFailure !== null && (typeof integrityFailure !== "string" || integrityFailure === "")) {
      throw new TypeError("Implementation Gate requires typed identity, budget and observations");
    }
    if (identity.taskId === null ? identity.stepId !== "impl-gate"
      : !new TaskStepIdentity({ taskId: identity.taskId, role: "gate" }).matchesNode(identity.stepId)) {
      throw new TypeError("Implementation Gate identity does not own an implementation Gate");
    }
    for (const [field, Type] of Object.entries(OPTIONAL_VALUES)) {
      const value = observations[field] ?? null;
      if (value !== null && !(value instanceof Type)) throw new TypeError(`Implementation Gate ${field} must be typed`);
      this[field] = value;
    }
    if (result !== null && (this.producer === null || this.publication === null || this.lineage === null
      || this.recoveryEvidence === null || this.publicationStatus === null
      || this.reviewReadiness === null
      || identity.taskId !== null && (this.taskBudget === null || this.taskFrontier === null || this.taskProgress === null || snapshotRevision === null))) {
      throw new TypeError("Observed Gate evidence requires its exact producer, lineage and scope obligations");
    }
    if ((result === "fail") !== (this.failure !== null)) throw new TypeError("Gate failure evidence must accompany exactly failed evaluation");
    this.identity = identity;
    this.reviewReadiness?.assertTarget(identity, this.taskBudget);
    this.retry = retry;
    this.result = result;
    this.snapshotRevision = snapshotRevision;
    this.nonblocking = nonblocking;
    this.integrityFailure = integrityFailure;
    if (continuation !== null && !(continuation instanceof AcceptedGateDeferral)) throw new TypeError("Gate continuation must be an accepted deferral");
    this.continuation = continuation;
    continuation?.assertEvaluation(this);
    if (acceptedDecision !== null && !(acceptedDecision instanceof AcceptedNonblockingDecision)) throw new TypeError("Gate accepted decision must be typed");
    this.acceptedDecision = acceptedDecision;
    acceptedDecision?.assertEvidence(this);
    const originalMeaning = classifyImplementationGateMeaning(this);
    if (acceptedDecision !== null && (continuation !== null || integrityFailure !== null
      || !["defer", "error"].includes(originalMeaning.strictValue)
      || originalMeaning.strictValue === "error" && !["local", "tooling"].includes(this.failure?.category))) {
      throw new TypeError("Accepted Gate decision requires its original eligible strict stop");
    }
    this.#meaning = acceptedDecision === null ? originalMeaning
      : new ImplementationGateMeaning("await", originalMeaning.reason, originalMeaning.strictValue);
    if (continuation !== null && this.#meaning.value !== "defer") throw new TypeError("accepted Gate deferral requires the original deferred observation");
    Object.freeze(this);
  }

  get stepId() { return this.identity.taskId === null ? "impl-gate"
    : new TaskStepIdentity({ taskId: this.identity.taskId, role: "gate" }).definitionId; }
  get executionRequired() { return this.result === null; }
  get repairAvailable() { return this.recoveryEvidence?.kind === "repair"; }
  get meaning() { return this.#meaning; }
  get resultKind() { return this.#meaning.resultKind(this.stepId); }
  assertResultKind(kind) {
    if (kind !== this.resultKind) throw new TypeError("Implementation Gate Result kind contradicts its acquired evidence");
  }

  toJSON() {
    return { identity: this.identity.toJSON(), retry: this.retry.toJSON(),
      result: this.result, snapshotRevision: this.snapshotRevision, nonblocking: this.nonblocking,
      integrityFailure: this.integrityFailure,
      ...(this.continuation === null ? {} : { continuation: this.continuation.toJSON() }),
      ...(this.acceptedDecision === null ? {} : { acceptedDecision: this.acceptedDecision.toJSON() }),
      ...Object.fromEntries(Object.keys(OPTIONAL_VALUES).map((field) => [field, this[field]?.toJSON() ?? null])) };
  }

  static fromJSON(value) {
    return new ImplementationGateResultEvidence({ ...value,
      acceptedDecision: value.acceptedDecision === undefined ? null : AcceptedNonblockingDecision.fromJSON(value.acceptedDecision),
      identity: new GateTargetBinding(value.identity), retry: new GateRetryMetrics(value.retry),
      continuation: value.continuation === undefined ? null : AcceptedGateDeferral.fromJSON(value.continuation),
      ...Object.fromEntries(Object.entries(OPTIONAL_VALUES).map(([field, Type]) => [field,
        value[field] == null ? null : Type === ImplementationTaskFrontier
          ? ImplementationTaskFrontier.fromJSON(value[field]) : new Type(value[field])])) });
  }

  static fromTransitionFacts(facts, taskFrontier = null) {
    return new ImplementationGateResultEvidence({ identity: facts.target, retry: facts.retry,
      result: facts.result, producer: facts.producer, publication: facts.catalogPublication,
      lineage: facts.lineage, taskBudget: facts.taskBudget, reviewReadiness: facts.reviewReadiness,
      observationConvergence: facts.observationConvergence, taskFrontier,
      failure: facts.failure, recoveryEvidence: facts.recoveryEvidence,
      snapshotRevision: facts.snapshotRevision, publicationStatus: facts.postPublication,
      taskProgress: facts.taskSettlementProgress,
      nonblocking: facts.nonblocking, integrityFailure: facts.integrityFailure });
  }
}

/** Acquired input wrapper shared by both implementation Gate Steps. */
export class GateStepObservation {
  constructor(evidence) {
    if (!(evidence instanceof ImplementationGateResultEvidence)) throw new TypeError("Gate observation requires typed implementation evidence");
    this.evidence = evidence;
    Object.freeze(this);
  }
}

export class ImplementationGateMeaning {
  constructor(value, reason = null, strictValue = value) {
    if (!["execution", "pass", "refresh", "repair", "retry", "defer", "await", "error"].includes(value)) {
      throw new TypeError("Unknown implementation Gate observation meaning");
    }
    this.value = value;
    this.strictValue = strictValue;
    this.reason = reason;
    Object.freeze(this);
  }
  resultKind(stepId) {
    const suffixes = stepId === "impl-gate"
      ? { execution: "execution-required", pass: "passed", refresh: "evidence-refresh", repair: "semantic-failure",
        retry: "semantic-failure", defer: "semantic-failure", await: "awaiting-decision", error: "error" }
      : stepId === "task-gate"
        ? { execution: "execution-required", pass: "passed", refresh: "retry-required", repair: "repair-required",
          retry: "retry-required", defer: "deferred", await: "awaiting-decision", error: "error" } : null;
    if (suffixes === null) throw new TypeError("Gate meaning requires an implementation Gate responsibility");
    return `${stepId}-${suffixes[this.value]}`;
  }
}

/** Shared semantic classification for Task and integration Gates. */
export function implementationGateMeaning(evidence) {
  if (evidence instanceof ImplementationGateResultEvidence) return evidence.meaning;
  return classifyImplementationGateMeaning(evidence);
}

function classifyImplementationGateMeaning(evidence) {
  if (!(evidence instanceof ImplementationGateResultEvidence)
    && !(evidence instanceof GateTransitionFacts) || evidence instanceof GateTransitionFacts
      && !["task-impl", "integration"].includes(evidence.phase)) throw new TypeError("Gate meaning requires acquired implementation evidence");
  const meaning = (value, reason = null, strictValue = value) => new ImplementationGateMeaning(value, reason, strictValue);
  const stopped = (value, reason) => meaning(evidence.nonblocking ? "await" : value, reason, value);
  if (evidence.integrityFailure !== null) return meaning("error", evidence.integrityFailure);
  if (evidence.executionRequired) return meaning("execution");
  if (evidence.result === "pass") {
    if (evidence.reviewReadiness?.allowsGatePass !== true) {
      return meaning("error", "unresolved_review_findings");
    }
    return meaning("pass");
  }
  if (evidence.result === "recovered" || evidence.recoveryEvidence?.kind === "recovered") return meaning("refresh");
  if (evidence.failure.category === "tooling") return stopped("error", evidence.failure.code ?? "tooling_failure");
  if (evidence.failure.category === "local") return stopped("error", evidence.failure.code ?? "local_input_invalid");
  const repairAvailable = evidence.recoveryEvidence?.kind === "repair";
  if (repairAvailable && !evidence.taskBudget?.finalRound) return meaning("repair");
  if (evidence.taskBudget?.finalRound && (repairAvailable || evidence.observationConvergence?.allRecurring)) {
    return stopped("defer", "task_round_exhausted");
  }
  if (evidence.observationConvergence?.sameEvidence) return stopped("error", "same_gate_observation_without_changed_repair");
  if (!evidence.retry.exhausted) return meaning("retry");
  if (evidence.taskBudget !== null && !evidence.taskBudget.finalRound) return meaning("error", "missing_plan_gate_repair_evidence");
  return stopped("defer", "semantic_retry_exhausted");
}
