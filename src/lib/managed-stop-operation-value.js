import { isDeepStrictEqual } from "node:util";
import { executionUuid } from "./process-execution-values.js";

/** Persisted stop facts; interpreting a deadline requires an explicit clock. */
export class ManagedStopOperationValue {
  constructor({ requestId, reason, graceMs, startedAt, deadline, clockSessionId }) {
    this.requestId = executionUuid(requestId, "Managed stop request ID");
    this.clockSessionId = executionUuid(clockSessionId, "Managed stop clock session ID");
    if (typeof reason !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(reason)) throw new TypeError("Managed stop reason is invalid");
    if (!Number.isFinite(graceMs) || graceMs <= 0) throw new TypeError("Managed stop grace must be positive and finite");
    if (!Number.isFinite(startedAt) || startedAt < 0 || !Number.isFinite(deadline) || deadline <= startedAt
      || deadline - startedAt > Math.min(14000, graceMs * 2 + 2000) + 0.001) {
      throw new TypeError("Managed stop deadline exceeds its finite operation budget");
    }
    this.reason = reason; this.graceMs = graceMs; this.startedAt = startedAt; this.deadline = deadline;
    Object.freeze(this);
  }
  static fromStored(value) {
    if (value === null || typeof value !== "object" || Object.keys(value).length !== 6
      || ["requestId", "reason", "graceMs", "startedAt", "deadline", "clockSessionId"].some((key) => !Object.hasOwn(value, key))) {
      throw new TypeError("Managed stop operation has missing or unknown fields");
    }
    return new ManagedStopOperationValue(value);
  }
  static fromPayload({ requestId, reason, graceMs, startedAt, stopDeadline, clockSessionId }) {
    return new ManagedStopOperationValue({ requestId, reason, graceMs, startedAt, deadline: stopDeadline, clockSessionId });
  }
  remainingMs(now, clockSessionId) {
    if (clockSessionId !== this.clockSessionId) {
      const error = new Error("Managed stop deadline belongs to an unavailable coordinator clock session");
      error.code = "PROCESS_EXECUTION_CLOCK_SESSION_UNKNOWN";
      throw error;
    }
    if (!Number.isFinite(now) || now < 0) throw new TypeError("Stop deadline interpretation requires a monotonic clock observation");
    return Math.max(0, this.deadline - now);
  }
  matches(other) { return other instanceof ManagedStopOperationValue && isDeepStrictEqual(this.toJSON(), other.toJSON()); }
  toPayload() { return { requestId: this.requestId, reason: this.reason, graceMs: this.graceMs, startedAt: this.startedAt, stopDeadline: this.deadline, clockSessionId: this.clockSessionId }; }
  toJSON() { return { requestId: this.requestId, reason: this.reason, graceMs: this.graceMs, startedAt: this.startedAt, deadline: this.deadline, clockSessionId: this.clockSessionId }; }
}
