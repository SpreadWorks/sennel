/** Read-only typed facts for the definition-owned Gate transition boundary. */

import { TASK_EXECUTION_ROUND_POLICY } from "./task-execution-policy.js";

const GATE_PHASES = new Set(["draft", "spec", "task-spec", "task-impl", "integration"]);
const GATE_SCOPES = new Set(["flow", "task"]);
const GATE_RESULTS = new Set(["pass", "fail", "recovered"]);
const FAILURE_CATEGORIES = new Set(["semantic", "local", "tooling"]);
const LOCAL_FAILURE_KINDS = new Set(["mechanical", "mechanical_guardrail_fail"]);
const RECOVERY_KINDS = new Set(["none", "repair", "defer", "recovered"]);
const POST_PUBLICATION_STATES = new Set(["unclassified", "classified"]);

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function optionalText(value, field) {
  return value == null ? null : requiredText(value, field);
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function requireObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function taskGateStepId(taskId, role) {
  return `${requiredText(taskId, "gate Task id")}-${role}`;
}

function taskGateBindingIsValid(taskId, stepId) {
  return stepId === taskGateStepId(taskId, "gate");
}

/** The identity assigned by the canonical store to a producer Attempt. */
export class GateAttemptIdentity {
  constructor({ id, sequence } = {}) {
    this.id = requiredText(id, "gate Attempt id");
    this.sequence = positiveInteger(sequence, "gate Attempt sequence");
    Object.freeze(this);
  }

  matches(other) {
    return other instanceof GateAttemptIdentity
      && this.id === other.id
      && this.sequence === other.sequence;
  }

  toJSON() { return { id: this.id, sequence: this.sequence }; }
}

/** Immutable catalog publication tied to the producer Attempt that created it. */
export class GateCatalogPublication {
  constructor({ attemptId, sequence, producerActivityId, artifactId, fingerprint } = {}) {
    this.attempt = new GateAttemptIdentity({ id: attemptId, sequence });
    this.producerActivityId = requiredText(producerActivityId, "gate catalog producer activityId");
    this.artifactId = requiredText(artifactId, "gate catalog artifactId");
    this.fingerprint = requiredText(fingerprint, "gate catalog fingerprint");
    Object.freeze(this);
  }

  toJSON() {
    return {
      attemptId: this.attempt.id,
      sequence: this.attempt.sequence,
      producerActivityId: this.producerActivityId,
      artifactId: this.artifactId,
      fingerprint: this.fingerprint,
    };
  }
}

/** A category separates semantic rejection, local input defects, and external failures. */
export class GateFailureCategory {
  constructor({ category, code = null } = {}) {
    this.category = requiredText(category, "gate failure category");
    if (!FAILURE_CATEGORIES.has(this.category)) throw new Error("gate failure category is invalid");
    this.code = optionalText(code, "gate failure code");
    Object.freeze(this);
  }

  toJSON() { return { category: this.category, code: this.code }; }

  /** Normalize an evaluator result once at the producer boundary. */
  static fromObservedGateResult(result) {
    if (result?.result !== "fail") throw new Error("observed Gate failure requires a failed result");
    const artifacts = requireObject(result.artifacts, "observed Gate failure artifacts");
    const failureKind = requiredText(artifacts.failureKind, "observed Gate failure kind");
    // Only a completed semantic judgment spends the semantic Gate budget.
    // Local artifacts and mechanical checks are actionable input defects;
    // every explicit evaluator/provider execution failure remains external.
    const category = failureKind === "ai_semantic_fail"
      ? "semantic"
      : LOCAL_FAILURE_KINDS.has(failureKind) ? "local" : "tooling";
    return new GateFailureCategory({
      category,
      code: artifacts.failureCode ?? failureKind,
    });
  }
}

/**
 * Links source evidence and the canonical result to one stable producer
 * revision. Physical artifact hashes remain distinct; paired revision
 * bindings prove that the two catalog entries describe one Attempt.
 */
export class GateLineage {
  constructor({
    sourceAttempt,
    canonicalAttempt,
    sourceFingerprint,
    canonicalFingerprint,
    sourceRevisionFingerprint = null,
    canonicalRevisionFingerprint = null,
  } = {}) {
    this.sourceAttempt = sourceAttempt instanceof GateAttemptIdentity ? sourceAttempt : new GateAttemptIdentity(sourceAttempt);
    this.canonicalAttempt = canonicalAttempt instanceof GateAttemptIdentity
      ? canonicalAttempt
      : new GateAttemptIdentity(canonicalAttempt);
    this.sourceFingerprint = requiredText(sourceFingerprint, "gate source fingerprint");
    this.canonicalFingerprint = requiredText(canonicalFingerprint, "gate canonical fingerprint");
    this.sourceRevisionFingerprint = optionalText(sourceRevisionFingerprint, "gate source revision fingerprint");
    this.canonicalRevisionFingerprint = optionalText(canonicalRevisionFingerprint, "gate canonical revision fingerprint");
    if ((this.sourceRevisionFingerprint === null) !== (this.canonicalRevisionFingerprint === null)) {
      throw new Error("gate lineage revision bindings must be present together");
    }
    Object.freeze(this);
  }

  get isCurrent() {
    return this.sourceAttempt.matches(this.canonicalAttempt)
      // A one-artifact lineage is bound by its physical digest. Distinct
      // source/result artifacts must carry equal revision bindings on both
      // sides; a token supplied for only one side can never bypass this.
      && (this.sourceRevisionFingerprint === null
        ? this.sourceFingerprint === this.canonicalFingerprint
        : this.sourceRevisionFingerprint === this.canonicalRevisionFingerprint);
  }

  toJSON() {
    return {
      sourceAttempt: this.sourceAttempt.toJSON(),
      canonicalAttempt: this.canonicalAttempt.toJSON(),
      sourceFingerprint: this.sourceFingerprint,
      canonicalFingerprint: this.canonicalFingerprint,
      sourceRevisionFingerprint: this.sourceRevisionFingerprint,
      canonicalRevisionFingerprint: this.canonicalRevisionFingerprint,
    };
  }
}

/** Evidence already persisted by a recovery producer; it never authorizes an ad-hoc route. */
export class GateRecoveryEvidence {
  constructor({ kind = "none", attempt = null, fingerprint = null } = {}) {
    this.kind = requiredText(kind, "gate recovery evidence kind");
    if (!RECOVERY_KINDS.has(this.kind)) throw new Error("gate recovery evidence kind is invalid");
    this.attempt = attempt == null ? null : (attempt instanceof GateAttemptIdentity ? attempt : new GateAttemptIdentity(attempt));
    this.fingerprint = optionalText(fingerprint, "gate recovery evidence fingerprint");
    if (this.kind === "none" && (this.attempt !== null || this.fingerprint !== null)) {
      throw new Error("empty gate recovery evidence must not carry a binding");
    }
    if (this.kind !== "none" && (this.attempt === null || this.fingerprint === null)) {
      throw new Error("gate recovery evidence requires Attempt and fingerprint binding");
    }
    Object.freeze(this);
  }

  isBoundTo(lineage) {
    if (!(lineage instanceof GateLineage)) throw new Error("gate recovery lineage must be typed");
    return this.attempt === null || (this.attempt.matches(lineage.canonicalAttempt)
      && this.fingerprint === lineage.canonicalFingerprint);
  }

  toJSON() { return { kind: this.kind, attempt: this.attempt?.toJSON() ?? null, fingerprint: this.fingerprint }; }
}

/**
 * The canonical result publication deliberately precedes Gate classification.
 * This fact records whether that published result still needs its one
 * Definition-owned post-publication classification.  It is not a retry or a
 * route: it only prevents a crashed post hook from being mistaken for a fresh
 * evaluator admission.
 */
export class GatePostPublicationState {
  constructor({ status } = {}) {
    this.status = requiredText(status, "gate post-publication status");
    if (!POST_PUBLICATION_STATES.has(this.status)) {
      throw new Error("gate post-publication status is invalid");
    }
    Object.freeze(this);
  }

  get requiresReconciliation() { return this.status === "unclassified"; }

  toJSON() { return { status: this.status }; }
}

/**
 * Canonical review/triage/repair readiness bound to an integration Gate.
 * The reader supplies it; Definition only consumes its explicit passability.
 */
export class GateReviewFindingReadiness {
  constructor({
    status, findingFingerprints = [], reviewFingerprints = [],
    triageFingerprint = null, repairFingerprint = null, decisionFingerprint,
  } = {}) {
    this.status = requiredText(status, "gate review finding readiness status");
    if (!new Set(["ready", "blocking"]).has(this.status)) {
      throw new Error("gate review finding readiness status is invalid");
    }
    if (!Array.isArray(findingFingerprints) || findingFingerprints.some((value) => typeof value !== "string" || value === "")) {
      throw new Error("gate review finding readiness finding fingerprints are invalid");
    }
    if (!Array.isArray(reviewFingerprints) || reviewFingerprints.some((value) => typeof value !== "string" || value === "")) {
      throw new Error("gate review finding readiness review fingerprints are invalid");
    }
    this.findingFingerprints = Object.freeze([...findingFingerprints].sort());
    this.reviewFingerprints = Object.freeze([...reviewFingerprints]);
    this.triageFingerprint = optionalText(triageFingerprint, "gate review finding readiness triage fingerprint");
    this.repairFingerprint = optionalText(repairFingerprint, "gate review finding readiness repair fingerprint");
    this.decisionFingerprint = requiredText(decisionFingerprint, "gate review finding readiness decision fingerprint");
    if ((this.status === "ready") !== (this.findingFingerprints.length === 0)) {
      throw new Error("gate review finding readiness status does not match unresolved findings");
    }
    Object.freeze(this);
  }

  get allowsPass() { return this.status === "ready"; }

  toJSON() {
    return {
      status: this.status,
      findingFingerprints: [...this.findingFingerprints],
      reviewFingerprints: [...this.reviewFingerprints],
      triageFingerprint: this.triageFingerprint,
      repairFingerprint: this.repairFingerprint,
      decisionFingerprint: this.decisionFingerprint,
    };
  }
}

/** Reset-aware retry facts are computed by the state reader, never by commands. */
export class GateRetryMetrics {
  constructor({ used = 0, maximum } = {}) {
    this.used = nonNegativeInteger(used, "gate retry metrics used");
    this.maximum = positiveInteger(maximum, "gate retry metrics maximum");
    Object.freeze(this);
  }

  get remaining() { return Math.max(0, this.maximum - this.used); }
  get exhausted() { return this.used >= this.maximum; }
  toJSON() { return { used: this.used, maximum: this.maximum, remaining: this.remaining }; }
}

/** Persisted producer ownership prevents a consumer from claiming another gate's result. */
export class GateProducerOwnership {
  constructor({ runId, specId, activityId, phase, scope, taskId = null, stepId } = {}) {
    this.runId = requiredText(runId, "gate producer runId");
    this.specId = requiredText(specId, "gate producer specId");
    this.activityId = requiredText(activityId, "gate producer activityId");
    this.phase = requiredText(phase, "gate producer phase");
    if (!GATE_PHASES.has(this.phase)) throw new Error("gate producer phase is invalid");
    this.scope = requiredText(scope, "gate producer scope");
    if (!GATE_SCOPES.has(this.scope)) throw new Error("gate producer scope is invalid");
    this.taskId = optionalText(taskId, "gate producer taskId");
    if ((this.scope === "task") !== (this.taskId !== null)) {
      throw new Error("gate producer task scope requires exactly one taskId binding");
    }
    this.stepId = requiredText(stepId, "gate producer stepId");
    Object.freeze(this);
  }
  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      activityId: this.activityId,
      phase: this.phase,
      scope: this.scope,
      taskId: this.taskId,
      stepId: this.stepId,
    };
  }
}

