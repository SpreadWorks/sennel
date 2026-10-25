import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AgentProcessStopEvidence } from "./agent-failure.js";
import { ManagedStopOperationValue } from "./managed-stop-operation-value.js";
import { ProcessExecutionInvocationDisclosure } from "./process-execution-invocation.js";
export { ProcessExecutionInvocationDisclosure } from "./process-execution-invocation.js";
import { ProcessExecutionReservationRevocation, ProcessExecutionCallClosure } from "./process-execution-reservation-revocation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function executionUuid(value, name) {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${name} must be a UUID`);
  return value;
}
export function executionValueSnapshot(value) { return value == null ? null : JSON.parse(JSON.stringify(value)); }
export function freezeExecutionValue(value) {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freezeExecutionValue(nested);
    Object.freeze(value);
  }
  return value;
}
function encodedExecutionValueDigest(text) { return crypto.createHash("sha256").update(text).digest("hex"); }
export function executionValueDigest(value) { return encodedExecutionValueDigest(JSON.stringify(value)); }

/** One immutable JSON representation and the digest of those exact bytes. */
export class ProcessExecutionValueEncoding {
  #text;
  constructor(value) {
    this.#text = JSON.stringify(value);
    if (typeof this.#text !== "string") throw new TypeError("Execution value has no JSON representation");
    this.digest = encodedExecutionValueDigest(this.#text);
    Object.freeze(this);
  }
  text() { return this.#text; }
}

class ProcessExecutionCommandValue {
  constructor(value, reason) {
    this.value = value;
    this.reason = reason;
    if (new.target === ProcessExecutionCommandValue) Object.freeze(this);
  }
  toJSON() { return { value: this.value, reason: this.reason }; }
}

class ProcessExecutionCommandArgument extends ProcessExecutionCommandValue {
  constructor(position) {
    // Argument payloads may contain arbitrary credentials, prompt text or paths.
    // Preserve their exact positions without guessing which contents are public.
    super(null, "not-public");
    this.position = position;
    Object.freeze(this);
  }
  toJSON() { return { position: this.position, ...super.toJSON() }; }
}

/** A disclosure-safe descriptor derived from the actual launcher input. */
export class ProcessExecutionCommandDescriptor {
  constructor(program, args, { cwd, executionRoot } = {}) {
    if (args === undefined && program !== null && typeof program === "object") {
      const value = program;
      const { program: savedProgram, cwd: savedCwd } = value;
      if (!Array.isArray(value.argv) || typeof value.complete !== "boolean"
        || !(savedProgram?.value === null && ["absolute-path", "not-public"].includes(savedProgram.reason)
          || typeof savedProgram?.value === "string" && /^[a-zA-Z0-9_.+-]+$/.test(savedProgram.value) && savedProgram.reason === null)
        || !(savedCwd?.value === null && savedCwd.reason === "not-public"
          || ["inherited", "execution-root"].includes(savedCwd?.value) && savedCwd.reason === null)) throw new TypeError("Public command descriptor contains private input");
      this.program = new ProcessExecutionCommandValue(savedProgram.value, savedProgram.reason);
      this.argv = Object.freeze(value.argv.map((_argument, position) => new ProcessExecutionCommandArgument(position)));
      this.cwd = new ProcessExecutionCommandValue(savedCwd.value, savedCwd.reason);
      this.complete = savedProgram.value !== null && this.argv.length === 0 && savedCwd.reason === null;
      if (!isDeepStrictEqual(value, this.toJSON())) throw new TypeError("Public command descriptor has unknown or private fields");
      Object.freeze(this);
      return;
    }
    const publicProgram = typeof program === "string" && /^[a-zA-Z0-9_.+-]+$/.test(program);
    this.program = new ProcessExecutionCommandValue(publicProgram ? program : null,
      publicProgram ? null : path.isAbsolute(program) ? "absolute-path" : "not-public");
    this.argv = Object.freeze(args.map((_, position) => new ProcessExecutionCommandArgument(position)));
    this.cwd = new ProcessExecutionCommandValue(cwd === undefined ? "inherited" : path.resolve(cwd) === path.resolve(executionRoot)
      ? "execution-root" : null, cwd !== undefined && path.resolve(cwd) !== path.resolve(executionRoot) ? "not-public" : null);
    this.complete = publicProgram && args.length === 0 && this.cwd.reason === null;
    Object.freeze(this);
  }
  toJSON() { return { program: this.program.toJSON(), argv: this.argv.map((argument) => argument.toJSON()), cwd: this.cwd.toJSON(), complete: this.complete }; }
  static fromStored(value) { return new ProcessExecutionCommandDescriptor(value); }
}

/** Wall-clock observations and a separately measured monotonic physical span. */
export class ProcessExecutionTiming {
  constructor({ startAcceptedAt = null, startedAt = null, stopRequestedAt = null, finishedAt = null, durationMs = null } = {}) {
    for (const value of [startAcceptedAt, startedAt, stopRequestedAt, finishedAt]) {
      if (value !== null && (typeof value !== "string" || new Date(value).toISOString() !== value)) throw new TypeError("Process timing requires an ISO timestamp");
    }
    if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs < 0 || startedAt === null || finishedAt === null)) {
      throw new TypeError("Process duration requires a measured start and finish");
    }
    Object.assign(this, { startAcceptedAt, startedAt, stopRequestedAt, finishedAt, durationMs });
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
}

const FAILURE_VERSION = 2;
const DIAGNOSTIC_VERSION = 1;
const MAX_FAILURE_BYTES = 16 * 1024;

function failureFields(value, fields, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new TypeError(`${name} has missing or unknown fields`);
  }
}
function failureText(value, name, maximum = 2048) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maximum) throw new TypeError(`${name} exceeds its bounded text contract`);
  return value;
}
function failureCode(value) {
  if (typeof value !== "string" || !/^PROCESS_EXECUTION_[A-Z0-9_]{1,128}$/.test(value)) throw new TypeError("Process failure cause code is invalid");
  return value;
}
function failureId(value, name) { return value === null ? null : executionUuid(value, name); }
class ProcessExecutionFailureExecutor {
  constructor(value) {
    failureFields(value, ["executorId", "executorSession"], "Failure executor");
    this.executorId = executionUuid(value.executorId, "Failure executor ID");
    this.executorSession = executionUuid(value.executorSession, "Failure executor session");
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
}

class ProcessExecutionFailureReason {
  constructor({ code, message }) {
    this.code = failureCode(code);
    this.message = failureText(message, "Primary failure message");
  }
  toJSON() { return { ...this }; }
}

class ProcessExecutionFailureCause extends ProcessExecutionFailureReason {
  constructor({ code, message, executionId = null, callId = null }) {
    super({ code, message });
    this.executionId = failureId(executionId, "Primary failure executionId");
    this.callId = failureId(callId, "Primary failure callId");
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
  static fromStored(value) {
    failureFields(value, ["code", "message", "executionId", "callId"], "Primary failure cause");
    return new this(value);
  }
}

/** Registered execution diagnostics disclose identity and phase, never capabilities. */
export class ProcessExecutionFailureDiagnostic {
  constructor({ schemaVersion = 2, executionId, callId, operation, role, executor = null, phase, primaryCause }) {
    if (schemaVersion !== 2) throw new TypeError("Process failure diagnostic version is unsupported");
    this.schemaVersion = schemaVersion;
    this.executionId = executionUuid(executionId, "Diagnostic executionId");
    this.callId = executionUuid(callId, "Diagnostic callId");
    if (typeof operation !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(operation)) throw new TypeError("Diagnostic operation is invalid");
    if (!["coordinator", "executor", "descendant"].includes(role)) throw new TypeError("Diagnostic registered role is invalid");
    if (!["reserved", "claimed", "running", "exited", "spawn-failed", "stopped", "unknown"].includes(phase)) throw new TypeError("Diagnostic execution phase is invalid");
    this.operation = operation;
    this.role = role;
    this.phase = phase;
    this.executor = executor === null ? null : executor instanceof ProcessExecutionFailureExecutor ? executor : new ProcessExecutionFailureExecutor(executor);
    if (role !== "coordinator" && this.executor === null) throw new TypeError("Executor diagnostic requires its registered identity");
    failureFields(primaryCause, ["code", "message"], "Diagnostic primary cause");
    this.primaryCause = Object.freeze(new ProcessExecutionFailureReason(primaryCause));
    Object.freeze(this);
  }
  toJSON() { return { ...this, executor: this.executor?.toJSON() ?? null, primaryCause: this.primaryCause.toJSON() }; }
  static fromStored(value) {
    failureFields(value, ["schemaVersion", "executionId", "callId", "operation", "role", "executor", "phase", "primaryCause"], "Process failure diagnostic");
    return new this(value);
  }
}

function communicationTime(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new TypeError(`${name} must be a finite non-negative time`);
  return value;
}

/** Measured transport outcome; no socket errors, request content or authority. */
export class ProcessExecutionCommunicationAttempt {
  constructor({ ordinal, responseDeadlineMs, elapsedMs, outcome }) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 3) throw new TypeError("Communication attempt ordinal is invalid");
    if (!["timeout", "disconnected", "connection-error", "refused", "invalid-response", "aborted", "deadline"].includes(outcome)) throw new TypeError("Communication attempt outcome is invalid");
    this.ordinal = ordinal;
    this.responseDeadlineMs = communicationTime(responseDeadlineMs, "Communication response deadline");
    this.elapsedMs = communicationTime(elapsedMs, "Communication attempt elapsed time");
    this.outcome = outcome;
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
  static fromStored(value) {
    failureFields(value, ["ordinal", "responseDeadlineMs", "elapsedMs", "outcome"], "Communication attempt");
    return new this(value);
  }
}

/** Immutable first communication failure, independently enriched by stop proof. */
export class ProcessExecutionCommunicationDiagnostic {
  constructor({ schemaVersion = DIAGNOSTIC_VERSION, operation, budgetMs, elapsedMs, cutoff,
    acceptance = "unknown", stopConfirmation = "unknown", attempts }) {
    if (schemaVersion !== DIAGNOSTIC_VERSION) throw new TypeError("Communication diagnostic version is unsupported");
    if (typeof operation !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(operation)) throw new TypeError("Communication operation is invalid");
    if (!["budget-exhausted", "operation-deadline", "aborted", "refused"].includes(cutoff)) throw new TypeError("Communication cutoff is invalid");
    if (!["unknown", "accepted", "rejected"].includes(acceptance)) throw new TypeError("Communication acceptance is invalid");
    if (!["unknown", "confirmed"].includes(stopConfirmation)) throw new TypeError("Communication stop confirmation is invalid");
    if (!Array.isArray(attempts) || attempts.length > 3) throw new TypeError("Communication attempts exceed their bounded history");
    this.schemaVersion = schemaVersion;
    this.operation = operation;
    this.budgetMs = communicationTime(budgetMs, "Communication budget");
    this.elapsedMs = communicationTime(elapsedMs, "Communication elapsed time");
    this.cutoff = cutoff;
    this.acceptance = acceptance;
    this.stopConfirmation = stopConfirmation;
    this.attempts = Object.freeze(attempts.map((value) => value instanceof ProcessExecutionCommunicationAttempt ? value : ProcessExecutionCommunicationAttempt.fromStored(value)));
    let previousDeadline = 0;
    for (const [index, attempt] of this.attempts.entries()) {
      if (attempt.ordinal !== index + 1 || attempt.responseDeadlineMs < previousDeadline || attempt.responseDeadlineMs > this.budgetMs
        || attempt.elapsedMs > this.elapsedMs) throw new TypeError("Communication attempt history is inconsistent");
      previousDeadline = attempt.responseDeadlineMs;
    }
    Object.freeze(this);
  }
  toJSON() { return { ...this, attempts: this.attempts.map((attempt) => attempt.toJSON()) }; }
  withStopConfirmation(stopConfirmation) {
    if (this.stopConfirmation === "confirmed" && stopConfirmation !== "confirmed") throw new TypeError("Confirmed communication stop proof cannot be removed");
    return new this.constructor({ ...this, stopConfirmation });
  }
  static fromStored(value) {
    failureFields(value, ["schemaVersion", "operation", "budgetMs", "elapsedMs", "cutoff", "acceptance", "stopConfirmation", "attempts"], "Communication diagnostic");
    return new this(value);
  }
}

export class ProcessExecutionControlFailure extends Error {
  constructor(reason, message, { cause, executionId = null, callId = null, diagnostic = null, primaryCause = null, communication = null } = {}) {
    super(message, { cause });
    if (typeof reason !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(reason) || reason.length > 128) throw new TypeError("Process failure reason is invalid");
    this.name = "ProcessExecutionControlFailure";
    this.schemaVersion = FAILURE_VERSION;
    this.code = reason.startsWith("PROCESS_EXECUTION_") ? reason : `PROCESS_EXECUTION_${reason.replace(/-/g, "_").toUpperCase()}`;
    this.reason = reason;
    failureText(message, "Process failure message");
    const inherited = cause instanceof ProcessExecutionControlFailure ? cause : null;
    const communicationEvidence = communication ?? inherited?.communication ?? null;
    this.communication = communicationEvidence === null ? null : communicationEvidence instanceof ProcessExecutionCommunicationDiagnostic
      ? communicationEvidence : ProcessExecutionCommunicationDiagnostic.fromStored(communicationEvidence);
    const evidence = diagnostic ?? inherited?.diagnostic ?? null;
    this.diagnostic = evidence === null ? null : evidence instanceof ProcessExecutionFailureDiagnostic ? evidence : ProcessExecutionFailureDiagnostic.fromStored(evidence);
    this.executionId = failureId(executionId ?? inherited?.executionId ?? this.diagnostic?.executionId ?? null, "Control failure executionId");
    this.callId = failureId(callId ?? inherited?.callId ?? this.diagnostic?.callId ?? null, "Control failure callId");
    const primary = primaryCause ?? inherited?.primaryCause ?? (this.diagnostic === null ? null : {
      ...this.diagnostic.primaryCause, executionId: this.diagnostic.executionId, callId: this.diagnostic.callId });
    this.primaryCause = new ProcessExecutionFailureCause({ ...(primary ?? { code: this.code, message }),
      executionId: primary?.executionId ?? this.executionId, callId: primary?.callId ?? this.callId });
    if ((this.executionId !== null && this.primaryCause.executionId !== null && this.executionId !== this.primaryCause.executionId)
      || (this.diagnostic !== null && (this.diagnostic.executionId !== this.primaryCause.executionId || this.diagnostic.callId !== this.primaryCause.callId
        || this.diagnostic.primaryCause.code !== this.primaryCause.code || this.diagnostic.primaryCause.message !== this.primaryCause.message))) {
      throw new TypeError("Process failure diagnostic and primary provenance disagree");
    }
    this.retryable = false;
  }
  toJSON() {
    return { schemaVersion: this.schemaVersion, name: this.name, reason: this.reason, code: this.code, message: this.message,
      executionId: this.executionId, callId: this.callId, retryable: this.retryable,
      diagnostic: this.diagnostic?.toJSON() ?? null, primaryCause: this.primaryCause.toJSON(), communication: this.communication?.toJSON() ?? null };
  }
  withCause(cause) {
    return new this.constructor(this.reason, this.message, { cause,
      executionId: this.executionId, callId: this.callId, diagnostic: this.diagnostic,
      primaryCause: this.primaryCause, communication: this.communication });
  }
  withContext({ executionId, callId }) {
    return new this.constructor(this.reason, this.message, { cause: this, executionId, callId });
  }
  withStopConfirmation(stopConfirmation) {
    return new this.constructor(this.reason, this.message, { cause: this,
      communication: this.communication?.withStopConfirmation(stopConfirmation) ?? null });
  }
  static fromStored(value, context = {}) {
    if (value?.schemaVersion !== FAILURE_VERSION) {
      const reason = value?.schemaVersion === undefined ? "failure-evidence-missing" : "failure-evidence-unsupported";
      throw new this(reason, "Process control failure lacks supported versioned evidence", {
        executionId: context.executionId ?? (typeof value?.executionId === "string" && UUID.test(value.executionId) ? value.executionId : null),
        callId: context.callId ?? (typeof value?.callId === "string" && UUID.test(value.callId) ? value.callId : null),
      });
    }
    try {
      failureFields(value, ["schemaVersion", "name", "reason", "code", "message", "executionId", "callId", "retryable", "diagnostic", "primaryCause", "communication"], "Process control failure");
      const restored = new this(value.reason, value.message, { executionId: value.executionId, callId: value.callId,
        diagnostic: value.diagnostic, primaryCause: ProcessExecutionFailureCause.fromStored(value.primaryCause), communication: value.communication });
      if (!isDeepStrictEqual(restored.toJSON(), value) || Buffer.byteLength(JSON.stringify(value)) > MAX_FAILURE_BYTES) throw new TypeError("Process control failure has excessive or inconsistent fields");
      for (const field of ["executionId", "callId"]) if (context[field] !== undefined && restored[field] !== context[field]) throw new TypeError("Process control failure belongs to another physical call");
      return restored;
    } catch (cause) {
      if (context.executionId !== undefined || context.callId !== undefined) throw new this("failure-evidence-invalid", "Process control failure evidence is invalid for its physical call", { ...context, cause });
      throw cause;
    }
  }
  static fromEnvelope(envelope) {
    const value = envelope?.data?.processExecutionControlFailure;
    if (envelope?.ok !== false) return null;
    const code = Array.isArray(envelope.errors)
      ? envelope.errors.find((entry) => entry?.level === "fatal")?.code : null;
    if (value === undefined && !(typeof code === "string" && code.startsWith("PROCESS_EXECUTION_"))) return null;
    let failure = null;
    try {
      failure = this.fromStored(value);
      if (code !== failure.code) throw new TypeError("Failure envelope code differs from its typed data");
      return failure;
    } catch (cause) {
      const primary = failure ?? (cause instanceof this ? cause : null);
      throw new this("failure-envelope-invalid", "Typed process control failure envelope is invalid", { cause,
        executionId: primary?.executionId ?? null, callId: primary?.callId ?? null,
        diagnostic: primary?.diagnostic ?? null, primaryCause: primary?.primaryCause ?? null, communication: primary?.communication ?? null });
    }
  }
}

/** Opaque semantic binding: the process layer stores and compares it, never interprets it. */
export class ProcessExecutionBinding {
  constructor(value = null) {
    this.value = freezeExecutionValue(executionValueSnapshot(value instanceof ProcessExecutionBinding ? value.value : value));
    if (this.value !== null && (typeof this.value !== "object" || Array.isArray(this.value))) {
      throw new TypeError("Process execution binding must be an object or null");
    }
    Object.freeze(this);
  }
  toJSON() { return executionValueSnapshot(this.value); }
  matches(other) { return other instanceof ProcessExecutionBinding && isDeepStrictEqual(this.value, other.value); }
  includes(other) {
    if (!(other instanceof ProcessExecutionBinding)) return false;
    if (other.value === null || this.value === null) return this.matches(other);
    return Object.entries(other.value).every(([name, value]) => isDeepStrictEqual(this.value[name], value));
  }
  get digest() { return executionValueDigest(this.value); }
}

export class ProcessExecutionCheckoutIdentity {
  constructor({ mainRoot, executionRoot, mainDevice, mainInode, checkoutDevice, checkoutInode }) {
    for (const value of [mainRoot, executionRoot]) {
      if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) throw new TypeError("Runtime authority must be an absolute path");
    }
    for (const value of [mainDevice, mainInode, checkoutDevice, checkoutInode]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Runtime directory identity is invalid");
    }
    Object.assign(this, { mainRoot, executionRoot, mainDevice, mainInode, checkoutDevice, checkoutInode });
    Object.freeze(this);
  }
  matchesRepository(other) {
    return other instanceof ProcessExecutionCheckoutIdentity && this.mainRoot === other.mainRoot
      && this.mainDevice === other.mainDevice && this.mainInode === other.mainInode;
  }
  matches(other) { return other instanceof ProcessExecutionCheckoutIdentity && isDeepStrictEqual(this.toJSON(), other.toJSON()); }
  toJSON() { return { ...this }; }
}

