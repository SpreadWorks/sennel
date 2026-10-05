import crypto from "node:crypto";

export const TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION = "recover_task_gate_classification";

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

/** Stable identity for one audited correction of a post-publication Task Gate classification. */
export class TaskGateClassificationRecoveryIdentity {
  constructor({ publicationActivityId, failedActivityId, attempt } = {}) {
    this.publicationActivityId = requiredText(publicationActivityId, "Task Gate classification recovery publication Activity id");
    this.failedActivityId = requiredText(failedActivityId, "Task Gate classification recovery failed Activity id");
    this.attempt = Object.freeze({
      id: requiredText(attempt?.id, "Task Gate classification recovery Attempt id"),
      sequence: positiveInteger(attempt?.sequence, "Task Gate classification recovery Attempt sequence"),
    });
    this.activityId = `task-gate-classification-recovery-${crypto.createHash("sha256")
      .update(JSON.stringify({
        publicationActivityId: this.publicationActivityId,
        failedActivityId: this.failedActivityId,
        attempt: this.attempt,
      }))
      .digest("hex")}`;
    Object.freeze(this);
  }

  toJSON() {
    return {
      publicationActivityId: this.publicationActivityId,
      failedActivityId: this.failedActivityId,
      attempt: { ...this.attempt },
      activityId: this.activityId,
    };
  }
}
