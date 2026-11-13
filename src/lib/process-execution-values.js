import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { AgentProcessStopEvidence } from "./agent-failure.js";
import { ManagedStopOperationValue } from "./managed-stop-operation-value.js";
import { ProcessExecutionInvocationDisclosure } from "./process-execution-invocation.js";
export { ProcessExecutionInvocationDisclosure } from "./process-execution-invocation.js";
import { ProcessExecutionReservationRevocation, ProcessExecutionCallClosure } from "./process-execution-reservation-revocation.js";
import { FileIdentity } from "./file-identity.js";
import { ProcessCheckoutEvidenceEncoding } from "./process-checkout-evidence-encoding.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function executionUuid(value, name) {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${name} must be a UUID`);
  return value;
}
export function executionValueSnapshot(value) { return value == null ? null : JSON.parse(JSON.stringify(value)); }
/** Require the complete restored JSON structure without imposing object-key order. */
export function executionValueExact(value, restored) {
  if (!isDeepStrictEqual(value, executionValueSnapshot(restored))) throw new TypeError("Runtime record has missing or unknown fields");
  return restored;
}
// Only complete graphs frozen here through ordinary own data properties may
// skip another traversal. A class prototype does not change Object.values'
// own-property traversal. Accessors, proxies and cycles remain live on every
// call; private and inherited fields are never visited by this operation.
/** Recent completed freeze proofs. Expired graphs take the full traversal. */
class FrozenExecutionDataCache {
  #current = new WeakSet();
  #previous = new WeakSet();
  #entries = 0;

  has(value) { return this.#current.has(value) || this.#previous.has(value); }

  add(value) {
    if (this.#entries === 16_384) {
      this.#previous = this.#current;
      this.#current = new WeakSet();
      this.#entries = 0;
    }
    this.#current.add(value);
    this.#entries++;
  }
}

const frozenExecutionData = new FrozenExecutionDataCache();
export function freezeExecutionValue(value) {
  const visited = new WeakMap();
  const freeze = (current) => {
    if (current === null || typeof current !== "object") return true;
    if (frozenExecutionData.has(current)) return true;
    if (visited.has(current)) return visited.get(current);
    visited.set(current, false);
    // Indexed native views have their own integrity and resize semantics.
    let reusable = !types.isProxy(current) && !types.isTypedArray(current);
    if (reusable) reusable = Object.keys(current).every((key) => Object.hasOwn(Object.getOwnPropertyDescriptor(current, key), "value"));
    const nestedValues = Object.values(current);
    for (const nested of nestedValues) if (!freeze(nested)) reusable = false;
    Object.freeze(current);
    visited.set(current, reusable);
    if (reusable) frozenExecutionData.add(current);
    return reusable;
  };
  freeze(value);
  return value;
}

function encodedExecutionValueDigest(parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}
export function executionValueDigest(value) { return encodedExecutionValueDigest([JSON.stringify(value)]); }

/** A fresh control reply and a logical wakeup cursor, never authority or an exit proof. */
export class ProcessExecutionControlObservation {
  constructor(value) {
    this.executionId = executionUuid(value.executionId, "control observation execution ID");
    this.callId = executionUuid(value.callId, "control observation call ID");
    if (value.control === null || typeof value.control !== "object" || Array.isArray(value.control)) throw new TypeError("Control observation requires its original control reply");
    this.control = freezeExecutionValue(executionValueSnapshot(value.control));
    if (typeof value.publicationDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.publicationDigest)) throw new TypeError("Control observation cursor is invalid");
    this.publicationDigest = value.publicationDigest;
    executionValueExact(value, this);
    Object.freeze(this);
  }
  matches(executionId, callId) { return this.executionId === executionId && this.callId === callId; }
  toJSON() { return { executionId: this.executionId, callId: this.callId,
    control: executionValueSnapshot(this.control), publicationDigest: this.publicationDigest }; }
  static fromStored(value) { return new this(value); }
}

