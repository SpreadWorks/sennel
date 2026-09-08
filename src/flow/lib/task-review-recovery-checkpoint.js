import crypto from "node:crypto";

import { CanonicalFlowArtifactWrite, CurrentAttemptIdentity } from "./current-flow-state.js";
import { SourceMutationBaseline, WorkerArtifactRepositoryMutationSnapshot } from "./worker-artifact-handoff.js";
import { captureCurrentTaskSource } from "./task-mutation-lineage.js";

const SHA256 = /^[a-f0-9]{64}$/;

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function exact(value, keys, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${field} has an invalid schema`);
  }
  return value;
}

function sha(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function digest(value, field) {
  const result = text(value, field).toLowerCase();
  if (!SHA256.test(result)) throw new Error(`${field} must be a SHA-256 digest`);
  return result;
}

export function sameTaskReviewRepositorySnapshot(left, right) {
  return JSON.stringify(left.toJSON()) === JSON.stringify(right.toJSON());
}

function sameAttempt(left, right) {
  return left.id === right.id && left.nodeId === right.nodeId && left.sequence === right.sequence;
}

/** Bind a recovery prerequisite to its canonical bytes and sole publication. */
function publicationActivity({ flowManager, state, source, logicalKey }) {
  const descriptor = flowManager.artifactCatalog(state.specId).artifacts
    .find((entry) => entry.relativePath === source.relativePath);
  if (descriptor?.logicalKey !== logicalKey
    || descriptor.activityId === null
    || source.descriptor.logicalKey !== logicalKey
    || source.descriptor.activityId !== descriptor.activityId
    || source.descriptor.hash !== descriptor.hash
    || crypto.createHash("sha256").update(source.bytes).digest("hex") !== descriptor.hash) {
    throw new Error(`Task Review recovery prerequisite is not catalog-published: ${logicalKey}`);
  }
  const activities = flowManager.activityLedger(state.specId)
    .filter((entry) => entry.id === descriptor.activityId);
  if (activities.length !== 1) {
    throw new Error(`Task Review recovery prerequisite has no unique publication: ${logicalKey}`);
  }
  return activities[0];
}

/** Parent-observed zero-effect boundary for one stopped Task Review worker. */
export class TaskReviewUnsealedCheckpoint {
  constructor(value, { root } = {}) {
    exact(value, ["version", "runId", "specId", "taskId", "nodeId", "attempt", "manifestDigest", "taskSourceFingerprint", "baseline", "observed", "digest"], "Task Review unsealed checkpoint");
    if (value.version !== 1) throw new Error("Task Review unsealed checkpoint version is invalid");
    this.version = 1;
    this.runId = text(value.runId, "Task Review checkpoint runId");
    this.specId = text(value.specId, "Task Review checkpoint specId");
    this.taskId = text(value.taskId, "Task Review checkpoint taskId");
    this.nodeId = text(value.nodeId, "Task Review checkpoint nodeId");
    this.attempt = CurrentAttemptIdentity.from(value.attempt);
    if (this.nodeId !== `${this.taskId}-review` || this.attempt.nodeId !== this.nodeId) {
      throw new Error("Task Review checkpoint does not bind its Task Review Attempt");
    }
    this.manifestDigest = digest(value.manifestDigest, "Task Review checkpoint manifestDigest");
    this.taskSourceFingerprint = digest(value.taskSourceFingerprint, "Task Review checkpoint taskSourceFingerprint");
    this.baseline = value.baseline instanceof SourceMutationBaseline
      ? value.baseline : SourceMutationBaseline.fromStored(value.baseline, { root });
    this.observed = value.observed instanceof WorkerArtifactRepositoryMutationSnapshot
      ? value.observed : WorkerArtifactRepositoryMutationSnapshot.fromStored(value.observed, { root });
    if (!sameAttempt(this.attempt, this.baseline.attempt) || !sameTaskReviewRepositorySnapshot(this.baseline.snapshot, this.observed)) {
      throw new Error("Task Review checkpoint does not prove a zero-effect worker boundary");
    }
    const unsigned = this.unsignedJSON();
    this.digest = sha(unsigned);
    if (this.digest !== digest(value.digest, "Task Review checkpoint digest")) throw new Error("Task Review checkpoint digest does not match its content");
    Object.freeze(this);
  }

  static capture({ runId, specId, taskId, attempt, manifestDigest, taskSourceFingerprint, baseline } = {}) {
    if (!(baseline instanceof SourceMutationBaseline)) throw new Error("Task Review checkpoint requires a parent source baseline");
    const observed = WorkerArtifactRepositoryMutationSnapshot.capture({
      root: baseline.snapshot.root,
      authorities: baseline.snapshot.authorities,
      ignoredDirectories: baseline.snapshot.ignoredDirectories,
      runtimeLocks: baseline.snapshot.runtimeLocks,
    });
    const identity = CurrentAttemptIdentity.from(attempt);
    const unsigned = {
      version: 1,
      runId: text(runId, "Task Review checkpoint runId"),
      specId: text(specId, "Task Review checkpoint specId"),
      taskId: text(taskId, "Task Review checkpoint taskId"),
      nodeId: identity.nodeId,
      attempt: identity.toJSON(),
      manifestDigest: digest(manifestDigest, "Task Review checkpoint manifestDigest"),
      taskSourceFingerprint: digest(taskSourceFingerprint, "Task Review checkpoint taskSourceFingerprint"),
      baseline: baseline.toJSON(),
      observed: observed.toJSON(),
    };
    return new TaskReviewUnsealedCheckpoint({ ...unsigned, digest: sha(unsigned) }, { root: baseline.snapshot.root });
  }

  unsignedJSON() {
    return {
      version: this.version,
      runId: this.runId,
      specId: this.specId,
      taskId: this.taskId,
      nodeId: this.nodeId,
      attempt: this.attempt.toJSON(),
      manifestDigest: this.manifestDigest,
      taskSourceFingerprint: this.taskSourceFingerprint,
      baseline: this.baseline.toJSON(),
      observed: this.observed.toJSON(),
    };
  }
  toJSON() { return { ...this.unsignedJSON(), digest: this.digest }; }
  assertTaskSource({ flowManager, state, root }) {
    const current = captureCurrentTaskSource({ root, flowManager, state, taskId: this.taskId });
    if (current.fingerprint !== this.taskSourceFingerprint) {
      throw new Error("Task Review recovery checkout changes Task-owned source after worker stop");
    }
    return this;
  }
  assertActiveState(state) {
    if (state?.runId !== this.runId || state?.specId !== this.specId
      || !this.attempt.matches(state) || state.current?.at(-1) !== this.nodeId) {
      throw new Error("Task Review checkpoint does not match the active Flow Attempt");
    }
    return this;
  }
  assertFailedState(state) {
    if (state?.runId !== this.runId || state?.specId !== this.specId
      || !this.attempt.matchesFailed(state) || state.current?.at(-1) !== this.nodeId) {
      throw new Error("Task Review checkpoint does not match the failed Flow Attempt");
    }
    return this;
  }
}

/** Canonical recovery-time checkout observation, tied to receipt and checkpoint. */
export class TaskReviewRecoveryAuthorization {
  constructor(value, { root } = {}) {
    exact(value, ["version", "checkpointDigest", "previousAttempt", "currentAttempt", "receiptDigest", "targetDigest", "snapshot", "digest"], "Task Review recovery authorization");
    if (value.version !== 1) throw new Error("Task Review recovery authorization version is invalid");
    this.version = 1;
    this.checkpointDigest = digest(value.checkpointDigest, "Task Review authorization checkpointDigest");
    this.previousAttempt = CurrentAttemptIdentity.from(value.previousAttempt);
    this.currentAttempt = CurrentAttemptIdentity.from(value.currentAttempt);
    if (this.previousAttempt.nodeId !== this.currentAttempt.nodeId
      || this.previousAttempt.sequence + 1 !== this.currentAttempt.sequence
      || this.previousAttempt.id === this.currentAttempt.id) {
      throw new Error("Task Review recovery authorization Attempt binding is invalid");
    }
    this.receiptDigest = digest(value.receiptDigest, "Task Review authorization receiptDigest");
    this.targetDigest = digest(value.targetDigest, "Task Review authorization targetDigest");
    this.snapshot = value.snapshot instanceof WorkerArtifactRepositoryMutationSnapshot
      ? value.snapshot : WorkerArtifactRepositoryMutationSnapshot.fromStored(value.snapshot, { root });
    const unsigned = this.unsignedJSON();
    this.digest = sha(unsigned);
    if (this.digest !== digest(value.digest, "Task Review authorization digest")) throw new Error("Task Review recovery authorization digest does not match its content");
    Object.freeze(this);
  }
  static capture({ checkpoint, receipt, targetDigest } = {}) {
    if (!(checkpoint instanceof TaskReviewUnsealedCheckpoint)) throw new Error("Task Review recovery authorization requires a checkpoint");
    const snapshot = WorkerArtifactRepositoryMutationSnapshot.capture({
      root: checkpoint.baseline.snapshot.root,
      authorities: checkpoint.baseline.snapshot.authorities,
      ignoredDirectories: checkpoint.baseline.snapshot.ignoredDirectories,
      runtimeLocks: checkpoint.baseline.snapshot.runtimeLocks,
    });
    const unsigned = {
      version: 1,
      checkpointDigest: checkpoint.digest,
      previousAttempt: checkpoint.attempt.toJSON(),
      currentAttempt: { id: receipt.current.attemptId, nodeId: checkpoint.nodeId, sequence: receipt.current.attempt },
      receiptDigest: sha(receipt.toJSON()),
      targetDigest: digest(targetDigest, "Task Review authorization targetDigest"),
      snapshot: snapshot.toJSON(),
    };
    return new TaskReviewRecoveryAuthorization({ ...unsigned, digest: sha(unsigned) }, { root: checkpoint.baseline.snapshot.root });
  }
  unsignedJSON() {
    return {
      version: this.version,
      checkpointDigest: this.checkpointDigest,
      previousAttempt: this.previousAttempt.toJSON(),
      currentAttempt: this.currentAttempt.toJSON(),
      receiptDigest: this.receiptDigest,
      targetDigest: this.targetDigest,
      snapshot: this.snapshot.toJSON(),
    };
  }
  toJSON() { return { ...this.unsignedJSON(), digest: this.digest }; }
}

export function taskReviewCheckpointArtifact(checkpoint) {
  if (!(checkpoint instanceof TaskReviewUnsealedCheckpoint)) throw new Error("Task Review checkpoint artifact requires a typed checkpoint");
  return new CanonicalFlowArtifactWrite({ logicalKey: "task.review.unsealed.checkpoint", parameters: { taskId: checkpoint.taskId, attemptId: checkpoint.attempt.id }, mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(checkpoint.toJSON(), null, 2)}\n`) });
}

