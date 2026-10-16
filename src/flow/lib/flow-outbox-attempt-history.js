import { isDeepStrictEqual } from "node:util";
import { hasFinalizationStepContract } from "../engine/step-result.js";
import { FlowExecutionObservationBinding } from "../../lib/flow-execution-observation.js";

function outcome(activity) {
  const operation = activity.transition.operation;
  const outbox = activity.transition.outbox;
  if (operation === "complete_outbox"
    || ["confirm_attempt", "record_draft_step_settlement"].includes(operation)
      && (activity.nodeId === "report" || hasFinalizationStepContract(activity.nodeId)) && outbox.result !== null) return "done";
  if (["fail_outbox", "recover_interrupted_finalize_sync"].includes(operation)
    || hasFinalizationStepContract(activity.nodeId) && outbox.failure !== null) return "failed";
  return "pending";
}

export class CurrentFlowOutboxAttempt {
  constructor(activities) {
    if (!Array.isArray(activities) || activities.length === 0) throw new TypeError("Outbox Attempt requires its Activities");
    const first = activities[0].transition.outbox;
    const latest = activities.at(-1);
    const beginning = activities.find((activity) => ["begin_outbox", "reopen_outbox"].includes(activity.transition.operation));
    this.id = first.id;
    this.operation = first.operation;
    this.attempt = first.attempt;
    const binding = beginning?.transition.outbox.executionBinding ?? null;
    this.executionBinding = binding === null ? null : binding instanceof FlowExecutionObservationBinding
      ? binding : FlowExecutionObservationBinding.fromJSON(binding);
    this.executionBinding?.assertOutboxAttempt(this.id, this.attempt);
    for (const activity of activities) {
      const recorded = activity.transition.outbox;
      if (recorded.id !== this.id || recorded.operation !== this.operation || recorded.attempt !== this.attempt) throw new TypeError("Outbox Attempt identity differs between Activities");
      if (recorded.executionBinding != null && this.executionBinding !== null
        && !isDeepStrictEqual(recorded.executionBinding.toJSON?.() ?? recorded.executionBinding, this.executionBinding.toJSON())) throw new TypeError("Outbox Attempt changed its starting binding");
    }
    this.outboxAttemptId = this.executionBinding?.outboxAttemptId ?? null;
    this.status = outcome(latest);
    this.startedAt = beginning?.timing?.startedAt ?? null;
    this.updatedAt = latest.timing?.finishedAt ?? latest.result?.confirmedAt ?? null;
    this.result = latest.transition.outbox.result?.toJSON?.() ?? latest.transition.outbox.result ?? null;
    this.failure = latest.transition.outbox.failure;
    this.exactRecoveryReceipt = latest.transition.outbox.exactRecoveryReceipt?.toJSON?.() ?? latest.transition.outbox.exactRecoveryReceipt ?? null;
    this.failureHistory = Object.freeze(activities.filter((activity) => outcome(activity) === "failed").map((activity) => Object.freeze({
      attempt: this.attempt, failure: activity.transition.outbox.failure,
      recordedAt: activity.timing?.finishedAt ?? null, code: activity.transition.outbox.failureCode,
      recovery: activity.transition.outbox.recovery?.toJSON?.() ?? activity.transition.outbox.recovery ?? null,
    })));
    this.activityId = latest.id;
    this.sourceActivityIds = Object.freeze(activities.map((activity) => activity.id));
    Object.freeze(this);
  }
  toJSON() { return { ...this, executionBinding: this.executionBinding?.toJSON() ?? null }; }
}

/** One canonical aggregation shared by operational status and historical query. */
export class CurrentFlowOutboxAttemptHistory {
  constructor(activities) {
    const groups = new Map();
    const operations = new Map();
    for (const activity of activities) {
      const outbox = activity.transition.outbox;
      if (outbox === null) continue;
      if (operations.has(outbox.id) && operations.get(outbox.id) !== outbox.operation) throw new TypeError("Canonical outbox id cannot change its operation");
      operations.set(outbox.id, outbox.operation);
      const key = JSON.stringify([outbox.id, outbox.attempt]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(activity);
    }
    this.attempts = Object.freeze([...groups.values()].map((entries) => new CurrentFlowOutboxAttempt(entries)));
    Object.freeze(this);
  }
  static fromActivities(activities) { return new this(activities); }
  status({ id, operation, active = null }) {
    const matching = this.attempts.filter((attempt) => attempt.id === id);
    if (matching.some((attempt) => attempt.operation !== operation) || active !== null && active.operation !== operation) throw new TypeError("Canonical outbox id cannot change its operation");
    const latest = matching.at(-1);
    return Object.freeze({ id, operation, status: active !== null ? "pending" : latest?.status ?? "missing",
      attempt: latest?.attempt ?? 0, startedAt: latest?.startedAt ?? null, updatedAt: latest?.updatedAt ?? null,
      failure: latest?.failure ?? null, failureHistory: Object.freeze(matching.flatMap((attempt) => attempt.failureHistory)),
      exactRecoveryReceipt: latest?.exactRecoveryReceipt ?? null, result: latest?.result ?? null,
      activityId: latest?.activityId ?? null, executionBinding: latest?.executionBinding?.toJSON() ?? null,
      outboxAttemptId: latest?.outboxAttemptId ?? null });
  }
  toJSON() { return this.attempts.map((attempt) => attempt.toJSON()); }
}
