const FAILURE_KINDS = new Set([
  "temporary-unavailable", "recovery-untrusted", "rollback-required",
  "start-uncertain", "rejected", "authority-violation", "settlement-pending",
]);
const AUTHORITY_FAILURES = new Set([
  "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION",
  "FLOW_SOURCE_HANDOFF_FINALIZE_AUTHORITY_VIOLATION",
  "FLOW_SOURCE_HANDOFF_CANONICAL_PATH_VIOLATION",
  "FLOW_SOURCE_HANDOFF_CANONICAL_MUTATION_INVALID",
]);
const TEMPORARY_READ_FAILURES = new Set(["EAGAIN", "EBUSY", "EMFILE", "ENFILE"]);

function optionalDigest(value, label) {
  if (value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

/** Observed failure evidence; disposition belongs to the Flow Definition. */
export class SourceHandoffFailureFacts {
  constructor({
    kind, checkpointDigest = null, identity = null, code, message,
    rollbackPlanDigest = null, handoffDigest = null,
    ownershipProven = false, workerStopped = false, retryable = false, failureKind = null,
    providerFailed = false,
  } = {}) {
    if (!FAILURE_KINDS.has(kind)) throw new Error("invalid source handoff failure kind");
    if (typeof code !== "string" || code.trim() === ""
      || typeof message !== "string" || message.trim() === "") {
      throw new Error("source handoff failure requires its code and message");
    }
    if (typeof ownershipProven !== "boolean" || typeof workerStopped !== "boolean"
      || typeof retryable !== "boolean" || typeof providerFailed !== "boolean") {
      throw new Error("source handoff failure requires explicit ownership and process facts");
    }
    if (identity !== null && typeof identity.toJSON !== "function") {
      throw new Error("source handoff failure requires a typed identity");
    }
    this.kind = kind;
    this.checkpointDigest = optionalDigest(checkpointDigest, "failure checkpoint");
    this.identity = identity;
    this.code = code;
    this.message = message;
    this.rollbackPlanDigest = optionalDigest(rollbackPlanDigest, "failure rollback plan");
    this.handoffDigest = optionalDigest(handoffDigest, "failure handoff");
    this.ownershipProven = ownershipProven;
    this.workerStopped = workerStopped;
    this.retryable = retryable;
    this.failureKind = failureKind === null ? null : requiredString(String(failureKind), "failure kind");
    this.providerFailed = providerFailed;
    Object.freeze(this);
  }

  static fromError(error, {
    request = null, ownershipProven = false, workerStopped = false, agentError = null,
  } = {}) {
    const code = error.code ?? "FLOW_SOURCE_HANDOFF_INVALID";
    let kind = "rejected";
    if (code === "FLOW_SOURCE_HANDOFF_START_UNCERTAIN") kind = "start-uncertain";
    else if (code === "FLOW_SOURCE_HANDOFF_RECOVERY_UNAVAILABLE") kind = "temporary-unavailable";
    else if (code === "FLOW_SOURCE_HANDOFF_ROLLBACK_REQUIRED") kind = "rollback-required";
    else if (code === "FLOW_SOURCE_HANDOFF_RECOVERY_UNTRUSTED") kind = "recovery-untrusted";
    else if (code === "FLOW_ARTIFACT_HANDOFF_CONFLICT") kind = "recovery-untrusted";
    else if (error.recoveryPossible === true) kind = "settlement-pending";
    else if (code.startsWith("FLOW_HANDOFF_AUTHORITY_LOCK_")) kind = "recovery-untrusted";
    else if (AUTHORITY_FAILURES.has(code)) kind = "authority-violation";
    else if (code === "FLOW_HANDOFF_AUTHORITY_WAIT_TIMEOUT"
      || TEMPORARY_READ_FAILURES.has(code)) kind = "temporary-unavailable";
    return new SourceHandoffFailureFacts({
      kind, code, message: error.message,
      checkpointDigest: request?.sourceHandoffCheckpoint?.digest ?? null,
      identity: request?.sourceHandoffIdentity ?? null,
      ownershipProven, workerStopped, retryable: error.retryable === true,
      failureKind: error.data?.failureKind ?? null,
      providerFailed: agentError !== null,
    });
  }

  toJSON() {
    return {
      kind: this.kind, checkpointDigest: this.checkpointDigest,
      identity: this.identity?.toJSON() ?? null,
      code: this.code, message: this.message,
      rollbackPlanDigest: this.rollbackPlanDigest, handoffDigest: this.handoffDigest,
      ownershipProven: this.ownershipProven, workerStopped: this.workerStopped,
      retryable: this.retryable, failureKind: this.failureKind,
      providerFailed: this.providerFailed,
    };
  }
}
