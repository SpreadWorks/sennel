import { requireString } from "./flow-value-assertions.js";

export class FlowOutboxIdentity {
  constructor({ runId, taskId = null, stepId, operation, idempotencyKey = null }) {
    this.runId = requireString(runId, "outbox runId");
    if (taskId != null) requireString(taskId, "outbox taskId");
    this.taskId = taskId;
    this.stepId = requireString(stepId, "outbox stepId");
    this.operation = requireString(operation, "outbox operation");
    const segments = ["flow-outbox-v1", this.runId, this.taskId ?? "flow", this.stepId, this.operation];
    const derivedKey = segments.map((segment) => encodeURIComponent(segment)).join(":");
    if (idempotencyKey != null && idempotencyKey !== derivedKey) {
      throw new Error("outbox idempotencyKey does not match its identity");
    }
    this.idempotencyKey = derivedKey;
    Object.freeze(this);
  }

  equals(other) {
    return other instanceof FlowOutboxIdentity && this.idempotencyKey === other.idempotencyKey;
  }

  toJSON() {
    return {
      idempotencyKey: this.idempotencyKey,
      runId: this.runId,
      taskId: this.taskId,
      stepId: this.stepId,
      operation: this.operation,
    };
  }

  static fromStored(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("stored outbox identity must be an object");
    }
    return new FlowOutboxIdentity(value);
  }
}
