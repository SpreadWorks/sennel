import { AgentFileInputFailure } from "./agent-file-input-failure.js";

function count(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  return value;
}

export class EvaluationUnavailable {
  constructor(kind, reason) {
    if (!["file-read-failed", "context-limit", "evaluation-failed"].includes(kind)
      || typeof reason !== "string" || !reason.trim()) throw new TypeError("Evaluation unavailable requires a supported kind and non-empty reason");
    this.kind = kind;
    this.reason = reason.trim();
    Object.freeze(this);
  }
  get retryable() { return false; }
  static from(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "kind,reason") throw new TypeError("evaluationUnavailable requires exactly kind and reason");
    switch (value.kind) {
      case "file-read-failed": return new FileReadUnavailable(value.reason);
      case "context-limit": return new ContextLimitUnavailable(value.reason);
      case "evaluation-failed": return new EvaluationFailedUnavailable(value.reason);
      default: throw new TypeError("Unsupported evaluationUnavailable.kind");
    }
  }
}
export class FileReadUnavailable extends EvaluationUnavailable {
  constructor(reason) { super("file-read-failed", reason); }
  get retryable() { return true; }
}
export class ContextLimitUnavailable extends EvaluationUnavailable {
  constructor(reason) { super("context-limit", reason); }
}
export class EvaluationFailedUnavailable extends EvaluationUnavailable {
  constructor(reason) { super("evaluation-failed", reason); }
}

export class AgentResponseAttemptEvidence {
  constructor(input = {}) {
    this.attempt = count(input.attempt, "response attempt", 1);
    if (input.responseAttemptOrdinal !== undefined && input.responseAttemptOrdinal !== this.attempt) {
      throw new TypeError("Protocol response ordinal must match attempt");
    }
    this.responseAttemptOrdinal = this.attempt;
    for (const field of ["repair", "fresh", "providerCalled"]) {
      if (input[field] !== undefined && typeof input[field] !== "boolean") throw new TypeError(`Protocol ${field} must be boolean`);
    }
    this.repair = input.repair === true;
    this.retryKind = input.retryKind ?? (this.repair ? "format" : null);
    if (![null, "format", "file-read"].includes(this.retryKind)
      || this.repair !== (this.retryKind === "format")) throw new TypeError("Protocol attempt retry kind must match format repair");
    if (typeof input.cacheOutcome !== "string" || !input.cacheOutcome.trim()) throw new TypeError("cacheOutcome must be non-empty");
    this.cacheOutcome = input.cacheOutcome;
    this.fresh = input.fresh === true;
    this.providerCalled = input.providerCalled ?? this.cacheOutcome !== "hit";
    this.providerAttemptCount = count(input.providerAttemptCount ?? (this.providerCalled ? this.attempt : 0), "provider attempt count");
    this.responseCallCount = count(input.responseCallCount ?? this.attempt, "response call count");
    this.failureKind = input.failureKind ?? null;
    this.reason = input.reason ?? null;
    this.error = input.error ? String(input.error) : null;
    if (this.failureKind !== null && (typeof this.failureKind !== "string" || !this.failureKind.trim()
      || typeof this.reason !== "string" || !this.reason.trim())) throw new TypeError("Failed protocol attempt requires a kind and reason");
    if (this.failureKind === null && (this.reason !== null || this.error !== null)) throw new TypeError("Accepted protocol attempt cannot contain failure details");
    Object.freeze(this);
  }
  withError(error, failureKind = error.data?.failureMode ?? "format-failure") {
    return new this.constructor({ ...this.toJSON(), failureKind, reason: error.message, error: error.message });
  }
  toJSON() { return { ...this }; }
}