/** Logical ownership of an actual ChildProcess handle, independent of OS PID. */
export class ProcessExecutorIdentity {
  constructor({ executorId, executorSession, launchClaim }) {
    this.executorId = executionUuid(executorId, "executor ID");
    this.executorSession = executionUuid(executorSession, "executor session");
    this.launchClaim = executionUuid(launchClaim, "executor launch claim");
    Object.freeze(this);
  }
  matches(other) {
    return other instanceof ProcessExecutorIdentity && isDeepStrictEqual(this.toJSON(), other.toJSON());
  }
  toJSON() { return { ...this }; }
  static fromStored(value) {
    failureFields(value, ["executorId", "executorSession", "launchClaim"], "Executor identity");
    return new this(value);
  }
}

/** Only the handle owner may report an observed exit or a failed spawn. */
export class ChildExitObservation {
  constructor({ executor, kind, code = null, signal = null, errorCode = null, observedAt }) {
    this.executor = executor instanceof ProcessExecutorIdentity ? executor : ProcessExecutorIdentity.fromStored(executor);
    if (!["exited", "spawn-failed"].includes(kind)) throw new TypeError("Child observation must prove exit or spawn failure");
    if (code !== null && (!Number.isSafeInteger(code) || code < 0)) throw new TypeError("Child exit code is invalid");
    if (signal !== null && (typeof signal !== "string" || !/^SIG[A-Z0-9]+$/.test(signal))) throw new TypeError("Child exit signal is invalid");
    if (errorCode !== null && (typeof errorCode !== "string" || errorCode.length > 128)) throw new TypeError("Child spawn error code is invalid");
    if (typeof observedAt !== "string" || new Date(observedAt).toISOString() !== observedAt) throw new TypeError("Child observation time is invalid");
    if (kind === "exited" && (code === null) === (signal === null)) throw new TypeError("An exited child requires exactly one exit code or signal");
    if (kind === "spawn-failed" && (code !== null || signal !== null || errorCode === null)) throw new TypeError("Spawn failure must have an error and no exit");
    Object.assign(this, { kind, code, signal, errorCode, observedAt });
    Object.freeze(this);
  }
  toJSON() { return { executor: this.executor.toJSON(), kind: this.kind, code: this.code, signal: this.signal,
    errorCode: this.errorCode, observedAt: this.observedAt }; }
  static fromStored(value) {
    failureFields(value, ["executor", "kind", "code", "signal", "errorCode", "observedAt"], "Child exit observation");
    return new this(value);
  }
}

