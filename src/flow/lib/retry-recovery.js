/**
 * Version-1 retry recovery.
 *
 * Retry authority is the active failed Attempt.  Retrying it is one typed
 * Activity transition; it never resets a mutable counter or writes a sibling
 * recovery document.
 */

import crypto from "node:crypto";

import { RetryTargetRoute } from "./retry-target-route.js";
import { CanonicalFlowArtifactWrite } from "./current-flow-state.js";
import { flowStateSpecLocation } from "../../lib/flow-workspace.js";
import { buildRepairFingerprint } from "./repair-fingerprint.js";
import { RuntimeModuleIdentity } from "./runtime-module-identity.js";
import { ReviewTargetAuthority } from "./review-target-authority.js";
import { TaskStepIdentity } from "./task-step-identity.js";
import { TaskReviewReconciliationRecord, TASK_REVIEW_RECONCILIATION_KEY } from "./task-review-reconciliation-record.js";
import {
  readTaskReviewUnsealedCheckpoint,
  TaskReviewRecoveryAuthorization,
  taskReviewAuthorizationArtifact,
} from "./task-review-recovery-checkpoint.js";

export const RECOVERY_REASON_MIN_LENGTH = 20;
export const RECOVERY_REASON_MAX_LENGTH = 500;
export const RETRY_RECOVERY_ARTIFACT_KEYS = Object.freeze(new Set([
  "retry.recovery.baseline",
  "retry.recovery.receipt",
  TASK_REVIEW_RECONCILIATION_KEY,
]));

const BASELINE_PHASES = new Map([
  ["draft-questions-review", "draft-questions"], ["draft-coverage-review", "draft-coverage"],
  ["spec-review", "spec"], ["test-review", "test"], ["impl-review", "impl"], ["task-review", "impl"],
  ["draft-gate", "draft"], ["spec-gate", "spec"], ["impl-gate", "integration"], ["task-gate", "task-impl"],
]);
const BASELINE_MODULES = Object.freeze({
  review: Object.freeze(["run-review.js", "review-target-authority.js", "canonical-review-artifacts.js", "review-work-unit.js", "../commands/review.js"]),
  gate: Object.freeze(["run-gate.js", "canonical-gate-artifacts.js"]),
});

function taskStepInDefinition(node, nodeId) {
  if (node === null || node === undefined || typeof node !== "object") return null;
  const direct = node.kind === "task" ? TaskStepIdentity.fromTaskNode(node, nodeId) : null;
  if (direct !== null) return direct;
  if (!Array.isArray(node.steps)) return null;
  for (const child of node.steps) {
    const resolved = taskStepInDefinition(child, nodeId);
    if (resolved !== null) return resolved;
  }
  return null;
}

function taskStepForStateNode(state, nodeId) {
  const projected = TaskStepIdentity.fromStateNode(state, nodeId);
  if (projected !== null) return projected;
  const fromDefinition = taskStepInDefinition(state?.root, nodeId);
  if (fromDefinition !== null) return fromDefinition;
  if (typeof state?.findNode !== "function" || !Array.isArray(state.current)) return null;
  const task = state.current
    .map((id) => state.findNode(id))
    .find((node) => node?.kind === "task") ?? null;
  return TaskStepIdentity.fromTaskNode(task, nodeId);
}

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function requiredPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function nullableDigest(value, field) {
  if (value == null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value.trim().toLowerCase())) {
    throw new Error(`${field} has invalid digest semantics`);
  }
  return value.trim().toLowerCase();
}

function requiredDigest(value, field) {
  const digest = nullableDigest(value, field);
  if (digest === null) throw new Error(`${field} is required`);
  return digest;
}

class RetryEvidenceRoute {
  constructor({ kind, phase, taskId = null } = {}) {
    if (!["review", "gate"].includes(kind)) throw new Error("retry evidence route kind is invalid");
    this.kind = requiredText(kind, "retry evidence route kind");
    this.phase = requiredText(phase, "retry evidence route phase");
    this.taskId = taskId == null ? null : requiredText(taskId, "retry evidence route taskId");
    if (this.phase === "task-impl" || (this.kind === "review" && this.phase === "impl" && this.taskId !== null)) {
      if (this.taskId === null) throw new Error("task retry evidence route requires taskId");
    }
    Object.freeze(this);
  }
  equals(other) { return other instanceof RetryEvidenceRoute && this.kind === other.kind && this.phase === other.phase && this.taskId === other.taskId; }
  toJSON() { return { kind: this.kind, phase: this.phase, taskId: this.taskId }; }
}

