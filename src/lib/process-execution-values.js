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

export class ProcessExecutionControlFailure extends Error {
  constructor(reason, message, { cause, executionId = null, callId = null } = {}) {
    super(message, { cause });
    this.name = "ProcessExecutionControlFailure";
    this.code = reason.startsWith("PROCESS_EXECUTION_") ? reason : `PROCESS_EXECUTION_${reason.replace(/-/g, "_").toUpperCase()}`;
    this.reason = reason;
    this.executionId = executionId;
    this.callId = callId;
    this.retryable = false;
  }
  toJSON() {
    return { name: this.name, reason: this.reason, code: this.code, message: this.message,
      executionId: this.executionId, callId: this.callId, retryable: this.retryable };
  }
  static fromStored(value) {
    const restored = new this(value.reason, value.message, { executionId: value.executionId, callId: value.callId });
    if (typeof value.message !== "string" || !isDeepStrictEqual(restored.toJSON(), value)) throw new TypeError("Process control failure has unknown or inconsistent fields");
    if (restored.executionId !== null) executionUuid(restored.executionId, "control failure executionId");
    if (restored.callId !== null) executionUuid(restored.callId, "control failure callId");
    return restored;
  }
  static fromEnvelope(envelope) {
    const value = envelope?.data?.processExecutionControlFailure;
    if (envelope?.ok !== false) return null;
    const code = Array.isArray(envelope.errors)
      ? envelope.errors.find((entry) => entry?.level === "fatal")?.code : null;
    if (value === undefined && !(typeof code === "string" && code.startsWith("PROCESS_EXECUTION_"))) return null;
    try {
      const failure = this.fromStored(value);
      if (code !== failure.code) throw new TypeError("Failure envelope code differs from its typed data");
      return failure;
    } catch (cause) {
      throw new this("failure-envelope-invalid", "Typed process control failure envelope is invalid", { cause });
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
