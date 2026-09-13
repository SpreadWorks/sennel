/**
 * Typed failures emitted by the agent process boundary.
 *
 * Retryability is owned by the failure type. Callers may choose a smaller
 * retry budget, but they must not turn a terminal failure into a retryable
 * one by matching free-form provider output.
 */

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function failureText(error) {
  const values = [
    error?.message,
    error?.stderr,
    error?.stdout,
    error?.cause?.message,
    error?.cause?.stderr,
  ].filter((value) => value != null && String(value).trim() !== "");
  return values.map(String).join("\n");
}

function errorCodeText(error) {
  return [error?.code, error?.cause?.code, error?.stdinError?.code]
    .filter((value) => value != null)
    .map(String)
    .join(" ");
}

function copyDiagnostics(target, source) {
  for (const field of [
    "stdout",
    "stderr",
    "signal",
    "killed",
    "stdinError",
    "errno",
    "syscall",
    "path",
    "spawnargs",
    "timeoutMs",
    "graceMs",
    "finalAction",
    "timeoutReason",
    "unterminatedMembers",
    "diagnosticLog",
  ]) {
    if (source?.[field] != null) target[field] = source[field];
  }
  if (source?.code != null && typeof source.code !== "string") {
    target.providerExitCode = source.code;
  }
}

function restoreStableAgentFailure(error) {
  const constructors = new Map([
    ["AGENT_TEMPORARY_RATE_LIMIT", TemporaryRateLimitFailure],
    ["AGENT_TEMPORARY_NETWORK", TemporaryNetworkFailure],
    ["AGENT_TIMEOUT", AgentTimeoutFailure],
    ["AGENT_AUTHENTICATION_FAILED", AgentAuthenticationFailure],
    ["AGENT_PERMISSION_CONFIGURATION_FAILED", AgentPermissionConfigurationFailure],
    ["AGENT_USAGE_LIMIT_REACHED", AgentUsageLimitFailure],
    ["AGENT_PERMANENT_NETWORK_FAILURE", PermanentNetworkFailure],
    ["AGENT_UNKNOWN_PROVIDER_FAILURE", UnknownProviderFailure],
    ["AGENT_EMPTY_RESPONSE", EmptyAgentResponseFailure],
  ]);
  const Failure = constructors.get(error?.code);
  if (Failure === undefined) return null;
  return new Failure({
    message: error.message,
    attemptCount: error.attemptCount ?? 1,
    maxAttempts: error.maxAttempts ?? 1,
    cause: error,
    ...(error.code === "AGENT_TIMEOUT" ? { stopEvidence: error.stopEvidence ?? null } : {}),
  });
}

const PROCESS_STOP_STATUSES = new Set(["confirmed", "uncertain"]);

/**
 * Provider-process termination evidence produced by the process supervisor.
 * An empty member list is diagnostic data only; it is never termination proof.
 */
export class AgentProcessStopEvidence {
  constructor({ status, reason, unterminatedMembers = [] } = {}) {
    this.status = requireString(status, "agent process stop status");
    if (!PROCESS_STOP_STATUSES.has(this.status)) {
      throw new Error("agent process stop status must be confirmed or uncertain");
    }
    this.reason = requireString(reason, "agent process stop reason");
    if (!Array.isArray(unterminatedMembers)) {
      throw new Error("agent process unterminatedMembers must be an array");
    }
    this.unterminatedMembers = Object.freeze(unterminatedMembers.map((member) => {
      if (member === null || typeof member !== "object" || Array.isArray(member)) {
        throw new Error("agent process unterminated member must be an object");
      }
      const value = typeof member.toJSON === "function" ? member.toJSON() : member;
      if (!Number.isSafeInteger(value.pid) || value.pid < 1) {
        throw new Error("agent process unterminated member pid is invalid");
      }
      return Object.freeze({ ...value });
    }));
    if (this.status === "confirmed" && this.unterminatedMembers.length > 0) {
      throw new Error("confirmed agent process stop cannot retain unterminated members");
    }
    Object.freeze(this);
  }

  static confirmed() {
    return new AgentProcessStopEvidence({ status: "confirmed", reason: "process-tree-death-observed" });
  }

  static uncertain(reason = "process-tree-death-not-observed", unterminatedMembers = []) {
    return new AgentProcessStopEvidence({ status: "uncertain", reason, unterminatedMembers });
  }

  static from(value) {
    return value instanceof AgentProcessStopEvidence ? value : new AgentProcessStopEvidence(value);
  }

  get confirmed() { return this.status === "confirmed"; }

  toJSON() {
    return {
      status: this.status,
      reason: this.reason,
      unterminatedMembers: this.unterminatedMembers.map((member) => ({ ...member })),
    };
  }
}

const EXTERNAL_INTERVENTION_KINDS = new Set([
  "authentication",
  "permission_configuration",
  "usage_limit",
]);

