const OUTBOX_STATUSES = new Set(["pending", "done", "failed"]);
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,199}$/;

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireTimestamp(value, field) {
  requireString(value, field);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`);
  return value;
}

function cloneJson(value) {
  if (value === undefined) return null;
  return structuredClone(value);
}

function optionalFailureCode(value) {
  if (value == null) return null;
  const code = requireString(value, "outbox failure code");
  if (!FAILURE_CODE.test(code)) throw new Error("outbox failure code is invalid");
  return code;
}

export class PreSyncRebaseRecovery {
  constructor({ baseRef, baseHead }) {
    this.baseRef = requireString(baseRef, "pre-sync recovery baseRef");
    this.baseHead = requireString(baseHead, "pre-sync recovery baseHead");
    if (!GIT_OBJECT_ID.test(this.baseHead)) throw new Error("pre-sync recovery baseHead is invalid");
    Object.freeze(this);
  }

  toJSON() {
    return { baseRef: this.baseRef, baseHead: this.baseHead };
  }

  static fromStored(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("stored pre-sync recovery must be an object");
    }
    return new PreSyncRebaseRecovery(value);
  }

  static fromError(error) {
    if (error?.code !== "MERGE_PRE_SYNC_CONFLICT" || error?.data?.recovery == null) return null;
    return PreSyncRebaseRecovery.fromStored(error.data.recovery);
  }
}

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

export class FlowOutboxRecoveryReceipt {
  constructor({ idempotencyKey, attempt, failure, recoveryKey = null }) {
    this.idempotencyKey = requireString(idempotencyKey, "exact recovery receipt idempotencyKey");
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error("exact recovery receipt attempt must be a positive integer");
    }
    this.attempt = attempt;
    this.failure = requireString(failure, "exact recovery receipt failure");
    this.recoveryKey = recoveryKey == null ? null : requireString(recoveryKey, "exact recovery receipt recoveryKey");
    Object.freeze(this);
  }

  toJSON() {
    return {
      idempotencyKey: this.idempotencyKey,
      attempt: this.attempt,
      failure: this.failure,
      ...(this.recoveryKey != null ? { recoveryKey: this.recoveryKey } : {}),
    };
  }

  static fromStored(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("stored exact recovery receipt must be an object");
    }
    return new FlowOutboxRecoveryReceipt(value);
  }
}

export class FlowOutboxFailure {
  constructor({ attempt, failure, recordedAt, code = null, recovery = null }) {
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error("outbox failure attempt must be a positive integer");
    }
    this.attempt = attempt;
    this.failure = requireString(failure, "outbox failure history message");
    this.recordedAt = requireTimestamp(recordedAt, "outbox failure history timestamp");
    this.code = optionalFailureCode(code);
    this.recovery = recovery == null ? null : (
      recovery instanceof PreSyncRebaseRecovery ? recovery : PreSyncRebaseRecovery.fromStored(recovery)
    );
    if (this.recovery != null && this.code !== "MERGE_PRE_SYNC_CONFLICT") {
      throw new Error("pre-sync recovery is reserved for merge pre-sync conflicts");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      attempt: this.attempt,
      failure: this.failure,
      recordedAt: this.recordedAt,
      ...(this.code != null ? { code: this.code } : {}),
      ...(this.recovery != null ? { recovery: this.recovery.toJSON() } : {}),
    };
  }

  static fromStored(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("stored outbox failure history must be an object");
    }
    return new FlowOutboxFailure(value);
  }

  static fromError({ attempt, error, recordedAt }) {
    const code = typeof error?.code === "string" && FAILURE_CODE.test(error.code)
      ? error.code
      : null;
    return new FlowOutboxFailure({
      attempt,
      failure: error instanceof Error ? error.message : String(error || "side effect failed"),
      recordedAt,
      code,
      recovery: PreSyncRebaseRecovery.fromError(error),
    });
  }
}

export class FlowOutboxEntry {
  constructor({
    identity,
    status,
    attempt,
    startedAt,
    updatedAt,
    result = null,
    failure = null,
    failureHistory = [],
    exactRecoveryReceipt = null,
  }) {
    if (!(identity instanceof FlowOutboxIdentity)) throw new Error("outbox identity is required");
    if (!OUTBOX_STATUSES.has(status)) throw new Error(`invalid outbox status: ${status}`);
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("outbox attempt must be a positive integer");
    requireTimestamp(startedAt, "outbox startedAt");
    requireTimestamp(updatedAt, "outbox updatedAt");
    if (status === "pending" && (result != null || failure != null)) {
      throw new Error("pending outbox entry cannot retain a result or failure");
    }
    if (status === "done" && failure != null) throw new Error("done outbox entry cannot retain a failure");
    if (status === "failed") requireString(failure, "outbox failure");
    if (!Array.isArray(failureHistory)) throw new Error("outbox failure history must be an array");
    if (exactRecoveryReceipt != null && !(exactRecoveryReceipt instanceof FlowOutboxRecoveryReceipt)) {
      throw new Error("outbox exact recovery receipt must be a FlowOutboxRecoveryReceipt");
    }
    this.identity = identity;
    this.status = status;
    this.attempt = attempt;
    this.startedAt = startedAt;
    this.updatedAt = updatedAt;
    this.result = cloneJson(result);
    this.failure = failure;
    this.failureHistory = failureHistory.map((entry) => (
      entry instanceof FlowOutboxFailure ? entry : FlowOutboxFailure.fromStored(entry)
    ));
    this.exactRecoveryReceipt = exactRecoveryReceipt;
    Object.freeze(this);
  }

  get idempotencyKey() {
    return this.identity.idempotencyKey;
  }

  get latestFailure() {
    return this.failureHistory.at(-1) || null;
  }

  retry(at) {
    if (this.status === "done" || this.status === "pending") return this;
    return new FlowOutboxEntry({
      identity: this.identity,
      status: "pending",
      attempt: this.attempt + 1,
      startedAt: requireTimestamp(at, "outbox retry timestamp"),
      updatedAt: at,
      failureHistory: this.failureHistory,
      exactRecoveryReceipt: this.exactRecoveryReceipt,
    });
  }

  touch(at) {
    if (this.status !== "pending") return this;
    const requestedAt = requireTimestamp(at, "outbox touch timestamp");
    const updatedAt = Date.parse(requestedAt) > Date.parse(this.updatedAt)
      ? requestedAt
      : new Date(Date.parse(this.updatedAt) + 1).toISOString();
    return new FlowOutboxEntry({
      identity: this.identity,
      status: "pending",
      attempt: this.attempt,
      startedAt: this.startedAt,
      updatedAt,
      failureHistory: this.failureHistory,
      exactRecoveryReceipt: this.exactRecoveryReceipt,
    });
  }

  complete(result, at) {
    if (this.status === "done") return this;
    if (this.status !== "pending") throw new Error("failed outbox entry must begin a retry before completion");
    return new FlowOutboxEntry({
      identity: this.identity,
      status: "done",
      attempt: this.attempt,
      startedAt: this.startedAt,
      updatedAt: requireTimestamp(at, "outbox completion timestamp"),
      result,
      failureHistory: this.failureHistory,
      exactRecoveryReceipt: this.exactRecoveryReceipt,
    });
  }

  fail(error, at) {
    if (this.status === "done") return this;
    return new FlowOutboxEntry({
      identity: this.identity,
      status: "failed",
      attempt: this.attempt,
      startedAt: this.startedAt,
      updatedAt: requireTimestamp(at, "outbox failure timestamp"),
      failure: error instanceof Error ? error.message : String(error || "side effect failed"),
      failureHistory: [...this.failureHistory, FlowOutboxFailure.fromError({
        attempt: this.attempt,
        error,
        recordedAt: at,
      })],
      exactRecoveryReceipt: this.exactRecoveryReceipt,
    });
  }

  toJSON() {
    return {
      ...this.identity.toJSON(),
      status: this.status,
      attempt: this.attempt,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      ...(this.status === "done" ? { result: cloneJson(this.result) } : {}),
      ...(this.status === "failed" ? { failure: this.failure } : {}),
      ...(this.failureHistory.length > 0 ? { failureHistory: this.failureHistory.map((entry) => entry.toJSON()) } : {}),
      ...(this.exactRecoveryReceipt ? { exactRecoveryReceipt: this.exactRecoveryReceipt.toJSON() } : {}),
    };
  }

  static fromStored(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("stored outbox entry must be an object");
    }
    return new FlowOutboxEntry({
      ...value,
      identity: FlowOutboxIdentity.fromStored(value),
      exactRecoveryReceipt: value.exactRecoveryReceipt == null
        ? null
        : FlowOutboxRecoveryReceipt.fromStored(value.exactRecoveryReceipt),
    });
  }
}

export class FlowOutboxRecoveryClaim {
  constructor({ identity, attempt, failure, recoveryKey = null }) {
    if (!(identity instanceof FlowOutboxIdentity)) throw new Error("exact recovery identity is required");
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error("exact recovery attempt must be a positive integer");
    }
    this.identity = identity;
    this.attempt = attempt;
    this.failure = requireString(failure, "exact recovery failure");
    this.recoveryKey = recoveryKey == null ? null : requireString(recoveryKey, "exact recovery recoveryKey");
    Object.freeze(this);
  }

  reopen(entry, at) {
    if (!(entry instanceof FlowOutboxEntry) || !entry.identity.equals(this.identity)) {
      throw new Error("exact recovery target does not match the outbox entry");
    }
    if (entry.status !== "failed") throw new Error("exact recovery requires a failed outbox entry");
    if (
      entry.exactRecoveryReceipt
      && (
        this.recoveryKey == null
        || entry.exactRecoveryReceipt.recoveryKey === this.recoveryKey
      )
    ) {
      throw new Error("exact recovery was already consumed for this outbox entry");
    }
    if (entry.attempt !== this.attempt) throw new Error("exact recovery attempt does not match the outbox entry");
    if (entry.failure !== this.failure) throw new Error("exact recovery failure does not match the outbox entry");
    const updatedAt = requireTimestamp(at, "exact recovery timestamp");
    return new FlowOutboxEntry({
      identity: entry.identity,
      status: "pending",
      attempt: entry.attempt,
      startedAt: entry.startedAt,
      updatedAt,
      exactRecoveryReceipt: new FlowOutboxRecoveryReceipt({
        idempotencyKey: this.identity.idempotencyKey,
        attempt: this.attempt,
        failure: this.failure,
        recoveryKey: this.recoveryKey,
      }),
    });
  }
}

export class FlowOutboxRecoveryRequiredError extends Error {
  constructor(entry) {
    if (!(entry instanceof FlowOutboxEntry) || entry.status !== "failed") {
      throw new Error("failed FlowOutboxEntry is required");
    }
    super(`Outbox operation ${entry.identity.stepId} is blocked by its unchanged failed entry: ${entry.failure}`);
    this.name = "FlowOutboxRecoveryRequiredError";
    this.code = "FINALIZATION_OUTBOX_RECOVERY_REQUIRED";
    this.retryable = false;
    this.recoveryHint = "Refresh next-action and use only the exact or durable recovery authorized for this outbox identity.";
    this.idempotencyKey = entry.idempotencyKey;
    this.attempt = entry.attempt;
    this.data = Object.freeze({
      retryable: false,
      recoveryHint: this.recoveryHint,
      idempotencyKey: this.idempotencyKey,
      attempt: this.attempt,
    });
  }
}

export class FlowOutbox {
  constructor(entries = []) {
    if (!Array.isArray(entries)) throw new Error("flow outbox must be an array");
    this.entries = entries.map((entry) => (
      entry instanceof FlowOutboxEntry ? entry : FlowOutboxEntry.fromStored(entry)
    ));
    const keys = new Set();
    for (const entry of this.entries) {
      if (keys.has(entry.idempotencyKey)) throw new Error(`duplicate outbox identity: ${entry.idempotencyKey}`);
      keys.add(entry.idempotencyKey);
    }
  }

  find(identity) {
    if (!(identity instanceof FlowOutboxIdentity)) throw new Error("outbox identity is required");
    return this.entries.find((entry) => entry.identity.equals(identity)) || null;
  }

  begin(identity, at = new Date().toISOString()) {
    const current = this.find(identity);
    if (current?.status === "done" || current?.status === "pending") return current;
    const next = current
      ? current.retry(at)
      : new FlowOutboxEntry({
          identity,
          status: "pending",
          attempt: 1,
          startedAt: requireTimestamp(at, "outbox begin timestamp"),
          updatedAt: at,
        });
    this.#replace(next);
    return next;
  }

  complete(identity, result, at = new Date().toISOString()) {
    const current = this.find(identity);
    if (!current) throw new Error(`outbox entry not found: ${identity.idempotencyKey}`);
    const next = current.complete(result, at);
    this.#replace(next);
    return next;
  }

  fail(identity, error, at = new Date().toISOString()) {
    const current = this.find(identity);
    if (!current) throw new Error(`outbox entry not found: ${identity.idempotencyKey}`);
    const next = current.fail(error, at);
    this.#replace(next);
    return next;
  }

  touch(identity, at = new Date().toISOString()) {
    const current = this.find(identity);
    if (!current) throw new Error(`outbox entry not found: ${identity.idempotencyKey}`);
    const next = current.touch(at);
    this.#replace(next);
    return next;
  }

  reopenFailedExact(claim, at = new Date().toISOString()) {
    if (!(claim instanceof FlowOutboxRecoveryClaim)) throw new Error("exact recovery claim is required");
    const current = this.find(claim.identity);
    if (!current) throw new Error("exact recovery target was not found in the outbox");
    const next = claim.reopen(current, at);
    this.#replace(next);
    return next;
  }

  merge(entry) {
    if (!(entry instanceof FlowOutboxEntry)) throw new Error("outbox entry is required");
    const current = this.find(entry.identity);
    if (current?.status === "done") return current;
    if (!current || entry.attempt > current.attempt || entry.updatedAt > current.updatedAt) {
      this.#replace(entry);
      return entry;
    }
    return current;
  }

  #replace(entry) {
    const index = this.entries.findIndex((candidate) => candidate.identity.equals(entry.identity));
    if (index >= 0) this.entries[index] = entry;
    else this.entries.push(entry);
  }

  toJSON() {
    return this.entries.map((entry) => entry.toJSON());
  }
}

export class FlowOutboxStore {
  constructor(flowManager, { specId = null, operationOwnerToken = null } = {}) {
    if (!flowManager
      || typeof flowManager.beginOutbox !== "function"
      || typeof flowManager.completeOutbox !== "function"
      || typeof flowManager.failOutbox !== "function"
      || typeof flowManager.reopenOutboxExact !== "function"
      || typeof flowManager.outboxStatus !== "function") {
      throw new Error("canonical Flow outbox APIs are required for the outbox");
    }
    this.flowManager = flowManager;
    this.specId = specId;
    this.operationOwnerToken = operationOwnerToken;
  }

  begin(identity) {
    return this.#canonicalBegin(identity);
  }

  /**
   * Resolve one operation through the manager boundary.  Callers that need to
   * recover a known side effect must not deserialize `flow.json.outbox`
   * themselves: Version 1 intentionally keeps only `{ id, operation }` for
   * unfinished work and derives terminal history from Activities.
   */
  status(identity) {
    if (!(identity instanceof FlowOutboxIdentity)) throw new Error("outbox identity is required");
    const status = this.#canonicalStatus(identity);
    return status.status === "missing" ? null : this.#entry(identity, status);
  }

  beginCommand(identity) {
    const status = this.#canonicalStatus(identity);
    if (status.status === "failed") throw new FlowOutboxRecoveryRequiredError(this.#entry(identity, status));
    return this.#canonicalBegin(identity);
  }

  complete(identity, result) {
    const status = this.flowManager.completeOutbox({
      ...(this.specId ? { specId: this.specId } : {}),
      id: identity.idempotencyKey,
      operation: identity.operation,
      result: cloneJson(result),
    });
    return this.#entry(identity, status, result);
  }

  fail(identity, error) {
    const failure = error instanceof Error ? error.message : String(error || "side effect failed");
    const code = typeof error?.code === "string" && FAILURE_CODE.test(error.code)
      ? error.code
      : null;
    const recovery = code === "MERGE_PRE_SYNC_CONFLICT" && error?.data?.recovery != null
      ? PreSyncRebaseRecovery.fromError(error)?.toJSON() ?? null
      : null;
    const status = this.flowManager.failOutbox({
      ...(this.specId ? { specId: this.specId } : {}),
      id: identity.idempotencyKey,
      operation: identity.operation,
      failure,
      failureCode: code,
      recovery,
    });
    return this.#entry(identity, status);
  }

  touch(identity) {
    const status = this.#canonicalStatus(identity);
    if (status.status !== "pending") throw new Error(`outbox entry not found: ${identity.idempotencyKey}`);
    return this.#entry(identity, status);
  }

  reopenFailedExact(claim) {
    if (!(claim instanceof FlowOutboxRecoveryClaim)) throw new Error("exact recovery claim is required");
    const status = this.flowManager.reopenOutboxExact({
      ...(this.specId ? { specId: this.specId } : {}),
      operationOwnerToken: this.operationOwnerToken,
      id: claim.identity.idempotencyKey,
      operation: claim.identity.operation,
      attempt: claim.attempt,
      failure: claim.failure,
      recoveryKey: claim.recoveryKey,
    });
    return this.#entry(claim.identity, status);
  }

  #canonicalStatus(identity) {
    if (!(identity instanceof FlowOutboxIdentity)) throw new Error("outbox identity is required");
    return this.flowManager.outboxStatus({
      ...(this.specId ? { specId: this.specId } : {}),
      id: identity.idempotencyKey,
      operation: identity.operation,
    });
  }

  #canonicalBegin(identity) {
    if (!(identity instanceof FlowOutboxIdentity)) throw new Error("outbox identity is required");
    const status = this.flowManager.beginOutbox({
      ...(this.specId ? { specId: this.specId } : {}),
      id: identity.idempotencyKey,
      operation: identity.operation,
    });
    return this.#entry(identity, status);
  }

  #entry(identity, status, result = undefined) {
    const now = new Date().toISOString();
    const startedAt = status.startedAt ?? now;
    const updatedAt = status.updatedAt ?? now;
    const attempt = status.attempt > 0 ? status.attempt : 1;
    if (status.status === "pending") {
      return new FlowOutboxEntry({
        identity,
        status: "pending",
        attempt,
        startedAt,
        updatedAt,
        exactRecoveryReceipt: status.exactRecoveryReceipt == null
          ? null
          : FlowOutboxRecoveryReceipt.fromStored(status.exactRecoveryReceipt),
      });
    }
    if (status.status === "done") {
      return new FlowOutboxEntry({
        identity,
        status: "done",
        attempt,
        startedAt,
        updatedAt,
        result: result === undefined ? status.result ?? null : result,
      });
    }
    if (status.status === "failed") {
      return new FlowOutboxEntry({
        identity,
        status: "failed",
        attempt,
        startedAt,
        updatedAt,
        failure: status.failure || "side effect failed",
        failureHistory: status.failureHistory || [],
        exactRecoveryReceipt: status.exactRecoveryReceipt == null
          ? null
          : FlowOutboxRecoveryReceipt.fromStored(status.exactRecoveryReceipt),
      });
    }
    throw new Error(`outbox entry not found: ${identity.idempotencyKey}`);
  }

}

export function finalizationOutboxIdentity(flowState, stepId) {
  return new FlowOutboxIdentity({
    runId: flowState.runId,
    taskId: null,
    stepId,
    operation: stepId,
  });
}
