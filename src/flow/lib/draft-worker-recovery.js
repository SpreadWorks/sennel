import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isConditionalDraftWorkerStep } from "./draft-conditional-worker.js";
import { STEP_RESULT_REGISTRY, STEP_RESULT_TYPE, rehydrateStepResult } from "../engine/step-result.js";

export const DRAFT_WORKER_RECOVERY_OPERATION = "recover_draft_worker_execution";
export const DRAFT_STEP_ERROR_RECOVERY_OPERATION = "recover_draft_step_error";

const document = (value) => value?.toJSON?.() ?? value;

function isDraftStep(stepId) {
  return STEP_RESULT_REGISTRY.some((entry) => entry.stepId === stepId
    && entry.stepId.startsWith("draft") && entry.type === STEP_RESULT_TYPE.ERROR);
}

/** Canonical facts captured outside the explicit recovery policy. */
export class DraftExecutionRecoveryFacts {
  constructor({ state, activities, reason = null, expectedAttempt = state.attempt }) {
    const expected = document(expectedAttempt);
    if (state.attempt?.id !== expected?.id || state.attempt?.sequence !== expected?.sequence
      || state.attempt?.nodeId !== expected?.nodeId) {
      throw new DraftWorkerRecoveryRefusal("Draft recovery targets a changed Attempt");
    }
    this.state = state;
    this.activities = activities;
    this.reason = reason;
    Object.freeze(this);
  }
}

/** Durable operator authorization bound to the exact saved Error settlement. */
export class DraftStepErrorRecoveryReceipt {
  constructor({ binding, failedActivityId, failureReceiptId, reason }) {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new DraftWorkerRecoveryRefusal("Draft Step Error recovery requires a non-empty --reason describing the correction");
    }
    if (!binding || Object.keys(binding).sort().join(",") !== "attemptId,attemptSequence,runId,specId,stepId"
      || !isDraftStep(binding.stepId) || !Number.isSafeInteger(binding.attemptSequence)
      || binding.attemptSequence < 1
      || [binding.runId, binding.specId, binding.attemptId, failedActivityId, failureReceiptId]
        .some((value) => typeof value !== "string" || value.trim() === "")) {
      throw new DraftWorkerRecoveryRefusal("Draft Step Error recovery requires its exact failure binding");
    }
    this.binding = Object.freeze({ ...binding });
    this.failedActivityId = failedActivityId;
    this.failureReceiptId = failureReceiptId;
    this.reason = reason.trim();
    this.id = `draft-step-error-recovery-${createHash("sha256").update(JSON.stringify([
      binding.runId, binding.specId, binding.stepId, binding.attemptId, binding.attemptSequence,
      failedActivityId, failureReceiptId, this.reason,
    ])).digest("hex")}`;
    Object.freeze(this);
  }

  static fromJSON(value) {
    if (!value || Object.keys(value).sort().join(",") !== "binding,failedActivityId,failureReceiptId,id,reason") {
      throw new DraftWorkerRecoveryRefusal("Draft Step Error recovery receipt has an invalid schema");
    }
    const receipt = new this(value);
    if (receipt.id !== value.id) throw new DraftWorkerRecoveryRefusal("Draft Step Error recovery receipt identity is invalid");
    return receipt;
  }

  assertSource({ state, activities }) {
    const { binding } = this;
    const attempt = state.attempt;
    const failed = activities.map(document).find((entry) => entry.id === this.failedActivityId);
    const receipt = failed?.result?.draftSettlementReceipt;
    const latest = activities.map(document).filter((entry) => entry.attemptId === binding.attemptId
      && entry.sequence === binding.attemptSequence && entry.result?.draftSettlementReceipt != null).at(-1);
    if (state.runId !== binding.runId || state.specId !== binding.specId
      || state.current?.at(-1) !== binding.stepId || attempt?.nodeId !== binding.stepId
      || attempt?.id !== binding.attemptId || attempt?.sequence !== binding.attemptSequence
      || state.lifecycle.state !== "active" || state.history?.execution === "dormant"
      || attempt.failure?.category !== "step-result-error"
      || failed?.transition.operation !== "fail_attempt" || failed?.nodeId !== binding.stepId
      || failed.attemptId !== binding.attemptId || failed.sequence !== binding.attemptSequence
      || !isDeepStrictEqual(failed.failure, document(attempt.failure))
      || receipt?.id !== this.failureReceiptId || receipt.settlementKind !== "failure"
      || !isDeepStrictEqual(receipt.binding, binding) || latest?.id !== failed.id
      || rehydrateStepResult(binding.stepId, failed.result.stepResult).type !== STEP_RESULT_TYPE.ERROR) {
      throw new DraftWorkerRecoveryRefusal("Draft Step Error recovery requires the current exact saved failure receipt");
    }
  }

  assertTransition({ state, activities, activity, attempt }) {
    this.assertSource({ state, activities });
    const previous = document(state.attempt);
    const replacement = document(attempt);
    const expected = { ...previous, id: replacement.id, startedAt: replacement.startedAt,
      sequence: previous.sequence + 1, failure: null, blocker: null, incomplete: [] };
    if (activity.id !== this.id || replacement.id === previous.id
      || !isDeepStrictEqual(replacement, expected)) {
      throw new DraftWorkerRecoveryRefusal("Draft Step Error recovery must start the same Step with unchanged retry consumption and resource claims");
    }
  }

  toJSON() {
    return { id: this.id, binding: { ...this.binding }, failedActivityId: this.failedActivityId,
      failureReceiptId: this.failureReceiptId, reason: this.reason };
  }
}

