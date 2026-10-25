import { AgentTimeoutDiagnostic } from "./agent-timeout.js";
import { AgentProcessStopEvidence, AgentTimeoutFailure } from "./agent-failure.js";

export const DEFAULT_DIRECT_CHILD_EXIT_DRAIN_MS = 250;

/** Registered execution timeout; exit proof remains separate from the timeout. */
export class AgentTimeoutError extends AgentTimeoutFailure {
  constructor({ timeoutMs, graceMs, finalAction, timeoutDiagnostic = null, stopEvidence = null }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(graceMs) || graceMs <= 0) throw new TypeError("Timeout budgets must be positive and finite");
    if (timeoutDiagnostic !== null && !(timeoutDiagnostic instanceof AgentTimeoutDiagnostic)) throw new TypeError("Timeout diagnostic is invalid");
    const triggering = timeoutDiagnostic?.timeoutMs ?? timeoutMs;
    super({ message: "Agent timed out after " + triggering + "ms"
      + (timeoutDiagnostic === null ? "" : "; reason=" + timeoutDiagnostic.reason) + "; final action=" + finalAction,
      stopEvidence: stopEvidence === null ? AgentProcessStopEvidence.uncertain("registered-child-exit-not-observed") : AgentProcessStopEvidence.from(stopEvidence) });
    this.name = "AgentTimeoutError";
    this.timeoutMs = triggering; this.graceMs = graceMs; this.finalAction = finalAction;
    this.killed = true;
    if (timeoutDiagnostic !== null) this.timeoutReason = timeoutDiagnostic.reason;
  }
}

export class ProcessOutputBuffer {
  #chunks = [];
  #bytes = 0;

  constructor(maximum, encoding) {
    if (typeof maximum !== "number" || maximum < 0 || Number.isNaN(maximum)) {
      throw new TypeError("Process maximum buffer must be a non-negative number");
    }
    this.maximum = maximum;
    this.encoding = encoding;
  }

  append(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, this.maximum - this.#bytes);
    if (remaining > 0) this.#chunks.push(bytes.subarray(0, remaining));
    this.#bytes += bytes.length;
    return this.#bytes <= this.maximum;
  }

  toBuffer() { return Buffer.concat(this.#chunks); }

  toString() {
    const bytes = this.toBuffer();
    return bytes.toString(this.encoding !== "buffer" && Buffer.isEncoding(this.encoding) ? this.encoding : "utf8");
  }
}
