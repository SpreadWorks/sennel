/**
 * Typed failures emitted by the agent process boundary.
 *
 * Retryability is owned by the failure type. Callers may choose a smaller
 * retry budget, but they must not turn a terminal failure into a retryable
 * one by matching free-form provider output.
 */

import { BoundedStreamEvidence, utf8Prefix } from "./bounded-stream-evidence.js";

export const MAX_DURABLE_AGENT_FAILURE_MESSAGE_BYTES = 1024;
export const MAX_DURABLE_AGENT_FAILURE_MESSAGE_SERIALIZED_BYTES = (6 * MAX_DURABLE_AGENT_FAILURE_MESSAGE_BYTES) + 1024;

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

function durableProviderCompletionMessage(evidence) {
  const completion = [
    `provider=${evidence.provider}`,
    `profile=${evidence.profile}`,
    evidence.exitCode === null ? null : `exit=${evidence.exitCode}`,
    evidence.signal === null ? null : `signal=${evidence.signal}`,
    `stdout=${evidence.stdout.originalByteLength}B/${evidence.stdout.sha256}`,
    `stderr=${evidence.stderr.originalByteLength}B/${evidence.stderr.sha256}`,
  ].filter((part) => part !== null);
  const outputPreview = evidence.stderr.preview() || evidence.stdout.preview();
  return utf8Prefix(
    `${completion.join(" | ")}${outputPreview ? ` | providerOutput=${outputPreview}` : ""}`,
    MAX_DURABLE_AGENT_FAILURE_MESSAGE_BYTES,
  );
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
    ["AGENT_TEMPORARY_PROVIDER_UNAVAILABLE", TemporaryProviderUnavailableFailure],
    ["AGENT_UNCLASSIFIED_PROVIDER_EXIT", UnclassifiedProviderExitFailure],
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
    providerCompletionEvidence: error.providerCompletionEvidence ?? null,
    ...(error.code === "AGENT_TIMEOUT" ? { stopEvidence: error.stopEvidence ?? null } : {}),
  });
}

const PROVIDER_QUIESCENCE_STATUSES = new Set(["confirmed", "unavailable"]);