/** Exit and output completion are distinct durable observations. */
export class ProcessOutputState {
  constructor({ stdoutBytes, stderrBytes, completion, cutoffAt }) {
    for (const bytes of [stdoutBytes, stderrBytes]) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("Process output byte count is invalid");
    }
    if (!["complete", "truncated", "incomplete"].includes(completion)) throw new TypeError("Process output completion is invalid");
    if (typeof cutoffAt !== "string" || new Date(cutoffAt).toISOString() !== cutoffAt) throw new TypeError("Process output cutoff is invalid");
    Object.assign(this, { stdoutBytes, stderrBytes, completion, cutoffAt });
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
  static fromStored(value) {
    failureFields(value, ["stdoutBytes", "stderrBytes", "completion", "cutoffAt"], "Process output state");
    return new this(value);
  }
}

export const PROCESS_EXECUTION_EVENT_TYPES = Object.freeze([
  "reserved", "started", "spawn-failed", "exited", "stop-requested", "stop-unconfirmed", "result-finalized",
]);

/** Immutable runtime fact; its injected consumer owns canonical publication. */
export class ProcessExecutionEvent {
  constructor({ eventId, executionId, callId, parentCallId, rootCallId, sequence, type, binding, occurredAt, payload }) {
    this.eventId = executionUuid(eventId, "process event ID");
    this.executionId = executionUuid(executionId, "process event execution ID");
    this.callId = executionUuid(callId, "process event call ID");
    this.parentCallId = parentCallId === null ? null : executionUuid(parentCallId, "process event parent call ID");
    this.rootCallId = executionUuid(rootCallId, "process event root call ID");
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError("Process event sequence is invalid");
    if (!PROCESS_EXECUTION_EVENT_TYPES.includes(type)) throw new TypeError("Process event type is invalid");
    if (typeof occurredAt !== "string" || new Date(occurredAt).toISOString() !== occurredAt) throw new TypeError("Process event timestamp is invalid");
    this.sequence = sequence; this.type = type;
    this.binding = new ProcessExecutionBinding(binding);
    this.occurredAt = occurredAt;
    this.payload = freezeExecutionValue(executionValueSnapshot(payload));
    this.digest = executionValueDigest(this.toJSON());
    Object.freeze(this);
  }
  toJSON() { return { eventId: this.eventId, executionId: this.executionId, callId: this.callId,
    parentCallId: this.parentCallId, rootCallId: this.rootCallId, sequence: this.sequence, type: this.type,
    binding: this.binding.toJSON(), occurredAt: this.occurredAt, payload: executionValueSnapshot(this.payload) }; }
  static fromStored(value) {
    failureFields(value, ["eventId", "executionId", "callId", "parentCallId", "rootCallId", "sequence", "type", "binding", "occurredAt", "payload"], "Process execution event");
    return new this(value);
  }
}

