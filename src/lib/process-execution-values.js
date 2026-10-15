import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ProcessIdentity } from "./process-identity-values.js";
import { AgentProcessStopEvidence } from "./agent-failure.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function executionUuid(value, name) {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${name} must be a UUID`);
  return value;
}
export function executionValueSnapshot(value) { return value == null ? null : JSON.parse(JSON.stringify(value)); }
export function executionValueDigest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function executionProcessIdentity(value) { return value instanceof ProcessIdentity ? value : new ProcessIdentity(value); }

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
function failurePgid(value, name, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

class ProcessExecutionFailureBirth {
  constructor(value) {
    failureFields(value, ["pid", "bootIdentity", "startFingerprint"], "Failure birth");
    this.pid = failurePgid(value.pid, "Failure birth PID");
    this.bootIdentity = failureText(value.bootIdentity, "Failure boot identity", 256);
    if (this.bootIdentity.trim() === "") throw new TypeError("Failure boot identity is required");
    if (typeof value.startFingerprint !== "string" || !/^\d{1,32}$/.test(value.startFingerprint)) throw new TypeError("Failure birth start fingerprint is invalid");
    this.startFingerprint = value.startFingerprint;
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

/** Public evidence contains birth and observation only, never signaling authority. */
export class ProcessExecutionFailureDiagnostic {
  constructor({ schemaVersion = DIAGNOSTIC_VERSION, executionId, callId, operation, role, birth,
    originalPgid, observedPgid = null, observedSid = null, primaryCause }) {
    if (schemaVersion !== DIAGNOSTIC_VERSION) throw new TypeError("Process failure diagnostic version is unsupported");
    this.schemaVersion = schemaVersion;
    this.executionId = executionUuid(executionId, "Diagnostic executionId");
    this.callId = executionUuid(callId, "Diagnostic callId");
    if (typeof operation !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(operation)) throw new TypeError("Diagnostic operation is invalid");
    if (!["launcher", "provider", "descendant"].includes(role)) throw new TypeError("Diagnostic process role is invalid");
    this.operation = operation; this.role = role;
    this.birth = birth instanceof ProcessExecutionFailureBirth ? birth : new ProcessExecutionFailureBirth(birth);
    this.originalPgid = failurePgid(originalPgid, "Diagnostic original PGID");
    if (role === "launcher" && this.originalPgid !== this.birth.pid) throw new TypeError("Diagnostic launcher must identify its original dedicated group");
    this.observedPgid = failurePgid(observedPgid, "Diagnostic observed PGID", true);
    this.observedSid = failurePgid(observedSid, "Diagnostic observed SID", true);
    if ((this.observedPgid === null) !== (this.observedSid === null)) throw new TypeError("Diagnostic group and session observation must be paired");
    failureFields(primaryCause, ["code", "message"], "Diagnostic primary cause");
    this.primaryCause = Object.freeze(new ProcessExecutionFailureReason(primaryCause));
    Object.freeze(this);
  }
  toJSON() { return { ...this, birth: this.birth.toJSON(), primaryCause: this.primaryCause.toJSON() }; }
  static fromStored(value) {
    failureFields(value, ["schemaVersion", "executionId", "callId", "operation", "role", "birth", "originalPgid", "observedPgid", "observedSid", "primaryCause"], "Process failure diagnostic");
    if (value.schemaVersion !== DIAGNOSTIC_VERSION) throw new TypeError("Process failure diagnostic version is unsupported");
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
    if (!["start", "status", "stop"].includes(operation)) throw new TypeError("Communication operation is invalid");
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
    this.value = executionValueSnapshot(value instanceof ProcessExecutionBinding ? value.value : value);
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

export class ProcessExecutionStopReceipt {
  constructor({ executionId, callId, ownerEpoch, checkoutIdentity, binding, invocation = null, launcherIdentity, pgid, members, stopEvidence, outcomeDigest }) {
    this.executionId = executionUuid(executionId, "receipt executionId");
    this.callId = executionUuid(callId, "receipt callId");
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) throw new TypeError("Receipt owner epoch is invalid");
    this.ownerEpoch = ownerEpoch;
    this.checkoutIdentity = checkoutIdentity instanceof ProcessExecutionCheckoutIdentity ? checkoutIdentity : new ProcessExecutionCheckoutIdentity(checkoutIdentity);
    this.binding = new ProcessExecutionBinding(binding);
    this.invocation = executionValueSnapshot(invocation);
    this.launcherIdentity = launcherIdentity == null ? null : executionProcessIdentity(launcherIdentity);
    if (pgid !== null && (!Number.isSafeInteger(pgid) || pgid < 1)) throw new TypeError("Receipt process group is invalid");
    this.pgid = pgid;
    this.members = members.map(executionProcessIdentity);
    this.stopEvidence = AgentProcessStopEvidence.from(stopEvidence);
    if (!this.stopEvidence.confirmed) throw new TypeError("Receipt requires confirmed termination evidence");
    if (typeof outcomeDigest !== "string" || !/^[0-9a-f]{64}$/.test(outcomeDigest)) throw new TypeError("Receipt outcome digest is invalid");
    this.outcomeDigest = outcomeDigest;
    Object.freeze(this);
  }
  toJSON() { return { executionId: this.executionId, callId: this.callId, ownerEpoch: this.ownerEpoch,
    checkoutIdentity: this.checkoutIdentity.toJSON(), binding: this.binding.toJSON(), invocation: this.invocation, launcherIdentity: this.launcherIdentity, pgid: this.pgid,
    members: this.members, stopEvidence: this.stopEvidence.toJSON(), outcomeDigest: this.outcomeDigest }; }
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