export class RetryRecoveryBaseline {
  constructor(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("retry recovery baseline must be an object");
    const expected = ["route", "attemptId", "attempt", "runId", "specId", "issue", "projectDigest", "runtimeDigest", "targetDigest"];
    if (Object.keys(value).sort().join("\0") !== expected.sort().join("\0")) throw new Error("retry recovery baseline schema is invalid");
    this.route = value.route instanceof RetryEvidenceRoute ? value.route : new RetryEvidenceRoute(value.route);
    this.attemptId = requiredText(value.attemptId, "retry baseline attemptId");
    this.attempt = requiredPositiveInteger(value.attempt, "retry baseline attempt");
    this.runId = requiredText(value.runId, "retry baseline runId");
    this.specId = requiredText(value.specId, "retry baseline specId");
    this.issue = value.issue == null ? null : requiredPositiveInteger(value.issue, "retry baseline issue");
    this.projectDigest = nullableDigest(value.projectDigest, "retry baseline projectDigest");
    this.runtimeDigest = nullableDigest(value.runtimeDigest, "retry baseline runtimeDigest");
    this.targetDigest = nullableDigest(value.targetDigest, "retry baseline targetDigest");
    if (!this.projectDigest && !this.runtimeDigest && !this.targetDigest) throw new Error("retry baseline requires evidence");
    Object.freeze(this);
  }
  get digest() { return crypto.createHash("sha256").update(JSON.stringify(this.toJSON())).digest("hex"); }
  equals(other) { return other instanceof RetryRecoveryBaseline && JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON()); }
  toJSON() { return { route: this.route.toJSON(), attemptId: this.attemptId, attempt: this.attempt, runId: this.runId, specId: this.specId, issue: this.issue, projectDigest: this.projectDigest, runtimeDigest: this.runtimeDigest, targetDigest: this.targetDigest }; }
}

export class RetryRecoveryReceipt {
  constructor(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("retry recovery receipt must be an object");
    const expected = ["previous", "current", "reason", "reevaluationCount"];
    if (Object.keys(value).sort().join("\0") !== expected.sort().join("\0")) throw new Error("retry recovery receipt schema is invalid");
    this.previous = value.previous instanceof RetryRecoveryBaseline ? value.previous : new RetryRecoveryBaseline(value.previous);
    this.current = value.current instanceof RetryRecoveryBaseline ? value.current : new RetryRecoveryBaseline(value.current);
    this.reason = requiredText(value.reason, "retry recovery receipt reason");
    if (value.reevaluationCount !== 1) throw new Error("retry recovery receipt permits exactly one reevaluation");
    this.reevaluationCount = 1;
    if (this.previous.route.equals(this.current.route) === false) throw new Error("retry recovery receipt route mismatch");
    if (
      this.previous.runId !== this.current.runId
      || this.previous.specId !== this.current.specId
      || this.previous.issue !== this.current.issue
      || this.current.attempt !== this.previous.attempt + 1
      || this.current.attemptId === this.previous.attemptId
    ) throw new Error("retry recovery receipt Attempt identity is invalid");
    if (this.previous.digest === this.current.digest) throw new Error("retry recovery receipt evidence is unchanged");
    Object.freeze(this);
  }
  toJSON() { return { previous: this.previous.toJSON(), current: this.current.toJSON(), reason: this.reason, reevaluationCount: this.reevaluationCount }; }
}

function runtimeDigest(route) {
  const hash = crypto.createHash("sha256");
  const modules = route.kind === "review" && route.phase.startsWith("draft-")
    ? [...BASELINE_MODULES.review, "draft-review-routes.js"]
    : BASELINE_MODULES[route.kind];
  for (const name of modules) {
    const fingerprint = new RuntimeModuleIdentity({ key: name, moduleUrl: new URL(`./${name}`, import.meta.url) }).fingerprint();
    fingerprint.update(hash);
  }
  return hash.digest("hex");
}