class ProcessExecutionEventPublicationIdentity {
  constructor({ eventId, eventDigest }) {
    this.eventId = executionUuid(eventId, "published process event ID");
    if (typeof eventDigest !== "string" || !/^[a-f0-9]{64}$/.test(eventDigest)) throw new TypeError("Published process event digest is invalid");
    this.eventDigest = eventDigest;
    Object.freeze(this);
  }
  matches(event) { return event instanceof ProcessExecutionEvent && event.eventId === this.eventId && event.digest === this.eventDigest; }
  toJSON() { return { eventId: this.eventId, eventDigest: this.eventDigest }; }
}

/** A canonical writer returns this only after exact durable publication. */
export class ProcessExecutionCanonicalAcknowledgement extends ProcessExecutionEventPublicationIdentity {
  static fromEvent(event) {
    if (!(event instanceof ProcessExecutionEvent)) throw new TypeError("Canonical acknowledgement requires a typed process event");
    return new ProcessExecutionCanonicalAcknowledgement({ eventId: event.eventId, eventDigest: event.digest });
  }
  static fromStored(value) {
    failureFields(value, ["eventId", "eventDigest"], "Canonical process event acknowledgement");
    return new ProcessExecutionCanonicalAcknowledgement(value);
  }
}

/** The owning semantic adapter explicitly keeps this event outside canonical history. */
export class ProcessExecutionRuntimeOnlyDisposition extends ProcessExecutionEventPublicationIdentity {
  static fromEvent(event) {
    if (!(event instanceof ProcessExecutionEvent)) throw new TypeError("Runtime-only disposition requires a typed process event");
    return new ProcessExecutionRuntimeOnlyDisposition({ eventId: event.eventId, eventDigest: event.digest });
  }
  static fromStored(value) {
    failureFields(value, ["eventId", "eventDigest"], "Runtime-only process event disposition");
    return new ProcessExecutionRuntimeOnlyDisposition(value);
  }
}