export class AgentFailure extends Error {
  constructor({
    message,
    kind,
    code,
    retryable,
    recoveryHint,
    attemptCount = 1,
    maxAttempts = 1,
    cause = null,
  }) {
    if (new.target === AgentFailure) throw new Error("AgentFailure is abstract");
    super(requireString(message, "agent failure message"), cause ? { cause } : undefined);
    this.name = new.target.name;
    this.kind = requireString(kind, "agent failure kind");
    this.code = requireString(code, "agent failure code");
    if (!/^AGENT_[A-Z0-9_]+$/.test(this.code)) {
      throw new Error("agent failure code must be a stable AGENT_* code");
    }
    if (typeof retryable !== "boolean") throw new Error("agent failure retryable must be boolean");
    this.retryable = retryable;
    this.recoveryHint = requireString(recoveryHint, "agent failure recoveryHint");
    this.attemptCount = positiveInteger(attemptCount, "agent failure attemptCount");
    this.maxAttempts = positiveInteger(maxAttempts, "agent failure maxAttempts");
    if (this.attemptCount > this.maxAttempts) {
      throw new Error("agent failure attemptCount must not exceed maxAttempts");
    }
    copyDiagnostics(this, cause);
  }

  recordAttempts(attemptCount, maxAttempts) {
    this.attemptCount = positiveInteger(attemptCount, "agent failure attemptCount");
    this.maxAttempts = positiveInteger(maxAttempts, "agent failure maxAttempts");
    if (this.attemptCount > this.maxAttempts) {
      throw new Error("agent failure attemptCount must not exceed maxAttempts");
    }
    return this;
  }

  /** The provider cannot be retried until credentials, configuration, or quota changes. */
  get requiresExternalIntervention() {
    return EXTERNAL_INTERVENTION_KINDS.has(this.kind);
  }

  toJSON() {
    const timeoutDiagnostics = this.code === "AGENT_TIMEOUT";
    return {
      kind: this.kind,
      code: this.code,
      retryable: this.retryable,
      recoveryHint: this.recoveryHint,
      attemptCount: this.attemptCount,
      maxAttempts: this.maxAttempts,
      message: this.message,
      ...(this.providerExitCode != null ? { providerExitCode: this.providerExitCode } : {}),
      ...(this.signal != null ? { signal: this.signal } : {}),
      ...(timeoutDiagnostics && this.timeoutMs != null ? { timeoutMs: this.timeoutMs } : {}),
      ...(timeoutDiagnostics && this.graceMs != null ? { graceMs: this.graceMs } : {}),
      ...(timeoutDiagnostics && this.finalAction != null ? { finalAction: this.finalAction } : {}),
      ...(timeoutDiagnostics && this.timeoutReason != null ? { timeoutReason: this.timeoutReason } : {}),
      ...(timeoutDiagnostics && this.stdout != null ? { stdout: this.stdout } : {}),
      ...(timeoutDiagnostics && this.stdout == null ? { stdoutUnavailable: "provider produced no capturable stdout" } : {}),
      ...(timeoutDiagnostics && this.stderr != null ? { stderr: this.stderr } : {}),
      ...(timeoutDiagnostics && this.stderr == null ? { stderrUnavailable: "provider produced no capturable stderr" } : {}),
      ...(timeoutDiagnostics && this.diagnosticLog != null ? { diagnosticLog: this.diagnosticLog } : {}),
      ...(timeoutDiagnostics && Array.isArray(this.supervisorEvents) ? { supervisorEvents: this.supervisorEvents } : {}),
      ...(timeoutDiagnostics && this.stopEvidence instanceof AgentProcessStopEvidence
        ? { stopEvidence: this.stopEvidence.toJSON() }
        : {}),
      ...(timeoutDiagnostics && this.cause?.message ? {
        cause: {
          message: String(this.cause.message),
          ...(this.cause.code != null ? { code: String(this.cause.code) } : {}),
        },
      } : {}),
    };
  }