export function captureRetryRecoveryBaseline({ flowState, flowManager, executionRoot, artifactRoot, nodeId, attempt = null, specPath = null } = {}) {
  const route = retryEvidenceRouteForNode(flowState, nodeId);
  if (route === null) return null;
  const { kind, phase, taskId } = route;
  const location = flowStateSpecLocation(flowState);
  if (location === null && (typeof specPath !== "string" || specPath.trim() === "")) throw new Error("retry baseline requires manager-bound Flow state");
  const relativeSpecPath = location?.relativeSpecFile ?? specPath;
  let targetDigest;
  let projectDigest;
  if (kind === "review") {
    try {
      targetDigest = new ReviewTargetAuthority({ executionRoot, artifactRoot, flowState, flowManager, specPath: relativeSpecPath })
        .captureTargetStateForPhase(phase).digest;
      projectDigest = targetDigest;
    } catch (error) {
      if (error?.code === "REPAIR_BASELINE_UNRESOLVABLE"
        || error?.code === "CANONICAL_DRAFT_SOURCE_UNAVAILABLE"
        || /canonical artifact is absent|source artifact/i.test(error.message)) return null;
      throw error;
    }
  } else {
    let fingerprint;
    try {
      fingerprint = buildRepairFingerprint({ root: executionRoot, artifactRoot, specPath: relativeSpecPath, state: flowState });
    } catch (error) {
      if (error?.code === "REPAIR_BASELINE_UNRESOLVABLE") return null;
      throw error;
    }
    projectDigest = fingerprint.hash;
    const sourceKey = nodeId === "draft-gate" ? "draft.gate.source" : nodeId === "spec-gate" ? "spec.gate.source" : nodeId === "impl-gate" ? "impl.gate.source" : "task.gate.source";
    const source = flowManager.readArtifact({ specId: flowState.specId, logicalKey: sourceKey, parameters: taskId ? { taskId } : {}, consumerNodeId: nodeId, optional: true });
    if (source === null) return null;
    targetDigest = crypto.createHash("sha256").update(fingerprint.hash).update("\0").update(source.bytes).digest("hex");
  }
  const identity = attempt ?? flowState.attempt;
  if (!identity) throw new Error("retry baseline requires the started Attempt identity");
  return new RetryRecoveryBaseline({ route, attemptId: identity.id, attempt: identity.sequence, runId: flowState.runId, specId: flowState.specId, issue: flowState.issue ?? null, projectDigest, runtimeDigest: runtimeDigest(route), targetDigest });
}

/** Resolve the only retry evidence route that may own an executable leaf. */
export function retryEvidenceRouteForNode(flowState, nodeId) {
  const taskStep = taskStepForStateNode(flowState, nodeId);
  // A failed Task Attempt retains its immutable current path but has no
  // mutable `currentTaskId` projection. Its TaskStepIdentity is therefore the
  // durable authority for both baseline publication and exhausted recovery.
  const dynamicTask = taskStep !== null && ["review", "gate"].includes(taskStep.role);
  const phase = BASELINE_PHASES.get(nodeId) || (dynamicTask ? (nodeId.endsWith("-gate") ? "task-impl" : "impl") : null);
  if (!phase) return null;
  return new RetryEvidenceRoute({
    kind: taskStep?.role === "gate" || nodeId.endsWith("-gate") ? "gate" : "review",
    phase,
    taskId: dynamicTask ? taskStep.taskId : null,
  });
}

export function retryBaselineArtifact(baseline) {
  if (!(baseline instanceof RetryRecoveryBaseline)) throw new Error("retry baseline artifact requires a typed baseline");
  return new CanonicalFlowArtifactWrite({ logicalKey: "retry.recovery.baseline", parameters: { routeId: `${baseline.route.kind}-${baseline.route.phase}${baseline.route.taskId ? `-${baseline.route.taskId}` : ""}`, attemptId: baseline.attemptId }, mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(baseline.toJSON(), null, 2)}\n`, "utf8") });
}

export function retryReceiptArtifact(receipt) {
  if (!(receipt instanceof RetryRecoveryReceipt)) throw new Error("retry receipt artifact requires a typed receipt");
  const route = receipt.current.route;
  return new CanonicalFlowArtifactWrite({ logicalKey: "retry.recovery.receipt", parameters: { routeId: `${route.kind}-${route.phase}${route.taskId ? `-${route.taskId}` : ""}`, attemptId: receipt.current.attemptId }, mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(receipt.toJSON(), null, 2)}\n`, "utf8") });
}

/** Whether an untrusted generic artifact-write request tries to claim retry authority. */
export function containsRetryRecoveryArtifactWrite(writes) {
  return Array.isArray(writes) && writes.some((write) => {
    const logicalKey = write?.artifact?.logicalKey ?? write?.logicalKey ?? null;
    return RETRY_RECOVERY_ARTIFACT_KEYS.has(logicalKey);
  });
}

function assertPublicationAttempt(activity, value, field) {
  const transitionAttempt = activity?.transition?.attempt;
  const attemptId = transitionAttempt?.id ?? activity?.attemptId;
  const sequence = transitionAttempt?.sequence ?? activity?.sequence;
  if (attemptId !== value.attemptId || sequence !== value.attempt) {
    throw new Error(`${field} Attempt identity does not match its owning Activity`);
  }
}

function assertPublicationFlow(value, state, field) {
  if (
    value.runId !== state.runId
    || value.specId !== state.specId
    || value.issue !== (state.issue ?? null)
  ) throw new Error(`${field} Flow identity does not match its owning Flow`);
}