/** Target binding is durable evidence that this exact Attempt owned the selected leaf. */
export class GateTargetBinding {
  constructor({ runId, specId, taskId = null, stepId, attempt } = {}) {
    this.runId = requiredText(runId, "gate target runId");
    this.specId = requiredText(specId, "gate target specId");
    this.taskId = optionalText(taskId, "gate target taskId");
    this.stepId = requiredText(stepId, "gate target stepId");
    this.attempt = attempt instanceof GateAttemptIdentity ? attempt : new GateAttemptIdentity(attempt);
    Object.freeze(this);
  }
  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      taskId: this.taskId,
      stepId: this.stepId,
      attempt: this.attempt.toJSON(),
    };
  }
}

/**
 * Task-only lifecycle facts already projected by the canonical state reader.
 * Definition does not rediscover Task completion or the next Task from a
 * caller cache: it receives the immutable selected successor with the gate
 * observation and seals that selection into the action plan.
 */
export class GateTaskLifecycle {
  constructor({ taskId, implStepId = null, reviewStepId = null, triageStepId = null, repairStepId = null, gateStepId = null, nextTaskId = null, integrationStepId } = {}) {
    this.taskId = requiredText(taskId, "gate Task lifecycle taskId");
    this.implStepId = implStepId === null ? taskGateStepId(this.taskId, "impl") : requiredText(implStepId, "gate Task lifecycle implStepId");
    this.reviewStepId = reviewStepId === null ? taskGateStepId(this.taskId, "review") : requiredText(reviewStepId, "gate Task lifecycle reviewStepId");
    this.triageStepId = triageStepId === null ? taskGateStepId(this.taskId, "triage") : requiredText(triageStepId, "gate Task lifecycle triageStepId");
    this.repairStepId = repairStepId === null ? taskGateStepId(this.taskId, "repair") : requiredText(repairStepId, "gate Task lifecycle repairStepId");
    this.gateStepId = gateStepId === null ? taskGateStepId(this.taskId, "gate") : requiredText(gateStepId, "gate Task lifecycle gateStepId");
    if (this.implStepId !== taskGateStepId(this.taskId, "impl")
      || this.reviewStepId !== taskGateStepId(this.taskId, "review")
      || this.triageStepId !== taskGateStepId(this.taskId, "triage")
      || this.repairStepId !== taskGateStepId(this.taskId, "repair")
      || this.gateStepId !== taskGateStepId(this.taskId, "gate")) {
      throw new Error("gate Task lifecycle Step identities must bind one Task");
    }
    this.nextTaskId = optionalText(nextTaskId, "gate Task lifecycle nextTaskId");
    this.integrationStepId = requiredText(integrationStepId, "gate Task lifecycle integrationStepId");
    Object.freeze(this);
  }