export function taskReviewAuthorizationArtifact({ taskId, authorization } = {}) {
  if (!(authorization instanceof TaskReviewRecoveryAuthorization)) throw new Error("Task Review authorization artifact requires a typed authorization");
  return new CanonicalFlowArtifactWrite({ logicalKey: "task.review.recovery.authorization", parameters: { taskId: text(taskId, "Task Review authorization taskId"), attemptId: authorization.currentAttempt.id }, mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(authorization.toJSON(), null, 2)}\n`) });
}

export function readTaskReviewUnsealedCheckpoint({ flowManager, state, taskId, root, attemptId = null } = {}) {
  const requestedAttemptId = attemptId === null ? state.attempt.id : text(attemptId, "Task Review checkpoint requested attemptId");
  const source = flowManager.readArtifact({ specId: state.specId, logicalKey: "task.review.unsealed.checkpoint", parameters: { taskId, attemptId: requestedAttemptId }, consumerNodeId: `${taskId}-review`, optional: true });
  if (source === null) return null;
  const checkpoint = new TaskReviewUnsealedCheckpoint(JSON.parse(source.bytes.toString("utf8")), { root });
  if (checkpoint.runId !== state.runId || checkpoint.specId !== state.specId
    || checkpoint.taskId !== taskId || checkpoint.nodeId !== `${taskId}-review`
    || checkpoint.attempt.id !== requestedAttemptId) {
    throw new Error("Task Review checkpoint does not match its requested Flow Attempt");
  }
  if (attemptId === null) checkpoint.assertFailedState(state);
  const activity = publicationActivity({
    flowManager, state, source, logicalKey: "task.review.unsealed.checkpoint",
  });
  if (activity.transition.operation !== "fail_attempt"
    || activity.nodeId !== checkpoint.nodeId
    || activity.transition.nodeId !== checkpoint.nodeId
    || activity.attemptId !== checkpoint.attempt.id
    || activity.sequence !== checkpoint.attempt.sequence) {
    throw new Error("Task Review checkpoint is not published by its failed Attempt");
  }
  return checkpoint;
}

export function readTaskReviewRecoveryAuthorization({ flowManager, state, taskId, root } = {}) {
  const source = flowManager.readArtifact({ specId: state.specId, logicalKey: "task.review.recovery.authorization", parameters: { taskId, attemptId: state.attempt.id }, consumerNodeId: state.attempt.nodeId, optional: true });
  if (source === null) return null;
  const authorization = new TaskReviewRecoveryAuthorization(JSON.parse(source.bytes.toString("utf8")), { root });
  if (!authorization.currentAttempt.matches(state)
    || authorization.currentAttempt.nodeId !== `${taskId}-review`) {
    throw new Error("Task Review recovery authorization does not match the active Attempt");
  }
  const activity = publicationActivity({
    flowManager, state, source, logicalKey: "task.review.recovery.authorization",
  });
  if (activity.transition.operation !== "retry_recovery_attempt"
    || activity.nodeId !== authorization.currentAttempt.nodeId
    || activity.transition.nodeId !== authorization.currentAttempt.nodeId
    || activity.attemptId !== authorization.currentAttempt.id
    || activity.sequence !== authorization.currentAttempt.sequence
    || activity.transition.attempt.id !== authorization.currentAttempt.id
    || activity.transition.attempt.sequence !== authorization.currentAttempt.sequence) {
    throw new Error("Task Review recovery authorization is not published by its recovered Attempt");
  }
  return authorization;
}

/** The ordinary retry's one parent-published baseline is not a worker effect. */
export function readTaskReviewRetryBaselinePublication({ flowManager, state, taskId, previousAttempt } = {}) {
  const source = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: "retry.recovery.baseline",
    parameters: { routeId: `review-impl-${taskId}`, attemptId: state.attempt.id },
    consumerNodeId: `${taskId}-review`,
    optional: true,
  });
  if (source === null) return null;
  const activity = publicationActivity({
    flowManager, state, source, logicalKey: "retry.recovery.baseline",
  });
  if (activity.transition.operation !== "retry_attempt"
    || activity.nodeId !== `${taskId}-review`
    || activity.nodeId !== state.attempt.nodeId
    || activity.transition.nodeId !== activity.nodeId
    || activity.attemptId !== previousAttempt.id
    || activity.sequence !== previousAttempt.sequence
    || activity.transition.attempt.id !== state.attempt.id
    || activity.transition.attempt.sequence !== state.attempt.sequence) {
    throw new Error("Task Review baseline is not published by its ordinary retry");
  }
  return source;
}
