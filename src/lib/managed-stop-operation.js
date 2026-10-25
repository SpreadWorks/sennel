import { DEFAULT_REGISTERED_CHILD_GRACE_MS } from "./agent-timeout.js";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { ManagedStopOperationValue } from "./managed-stop-operation-value.js";

/** A monotonic number is meaningful only in the session that measured it. */
export const MANAGED_CLOCK_SESSION_ID = crypto.randomUUID();
export function managedMonotonicNow() { return performance.now(); }

/** The live interpreter supplies this coordinator's clock, never a peer's. */
export class ManagedStopOperation extends ManagedStopOperationValue {
  static fromStored(value) { return new ManagedStopOperation(ManagedStopOperationValue.fromStored(value)); }
  static fromPayload(value) { return new ManagedStopOperation(ManagedStopOperationValue.fromPayload(value)); }
  static begin({ reason = "recovery", graceMs = DEFAULT_REGISTERED_CHILD_GRACE_MS, now = managedMonotonicNow(), clockSessionId = MANAGED_CLOCK_SESSION_ID } = {}) {
    return new ManagedStopOperation({ requestId: crypto.randomUUID(), reason, graceMs, startedAt: now,
      deadline: now + Math.min(14000, graceMs * 2 + 2000), clockSessionId });
  }
  remainingMs(now = managedMonotonicNow(), clockSessionId = MANAGED_CLOCK_SESSION_ID) {
    return super.remainingMs(now, clockSessionId);
  }
}