/** Durable event writer whose next publication does not depend on prior coordinator ACKs.
 * Writers commit events in order and return their exact typed publication. The runtime
 * may acknowledge a contiguous group only after those independent publications finish.
 */
export class ProcessExecutionEventBatchWriter {
  constructor() {
    if (new.target === ProcessExecutionEventBatchWriter) throw new TypeError("Event batch writer requires a publication implementation");
  }
  write(_event) { throw new TypeError("Event batch writer must implement write"); }
}

export class ProcessExecutionStopReceipt {
  constructor(value) {
    if (value instanceof ProcessExecutionStopReceipt) value = value.toJSON();
    failureFields(value, ["schemaVersion", "scope", "executionId", "callId", "ownerEpoch", "checkoutIdentity", "binding", "invocation", "invocationDigest",
      "executor", "observation", "output", "closureRevision", "descendants", "stopOperation", "outcomeDigest"], "Registered stop receipt");
    const { schemaVersion, scope, executionId, callId, ownerEpoch, checkoutIdentity, binding, invocation, invocationDigest,
      executor, observation, output, closureRevision, descendants, stopOperation, outcomeDigest } = value;
    if (schemaVersion !== 3 || scope !== "registered-executions") throw new TypeError("Stop receipt requires the public invocation digest contract; older receipt formats require explicit maintenance");
    this.schemaVersion = schemaVersion;
    this.scope = scope;
    this.executionId = executionUuid(executionId, "receipt executionId");
    this.callId = executionUuid(callId, "receipt callId");
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) throw new TypeError("Receipt owner epoch is invalid");
    this.ownerEpoch = ownerEpoch;
    this.checkoutIdentity = checkoutIdentity instanceof ProcessExecutionCheckoutIdentity ? checkoutIdentity : new ProcessExecutionCheckoutIdentity(checkoutIdentity);
    this.binding = new ProcessExecutionBinding(binding);
    const disclosure = new ProcessExecutionInvocationDisclosure({ invocation, invocationDigest });
    this.invocation = disclosure.invocation; this.invocationDigest = disclosure.invocationDigest;
    this.executor = executor instanceof ProcessExecutorIdentity ? executor : ProcessExecutorIdentity.fromStored(executor);
    this.observation = observation instanceof ChildExitObservation ? observation : ChildExitObservation.fromStored(observation);
    if (!this.executor.matches(this.observation.executor)) throw new TypeError("Exit observation belongs to another handle owner");
    this.output = output instanceof ProcessOutputState ? output : ProcessOutputState.fromStored(output);
    if (!Number.isSafeInteger(closureRevision) || closureRevision < 1) throw new TypeError("Receipt closure revision is invalid");
    this.closureRevision = closureRevision;
    if (!Array.isArray(descendants)) throw new TypeError("Receipt descendants must be an array");
    this.descendants = Object.freeze(descendants.map((entry) => ProcessExecutionCallClosure.fromStored(entry)));
    if (this.descendants.some((entry) => entry.callId === this.callId)
      || new Set(this.descendants.map((entry) => entry.callId)).size !== this.descendants.length) throw new TypeError("Receipt descendant inventory is cyclic or duplicated");
    this.stopOperation = stopOperation === null ? null : ManagedStopOperationValue.fromStored(stopOperation);
    this.stopEvidence = new AgentProcessStopEvidence({ status: "confirmed", reason: "registered-child-exit-observed" });
    if (typeof outcomeDigest !== "string" || !/^[0-9a-f]{64}$/.test(outcomeDigest)) throw new TypeError("Receipt outcome digest is invalid");
    this.outcomeDigest = outcomeDigest;
    Object.freeze(this);
  }
  toJSON() { return { schemaVersion: this.schemaVersion, scope: this.scope,
    executionId: this.executionId, callId: this.callId, ownerEpoch: this.ownerEpoch,
    checkoutIdentity: this.checkoutIdentity.toJSON(), binding: this.binding.toJSON(), invocation: executionValueSnapshot(this.invocation), invocationDigest: this.invocationDigest,
    executor: this.executor.toJSON(), observation: this.observation.toJSON(), output: this.output.toJSON(),
    closureRevision: this.closureRevision, descendants: this.descendants.map((entry) => entry.toJSON()),
    stopOperation: executionValueSnapshot(this.stopOperation), outcomeDigest: this.outcomeDigest }; }
}