  get successorStepId() {
    return this.nextTaskId === null ? this.integrationStepId : taskGateStepId(this.nextTaskId, "impl");
  }

  toJSON() {
    return {
      taskId: this.taskId,
      implStepId: this.implStepId,
      reviewStepId: this.reviewStepId,
      triageStepId: this.triageStepId,
      repairStepId: this.repairStepId,
      gateStepId: this.gateStepId,
      nextTaskId: this.nextTaskId,
      integrationStepId: this.integrationStepId,
    };
  }
}

export class GateTaskBudget {
  constructor({ round, maximumRounds = TASK_EXECUTION_ROUND_POLICY.maximumRounds } = {}) {
    this.round = positiveInteger(round, "gate Task budget round");
    this.maximumRounds = positiveInteger(maximumRounds, "gate Task budget maximumRounds");
    TASK_EXECUTION_ROUND_POLICY.assertRound(this.round);
    if (this.maximumRounds !== TASK_EXECUTION_ROUND_POLICY.maximumRounds) throw new Error("gate Task budget does not match the Definition-owned Task execution policy");
    Object.freeze(this);
  }
  get finalRound() { return this.round === this.maximumRounds; }
  toJSON() { return { round: this.round, maximumRounds: this.maximumRounds, finalRound: this.finalRound }; }
}

