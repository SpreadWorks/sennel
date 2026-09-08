import {
  CurrentAttemptIdentity,
  CurrentFlowState,
} from "./current-flow-state.js";

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function exactObject(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has invalid fields`);
  }
  return value;
}

/**
 * Child-process capability for one active Task Review Attempt.
 *
 * The parent derives this only from the canonical Store. The worker receives
 * the serialized value as an execution input, so projected Flow views never
 * become an accidental source of lifecycle identity.
 */
export class TaskReviewExecutionIdentity {
  constructor({ taskId, attempt, reviewAttempt } = {}) {
    this.taskId = requiredText(taskId, "Task Review execution taskId");
    this.attempt = CurrentAttemptIdentity.from(attempt);
    if (this.attempt.nodeId !== `${this.taskId}-review`) {
      throw new Error("Task Review execution Attempt does not match its Task");
    }
    if (!Number.isSafeInteger(reviewAttempt) || reviewAttempt < 1 || reviewAttempt > 4) {
      throw new Error("Task Review execution reviewAttempt must be between 1 and 4");
    }
    this.reviewAttempt = reviewAttempt;
    Object.freeze(this);
  }

  static fromCanonicalState({ state, taskId, reviewAttempt } = {}) {
    if (!(state instanceof CurrentFlowState)) {
      throw new Error("Task Review execution requires a canonical Flow state");
    }
    const identity = new TaskReviewExecutionIdentity({ taskId, attempt: state.attempt, reviewAttempt });
    if (!identity.attempt.matches(state)) {
      throw new Error("Task Review execution requires its active canonical Attempt");
    }
    return identity;
  }

  static fromJSON(value) {
    const document = exactObject(value, ["taskId", "attempt", "reviewAttempt"], "Task Review execution identity");
    exactObject(document.attempt, ["id", "nodeId", "sequence"], "Task Review execution Attempt");
    return new TaskReviewExecutionIdentity(document);
  }

  assertTask(taskId) {
    if (this.taskId !== requiredText(taskId, "Task Review execution Task")) {
      throw new Error("Task Review execution identity does not match canonical Task inputs");
    }
  }

  toJSON() {
    return Object.freeze({ taskId: this.taskId, attempt: this.attempt.toJSON(), reviewAttempt: this.reviewAttempt });
  }
}