class ProcessExecutionRecoveryOwner {
  constructor(value) {
    failureFields(value, ["executionId", "ownerEpoch", "authorityState"], "Non-execution owner");
    this.executionId = executionUuid(value.executionId, "Non-execution executionId");
    if (!Number.isSafeInteger(value.ownerEpoch) || value.ownerEpoch < 1
      || !["closed", "exclusive"].includes(value.authorityState)) throw new TypeError("Non-execution owner authority is not controlled");
    this.ownerEpoch = value.ownerEpoch;
    this.authorityState = value.authorityState;
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
}

/** Reservation and start permission are separate persisted physical facts. */
export class ProcessExecutionRecoveryCall {
  constructor(value) {
    if (value instanceof ProcessExecutionRecoveryCall) value = value.toStored();
    failureFields(value, ["executionId", "ownerEpoch", "callId", "binding", "invocation", "invocationDigest", "startPermitted", "receipt", "revocation"], "Recovery call");
    const { executionId, ownerEpoch, callId, binding, invocation, invocationDigest, startPermitted, receipt, revocation } = value;
    this.executionId = executionUuid(executionId, "Recovery call executionId");
    this.callId = executionUuid(callId, "Recovery call callId");
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1 || typeof startPermitted !== "boolean") throw new TypeError("Recovery call reservation identity is invalid");
    this.ownerEpoch = ownerEpoch;
    this.binding = new ProcessExecutionBinding(binding);
    const disclosure = new ProcessExecutionInvocationDisclosure({ invocation, invocationDigest });
    this.invocation = disclosure.invocation; this.invocationDigest = disclosure.invocationDigest;
    this.startPermitted = startPermitted;
    this.receipt = receipt === null ? null : receipt instanceof ProcessExecutionStopReceipt ? receipt : new ProcessExecutionStopReceipt(receipt);
    this.revocation = revocation === null ? null : revocation instanceof ProcessExecutionReservationRevocation ? revocation : ProcessExecutionReservationRevocation.fromStored(revocation);
    if (startPermitted ? this.receipt === null || this.revocation !== null : this.receipt !== null || this.revocation === null) throw new TypeError("Recovery call requires its exact child receipt or unclaimed revocation");
    const closure = this.receipt ?? this.revocation;
    if (closure.executionId !== this.executionId || closure.callId !== this.callId
      || closure.ownerEpoch !== this.ownerEpoch || !closure.binding.matches(this.binding)
      || !isDeepStrictEqual(executionValueSnapshot(closure.invocation), executionValueSnapshot(this.invocation)) || closure.invocationDigest !== this.invocationDigest) throw new TypeError("Recovery call differs from its exact closure evidence");
    Object.freeze(this);
  }
  toStored() { return { executionId: this.executionId, callId: this.callId, ownerEpoch: this.ownerEpoch,
    binding: this.binding.toJSON(), invocation: executionValueSnapshot(this.invocation), invocationDigest: this.invocationDigest, startPermitted: this.startPermitted,
    receipt: this.receipt?.toJSON() ?? null, revocation: this.revocation?.toJSON() ?? null }; }
  toJSON() { return { executionId: this.executionId, callId: this.callId, ownerEpoch: this.ownerEpoch,
    binding: this.binding.toJSON(), invocation: executionValueSnapshot(this.invocation), invocationDigest: this.invocationDigest, startPermitted: this.startPermitted,
    receiptDigest: this.receipt === null ? null : executionValueDigest(this.receipt),
    revocationDigest: this.revocation === null ? null : executionValueDigest(this.revocation) }; }
}

