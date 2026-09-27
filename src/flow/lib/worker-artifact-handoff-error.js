export function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

export class WorkerArtifactHandoffError extends Error {
  constructor(classification, code, message, {
    cause = null,
    data = {},
    retryable = false,
    recoveryPossible = classification === "recovery-required",
  } = {}) {
    if (!["missing", "invalid", "stale", "conflict", "recovery-required"].includes(classification)) {
      throw new Error(`invalid worker artifact handoff classification: ${classification}`);
    }
    if (typeof retryable !== "boolean") throw new Error("worker artifact handoff retryable must be boolean");
    if (typeof recoveryPossible !== "boolean") throw new Error("worker artifact handoff recoveryPossible must be boolean");
    super(message, cause ? { cause } : undefined);
    this.name = "WorkerArtifactHandoffError";
    this.classification = classification;
    this.code = requiredString(code, "worker artifact handoff error code");
    this.recoveryPossible = recoveryPossible;
    this.retryable = retryable;
    this.data = Object.freeze({ ...data });
  }

  get isAdmissionRejection() {
    return ["invalid", "stale", "conflict"].includes(this.classification);
  }
}