/** Explicit Definition decision; automatic Step Error execution stays blocked. */
export class DraftStepErrorRecoveryDecision {
  constructor(facts) {
    const { state, activities, reason } = facts;
    const failed = activities.map(document).findLast((entry) => entry.nodeId === state.current?.at(-1)
      && entry.attemptId === state.attempt?.id && entry.sequence === state.attempt?.sequence
      && entry.transition.operation === "fail_attempt");
    this.receipt = new DraftStepErrorRecoveryReceipt({
      binding: failed?.result?.draftSettlementReceipt?.binding,
      failedActivityId: failed?.id,
      failureReceiptId: failed?.result?.draftSettlementReceipt?.id,
      reason,
    });
    this.receipt.assertSource(facts);
    this.stepId = this.receipt.binding.stepId;
    Object.freeze(this);
  }
}

export function resolveDraftExecutionRecovery(facts) {
  if (!(facts instanceof DraftExecutionRecoveryFacts)) throw new TypeError("Draft recovery requires typed canonical facts");
  return facts.state.attempt?.failure?.category === "step-result-error"
    ? new DraftStepErrorRecoveryDecision(facts)
    : resolveDraftWorkerRecovery(facts);
}

export class DraftWorkerRecoveryRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "DraftWorkerRecoveryRefusal";
    this.code = "FLOW_DRAFT_EXECUTION_RECOVERY_INELIGIBLE";
  }
}