  static from(error) {
    if (error instanceof AgentFailure) return error;
    const stable = restoreStableAgentFailure(error);
    if (stable !== null) return stable;
    const text = failureText(error);
    const codes = errorCodeText(error);
    const input = { message: text || "unknown agent provider failure", cause: error };

    if (
      /(?:api[_ -]?error[_ -]?status|http(?: status)?)\s*[=:]?\s*401\b|\b401\s+unauthorized\b|\boauth\b|failed to authenticate|authentication failed|unauthorized|token (?:has )?expired|login required|not logged in|please (?:run )?\/?login/i.test(text)
    ) return new AgentAuthenticationFailure(input);

    if (
      /\b(?:ENOENT|EACCES|EPERM|EEXIST|ENOTDIR|EISDIR|EROFS)\b/.test(codes)
      || error?.code === 126
      || error?.code === 127
      || /\b403\s+forbidden\b|agent command not found|command not found|executable.*not found|permission denied|not permitted|missing (?:agent )?(?:profile|configuration|config)|no agent configured|profile .* is not defined/i.test(text)
    ) return new AgentPermissionConfigurationFailure(input);

    if (
      /usage limit|you(?:'ve| have) hit your (?:usage )?limit|quota(?: exceeded| exhausted| reached)?|session limit|credit balance|billing limit|insufficient credits|too many tokens for (?:this )?(?:account|plan)/i.test(text)
    ) return new AgentUsageLimitFailure(input);

    if (/\b429\b|rate[ -]?limit(?:ed|ing)?|too many requests/i.test(text)) {
      return new TemporaryRateLimitFailure(input);
    }

    if (/\bEAI_AGAIN\b/.test(codes) || /temporary failure in name resolution|temporary dns/i.test(text)) {
      return new TemporaryNetworkFailure(input);
    }

    if (
      error?.code === "AGENT_TIMEOUT"
      || error?.signal === "SIGTERM"
      || error?.killed === true
      || /\btimed? out\b|\btimeout\b/i.test(text)
    ) return new AgentTimeoutFailure({ ...input, stopEvidence: error?.stopEvidence ?? null });

    if (/\bENOTFOUND\b/.test(codes) || /could not resolve (?:host|hostname)|name or service not known/i.test(text)) {
      return new PermanentNetworkFailure(input);
    }

    if (/empty response|no candidates? returned|empty candidates?/i.test(text)) {
      return new EmptyAgentResponseFailure({
        ...input,
        message: text ? `agent returned no response: ${text}` : "agent returned no response",
      });
    }

    return new UnknownProviderFailure(input);
  }
}

export class TemporaryRateLimitFailure extends AgentFailure {
  constructor(input = {}) {
    super({
      ...input,
      kind: "temporary_rate_limit",
      code: "AGENT_TEMPORARY_RATE_LIMIT",
      retryable: true,
      recoveryHint: "Wait for the provider rate-limit window, then retry the same input.",
    });
  }
}

export class TemporaryNetworkFailure extends AgentFailure {
  constructor(input = {}) {
    super({
      ...input,
      kind: "temporary_network",
      code: "AGENT_TEMPORARY_NETWORK",
      retryable: true,
      recoveryHint: "Restore temporary DNS connectivity, then retry the same input.",
    });
  }
}

export class AgentTimeoutFailure extends AgentFailure {
  constructor(input = {}) {
    const stopEvidence = input.stopEvidence == null
      ? AgentProcessStopEvidence.uncertain()
      : AgentProcessStopEvidence.from(input.stopEvidence);
    super({
      ...input,
      kind: "timeout",
      code: "AGENT_TIMEOUT",
      retryable: stopEvidence.confirmed,
      recoveryHint: stopEvidence.confirmed
        ? "Retry the same input after the timed-out provider process has terminated."
        : "Verify that the timed-out provider process tree has terminated before retrying.",
    });
    this.stopEvidence = stopEvidence;
  }
}

export class AgentAuthenticationFailure extends AgentFailure {
  constructor(input = {}) {
    super({
      ...input,
      kind: "authentication",
      code: "AGENT_AUTHENTICATION_FAILED",
      retryable: false,
      recoveryHint: "Repair or refresh provider authentication before starting a new attempt.",
    });
  }
}

export class AgentPermissionConfigurationFailure extends AgentFailure {
  constructor(input = {}) {
    super({
      ...input,
      kind: "permission_configuration",
      code: "AGENT_PERMISSION_CONFIGURATION_FAILED",
      retryable: false,
      recoveryHint: "Repair the provider executable, profile, configuration, or permission before starting a new attempt.",
    });
  }
}

export class AgentUsageLimitFailure extends AgentFailure {
  constructor(input = {}) {
    super({
      ...input,
      kind: "usage_limit",
      code: "AGENT_USAGE_LIMIT_REACHED",
      retryable: false,
      recoveryHint: "Restore provider quota or wait for the documented usage window before starting a new attempt.",
    });
  }
}

export class PermanentNetworkFailure extends AgentFailure {
  constructor(input = {}) {
    super({
      ...input,
      kind: "permanent_network",
      code: "AGENT_PERMANENT_NETWORK_FAILURE",
      retryable: false,
      recoveryHint: "Correct the provider hostname or permanent DNS configuration before starting a new attempt.",
    });
  }
}

export class UnknownProviderFailure extends AgentFailure {
  constructor(input = {}) {
    super({
      ...input,
      kind: "unknown_provider",
      code: "AGENT_UNKNOWN_PROVIDER_FAILURE",
      retryable: false,
      recoveryHint: "Inspect the preserved provider diagnostics and classify or repair the failure before starting a new attempt.",
    });
  }
}

export class EmptyAgentResponseFailure extends AgentFailure {
  constructor(input = {}) {
    super({
      ...input,
      message: input.message || "agent returned an empty response",
      kind: "empty_response",
      code: "AGENT_EMPTY_RESPONSE",
      retryable: true,
      recoveryHint: "Retry the same input because the provider returned no candidate response.",
    });
  }
}