/** Durable absence is meaningful only with a complete, exclusively observed inventory. */
export class ProcessExecutionNonExecutionEvidence {
  constructor({ schemaVersion = 1, checkoutIdentity, binding, invocation = null, inventoryDigest, ownerEpoch,
    executions, reservationBeforeSpawn = true }) {
    if (schemaVersion !== 1 || reservationBeforeSpawn !== true) throw new TypeError("Non-execution evidence requires the durable reservation-before-spawn contract");
    this.schemaVersion = schemaVersion;
    this.checkoutIdentity = checkoutIdentity instanceof ProcessExecutionCheckoutIdentity ? checkoutIdentity : new ProcessExecutionCheckoutIdentity(checkoutIdentity);
    this.binding = new ProcessExecutionBinding(binding);
    if (this.binding.value === null || Object.keys(this.binding.value).length === 0) throw new TypeError("Non-execution evidence requires an exact semantic binding");
    this.invocation = new ProcessExecutionBinding(invocation);
    new ProcessExecutionInvocationDisclosure({ invocation: this.invocation.toJSON(), invocationDigest: executionValueDigest(this.invocation.toJSON()) });
    if (this.invocation.value !== null && Object.keys(this.invocation.value).length === 0) throw new TypeError("Non-execution invocation query must not be empty");
    if (typeof inventoryDigest !== "string" || !/^[0-9a-f]{64}$/.test(inventoryDigest)) throw new TypeError("Non-execution inventory digest is invalid");
    this.inventoryDigest = inventoryDigest;
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1 || !Array.isArray(executions)
      || executions.length !== ownerEpoch) throw new TypeError("Non-execution evidence requires the complete owner epoch inventory");
    this.ownerEpoch = ownerEpoch;
    this.executions = Object.freeze(executions.map((execution) => new ProcessExecutionRecoveryOwner(execution)));
    if (this.executions.some((execution, index) => execution.ownerEpoch !== index + 1)) throw new TypeError("Non-execution owner epochs are incomplete");
    if (this.executions.some((execution, index) => execution.authorityState === "exclusive" && index !== this.executions.length - 1)) throw new TypeError("Only the current owner may hold checkout exclusion");
    if (new Set(this.executions.map((execution) => execution.executionId)).size !== this.executions.length) throw new TypeError("Non-execution inventory has duplicate executions");
    this.reservationBeforeSpawn = true;
    Object.freeze(this);
  }
  toJSON() { return { schemaVersion: this.schemaVersion, checkoutIdentity: this.checkoutIdentity.toJSON(),
    binding: this.binding.toJSON(), invocation: this.invocation.toJSON(), inventoryDigest: this.inventoryDigest, ownerEpoch: this.ownerEpoch,
    executions: this.executions.map((execution) => execution.toJSON()), reservationBeforeSpawn: this.reservationBeforeSpawn }; }
  static fromStored(value) {
    failureFields(value, ["schemaVersion", "checkoutIdentity", "binding", "invocation", "inventoryDigest", "ownerEpoch", "executions", "reservationBeforeSpawn"], "Non-execution evidence");
    return new this(value);
  }
}

export class ProcessExecutionStartPermit {
  constructor({ executionId, callId, ownerEpoch, ownerToken, capability, bindingDigest }) {
    this.executionId = executionUuid(executionId, "permit executionId");
    this.callId = executionUuid(callId, "permit callId");
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) throw new TypeError("Permit owner epoch is invalid");
    this.ownerEpoch = ownerEpoch;
    this.ownerToken = executionUuid(ownerToken, "permit owner token");
    this.capability = executionUuid(capability, "permit capability");
    if (typeof bindingDigest !== "string" || !/^[0-9a-f]{64}$/.test(bindingDigest)) throw new TypeError("Permit binding digest is invalid");
    this.bindingDigest = bindingDigest;
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
}