/** Read-only progress of the durable effects that follow a Task Gate result. */
export class TaskGateSettlementProgress {
  constructor({
    classificationRecorded,
    classificationRecovery = { status: "not-required" },
    metricOperations,
    issueLogRecorded,
    terminalLifecycleRecorded,
  } = {}) {
    if (typeof classificationRecorded !== "boolean" || typeof terminalLifecycleRecorded !== "boolean") {
      throw new Error("Task Gate settlement lifecycle progress must be boolean");
    }
    if (!Array.isArray(metricOperations)
      || metricOperations.some((operation) => !["increment", "reset"].includes(operation))) {
      throw new Error("Task Gate settlement metric operations are invalid");
    }
    if (new Set(metricOperations).size !== metricOperations.length) {
      throw new Error("Task Gate settlement metric operations must be unique");
    }
    if (metricOperations.length > 1) {
      throw new Error("Task Gate settlement cannot record conflicting metric operations");
    }
    if (typeof issueLogRecorded !== "boolean") {
      throw new Error("Task Gate settlement issue-log progress must be boolean");
    }
    if (terminalLifecycleRecorded && !issueLogRecorded) {
      throw new Error("Task Gate terminal lifecycle requires its issue-log effect");
    }
    this.classificationRecorded = classificationRecorded;
    this.classificationRecovery = classificationRecovery instanceof TaskGateClassificationRecoveryProgress
      ? classificationRecovery
      : new TaskGateClassificationRecoveryProgress(classificationRecovery);
    if (this.classificationRecovery.required && this.classificationRecorded) {
      throw new Error("Task Gate classification recovery cannot coexist with a completed classification");
    }
    this.metricOperations = Object.freeze([...metricOperations].sort());
    this.issueLogRecorded = issueLogRecorded;
    this.terminalLifecycleRecorded = terminalLifecycleRecorded;
    Object.freeze(this);
  }