function assertExactPublicationWrite(actualWrites, expectedWrite, field) {
  if (!Array.isArray(actualWrites) || actualWrites.length !== 1) {
    throw new Error(`${field} requires exactly one dedicated artifact write`);
  }
  const actual = actualWrites[0];
  if (
    actual?.artifact?.logicalKey !== expectedWrite.artifact.logicalKey
    || actual.artifact.relativePath !== expectedWrite.artifact.relativePath
    || actual.mediaType !== expectedWrite.mediaType
    || !Buffer.isBuffer(actual.bytes)
    || !actual.bytes.equals(expectedWrite.bytes)
  ) throw new Error(`${field} artifact bytes or authority do not match its typed publication`);
}

/**
 * Internal-only retry output admission.  Generic artifact publication never
 * carries recovery evidence: a retry transition owns both the Activity and
 * its exact route/Attempt/Flow-bound bytes in one catalog transaction.
 */
export class RetryRecoveryArtifactPublication {
  constructor({ baseline = null, receipt = null, taskReviewAuthorization = null, reconciliation = null } = {}) {
    if ((baseline === null) === (receipt === null)) {
      throw new Error("retry recovery artifact publication requires exactly one typed payload");
    }
    if (baseline !== null && !(baseline instanceof RetryRecoveryBaseline)) {
      throw new Error("retry recovery baseline publication requires a typed baseline");
    }
    if (receipt !== null && !(receipt instanceof RetryRecoveryReceipt)) {
      throw new Error("retry recovery receipt publication requires a typed receipt");
    }
    if (taskReviewAuthorization !== null && !(taskReviewAuthorization instanceof TaskReviewRecoveryAuthorization)) {
      throw new Error("Task Review recovery authorization publication requires a typed authorization");
    }
    if (taskReviewAuthorization !== null && receipt === null) {
      throw new Error("Task Review recovery authorization requires a retry recovery receipt");
    }
    this.baseline = baseline;
    this.receipt = receipt;
    this.taskReviewAuthorization = taskReviewAuthorization;
    if (reconciliation !== null && (!(reconciliation instanceof TaskReviewReconciliationRecord) || baseline === null || taskReviewAuthorization !== null)) {
      throw new Error("Task Review reconciliation requires its typed record and a new baseline only");
    }
    this.reconciliation = reconciliation;
    Object.freeze(this);
  }

  static baseline(baseline) { return new RetryRecoveryArtifactPublication({ baseline }); }
  static receipt(receipt, taskReviewAuthorization = null) { return new RetryRecoveryArtifactPublication({ receipt, taskReviewAuthorization }); }

  get artifactWrites() {
    const primary = this.baseline === null ? retryReceiptArtifact(this.receipt) : retryBaselineArtifact(this.baseline);
    if (this.reconciliation !== null) return Object.freeze([primary, this.reconciliation.artifactWrite]);
    return Object.freeze(this.taskReviewAuthorization === null
      ? [primary]
      : [primary, taskReviewAuthorizationArtifact({ taskId: this.taskReviewAuthorization.currentAttempt.nodeId.slice(0, -"-review".length), authorization: this.taskReviewAuthorization })]);
  }