/** The retained, unpublished execution lineage authorizing an explicit recovery. */
export class DraftWorkerRecoveryDecision {
  constructor({ state, activities }) {
    const stepId = state.current?.at(-1);
    const attempt = document(state.attempt);
    if (!isConditionalDraftWorkerStep(stepId) || attempt?.nodeId !== stepId
      || (attempt.failure !== null && (attempt.failure?.category !== "tooling"
        || attempt.failure.code !== "FLOW_DRAFT_EXECUTION_INPUT_STALE"
        || attempt.failure.retryable !== false))
      || state.lifecycle.state !== "active"
      || state.history?.execution === "dormant") {
      throw new DraftWorkerRecoveryRefusal("Draft execution recovery requires an active conditional Attempt with no failure or its retained INPUT_STALE failure");
    }
    const history = activities.map(document).filter((entry) => entry.nodeId === stepId
      && entry.attemptId === attempt.id && entry.sequence === attempt.sequence);
    const executions = history.filter((entry) => entry.result?.draftSettlementReceipt?.executionLifecycle != null);
    const checkpointActivity = executions.at(-1);
    const claimActivity = executions.at(-2);
    const checkpointReceipt = checkpointActivity?.result.draftSettlementReceipt;
    const claimedReceipt = claimActivity?.result.draftSettlementReceipt;
    const checkpoint = checkpointReceipt?.executionLifecycle;
    const claimed = claimedReceipt?.executionLifecycle;
    if (checkpoint?.phase !== "checkpoint" || checkpoint.binding.kind !== "worker"
      || checkpoint.claim !== null || claimed?.phase !== "claimed"
      || claimed.binding.kind !== "worker" || claimed.claim?.kind !== "worker"
      || checkpoint.binding.executionGeneration !== claimed.binding.executionGeneration + 1
      || checkpoint.binding.inputDigest !== claimed.binding.inputDigest
      || checkpoint.binding.inputRevision !== claimed.binding.inputRevision
      || checkpointReceipt.settlementKind !== "execution"
      || !isDeepStrictEqual(checkpointReceipt.binding, claimedReceipt.binding)
      || !isDeepStrictEqual(checkpointActivity.result.stepResult, claimActivity.result.stepResult)) {
      throw new DraftWorkerRecoveryRefusal("Draft execution recovery requires an unpublished rejected claim and its exact legacy checkpoint");
    }
    const binding = checkpointReceipt.binding;
    if (binding.runId !== state.runId || binding.specId !== state.specId
      || binding.stepId !== stepId || binding.attemptId !== attempt.id
      || binding.attemptSequence !== attempt.sequence) {
      throw new DraftWorkerRecoveryRefusal("Draft execution recovery lineage belongs to another Flow or Attempt");
    }
    const failures = history.filter((entry) => entry.transition.operation === "fail_attempt");
    const failureMatches = attempt.failure === null ? failures.length === 0
      : failures.length === 1 && failures[0].confirmationOrder > checkpointActivity.confirmationOrder
        && isDeepStrictEqual(failures[0].failure, attempt.failure);
    if (!failureMatches
      || history.some((entry) => entry.transition.operation === DRAFT_WORKER_RECOVERY_OPERATION)) {
      throw new DraftWorkerRecoveryRefusal("Draft execution recovery requires its retained checkpoint with no failure or exactly its subsequent stale failure");
    }
    this.stepId = stepId;
    this.checkpointReceipt = Object.freeze(structuredClone(checkpointReceipt));
    this.claim = Object.freeze(structuredClone(claimed.claim));
    this.activityId = `draft-worker-recovery-${createHash("sha256").update(JSON.stringify([
      state.runId, state.specId, attempt.id, attempt.sequence,
      checkpointActivity.id, claimActivity.id, failures[0]?.id ?? null,
    ])).digest("hex")}`;
    Object.freeze(this);
  }

  assertTransition({ activityId, previousAttempt, attempt, receipt }) {
    const lifecycle = receipt?.executionLifecycle;
    const old = this.checkpointReceipt;
    const { id: priorId, executionLifecycle: priorLifecycle, ...priorSelection } = old;
    const { id: nextId, executionLifecycle: nextLifecycle, ...nextSelection } = document(receipt) ?? {};
    if (activityId !== this.activityId
      || !isDeepStrictEqual(document(attempt), { ...document(previousAttempt), failure: null })
      || !isDeepStrictEqual(nextSelection, priorSelection)
      || lifecycle?.phase !== "checkpoint" || lifecycle.claim !== null
      || lifecycle.binding.kind !== "conditional-worker"
      || lifecycle.binding.executionGeneration !== old.executionLifecycle.binding.executionGeneration + 1
      || lifecycle.binding.inputDigest !== old.executionLifecycle.binding.inputDigest
      || lifecycle.binding.inputRevision !== old.executionLifecycle.binding.inputRevision) {
      throw new DraftWorkerRecoveryRefusal("Draft execution recovery must preserve its exact Attempt and migrate only the proven checkpoint");
    }
  }
}

export function resolveDraftWorkerRecovery(facts) {
  return new DraftWorkerRecoveryDecision(facts);
}