  hasMetric(effect) {
    return effect !== null && this.metricOperations.includes(effect.operation);
  }

  requiresReconciliation({ classificationRequired = false, metricEffect = null, issueLogRequired = false, terminalLifecycleRequired = false } = {}) {
    return this.classificationRecovery.required
      || (classificationRequired && !this.classificationRecorded)
      || (metricEffect !== null && !this.hasMetric(metricEffect))
      || (issueLogRequired && !this.issueLogRecorded)
      || (terminalLifecycleRequired && !this.terminalLifecycleRecorded);
  }

  toJSON() {
    return {
      classificationRecorded: this.classificationRecorded,
      classificationRecovery: this.classificationRecovery.toJSON(),
      metricOperations: [...this.metricOperations],
      issueLogRecorded: this.issueLogRecorded,
      terminalLifecycleRecorded: this.terminalLifecycleRecorded,
    };
  }
}

/** Read-only status of an audited correction for a legacy post-publication tooling classification. */
export class TaskGateClassificationRecoveryProgress {
  constructor({ status = "not-required", failedActivityId = null, recoveryActivityId = null } = {}) {
    this.status = requiredText(status, "Task Gate classification recovery status");
    if (!new Set(["not-required", "required", "recorded"]).has(this.status)) {
      throw new Error("Task Gate classification recovery status is invalid");
    }
    this.failedActivityId = optionalText(failedActivityId, "Task Gate classification recovery failed Activity id");
    this.recoveryActivityId = optionalText(recoveryActivityId, "Task Gate classification recovery Activity id");
    if (this.status === "not-required" && (this.failedActivityId !== null || this.recoveryActivityId !== null)) {
      throw new Error("Task Gate classification recovery absence cannot carry Activity identities");
    }
    if (this.status === "required" && (this.failedActivityId === null || this.recoveryActivityId !== null)) {
      throw new Error("required Task Gate classification recovery must identify only the failed Activity");
    }
    if (this.status === "recorded" && (this.failedActivityId === null || this.recoveryActivityId === null)) {
      throw new Error("recorded Task Gate classification recovery requires both Activity identities");
    }
    Object.freeze(this);
  }