  assertFor({ state, activity, artifactWrites } = {}) {
    const route = retryEvidenceRouteForNode(state, activity?.nodeId);
    if (route === null) throw new Error("retry recovery artifact publication requires a retryable owning leaf");
    if (this.baseline !== null) {
      if (this.reconciliation !== null) {
        this.reconciliation.assertPublication({ state, activity, baseline: this.baseline });
      } else if (!new Set(["start_attempt", "rewind", "recover_attempt", "retry_attempt"]).has(activity.transition.operation)) {
        throw new Error("retry recovery baseline publication requires a start, rewind, recovery, or retry Activity");
      }
      if (!this.baseline.route.equals(route)) {
        throw new Error("retry recovery baseline route does not match its owning Activity");
      }
      assertPublicationAttempt(activity, this.baseline, "retry recovery baseline");
      assertPublicationFlow(this.baseline, state, "retry recovery baseline");
      const expected = this.artifactWrites;
      if (!Array.isArray(artifactWrites) || artifactWrites.length !== expected.length) throw new Error("retry recovery publication has unexpected artifact writes");
      expected.forEach((write, index) => assertExactPublicationWrite([artifactWrites[index]], write, "retry recovery baseline"));
      return this;
    }
    if (activity.transition.operation !== "retry_recovery_attempt") {
      throw new Error("retry recovery receipt publication requires an exhausted recovery Activity");
    }
    if (!this.receipt.previous.route.equals(route) || !this.receipt.current.route.equals(route)) {
      throw new Error("retry recovery receipt route does not match its owning Activity");
    }
    assertPublicationAttempt(activity, this.receipt.current, "retry recovery receipt");
    assertPublicationFlow(this.receipt.previous, state, "retry recovery receipt previous");
    assertPublicationFlow(this.receipt.current, state, "retry recovery receipt current");
    if (
      state.attempt === null
      || state.attempt.id !== this.receipt.previous.attemptId
      || state.attempt.sequence !== this.receipt.previous.attempt
      || state.attempt.nodeId !== activity.nodeId
    ) throw new Error("retry recovery receipt previous Attempt does not match the failed active Attempt");
    const expected = [retryReceiptArtifact(this.receipt)];
    if (this.taskReviewAuthorization !== null) {
      const taskId = route.taskId;
      if (route.kind !== "review" || route.phase !== "impl" || taskId === null
        || this.taskReviewAuthorization.previousAttempt.nodeId !== activity.nodeId
        || this.taskReviewAuthorization.currentAttempt.nodeId !== activity.nodeId
        || this.taskReviewAuthorization.previousAttempt.sequence !== this.receipt.previous.attempt
        || this.taskReviewAuthorization.previousAttempt.id !== this.receipt.previous.attemptId
        || this.taskReviewAuthorization.currentAttempt.id !== this.receipt.current.attemptId
        || this.taskReviewAuthorization.currentAttempt.sequence !== this.receipt.current.attempt
        || this.taskReviewAuthorization.targetDigest !== this.receipt.current.targetDigest
        || this.taskReviewAuthorization.receiptDigest !== crypto.createHash("sha256").update(JSON.stringify(this.receipt.toJSON())).digest("hex")) {
        throw new Error("Task Review recovery authorization does not bind the retry receipt");
      }
      expected.push(taskReviewAuthorizationArtifact({ taskId, authorization: this.taskReviewAuthorization }));
    }
    if (!Array.isArray(artifactWrites) || artifactWrites.length !== expected.length) throw new Error("retry recovery publication has unexpected artifact writes");
    expected.forEach((write, index) => assertExactPublicationWrite([artifactWrites[index]], write, "retry recovery publication"));
    return this;
  }
}

/** Changed review/gate evidence required for an exhausted recovery. */
export class RetryRecoveryEvidence {
  constructor(value = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "digest,previousDigest,projectDigest,runtimeDigest,targetDigest") {
      throw new Error("changed evidence must contain only digest, previousDigest, projectDigest, runtimeDigest, and targetDigest");
    }
    this.digest = requiredDigest(value.digest, "changed evidence digest");
    this.previousDigest = requiredDigest(value.previousDigest, "previous evidence digest");
    this.projectDigest = requiredDigest(value.projectDigest, "changed evidence projectDigest");
    this.runtimeDigest = requiredDigest(value.runtimeDigest, "changed evidence runtimeDigest");
    this.targetDigest = requiredDigest(value.targetDigest, "changed evidence targetDigest");
    if (this.digest === this.previousDigest) {
      throw new Error("changed evidence must differ from the previous evidence");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      digest: this.digest,
      previousDigest: this.previousDigest,
      projectDigest: this.projectDigest,
      runtimeDigest: this.runtimeDigest,
      targetDigest: this.targetDigest,
    };
  }

  equals(other) {
    return other instanceof RetryRecoveryEvidence
      && JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }
}

export class RetryRecoveryTarget {
  constructor(value = {}) {
    this.runId = requiredText(value.runId, "retry target runId");
    this.specId = requiredText(value.specId, "retry target specId");
    this.issue = value.issue == null ? null : requiredPositiveInteger(value.issue, "retry target issue");
    Object.freeze(this);
  }

  equals(other) {
    return other instanceof RetryRecoveryTarget
      && this.runId === other.runId
      && this.specId === other.specId
      && this.issue === other.issue;
  }

  toJSON() { return { runId: this.runId, specId: this.specId, issue: this.issue }; }
}

function routeId(route) {
  return `${route.kind}-${route.phase}${route.taskId ? `-${route.taskId}` : ""}`;
}

export function readRetryBaseline(flowManager, state, route) {
  const source = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: "retry.recovery.baseline",
    parameters: { routeId: routeId(route), attemptId: state.attempt.id },
    consumerNodeId: state.attempt.nodeId,
    optional: true,
  });
  if (source === null) {
    const receipt = readRetryRecoveryReceipt(flowManager, state, route);
    return receipt === null ? null : receipt.current;
  }
  let baseline;
  try { baseline = new RetryRecoveryBaseline(JSON.parse(source.bytes.toString("utf8"))); } catch (error) { throw new Error(`retry baseline is invalid: ${error.message}`); }
  if (
    !baseline.route.equals(route)
    || baseline.attemptId !== state.attempt.id
    || baseline.attempt !== state.attempt.sequence
    || baseline.runId !== state.runId
    || baseline.specId !== state.specId
    || baseline.issue !== (state.issue ?? null)
  ) throw new Error("retry baseline identity does not match the active Attempt and Flow");
  return baseline;
}