/** Normal provider-process completion evidence produced by Agent's supervisor. */
export class AgentProviderCompletionEvidence {
  constructor({
    provider,
    profile,
    exitCode,
    signal = null,
    stdout = "",
    stderr = "",
    attemptCount = 1,
    maxAttempts = 1,
    processTreeQuiescence = "unavailable",
  } = {}) {
    this.provider = requireString(provider, "agent provider completion provider");
    this.profile = requireString(profile, "agent provider completion profile");
    if (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < 0)) {
      throw new Error("agent provider completion exitCode must be a non-negative integer or null");
    }
    if (signal !== null) requireString(signal, "agent provider completion signal");
    if (exitCode === null && signal === null) {
      throw new Error("agent provider completion requires an exitCode or signal");
    }
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout instanceof BoundedStreamEvidence
      ? stdout
      : typeof stdout === "string"
        ? new BoundedStreamEvidence(stdout)
        : BoundedStreamEvidence.from(stdout);
    this.stderr = stderr instanceof BoundedStreamEvidence
      ? stderr
      : typeof stderr === "string"
        ? new BoundedStreamEvidence(stderr)
        : BoundedStreamEvidence.from(stderr);
    this.attemptCount = positiveInteger(attemptCount, "agent provider completion attemptCount");
    this.maxAttempts = positiveInteger(maxAttempts, "agent provider completion maxAttempts");
    if (this.attemptCount > this.maxAttempts) {
      throw new Error("agent provider completion attemptCount must not exceed maxAttempts");
    }
    this.processTreeQuiescence = requireString(
      processTreeQuiescence,
      "agent provider completion processTreeQuiescence",
    );
    if (!PROVIDER_QUIESCENCE_STATUSES.has(this.processTreeQuiescence)) {
      throw new Error("agent provider completion processTreeQuiescence must be confirmed or unavailable");
    }
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof AgentProviderCompletionEvidence
      ? value
      : AgentProviderCompletionEvidence.fromJSON(value);
  }

  static fromJSON(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("agent provider completion evidence must be an object");
    }
    return new AgentProviderCompletionEvidence({
      ...value,
      stdout: BoundedStreamEvidence.fromJSON(value.stdout),
      stderr: BoundedStreamEvidence.fromJSON(value.stderr),
    });
  }

  get confirmedQuiescence() { return this.processTreeQuiescence === "confirmed"; }

  withAttempts(attemptCount, maxAttempts) {
    return new AgentProviderCompletionEvidence({
      ...this.toJSON(),
      attemptCount,
      maxAttempts,
    });
  }

  toJSON() {
    return {
      provider: this.provider,
      profile: this.profile,
      exitCode: this.exitCode,
      signal: this.signal,
      stdout: this.stdout.toJSON(),
      stderr: this.stderr.toJSON(),
      attemptCount: this.attemptCount,
      maxAttempts: this.maxAttempts,
      processTreeQuiescence: this.processTreeQuiescence,
    };
  }
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
    providerCompletionEvidence = null,
  }) {
    if (new.target === AgentFailure) throw new Error("AgentFailure is abstract");
    const completionEvidence = providerCompletionEvidence == null
      ? null
      : AgentProviderCompletionEvidence.from(providerCompletionEvidence);
    super(requireString(
      completionEvidence === null ? message : durableProviderCompletionMessage(completionEvidence),
      "agent failure message",
    ), cause ? { cause } : undefined);
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
    this.providerCompletionEvidence = completionEvidence;
    if (this.providerCompletionEvidence !== null
      && (this.providerCompletionEvidence.attemptCount !== this.attemptCount
        || this.providerCompletionEvidence.maxAttempts !== this.maxAttempts)) {
      throw new Error("agent failure attempts must match provider completion evidence");
    }
    if (this.providerCompletionEvidence !== null
      && this.providerCompletionEvidence.signal !== null
      && this.retryable) {
      throw new Error("signaled provider completion evidence cannot be retryable");
    }
    copyDiagnostics(this, cause);
  }

  recordAttempts(attemptCount, maxAttempts) {
    this.attemptCount = positiveInteger(attemptCount, "agent failure attemptCount");
    this.maxAttempts = positiveInteger(maxAttempts, "agent failure maxAttempts");
    if (this.attemptCount > this.maxAttempts) {
      throw new Error("agent failure attemptCount must not exceed maxAttempts");
    }
    if (this.providerCompletionEvidence !== null) {
      this.providerCompletionEvidence = this.providerCompletionEvidence.withAttempts(attemptCount, maxAttempts);
    }
    return this;
  }

  attachDiagnosticLog(diagnosticLog) {
    if (typeof diagnosticLog !== "string" || diagnosticLog.trim() === "") {
      throw new Error("agent diagnostic log path must be a non-empty string");
    }
    this.diagnosticLog = diagnosticLog;
    if (this.providerCompletionEvidence !== null) {
      this.message = utf8Prefix(
        `diagnosticLog=${diagnosticLog} | ${this.message}`,
        MAX_DURABLE_AGENT_FAILURE_MESSAGE_BYTES,
      );
    } else {
      this.message += ` | diagnosticLog=${diagnosticLog}`;
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
      ...(this.providerCompletionEvidence === null ? {} : {
        providerCompletionEvidence: this.providerCompletionEvidence.toJSON(),
      }),
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
    const providerCompletionEvidence = error?.providerCompletionEvidence == null
      ? null
      : AgentProviderCompletionEvidence.from(error.providerCompletionEvidence);
    const input = {
      message: text || "unknown agent provider failure",
      cause: error,
      providerCompletionEvidence,
    };

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

    if (/\bENOTFOUND\b/.test(codes) || /could not resolve (?:host|hostname)|name or service not known/i.test(text)) {
      return new PermanentNetworkFailure(input);
    }

    const normalProviderCompletion = providerCompletionEvidence === null
      || providerCompletionEvidence.signal === null;

    if (normalProviderCompletion
      && /\b429\b|rate[ -]?limit(?:ed|ing)?|too many requests/i.test(text)) {
      return new TemporaryRateLimitFailure(input);
    }

    if (normalProviderCompletion
      && (/\bEAI_AGAIN\b/.test(codes) || /temporary failure in name resolution|temporary dns/i.test(text))) {
      return new TemporaryNetworkFailure(input);
    }

    if (
      error?.code === "AGENT_TIMEOUT"
      || (providerCompletionEvidence === null && (
        error?.signal === "SIGTERM"
        || error?.killed === true
        || /\btimed? out\b|\btimeout\b/i.test(text)
      ))
    ) return new AgentTimeoutFailure({ ...input, stopEvidence: error?.stopEvidence ?? null });

    if (normalProviderCompletion
      && /empty response|no candidates? returned|empty candidates?/i.test(text)) {
      return new EmptyAgentResponseFailure({
        ...input,
        message: text ? `agent returned no response: ${text}` : "agent returned no response",
      });
    }

    if (providerCompletionEvidence !== null && providerCompletionEvidence.signal === null) {
      if (
        /selected model is at capacity|\bcapacity\b|overloaded|temporarily unavailable|(?:api[_ -]?error[_ -]?status|(?:http|api)(?: status)?)\s*[=:]?\s*(?:503|529)\b|\b(?:503|529)\s+(?:service unavailable|overloaded)\b/i.test(text)
      ) return new TemporaryProviderUnavailableFailure(input);
      if (providerCompletionEvidence.exitCode !== 0) {
        return new UnclassifiedProviderExitFailure(input);
      }
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

export class TemporaryProviderUnavailableFailure extends AgentFailure {
  constructor(input = {}) {
    const evidence = AgentProviderCompletionEvidence.from(input.providerCompletionEvidence);
    if (evidence.signal !== null || evidence.exitCode === 0) {
      throw new Error("temporary provider unavailability requires a signal-free non-zero completion");
    }
    super({
      ...input,
      providerCompletionEvidence: evidence,
      kind: "temporary_provider_unavailable",
      code: "AGENT_TEMPORARY_PROVIDER_UNAVAILABLE",
      retryable: true,
      recoveryHint: "Wait for provider capacity to become available, then retry the same input.",
    });
  }
}

export class UnclassifiedProviderExitFailure extends AgentFailure {
  constructor(input = {}) {
    const evidence = AgentProviderCompletionEvidence.from(input.providerCompletionEvidence);
    if (evidence.signal !== null || evidence.exitCode === 0) {
      throw new Error("unclassified provider exit requires a signal-free non-zero completion");
    }
    super({
      ...input,
      providerCompletionEvidence: evidence,
      kind: "unclassified_provider_exit",
      code: "AGENT_UNCLASSIFIED_PROVIDER_EXIT",
      retryable: true,
      recoveryHint: "Retry the same input after the completed provider process exited without a known terminal classification.",
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

/** Canonical policy projected from the stable AgentFailure subclass registry. */
export class AgentFailurePersistenceContract {
  constructor(failure) {
    if (!(failure instanceof AgentFailure)) {
      throw new Error("agent failure persistence contract requires an AgentFailure");
    }
    this.code = failure.code;
    this.kind = failure.kind;
    this.retryable = failure.retryable;
    Object.freeze(this);
  }

  static fromPersisted(value) {
    const failure = restoreStableAgentFailure(value);
    return failure === null ? null : new AgentFailurePersistenceContract(failure);
  }

  assertFacts({ retryable, agentFailureKind = null } = {}) {
    if (typeof retryable !== "boolean") {
      throw new Error("persisted agent failure retryable must be boolean");
    }
    if (retryable !== this.retryable) {
      throw new Error(`persisted ${this.code} retryability contradicts its stable AgentFailure policy`);
    }
    if (agentFailureKind !== null && agentFailureKind !== this.kind) {
      throw new Error(`persisted ${this.code} kind contradicts its stable AgentFailure policy`);
    }
  }
}
