import { DEFAULT_AGENT_PROCESS_TREE_GRACE_MS } from "./agent-timeout.js";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { executionUuid } from "./process-execution-values.js";

// hrtime has the same monotonic origin in the coordinator and its launcher.
export function managedMonotonicNow() { return Number(process.hrtime.bigint()) / 1e6; }

/** One durable stop deadline, shared by communication, signaling and proof. */
export class ManagedStopOperation {
  constructor({ requestId, reason, graceMs, startedAt, deadline }) {
    this.requestId = executionUuid(requestId, "Managed stop request ID");
    if (typeof reason !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(reason)) throw new TypeError("Managed stop reason is invalid");
    if (!Number.isFinite(graceMs) || graceMs <= 0) throw new TypeError("Managed stop grace must be positive and finite");
    if (!Number.isFinite(startedAt) || startedAt < 0 || !Number.isFinite(deadline) || deadline <= startedAt
      || deadline - startedAt > Math.min(14000, graceMs * 2 + 2000) + 0.001) {
      throw new TypeError("Managed stop deadline exceeds its finite operation budget");
    }
    this.reason = reason; this.graceMs = graceMs; this.startedAt = startedAt; this.deadline = deadline;
    Object.freeze(this);
  }
  static begin({ reason = "recovery", graceMs = DEFAULT_AGENT_PROCESS_TREE_GRACE_MS, now = managedMonotonicNow() } = {}) {
    return new this({ requestId: crypto.randomUUID(), reason, graceMs, startedAt: now, deadline: now + Math.min(14000, graceMs * 2 + 2000) });
  }
  static fromStored(value) {
    if (value === null || typeof value !== "object" || Object.keys(value).length !== 5
      || ["requestId", "reason", "graceMs", "startedAt", "deadline"].some((key) => !Object.hasOwn(value, key))) {
      throw new TypeError("Managed stop operation has missing or unknown fields");
    }
    return new this(value);
  }
  static fromPayload({ requestId, reason, graceMs, startedAt, stopDeadline }) {
    return new this({ requestId, reason, graceMs, startedAt, deadline: stopDeadline });
  }
  remainingMs(now = managedMonotonicNow()) { return Math.max(0, this.deadline - now); }
  matches(other) { return other instanceof ManagedStopOperation && isDeepStrictEqual(this.toJSON(), other.toJSON()); }
  toPayload() { return { requestId: this.requestId, reason: this.reason, graceMs: this.graceMs, startedAt: this.startedAt, stopDeadline: this.deadline }; }
  toJSON() { return { requestId: this.requestId, reason: this.reason, graceMs: this.graceMs, startedAt: this.startedAt, deadline: this.deadline }; }
}