/**
 * Read the sole receipt that can establish recovery evidence for the active
 * Attempt. A receipt is evidence only when its catalog publication belongs to
 * that exact exhausted-recovery Activity; its presence never authorizes a
 * downstream transition by itself.
 */
export function readRetryRecoveryReceipt(flowManager, state, route) {
  const source = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: "retry.recovery.receipt",
    parameters: { routeId: routeId(route), attemptId: state.attempt.id },
    consumerNodeId: state.attempt.nodeId,
    optional: true,
  });
  if (source === null) return null;
  let receipt;
  try { receipt = new RetryRecoveryReceipt(JSON.parse(source.bytes.toString("utf8"))); } catch (error) { throw new Error(`retry recovery receipt is invalid: ${error.message}`); }
  const current = receipt.current;
  if (
    !current.route.equals(route)
    || current.attemptId !== state.attempt.id
    || current.attempt !== state.attempt.sequence
    || current.runId !== state.runId
    || current.specId !== state.specId
    || current.issue !== (state.issue ?? null)
  ) throw new Error("retry recovery receipt identity does not match the active Attempt and Flow");
  const catalog = flowManager.artifactCatalog(state.specId);
  const descriptor = catalog.artifacts.find((entry) => entry.relativePath === source.relativePath) ?? null;
  if (
    descriptor === null
    || descriptor.logicalKey !== "retry.recovery.receipt"
    || descriptor.activityId === null
    || source.descriptor.logicalKey !== descriptor.logicalKey
    || source.descriptor.hash !== descriptor.hash
    || source.descriptor.activityId !== descriptor.activityId
    || crypto.createHash("sha256").update(source.bytes).digest("hex") !== descriptor.hash
  ) throw new Error("retry recovery receipt is not a catalog-published Activity artifact");
  const activities = flowManager.activityLedger(state.specId).filter((entry) => entry.id === descriptor.activityId);
  const activity = activities.length === 1 ? activities[0] : null;
  if (
    activity === null
    || activity.transition.operation !== "retry_recovery_attempt"
    || activity.nodeId !== state.attempt.nodeId
    || activity.attemptId !== current.attemptId
    || activity.sequence !== current.attempt
    || activity.transition.nodeId !== state.attempt.nodeId
    || activity.transition.attempt.id !== current.attemptId
    || activity.transition.attempt.sequence !== current.attempt
  ) throw new Error("retry recovery receipt publication Activity does not match the active Attempt");
  return receipt;
}

function canonicalState(state) {
  if (state?.schemaRevision !== 3) {
    throw new Error("retry recovery requires a Version-1 Flow");
  }
  return state;
}

function routeFor(request, state) {
  const nodeId = state.attempt?.nodeId ?? null;
  const taskStep = taskStepForStateNode(state, nodeId);
  const currentTask = taskStep === null ? null : state.findNode(taskStep.taskId);
  const taskScoped = typeof nodeId === "string"
    && currentTask !== null
    && ((request.kind === "review" && request.phase === "impl" && taskStep.role === "review")
      || (request.kind === "gate" && request.phase === "task-impl" && taskStep.role === "gate"));
  const route = RetryTargetRoute.forRecovery(request.kind, request.phase, {
    currentTaskId: taskScoped ? "active-task" : null,
  });
  if (route === null) {
    throw new Error(`retry recovery target is not defined: ${request.kind}/${request.phase}`);
  }
  return route;
}

function matchesRoute(route, nodeId, state = null) {
  if (route.stepId === nodeId) return true;
  if (typeof nodeId !== "string") return false;
  const taskStep = taskStepForStateNode(state, nodeId);
  if (route.stepId === "task-review") return taskStep?.role === "review";
  return route.stepId === "task-gate" && taskStep?.role === "gate";
}

/** Exact command input accepted by the retired-named retry CLI. */
export class RetryRecoveryInput {
  constructor(input = {}) {
    this.action = requiredText(input.action, "retry action");
    if (this.action !== "reset") throw new Error("retry action must be reset");
    this.kind = requiredText(input.kind, "retry kind");
    if (!["gate", "review"].includes(this.kind)) throw new Error("retry kind must be gate or review");
    this.phase = requiredText(input.phase, "retry phase");
    this.reason = requiredText(input.reason, "retry reason");
    if (this.reason.length < RECOVERY_REASON_MIN_LENGTH || this.reason.length > RECOVERY_REASON_MAX_LENGTH) {
      throw new Error(`retry reason must be ${RECOVERY_REASON_MIN_LENGTH}-${RECOVERY_REASON_MAX_LENGTH} characters`);
    }
    if (input.yes !== true) throw new Error("retry reset requires --yes");
    this.changedEvidence = input.changedEvidence == null
      ? null
      : new RetryRecoveryEvidence(input.changedEvidence);
    this.target = input.target == null ? null : new RetryRecoveryTarget(input.target);
    Object.freeze(this);
  }
}