const composedExecutionValueAuthority = Symbol("composed execution value encoding");
/** One immutable JSON representation and the digest of those exact bytes. */
export class ProcessExecutionValueEncoding {
  #text;
  #parts = null;
  #decodedValue;
  #digest;
  constructor(value, authority = null) {
    if (authority === composedExecutionValueAuthority) {
      this.#parts = Object.freeze(value);
      this.#text = null;
    } else {
      this.#text = JSON.stringify(value);
      if (typeof this.#text !== "string") throw new TypeError("Execution value has no JSON representation");
    }
    // Comparisons need the captured JSON, not a checksum. Keep the original
    // own enumerable digest projection while deriving it only when consumed.
    Object.defineProperty(this, "digest", { enumerable: true,
      get: () => this.#digest ??= encodedExecutionValueDigest([this.#render()]) });
    Object.freeze(this);
  }
  /** Compose captured values without invoking their original serializers again. */
  static array(values) {
    if (!Array.isArray(values)) throw new TypeError("Encoded array requires captured values");
    const parts = ["["];
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (!(value instanceof ProcessExecutionValueEncoding)) throw new TypeError("Encoded array requires captured values");
      if (index !== 0) parts.push(",");
      parts.push(value.#text === null ? value : value.#text);
    }
    parts.push("]");
    return new ProcessExecutionValueEncoding(parts, composedExecutionValueAuthority);
  }
  static object(entries) {
    if (!Array.isArray(entries)) throw new TypeError("Encoded object requires named captured values");
    const fields = Object.create(null);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError("Encoded object requires named captured values");
      const name = entry[0], value = entry[1];
      if (typeof name !== "string" || !(value instanceof ProcessExecutionValueEncoding)
        || Object.hasOwn(fields, name)) throw new TypeError("Encoded object requires distinct string names and captured values");
      fields[name] = value.#text === null ? value : value.#text;
    }
    // Object enumeration keeps JSON.stringify's numeric-key ordering, including
    // keys such as __proto__ that must remain ordinary data properties.
    const parts = ["{"];
    for (const [name, value] of Object.entries(fields)) {
      if (parts.length !== 1) parts.push(",");
      parts.push(JSON.stringify(name), ":", value);
    }
    parts.push("}");
    return new ProcessExecutionValueEncoding(parts, composedExecutionValueAuthority);
  }
  #appendTextParts(parts) {
    if (this.#text !== null) parts.push(this.#text);
    else for (const part of this.#parts) {
      if (typeof part === "string") parts.push(part);
      else part.#appendTextParts(parts);
    }
  }
  #render() {
    if (this.#text === null) {
      const parts = [];
      // Rendering a parent does not retain expanded text in its children.
      // Large request sections keep only their captured value references.
      this.#appendTextParts(parts);
      this.#text = parts.join("");
      this.#parts = null;
    }
    return this.#text;
  }
  text() { return this.#render(); }
  // Callers split encoded JSON only at boundaries that cannot split a UTF-16 pair.
  static digestParts(parts) { return encodedExecutionValueDigest(parts); }
  matches(other) { return other instanceof ProcessExecutionValueEncoding && this.#render() === other.#render(); }
  #decoded() {
    if (this.#decodedValue === undefined) this.#decodedValue = JSON.parse(this.#render());
    return this.#decodedValue;
  }
  #matchesJSON(value) { return isDeepStrictEqual(value, this.#decoded()); }
  /** Compare decoded JSON without invoking or retaining its serializers. */
  matchesJSON(value) { return this.#matchesJSON(value); }
  hasSameValue(other) {
    return other instanceof ProcessExecutionValueEncoding && (this.matches(other)
      || this.#matchesJSON(other.#decoded()));
  }
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

const FAILURE_VERSION = 3;
const DIAGNOSTIC_VERSION = 2;
const MAX_FAILURE_BYTES = 16 * 1024;
export const PROCESS_RUNTIME_RECORD_MIGRATION_REQUIRED = "PROCESS_EXECUTION_RUNTIME_RECORD_MIGRATION_REQUIRED";

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
  // Confirmation must not enlarge an already valid bounded failure. The
  // versioned wire uses false -> true; semantic callers keep the named state.
  toJSON() { return { schemaVersion: this.schemaVersion, operation: this.operation,
    budgetMs: this.budgetMs, elapsedMs: this.elapsedMs, cutoff: this.cutoff, acceptance: this.acceptance,
    stopConfirmed: this.stopConfirmation === "confirmed", attempts: this.attempts.map((attempt) => attempt.toJSON()) }; }
  withStopConfirmation(stopConfirmation) {
    if (this.stopConfirmation === "confirmed" && stopConfirmation !== "confirmed") throw new TypeError("Confirmed communication stop proof cannot be removed");
    return new this.constructor({ ...this, stopConfirmation });
  }
  static fromStored(value) {
    failureFields(value, ["schemaVersion", "operation", "budgetMs", "elapsedMs", "cutoff", "acceptance", "stopConfirmed", "attempts"], "Communication diagnostic");
    if (typeof value.stopConfirmed !== "boolean") throw new TypeError("Communication stop confirmation must be boolean");
    return new this({ ...value, stopConfirmation: value.stopConfirmed ? "confirmed" : "unknown" });
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
  static #instances = new WeakSet();
  constructor(value = null) {
    this.value = freezeExecutionValue(executionValueSnapshot(value instanceof ProcessExecutionBinding ? value.value : value));
    if (this.value !== null && (typeof this.value !== "object" || Array.isArray(this.value))) {
      throw new TypeError("Process execution binding must be an object or null");
    }
    Object.freeze(this);
    if (new.target === ProcessExecutionBinding) ProcessExecutionBinding.#instances.add(this);
  }
  /** Reuse only an immutable instance actually constructed by this class. */
  static from(value) {
    return this === ProcessExecutionBinding && ProcessExecutionBinding.#instances.has(value) ? value : new this(value);
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
  #mainIdentity;
  #checkoutIdentity;
  constructor({ mainRoot, executionRoot, mainDevice, mainInode, checkoutDevice, checkoutInode }) {
    for (const value of [mainRoot, executionRoot]) {
      if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) throw new TypeError("Runtime authority must be an absolute path");
    }
    this.#mainIdentity = FileIdentity.fromStored({ dev: mainDevice, ino: mainInode });
    this.#checkoutIdentity = FileIdentity.fromStored({ dev: checkoutDevice, ino: checkoutInode });
    Object.assign(this, { mainRoot, executionRoot,
      mainDevice: this.#mainIdentity.dev.toString(), mainInode: this.#mainIdentity.ino.toString(),
      checkoutDevice: this.#checkoutIdentity.dev.toString(), checkoutInode: this.#checkoutIdentity.ino.toString() });
    Object.freeze(this);
  }
  matchesRepository(other) {
    return other instanceof ProcessExecutionCheckoutIdentity && this.mainRoot === other.mainRoot
      && this.#mainIdentity.equals(other.#mainIdentity);
  }
  matches(other) { return this.matchesRepository(other) && this.executionRoot === other.executionRoot
    && this.#checkoutIdentity.equals(other.#checkoutIdentity); }
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
  #encodingValue;
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
    // The payload has already been normalized and detached from its producer.
    // Internal encoders can retain this immutable view without making another
    // public, independently mutable payload copy on every serialization.
    this.#encodingValue = freezeExecutionValue({ eventId: this.eventId, executionId: this.executionId, callId: this.callId,
      parentCallId: this.parentCallId, rootCallId: this.rootCallId, sequence: this.sequence, type: this.type,
      binding: this.binding.toJSON(), occurredAt: this.occurredAt, payload: this.payload });
    this.digest = executionValueDigest(this.#encodingValue);
    Object.freeze(this);
  }
  toEncodingValue() { return this.#encodingValue; }
  toJSON() { return { ...this.#encodingValue, binding: this.binding.toJSON(), payload: structuredClone(this.payload) }; }
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

/** Contiguous observations for one physical execution and exact semantic binding. */
export class ProcessExecutionEventGroup {
  constructor(events) {
    if (!Array.isArray(events) || events.length === 0 || events.some((event) => !(event instanceof ProcessExecutionEvent))) {
      throw new TypeError("Process event group requires typed events");
    }
    const first = events[0];
    if (events.some((event) => event.executionId !== first.executionId || !event.binding.matches(first.binding))) {
      throw new TypeError("Process event group requires one execution and exact binding");
    }
    this.events = Object.freeze([...events]);
    Object.freeze(this);
  }
}

/** Every returned publication belongs to one completed canonical transaction. */
export class ProcessExecutionAtomicEventWriter extends ProcessExecutionEventBatchWriter {
  constructor() {
    super();
    if (new.target === ProcessExecutionAtomicEventWriter) throw new TypeError("Atomic event writer requires a publication implementation");
  }
  write(event) {
    const result = this.writeGroup(new ProcessExecutionEventGroup([event]));
    return result?.then === undefined ? result[0] : result.then((publications) => publications[0]);
  }
  writeGroup(_group) { throw new TypeError("Atomic event writer must implement writeGroup"); }
}

export class ProcessExecutionStopReceipt {
  #checkoutEncoding;
  /** Artifact decoding requires an explicit, already acquired encoding proof. */
  static fromArtifact(value, encoding = null) {
    if (encoding !== null && !(encoding instanceof ProcessStopArtifactEncoding)) {
      throw new TypeError("Stop artifact decoding requires a typed encoding");
    }
    if (value instanceof ProcessExecutionStopReceipt) return value;
    return encoding === null ? new this(value) : encoding.receipt(value);
  }
  constructor(value) {
    if (value instanceof ProcessExecutionStopReceipt) value = value.toJSON();
    failureFields(value, ["schemaVersion", "scope", "executionId", "callId", "ownerEpoch", "checkoutIdentity", "binding", "invocation", "invocationDigest",
      "executor", "observation", "output", "closureRevision", "descendants", "stopOperation", "outcomeDigest"], "Registered stop receipt");
    const { schemaVersion, scope, executionId, callId, ownerEpoch, checkoutIdentity, binding, invocation, invocationDigest,
      executor, observation, output, closureRevision, descendants, stopOperation, outcomeDigest } = value;
    if (schemaVersion !== 4 || scope !== "registered-executions") throw new TypeError("Stop receipt requires current evidence encoding; older receipt formats require explicit migration");
    this.schemaVersion = schemaVersion;
    this.scope = scope;
    this.executionId = executionUuid(executionId, "receipt executionId");
    this.callId = executionUuid(callId, "receipt callId");
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) throw new TypeError("Receipt owner epoch is invalid");
    this.ownerEpoch = ownerEpoch;
    this.#checkoutEncoding = new ProcessCheckoutEvidenceEncoding(executionValueSnapshot(checkoutIdentity));
    this.checkoutIdentity = new ProcessExecutionCheckoutIdentity(this.#checkoutEncoding.decimals);
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
    checkoutIdentity: this.#checkoutEncoding.toJSON(), binding: this.binding.toJSON(), invocation: executionValueSnapshot(this.invocation), invocationDigest: this.invocationDigest,
    executor: this.executor.toJSON(), observation: this.observation.toJSON(), output: this.output.toJSON(),
    closureRevision: this.closureRevision, descendants: this.descendants.map((entry) => entry.toJSON()),
    stopOperation: executionValueSnapshot(this.stopOperation), outcomeDigest: this.outcomeDigest }; }
  /** Identity of the actual producer's exit fact, separate from current wire SHA. */
  toEvidenceJSON() {
    const value = this.toJSON();
    if (this.#checkoutEncoding.retained) value.schemaVersion = 3;
    return value;
  }
  get evidenceDigest() { return executionValueDigest(this.toEvidenceJSON()); }
  /** Native artifacts use current wire; an explicit retained value keeps its producer. */
  toArtifactJSON() { return this.toJSON(); }
}

/** Current typed exit observation with separately retained producer serialization. */
class RetainedArtifactProcessStopReceipt extends ProcessExecutionStopReceipt {
  constructor(value) {
    super(value);
    if (this.toEvidenceJSON().schemaVersion !== 3) {
      throw new TypeError("Retained artifact encoding requires its exact previous numeric producer");
    }
  }
  toArtifactJSON() { return this.toEvidenceJSON(); }
}

/** A lookup reference identifies a physical call, never its exit or permission. */
export class ProcessStopArtifactReference {
  constructor(value) {
    this.executionId = executionUuid(value.executionId, "Artifact stop execution ID");
    this.callId = executionUuid(value.callId, "Artifact stop call ID");
    if (!Number.isSafeInteger(value.ownerEpoch) || value.ownerEpoch < 1) {
      throw new TypeError("Artifact stop owner epoch is invalid");
    }
    this.ownerEpoch = value.ownerEpoch;
    Object.freeze(this);
  }
  get digest() { return executionValueDigest([this.executionId, this.ownerEpoch, this.callId]); }
}

/** Pure current proof values acquired by the owning catalog or sealed input reader.
 * This codec performs no IO or old conversion and grants no execution authority.
 */
export class ProcessStopArtifactEncoding {
  #receipts = new Map();
  constructor(receipts) {
    if (!Array.isArray(receipts)) throw new TypeError("Stop artifact encoding requires current receipt proofs");
    for (const value of receipts) {
      const receipt = value instanceof RetainedArtifactProcessStopReceipt ? value
        : new RetainedArtifactProcessStopReceipt(value);
      const key = new ProcessStopArtifactReference(receipt).digest;
      const previous = this.#receipts.get(key);
      if (previous !== undefined && !isDeepStrictEqual(previous.toJSON(), receipt.toJSON())) {
        throw new TypeError("Stop artifact encoding has conflicting producer identities");
      }
      this.#receipts.set(key, receipt);
    }
    Object.freeze(this);
  }
  receipt(value) {
    if (value instanceof ProcessExecutionStopReceipt) return value;
    if (value?.schemaVersion !== 3) return new ProcessExecutionStopReceipt(value);
    // Artifact serializers may reorder object keys. The proof authenticates
    // the complete JSON value; its producer evidence digest remains unchanged.
    const receipt = this.#receipts.get(new ProcessStopArtifactReference(value).digest);
    if (receipt === undefined || !isDeepStrictEqual(value, receipt.toArtifactJSON())) {
      throw new TypeError("Previous artifact receipt lacks its exact current encoding proof");
    }
    return receipt;
  }
  get receipts() { return Object.freeze([...this.#receipts.values()]); }
  toJSON() { return { version: 1, receipts: [...this.#receipts].sort(([a], [b]) => a.localeCompare(b))
    .map(([, receipt]) => receipt.toJSON()) }; }
  static fromJSON(value) {
    failureFields(value, ["version", "receipts"], "Stop artifact encoding");
    if (value.version !== 1) throw new TypeError("Stop artifact encoding version is unsupported");
    return new this(value.receipts);
  }
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
  toEvidenceStored() { return { ...this.toStored(), receipt: this.receipt?.toEvidenceJSON() ?? null,
    revocation: this.revocation?.toEvidenceJSON() ?? null }; }
  toJSON() { return { executionId: this.executionId, callId: this.callId, ownerEpoch: this.ownerEpoch,
    binding: this.binding.toJSON(), invocation: executionValueSnapshot(this.invocation), invocationDigest: this.invocationDigest, startPermitted: this.startPermitted,
    receiptDigest: this.receipt?.evidenceDigest ?? null,
    revocationDigest: this.revocation?.evidenceDigest ?? null }; }
}

/** Durable absence is meaningful only with a complete, exclusively observed inventory. */
export class ProcessExecutionNonExecutionEvidence {
  #checkoutEncoding;
  constructor({ schemaVersion = 2, checkoutIdentity, binding, invocation = null, inventoryDigest, ownerEpoch,
    executions, reservationBeforeSpawn = true }) {
    if (schemaVersion !== 2 || reservationBeforeSpawn !== true) throw new TypeError("Non-execution evidence requires exact checkout identities and durable reservation-before-spawn evidence");
    this.schemaVersion = schemaVersion;
    this.#checkoutEncoding = new ProcessCheckoutEvidenceEncoding(executionValueSnapshot(checkoutIdentity));
    this.checkoutIdentity = new ProcessExecutionCheckoutIdentity(this.#checkoutEncoding.decimals);
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
  toJSON() { return { schemaVersion: this.schemaVersion, checkoutIdentity: this.#checkoutEncoding.toJSON(),
    binding: this.binding.toJSON(), invocation: this.invocation.toJSON(), inventoryDigest: this.inventoryDigest, ownerEpoch: this.ownerEpoch,
    executions: this.executions.map((execution) => execution.toJSON()), reservationBeforeSpawn: this.reservationBeforeSpawn }; }
  toEvidenceJSON() {
    const value = this.toJSON();
    if (this.#checkoutEncoding.retained) value.schemaVersion = 1;
    return value;
  }
  get evidenceDigest() { return executionValueDigest(this.toEvidenceJSON()); }
  static fromStored(value) {
    failureFields(value, ["schemaVersion", "checkoutIdentity", "binding", "invocation", "inventoryDigest", "ownerEpoch", "executions", "reservationBeforeSpawn"], "Non-execution evidence");
    return new this(value);
  }
}

/** Saved inventory observation only. This value has no current-owner or
 * recovery capability; ProcessExecutionRecoveryEvidence owns those guarantees. */
export class ProcessExecutionRecoveryEvidenceSummary {
  #checkoutEncoding;
  constructor(value) {
    failureFields(value, ["schemaVersion", "checkoutIdentity", "binding", "invocation", "inventoryDigest", "ownerEpoch", "calls", "nonExecution"], "Recovery evidence summary");
    if (value.schemaVersion !== 4 || !Number.isSafeInteger(value.ownerEpoch) || value.ownerEpoch < 1
      || !/^[a-f0-9]{64}$/.test(value.inventoryDigest) || !Array.isArray(value.calls)) throw new TypeError("Recovery evidence summary requires its current exact identity contract");
    this.schemaVersion = 4;
    this.#checkoutEncoding = new ProcessCheckoutEvidenceEncoding(value.checkoutIdentity);
    this.checkoutIdentity = new ProcessExecutionCheckoutIdentity(this.#checkoutEncoding.decimals);
    this.binding = new ProcessExecutionBinding(value.binding);
    this.invocation = new ProcessExecutionBinding(value.invocation);
    this.inventoryDigest = value.inventoryDigest;
    this.ownerEpoch = value.ownerEpoch;
    this.calls = freezeExecutionValue(executionValueSnapshot(value.calls));
    this.nonExecution = value.nonExecution === null ? null : ProcessExecutionNonExecutionEvidence.fromStored(value.nonExecution);
    if ((this.calls.length === 0) !== (this.nonExecution !== null)) throw new TypeError("Recovery summary requires exact call or non-execution evidence");
    if (this.nonExecution !== null && (!this.nonExecution.checkoutIdentity.matches(this.checkoutIdentity)
      || !this.nonExecution.binding.matches(this.binding) || !this.nonExecution.invocation.matches(this.invocation)
      || this.nonExecution.inventoryDigest !== this.inventoryDigest || this.nonExecution.ownerEpoch !== this.ownerEpoch)) throw new TypeError("Non-execution summary differs from its inventory");
    executionValueExact(value, this);
    Object.freeze(this);
  }
  static fromSaved(value) {
    const { id, digest, ...summary } = value;
    const restored = new this(summary);
    if (id !== digest || digest !== restored.evidenceDigest) throw new TypeError("Saved recovery observation differs from its exact producer identity");
    return restored;
  }
  toJSON() { return { schemaVersion: this.schemaVersion, checkoutIdentity: this.#checkoutEncoding.toJSON(), binding: this.binding.toJSON(), invocation: this.invocation.toJSON(),
    inventoryDigest: this.inventoryDigest, ownerEpoch: this.ownerEpoch, calls: executionValueSnapshot(this.calls), nonExecution: this.nonExecution?.toJSON() ?? null }; }
  toEvidenceJSON() {
    const value = this.toJSON();
    if (this.#checkoutEncoding.retained) value.schemaVersion = 3;
    value.nonExecution = this.nonExecution?.toEvidenceJSON() ?? null;
    return value;
  }
  get evidenceDigest() { return executionValueDigest(this.toEvidenceJSON()); }
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
  matches(other) { return other instanceof ProcessExecutionStartPermit && isDeepStrictEqual(this.toJSON(), other.toJSON()); }
  toJSON() { return { ...this }; }
}