  get required() { return this.status === "required"; }

  toJSON() {
    return {
      status: this.status,
      failedActivityId: this.failedActivityId,
      recoveryActivityId: this.recoveryActivityId,
    };
  }
}

/** Complete input contract for a definition-owned Gate decision. */
export class GateTransitionFacts {
  constructor({
    phase,
    scope = "flow",
    snapshotRevision,
    producer,
    target,
    currentAttempt,
    catalogPublication,
    result,
    failure = null,
    retry,
    lineage,
    recoveryEvidence = {},
    postPublication = { status: "classified" },
    nonblocking = false,
    reviewReadiness = null,
    taskLifecycle = null,
    taskBudget = null,
    taskSettlementProgress = null,
  } = {}) {
    this.phase = requiredText(phase, "gate phase");
    if (!GATE_PHASES.has(this.phase)) throw new Error("gate phase is invalid");
    this.scope = requiredText(scope, "gate scope");
    if (!GATE_SCOPES.has(this.scope)) throw new Error("gate scope is invalid");
    this.snapshotRevision = snapshotRevision === null || snapshotRevision === undefined
      ? null
      : requiredText(snapshotRevision, "gate snapshot revision");
    this.producer = producer instanceof GateProducerOwnership ? producer : new GateProducerOwnership(producer);
    this.currentAttempt = currentAttempt instanceof GateAttemptIdentity ? currentAttempt : new GateAttemptIdentity(currentAttempt);
    this.target = target instanceof GateTargetBinding ? target : new GateTargetBinding(target);
    this.catalogPublication = catalogPublication instanceof GateCatalogPublication
      ? catalogPublication
      : new GateCatalogPublication(catalogPublication);
    this.result = requiredText(result, "gate result");
    if (!GATE_RESULTS.has(this.result)) throw new Error("gate result is invalid");
    this.failure = failure == null ? null : (failure instanceof GateFailureCategory ? failure : new GateFailureCategory(failure));
    if ((this.result === "fail") !== (this.failure !== null)) {
      throw new Error("gate failure facts must accompany exactly a failed result");
    }
    this.retry = retry instanceof GateRetryMetrics ? retry : new GateRetryMetrics(retry);
    this.lineage = lineage instanceof GateLineage ? lineage : new GateLineage(lineage);
    this.recoveryEvidence = recoveryEvidence instanceof GateRecoveryEvidence
      ? recoveryEvidence
      : new GateRecoveryEvidence(recoveryEvidence);
    this.postPublication = postPublication instanceof GatePostPublicationState
      ? postPublication
      : new GatePostPublicationState(postPublication);
    if (typeof nonblocking !== "boolean") throw new Error("gate nonblocking fact must be boolean");
    this.nonblocking = nonblocking;
    this.reviewReadiness = reviewReadiness === null
      ? null
      : (reviewReadiness instanceof GateReviewFindingReadiness ? reviewReadiness : new GateReviewFindingReadiness(reviewReadiness));
    if ((this.phase === "integration") !== (this.reviewReadiness !== null)) {
      throw new Error("integration Gate requires exactly one review finding readiness fact");
    }
    this.taskLifecycle = taskLifecycle === null
      ? null
      : (taskLifecycle instanceof GateTaskLifecycle ? taskLifecycle : new GateTaskLifecycle(taskLifecycle));
    if ((this.scope === "task") !== (this.taskLifecycle !== null)) {
      throw new Error("gate Task lifecycle must exist exactly for task scope");
    }
    this.taskBudget = taskBudget === null ? null : (taskBudget instanceof GateTaskBudget ? taskBudget : new GateTaskBudget(taskBudget));
    if ((this.scope === "task") !== (this.taskBudget !== null)) throw new Error("gate Task budget must exist exactly for task scope");
    this.taskSettlementProgress = taskSettlementProgress === null
      ? null
      : (taskSettlementProgress instanceof TaskGateSettlementProgress
        ? taskSettlementProgress
        : new TaskGateSettlementProgress(taskSettlementProgress));
    if ((this.scope === "task") !== (this.taskSettlementProgress !== null)) {
      throw new Error("gate Task settlement progress must exist exactly for task scope");
    }
    if ((this.scope === "task") !== (this.snapshotRevision !== null)) {
      throw new Error("gate snapshot revision is required exactly for Task settlement scope");
    }
    if ((this.result === "recovered") !== (this.recoveryEvidence.kind === "recovered")) {
      throw new Error("recovered gate result requires matching recovery evidence");
    }
    if (["repair", "defer"].includes(this.recoveryEvidence.kind) && this.failure?.category !== "semantic") {
      throw new Error("gate repair or defer evidence requires a semantic failure");
    }
    Object.freeze(this);
  }