/** Durable result projected from the just-appended retry Activity. */
export class CanonicalRetryRecoveryGrant {
  constructor({ request, previousAttempt, nextAttempt, activity }) {
    if (!(request instanceof RetryRecoveryInput)) throw new Error("retry grant requires RetryRecoveryInput");
    if (previousAttempt?.id == null || nextAttempt?.id == null) throw new Error("retry grant requires Attempt identities");
    if (!(activity?.transition?.operation === "retry_attempt" || activity?.transition?.operation === "retry_recovery_attempt")) {
      throw new Error("retry grant requires a retry_attempt or retry_recovery_attempt Activity");
    }
    this.kind = request.kind;
    this.phase = request.phase;
    this.previousAttemptId = previousAttempt.id;
    this.attemptId = nextAttempt.id;
    this.sequence = nextAttempt.sequence;
    this.operation = activity.transition.operation;
    this.activityId = activity.id;
    Object.freeze(this);
  }

  toJSON() {
    return {
      kind: this.kind,
      phase: this.phase,
      previousAttemptId: this.previousAttemptId,
      attemptId: this.attemptId,
      sequence: this.sequence,
      operation: this.operation,
      activityId: this.activityId,
    };
  }
}

/**
 * Deep Store operation for manual retry invocation.  The Version Store owns
 * both target validation and the Activity append; callers receive no mutable
 * state callback or filesystem authority.
 */
export class CanonicalRetryRecovery {
  constructor({ flowManager, state, request, executionRoot = null }) {
    if (!flowManager || typeof flowManager.retryCurrentAttempt !== "function" || typeof flowManager.retryExhaustedAttempt !== "function") {
      throw new Error("canonical retry recovery requires retry and exhausted-recovery FlowManager operations");
    }
    this.flowManager = flowManager;
    this.state = canonicalState(state);
    this.request = request instanceof RetryRecoveryInput ? request : new RetryRecoveryInput(request);
    this.executionRoot = executionRoot === null ? null : requiredText(executionRoot, "canonical retry recovery executionRoot");
    Object.freeze(this);
  }