export class AgentResponseGroupEvidence {
  constructor(input) {
    if (typeof input.groupIdentity !== "string" || !input.groupIdentity) throw new TypeError("Protocol evidence requires group identity");
    this.groupIdentity = input.groupIdentity;
    this.inputDigest = input.inputDigest ?? null;
    this.inputByteLength = input.inputByteLength ?? null;
    if ((this.inputDigest === null) !== (this.inputByteLength === null)
      || (this.inputDigest !== null && (!/^[a-f0-9]{64}$/.test(this.inputDigest)
        || !Number.isSafeInteger(this.inputByteLength) || this.inputByteLength < 0))) throw new TypeError("Protocol input evidence requires digest and byte length together");
    if (!Array.isArray(input.attempts)) throw new TypeError("Protocol evidence requires attempts");
    this.attempts = Object.freeze(input.attempts.map((attempt) => new AgentResponseAttemptEvidence(attempt)));
    if (!["accepted", "failed"].includes(input.outcome) || typeof input.stopReason !== "string" || !input.stopReason) throw new TypeError("Protocol evidence requires final outcome and stop reason");
    this.outcome = input.outcome;
    this.stopReason = input.stopReason;
    this.providerAttemptCount = count(input.providerAttemptCount, "group provider count");
    this.responseCallCount = count(input.responseCallCount, "group response count");
    if (this.outcome === "accepted" && (!this.attempts.length || this.attempts.at(-1).failureKind !== null)) {
      throw new TypeError("Accepted protocol evidence requires an accepted response attempt");
    }
    if (this.attempts.length && (this.attempts.at(-1).providerAttemptCount !== this.providerAttemptCount
      || this.attempts.at(-1).responseCallCount !== this.responseCallCount)) throw new TypeError("Protocol final counts must match the last response attempt");
    if (!this.attempts.length && (this.providerAttemptCount !== 0 || this.responseCallCount !== 0)) {
      throw new TypeError("Protocol evidence without responses cannot contain execution counts");
    }
    let previousProviderCount = 0;
    let previousResponseCount = 0;
    for (const [index, attempt] of this.attempts.entries()) {
      if (attempt.attempt !== index + 1 || attempt.providerAttemptCount < previousProviderCount
        || attempt.responseCallCount <= previousResponseCount
        || attempt.providerAttemptCount > this.providerAttemptCount
        || attempt.responseCallCount > this.responseCallCount) throw new TypeError("Protocol attempt evidence counts must preserve group order and totals");
      previousProviderCount = attempt.providerAttemptCount;
      previousResponseCount = attempt.responseCallCount;
    }
    Object.freeze(this);
  }
  toJSON() { return { ...this, attempts: this.attempts.map((attempt) => attempt.toJSON()) }; }
}

export class AgentResponseProtocolEvidence {
  constructor({ groups }) {
    if (!Array.isArray(groups)) throw new TypeError("Protocol evidence requires groups");
    this.groups = Object.freeze(groups.map((group) => group instanceof AgentResponseGroupEvidence ? group : new AgentResponseGroupEvidence(group)));
    if (new Set(this.groups.map((group) => group.groupIdentity)).size !== this.groups.length) throw new TypeError("Protocol evidence group identities must be unique");
    Object.freeze(this);
  }
  static from(value) { return value instanceof AgentResponseProtocolEvidence ? value : new AgentResponseProtocolEvidence(value); }
  get hasFileInput() { return this.groups.some((group) => group.inputDigest !== null); }
  toJSON() { return { groups: this.groups.map((group) => group.toJSON()) }; }
}

export class AgentResponseProtocolFailure extends Error {
  constructor({ cause, failureMode, evidence }) {
    super(cause.message, { cause });
    this.name = "AgentResponseProtocolFailure";
    this.evidence = evidence;
    this.data = Object.freeze({ failureMode, responseProtocolEvidence: evidence });
  }
}

export class AgentResponseProtocolResult {
  constructor(value, evidence) { this.value = value; this.evidence = evidence; Object.freeze(this); }
}

