/**
 * Canonical agent timeout value.
 *
 * Configuration is expressed in seconds for human-facing readability. Convert
 * to milliseconds only when calling Node.js process and timer APIs.
 */

export const DEFAULT_AGENT_TIMEOUT_SECONDS = 1_800;
export const DEFAULT_AGENT_PROCESS_TREE_GRACE_MS = 100;

export class AgentTimeout {
  constructor(seconds = DEFAULT_AGENT_TIMEOUT_SECONDS) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError("agent timeout must be a positive number of seconds");
    }
    this.seconds = value;
    Object.freeze(this);
  }

  static fromConfig(agentConfig = {}) {
    return new AgentTimeout(agentConfig?.timeout ?? DEFAULT_AGENT_TIMEOUT_SECONDS);
  }

  toMilliseconds() {
    return this.seconds * 1000;
  }

}

/** The exact threshold which caused an Agent timeout. */
export class AgentTimeoutDiagnostic {
  constructor({ reason, timeoutMs } = {}) {
    if (!new Set(["inactivity", "maximum_lifetime"]).has(reason)) {
      throw new TypeError("agent timeout diagnostic reason is invalid");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("agent timeout diagnostic threshold must be positive");
    }
    this.reason = reason;
    this.timeoutMs = timeoutMs;
    Object.freeze(this);
  }
}
