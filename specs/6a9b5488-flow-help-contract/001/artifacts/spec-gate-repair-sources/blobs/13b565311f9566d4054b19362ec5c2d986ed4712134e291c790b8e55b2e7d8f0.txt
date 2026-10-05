const MAX_CAPTURED_OUTPUT_LENGTH = 12_000;

function capturedText(value) {
  const text = String(value || "");
  if (text.length <= MAX_CAPTURED_OUTPUT_LENGTH) return text;
  return `${text.slice(0, MAX_CAPTURED_OUTPUT_LENGTH)}\n[output truncated]`;
}

/** A bounded, serializable record of one finalize-sync subprocess. */
export class FinalizeSyncDiagnostic {
  constructor({ phase, result = null, message = null }) {
    if (typeof phase !== "string" || phase === "") {
      throw new Error("finalize-sync diagnostic phase is required");
    }
    if (result != null && (typeof result !== "object" || Array.isArray(result))) {
      throw new Error("finalize-sync diagnostic result must be an object");
    }
    this.phase = phase;
    this.exitCode = Number.isInteger(result?.status) ? result.status : null;
    this.signal = result?.signal || null;
    this.killed = result?.killed === true;
    this.errorCode = result?.errorCode || null;
    this.stdout = capturedText(result?.stdout);
    this.stderr = capturedText(result?.stderr);
    this.message = message == null ? null : capturedText(message);
    Object.freeze(this);
  }

  toJSON() {
    return {
      phase: this.phase,
      exitCode: this.exitCode,
      signal: this.signal,
      killed: this.killed,
      errorCode: this.errorCode,
      stdout: this.stdout,
      stderr: this.stderr,
      ...(this.message != null ? { message: this.message } : {}),
    };
  }
}

/** Failure whose diagnostics are safe to emit in an envelope and issue log. */
export class FinalizeSyncExecutionError extends Error {
  constructor({ phase, diagnostics, message = null }) {
    if (!Array.isArray(diagnostics) || diagnostics.some((entry) => !(entry instanceof FinalizeSyncDiagnostic))) {
      throw new Error("finalize-sync execution error requires diagnostics");
    }
    const latest = diagnostics.at(-1);
    super(message || `finalize-sync ${phase} failed${latest?.exitCode != null ? ` (exit=${latest.exitCode})` : ""}`);
    this.name = "FinalizeSyncExecutionError";
    this.code = "FINALIZE_SYNC_FAILED";
    this.data = {
      phase,
      diagnostics: diagnostics.map((entry) => entry.toJSON()),
    };
  }
}

/** Persisted when a prior finalize-sync process disappeared before settlement. */
export class FinalizeSyncInterruptedError extends Error {
  constructor({ runtimeLog = null }) {
    super("finalize-sync was interrupted before it returned a result");
    this.name = "FinalizeSyncInterruptedError";
    this.code = "FINALIZE_SYNC_INTERRUPTED";
    this.data = runtimeLog == null ? {} : { runtimeLog };
  }
}