/** One response loop; provider transport admission stays with the injected executor. */
export async function executeAgentResponseProtocol({ callAgent, parseResponse,
  groupIdentity, fileReference = null, validateInput = null, accounting = null,
  freshRepairAvailable = true, maxFormatRetries = 1, maxFileReadRetries = 0 }) {
  const attempts = [];
  let formatRetries = 0;
  let fileReadRetries = 0;
  let retryKind = null;
  let originalError = null;
  let fallbackProviderCount = 0;
  const counts = () => accounting ? accounting.snapshot() : {
    providerAttemptCount: fallbackProviderCount, responseCallCount: attempts.length,
  };
  const evidence = (outcome, stopReason) => new AgentResponseProtocolEvidence({ groups: [new AgentResponseGroupEvidence({
    groupIdentity, inputDigest: fileReference?.digest ?? null, inputByteLength: fileReference?.byteLength ?? null,
    attempts, outcome, stopReason, ...counts(),
  })] });
  const fail = (cause, failureMode) => { throw new AgentResponseProtocolFailure({ cause, failureMode, evidence: evidence("failed", failureMode) }); };
  for (;;) {
    if (retryKind && freshRepairAvailable !== true) fail(originalError, "freshness_unavailable");
    try { validateInput?.(); } catch (error) { fail(error, "local_input_failure"); }
    const request = { attempt: attempts.length + 1, repair: retryKind === "format", retryKind,
      cacheMode: retryKind ? "bypass" : "default" };
    let raw;
    const providerCountBeforeCall = counts().providerAttemptCount;
    try { raw = await callAgent(request); } catch (error) {
      const denied = error.code === "PROMPT_CALL_LIMIT_EXCEEDED";
      const localInput = error instanceof AgentFileInputFailure;
      if (!accounting && !denied) fallbackProviderCount += error.attemptCount ?? 1;
      // An admission denial before callAgent is not another response attempt.
      if (!accounting || accounting.responseCallCount > (attempts.at(-1)?.responseCallCount ?? 0)) {
        attempts.push(new AgentResponseAttemptEvidence({ ...request, cacheOutcome: retryKind ? "bypass" : "provider_error",
          fresh: Boolean(retryKind), providerCalled: counts().providerAttemptCount > providerCountBeforeCall, ...counts(),
          responseCallCount: accounting?.responseCallCount ?? request.attempt,
          failureKind: localInput ? "local-input" : denied ? "provider-call-limit" : error.kind ?? "provider-failure", reason: error.message, error: error.message }));
      }
      fail(error, localInput ? "local_input_failure" : denied ? "provider_call_limit_exhausted" : "provider_failure");
    }
    const structured = raw && typeof raw === "object" && !Array.isArray(raw);
    const providerCalled = structured ? raw.providerCalled ?? true : true;
    if (!accounting && providerCalled) fallbackProviderCount += structured ? raw.providerAttemptCount ?? 1 : 1;
    const entry = new AgentResponseAttemptEvidence({ ...request,
      cacheOutcome: structured ? raw.cacheOutcome ?? request.cacheMode : request.cacheMode,
      fresh: structured ? raw.fresh : Boolean(retryKind), providerCalled,
      ...counts(), responseCallCount: accounting?.responseCallCount ?? request.attempt });
    attempts.push(entry);
    if (retryKind && !entry.fresh) fail(originalError, "cached_replay");
    let parsed;
    try { parsed = parseResponse(structured ? String(raw.text ?? "") : String(raw)); } catch (error) {
      attempts[attempts.length - 1] = entry.withError(error);
      originalError ||= error;
      if (formatRetries >= maxFormatRetries) fail(originalError, originalError.data?.failureMode ?? "schema_validation_failure");
      formatRetries += 1;
      retryKind = "format";
      continue;
    }
    if (parsed instanceof EvaluationUnavailable) {
      const error = new Error(parsed.reason);
      attempts[attempts.length - 1] = entry.withError(error, parsed.kind);
      originalError ||= error;
      if (!(parsed instanceof FileReadUnavailable)) fail(error, parsed instanceof ContextLimitUnavailable ? "context_limit" : "evaluation_failed");
      if (fileReadRetries >= maxFileReadRetries) fail(error, maxFileReadRetries ? "file_read_retry_exhausted" : "file_read_failure");
      fileReadRetries += 1;
      retryKind = "file-read";
      continue;
    }
    return new AgentResponseProtocolResult(parsed, evidence("accepted", attempts.length > 1 ? "recovered" : "accepted"));
  }
}