  apply() {
    const before = this.flowManager.canonicalState(this.state.specId);
    if (before?.attempt?.failure === null || before?.attempt?.failure === undefined) {
      throw new Error("retry recovery requires a failed active Attempt");
    }
    const route = routeFor(this.request, before);
    if (!matchesRoute(route, before.attempt?.nodeId, before)) {
      throw new Error(`retry recovery target is not active: ${this.request.kind}/${this.request.phase}`);
    }
    const evidenceRoute = retryEvidenceRouteForNode(before, before.attempt.nodeId);
    if (evidenceRoute === null) {
      throw new Error("retry recovery target has no durable evidence route");
    }
    const previousAttempt = before.attempt;
    const start = this.flowManager.activityLedger(this.state.specId).length;
    const disposition = before.failureDisposition();
    const target = new RetryRecoveryTarget({
      runId: before.runId,
      specId: before.specId,
      issue: before.issue ?? null,
    });
    if (this.request.target !== null && !this.request.target.equals(target)) {
      throw new Error("retry recovery target does not match the active Flow identity");
    }
    if (disposition.operation === "retry") {
      this.flowManager.retryCurrentAttempt({ specId: this.state.specId });
    } else {
      const failure = previousAttempt.failure;
      const toolingFailure = failure?.retryKind === "tooling"
        || failure?.category === "tooling"
        || failure?.category === "provider";
      if (!toolingFailure || disposition.remaining !== 0 || failure?.category === "semantic" || disposition.operation === "blocked") {
        throw new Error("exhausted recovery is authorized only for tooling failures with no definition budget remaining");
      }
      if (this.request.changedEvidence === null) {
        throw new Error("exhausted retry recovery requires changed evidence");
      }
      const baseline = readRetryBaseline(this.flowManager, before, evidenceRoute);
      if (baseline === null) {
        throw new Error("exhausted retry recovery requires a durable parent-derived baseline");
      }
      if (this.request.changedEvidence.previousDigest !== baseline.digest) {
        throw new Error("changed evidence does not bind the failed Attempt baseline");
      }
      const changed = ["projectDigest", "runtimeDigest", "targetDigest"].some((field) => (
        this.request.changedEvidence[field] !== null
        && this.request.changedEvidence[field] !== baseline[field]
      ));
      if (!changed) {
        throw new Error("changed evidence is unchanged from the failed Attempt baseline");
      }
      const currentBaseline = new RetryRecoveryBaseline({
        route: baseline.route,
        attemptId: crypto.randomUUID(),
        attempt: previousAttempt.sequence + 1,
        runId: baseline.runId,
        specId: baseline.specId,
        issue: baseline.issue,
        projectDigest: this.request.changedEvidence.projectDigest,
        runtimeDigest: this.request.changedEvidence.runtimeDigest,
        targetDigest: this.request.changedEvidence.targetDigest,
      });
      const receipt = new RetryRecoveryReceipt({ previous: baseline, current: currentBaseline, reason: this.request.reason, reevaluationCount: 1 });
      let taskReviewRecoveryAuthorization = null;
      if (evidenceRoute.kind === "review" && evidenceRoute.phase === "impl" && evidenceRoute.taskId !== null && this.executionRoot !== null) {
        const checkpoint = readTaskReviewUnsealedCheckpoint({
          flowManager: this.flowManager, state: before, taskId: evidenceRoute.taskId, root: this.executionRoot,
        });
        if (checkpoint !== null) {
          checkpoint.assertTaskSource({ flowManager: this.flowManager, state: before, root: this.executionRoot });
          const fresh = captureRetryRecoveryBaseline({
            flowState: before,
            flowManager: this.flowManager,
            executionRoot: this.executionRoot,
            artifactRoot: this.flowManager.specLocation(before.specId).repositoryRoot,
            nodeId: before.attempt.nodeId,
            attempt: before.attempt,
            specPath: this.flowManager.specLocation(before.specId)?.relativeSpecFile ?? null,
          });
          if (fresh === null || fresh.targetDigest !== currentBaseline.targetDigest) {
            throw new Error("Task Review recovery authorization target does not match current checkout evidence");
          }
          taskReviewRecoveryAuthorization = TaskReviewRecoveryAuthorization.capture({
            checkpoint, receipt, targetDigest: fresh.targetDigest,
          });
        }
      }
      this.flowManager.retryExhaustedAttempt({ specId: this.state.specId, receipt, taskReviewRecoveryAuthorization });
    }
    const after = this.flowManager.canonicalState(this.state.specId);
    const activity = this.flowManager.activityLedger(this.state.specId)[start];
    return new CanonicalRetryRecoveryGrant({
      request: this.request,
      previousAttempt,
      nextAttempt: after.attempt,
      activity,
    });
  }
}

/** The definition is the only retry-budget authority in Version 1. */
export function resolveRecoveryMaxAttempts({ resolvedMax } = {}) {
  return requiredPositiveInteger(resolvedMax, "resolved retry maximum");
}

export class RetryRecoveryView {
  constructor({ kind, phase, attempts, max, recoveryReason, recoveryPossible = false, recoveryCommand = null }) {
    this.kind = requiredText(kind, "retry view kind");
    this.phase = requiredText(phase, "retry view phase");
    this.canonicalPhase = this.phase;
    this.attempts = Number.isSafeInteger(attempts) && attempts >= 0 ? attempts : 0;
    this.max = Number.isSafeInteger(max) && max >= 0 ? max : 0;
    this.recoveryPossible = recoveryPossible === true;
    this.recoveryReason = requiredText(recoveryReason, "retry view reason");
    this.changedEvidence = null;
    this.recoveryCommand = recoveryCommand == null ? null : requiredText(recoveryCommand, "retry recovery command");
    Object.freeze(this);
  }

  toJSON() {
    return {
      kind: this.kind,
      phase: this.phase,
      canonicalPhase: this.canonicalPhase,
      attempts: this.attempts,
      max: this.max,
      recoveryPossible: this.recoveryPossible,
      recoveryReason: this.recoveryReason,
      changedEvidence: this.changedEvidence,
      recoveryCommand: this.recoveryCommand,
    };
  }
}

/**
 * V1 exposes exhausted retries as definition-owned terminal decisions.  It
 * deliberately does not inspect project files for a side-channel reset.
 */
export function buildStateRetryRecoveryView({ flowState, kind, phase, attempts, max, baselineAvailable = false, currentChanged = false } = {}) {
  canonicalState(flowState);
  if (attempts < max) return null;
  const recoveryPossible = baselineAvailable === true && currentChanged === true && flowState?.attempt?.failure?.category !== "semantic";
  return new RetryRecoveryView({
    kind,
    phase,
    attempts,
    max,
    recoveryPossible,
    recoveryCommand: recoveryPossible ? `sennel flow set retry reset ${kind} ${phase} --reason "Parent-derived canonical evidence changed." --yes` : null,
    recoveryReason: "definition-owned-retry-budget-exhausted",
  }).toJSON();
}