  get integrityFailure() {
    if ((this.phase === "task-impl") !== (this.scope === "task")) return "phase_scope_mismatch";
    if (this.producer.phase !== this.phase || this.producer.scope !== this.scope) return "producer_ownership_mismatch";
    if (this.producer.runId !== this.target.runId || this.producer.specId !== this.target.specId) {
      return "target_binding_mismatch";
    }
    if (this.producer.taskId !== this.target.taskId) return "target_task_mismatch";
    if (this.scope === "task" && (!taskGateBindingIsValid(this.target.taskId, this.target.stepId)
      || !taskGateBindingIsValid(this.producer.taskId, this.producer.stepId))) return "task_step_identity_mismatch";
    if (this.taskLifecycle !== null && (
      this.taskLifecycle.taskId !== this.target.taskId
      || this.taskLifecycle.gateStepId !== this.target.stepId
    )) return "task_lifecycle_mismatch";
    if (!this.currentAttempt.matches(this.target.attempt)) return "target_attempt_mismatch";
    if (this.producer.stepId !== this.target.stepId) return "producer_target_mismatch";
    if (this.producer.activityId !== this.catalogPublication.producerActivityId) {
      return "catalog_producer_mismatch";
    }
    if (!this.currentAttempt.matches(this.catalogPublication.attempt)) return "attempt_catalog_mismatch";
    if (this.catalogPublication.fingerprint !== this.lineage.canonicalFingerprint) {
      return "catalog_lineage_mismatch";
    }
    if (!this.currentAttempt.matches(this.lineage.canonicalAttempt)) return "attempt_lineage_mismatch";
    if (!this.lineage.isCurrent) return "source_canonical_lineage_mismatch";
    if (!this.recoveryEvidence.isBoundTo(this.lineage)) return "recovery_lineage_mismatch";
    return null;
  }

  /** Read a JSON-safe canonical-store fixture; no singleton or caller cache is trusted. */
  static fromPersisted(value) {
    requireObject(value, "persisted gate transition facts");
    return new GateTransitionFacts(value);
  }

  toJSON() {
    return {
      phase: this.phase, scope: this.scope,
      ...(this.snapshotRevision === null ? {} : { snapshotRevision: this.snapshotRevision }),
      producer: this.producer.toJSON(), target: this.target.toJSON(),
      currentAttempt: this.currentAttempt.toJSON(), catalogPublication: this.catalogPublication.toJSON(),
      result: this.result, failure: this.failure?.toJSON() ?? null, retry: this.retry.toJSON(),
      lineage: this.lineage.toJSON(), recoveryEvidence: this.recoveryEvidence.toJSON(),
      postPublication: this.postPublication.toJSON(),
      nonblocking: this.nonblocking,
      reviewReadiness: this.reviewReadiness?.toJSON() ?? null,
      taskLifecycle: this.taskLifecycle?.toJSON() ?? null,
      taskBudget: this.taskBudget?.toJSON() ?? null,
      ...(this.scope === "task" ? { taskSettlementProgress: this.taskSettlementProgress.toJSON() } : {}),
    };
  }
}
