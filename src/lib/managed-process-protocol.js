import net from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { FileLock, FileLockWaitPolicy } from "./file-lock.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import fs from "node:fs";
import { AtomicFile } from "./atomic-file.js";
import { ProcessIdentity, ProcessIdentitySource } from "./process-identity.js";
import { ProcessExecutionControlFailure, ProcessExecutionFailureDiagnostic,
  ProcessExecutionCommunicationAttempt, ProcessExecutionCommunicationDiagnostic, executionValueDigest, executionUuid,
} from "./process-execution-values.js";
import { readLinuxProcessGroupMembers } from "./process-supervisor.js";
import { ManagedControlPolicy } from "./managed-control-policy.js";
import { managedMonotonicNow } from "./managed-stop-operation.js";

export class ManagedProcessMessage {
  constructor(call, operation, payload = {}, { requestId = randomUUID(), payloadDigest = executionValueDigest(payload) } = {}) {
    const acceptance = new ManagedRequestAcceptance({ requestId, payloadDigest });
    this.executionId = call.executionId;
    this.callId = call.callId;
    this.ownerToken = call.ownerToken;
    this.capability = call.capability;
    this.operation = operation;
    this.payload = payload;
    this.requestId = acceptance.requestId;
    this.payloadDigest = acceptance.payloadDigest;
  }
  matches(call) {
    return this.executionId === call.executionId && this.callId === call.callId
      && this.ownerToken === call.ownerToken && this.capability === call.capability;
  }
  static from(value) {
    let acceptance;
    try { acceptance = new ManagedRequestAcceptance(value); }
    catch {
      throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Managed message lacks its request identity");
    }
    return new ManagedProcessMessage(value, value.operation, value.payload, acceptance);
  }
  respondsTo(request) {
    return this.matches(request) && this.operation === request.operation
      && this.requestId === request.requestId && this.payloadDigest === request.payloadDigest;
  }
  respond(payload) { return new ManagedProcessMessage(this, this.operation, payload, this); }
  assertPayload() {
    if (executionValueDigest(this.payload) !== this.payloadDigest) {
      throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Managed request content does not match its digest");
    }
  }
}

/** Durable admission identifies the request without retaining its environment. */
export class ManagedRequestAcceptance {
  constructor(message) {
    this.requestId = executionUuid(message?.requestId, "Managed request ID");
    if (typeof message.payloadDigest !== "string" || !/^[0-9a-f]{64}$/.test(message.payloadDigest)) {
      throw new TypeError("Managed acceptance requires a request identity and content digest");
    }
    this.payloadDigest = message.payloadDigest;
    Object.freeze(this);
  }
  matches(message) { return this.requestId === message.requestId && this.payloadDigest === message.payloadDigest; }
}

export function managedControlFailure(code, message, cause) {
  return new ProcessExecutionControlFailure(code, message, { cause });
}

function managedRecordLock(file, waitPolicy, deadline) {
  if (Number.isFinite(deadline)) {
    const existing = waitPolicy ?? new FileLockWaitPolicy();
    waitPolicy = new FileLockWaitPolicy({ timeoutMs: Math.min(existing.timeoutMs, Math.floor(Math.max(0, deadline - managedMonotonicNow()))),
      intervalMs: existing.intervalMs });
  }
  return new FileLock({ waitPolicy, directoryAuthority: new RealDirectoryAuthority(path.dirname(file)),
    fileName: `${path.basename(file)}.lock`, kind: "managed-process-record", authority: { file: path.resolve(file) } });
}

export function readManagedBinary(file, { maximum = 16 * 1024 * 1024, waitPolicy, deadline } = {}) {
  try {
    return managedRecordLock(file, waitPolicy, deadline).runExclusive(() => {
      if (new AtomicFile(`${file}.transition`).read() !== null) {
        throw managedControlFailure("PROCESS_EXECUTION_DURABILITY_UNCERTAIN", `Managed record has an incomplete durable write: ${file}`);
      }
      try {
        if (fs.lstatSync(file).size > maximum) throw managedControlFailure("PROCESS_EXECUTION_OUTPUT_CORRUPT", "Managed file exceeds its bounded size");
      } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
      return new AtomicFile(file).read();
    });
  } catch (cause) {
    if (cause instanceof ProcessExecutionControlFailure) throw cause;
    throw managedControlFailure("PROCESS_EXECUTION_RECORD_UNREADABLE", `Managed process record cannot be read: ${file}`, cause);
  }
}

export function readManagedRecord(file, options = {}) {
  const bytes = readManagedBinary(file, options);
  try { return bytes === null ? null : JSON.parse(bytes); }
  catch (cause) { throw managedControlFailure("PROCESS_EXECUTION_RECORD_UNREADABLE", `Managed JSON cannot be read: ${file}`, cause); }
}

export function writeManagedBinary(file, bytes, identity, { faultInjector, waitPolicy, deadline } = {}) {
  try {
    managedRecordLock(file, waitPolicy, deadline).runExclusive(() => {
      const store = new AtomicFile(file, { faultInjector });
      const content = Buffer.from(bytes);
      const transition = new AtomicFile(`${file}.transition`);
      if (transition.read() !== null) throw new Error("Managed record has an incomplete durable write");
      transition.write(JSON.stringify({ executionId: identity.executionId, callId: identity.callId }));
      store.write(content);
      if (!store.read()?.equals(content)) throw new Error("Record readback differs");
      transition.remove();
    });
  } catch (cause) {
    throw managedControlFailure("PROCESS_EXECUTION_RECORD_SAVE_FAILED", `Managed process record cannot be saved: ${file}`, cause);
  }
}

export function writeManagedRecord(file, value, options = {}) {
  writeManagedBinary(file, Buffer.from(JSON.stringify(value)), value, options);
}

function observeManagedGroup(pgid, ownerToken, identitySource, groupReader) {
  let unavailable;
  const stats = groupReader(pgid, (error) => { unavailable = error; });
  if (unavailable || stats === null) {
    const reason = unavailable ? `${unavailable.code || unavailable.name}: ${unavailable.message}` : "no group observation";
    throw managedControlFailure("PROCESS_EXECUTION_OBSERVATION_UNKNOWN", `Managed group membership is unavailable (${reason})`, unavailable);
  }
  let bootIdentity;
  try { bootIdentity = identitySource.readBootIdentity(); }
  catch (cause) { throw managedControlFailure("PROCESS_EXECUTION_OBSERVATION_UNKNOWN", "Managed boot identity is unavailable", cause); }
  return stats.map((stat) => new ManagedProcessMemberObservation(new ProcessIdentity({ pid: stat.pid, bootIdentity,
    startFingerprint: String(stat.startFingerprint), ownerToken }), stat));
}

class ManagedProcessMemberObservation {
  constructor(identity, stat) {
    this.identity = identity;
    this.stat = stat;
    Object.freeze(this);
  }
  get terminated() { return this.stat.state === "Z" || this.stat.state === "X"; }
}

class ManagedProcessObservedBirth {
  constructor(member, observation, role) {
    this.member = member;
    this.observation = observation;
    this.role = role;
    Object.freeze(this);
  }
}

export function captureManagedMembers(pgid, ownerToken) {
  return observeManagedGroup(pgid, ownerToken, new ProcessIdentitySource(), readLinuxProcessGroupMembers)
    .map((member) => member.identity);
}

/** Public diagnostics deliberately omit the member's signaling authority. */
export function managedMemberFailure(record, member, { code, message, operation, role, observation = null, cause } ) {
  const diagnostic = new ProcessExecutionFailureDiagnostic({ executionId: record.executionId, callId: record.callId,
    operation, role, birth: { pid: member.pid, bootIdentity: member.bootIdentity, startFingerprint: member.startFingerprint },
    originalPgid: record.pgid, observedPgid: observation?.stat?.pgrp ?? null,
    observedSid: observation?.stat?.sessionId ?? null, primaryCause: { code, message } });
  return new ProcessExecutionControlFailure(code, message, { cause, executionId: record.executionId, callId: record.callId, diagnostic,
    primaryCause: { code, message, executionId: record.executionId, callId: record.callId } });
}

/** One common assessment for launcher drain and independent receipt verification. */
export class ManagedProcessSnapshot {
  constructor(record, { identitySource = new ProcessIdentitySource(), groupReader = readLinuxProcessGroupMembers,
    providerIdentity = record.providerIdentity ?? null, operation = "stop-verification", persistMembers = null } = {}) {
    if (!Number.isSafeInteger(record.pgid) || record.pgid < 1 || !record.launcherIdentity) {
      throw managedControlFailure("PROCESS_EXECUTION_IDENTITY_UNKNOWN", "Managed group identity is incomplete");
    }
    this.executionId = record.executionId;
    this.callId = record.callId;
    this.pgid = record.pgid;
    this.launcher = record.launcherIdentity instanceof ProcessIdentity ? record.launcherIdentity : new ProcessIdentity(record.launcherIdentity);
    providerIdentity = providerIdentity === null || providerIdentity instanceof ProcessIdentity ? providerIdentity : new ProcessIdentity(providerIdentity);
    this.group = Object.freeze(observeManagedGroup(record.pgid, this.launcher.ownerToken, identitySource, groupReader));
    const known = new Map();
    for (const value of [this.launcher, ...(record.members || [])]) {
      const member = value instanceof ProcessIdentity ? value : new ProcessIdentity(value);
      known.set(member.pid, member);
    }
    let added = false;
    for (const { identity: member } of this.group) {
      const prior = known.get(member.pid);
      if (prior && !prior.sameBirth(member)) throw managedMemberFailure(record, prior, {
        code: "PROCESS_EXECUTION_IDENTITY_UNKNOWN", message: "Managed member PID was reused in the owned group", operation,
        role: prior.sameBirth(this.launcher) ? "launcher" : providerIdentity?.sameBirth(prior) ? "provider" : "descendant" });
      if (!prior) { known.set(member.pid, member); added = true; }
    }
    this.members = Object.freeze([...known.values()]);
    // A later failed observation must not discard a just-discovered birth.
    if (added && persistMembers) persistMembers(this.members);
    this.observations = Object.freeze(this.members.map((member) => {
      const observation = identitySource.observe(member);
      const role = member.sameBirth(this.launcher) ? "launcher" : providerIdentity?.sameBirth(member) ? "provider" : "descendant";
      if (observation.status === "unknown" || (observation.status === "live" && observation.stat === null)) {
        throw managedMemberFailure(record, member, { code: "PROCESS_EXECUTION_OBSERVATION_UNKNOWN",
          message: observation.reason, role, operation, observation });
      }
      if (observation.stat !== null && role !== "descendant" && (observation.stat.pgrp !== record.pgid
        || (role === "launcher" && observation.stat.pid !== record.pgid))) {
        throw managedMemberFailure(record, member, { code: "PROCESS_EXECUTION_IDENTITY_UNKNOWN",
          message: `${role} no longer owns its registered group`, role, operation, observation });
      }
      return new ManagedProcessObservedBirth(member, observation, role);
    }));
    Object.freeze(this);
  }
  isStopped({ excludeLauncher = false } = {}) {
    const included = (member) => !excludeLauncher || !member.sameBirth(this.launcher);
    return this.group.every((member) => !included(member.identity) || member.terminated)
      && this.observations.every(({ member, observation }) => !included(member) || observation.terminated);
  }
  /** Diagnose the same failed stop observation without reacquiring process state. */
  stopFailure(message) {
    if (this.isStopped()) return null;
    let survivor = this.observations.find(({ observation }) => !observation.terminated && observation.stat.pgrp !== this.pgid)
      ?? this.observations.find(({ observation, role }) => !observation.terminated && role !== "launcher")
      ?? this.observations.find(({ observation }) => !observation.terminated);
    if (!survivor) {
      // A member can exit between enumeration and its birth observation. The
      // group scan still prevents proof; retain that observation as the cause.
      const observed = this.group.find((member) => !member.terminated);
      const { member, role } = this.observations.find(({ member }) => member.sameBirth(observed.identity));
      survivor = new ManagedProcessObservedBirth(member, observed, role);
    }
    return managedMemberFailure(this, survivor.member, { code: "PROCESS_EXECUTION_STOP_UNPROVEN", message,
      operation: "stop-deadline", role: survivor.role, observation: survivor.observation });
  }
}

/** Recovery observes every recorded birth, including members outside the group. */
export function verifyManagedProcessStopped(record) {
  return new ManagedProcessSnapshot(record).isStopped();
}

export function assertManagedLauncherIdentity(record) {
  const identity = record.launcherIdentity instanceof ProcessIdentity
    ? record.launcherIdentity : new ProcessIdentity(record.launcherIdentity);
  const observation = new ProcessIdentitySource().observe(identity);
  if (observation.status !== "live" || observation.terminated || observation.stat === null
    || observation.stat.pgrp !== record.pgid || observation.stat.pid !== record.pgid) {
    throw managedMemberFailure(record, identity, { code: observation.status === "unknown" ? "PROCESS_EXECUTION_OBSERVATION_UNKNOWN" : "PROCESS_EXECUTION_IDENTITY_UNKNOWN",
      message: "Launcher no longer owns its registered group", role: "launcher", operation: "launcher-authentication", observation });
  }
}

function managedSocketRequest(call, message, { timeoutMs, abortSignal, onWait, readSettlement }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(call.endpoint);
    let text = "";
    let done = false;
    let timer;
    let poll;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      abortSignal?.removeEventListener("abort", aborted);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const aborted = () => finish(managedControlFailure("PROCESS_EXECUTION_COMMUNICATION_ABORTED", "Managed communication was aborted"));
    timer = setTimeout(() => finish(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed launcher did not respond")), Math.max(1, timeoutMs));
    poll = setInterval(() => {
      try {
        onWait();
        const settled = readSettlement();
        if (settled !== null) finish(null, settled);
      } catch (error) { finish(error); }
    }, 20);
    abortSignal?.addEventListener("abort", aborted, { once: true });
    if (abortSignal?.aborted) aborted();
    socket.on("error", (cause) => finish(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed launcher connection failed", cause)));
    socket.on("end", () => { if (!done) finish(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed launcher disconnected before its response")); });
    socket.on("close", () => { if (!done) finish(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed launcher disconnected before its response")); });
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (bytes) => {
      text += bytes;
      if (text.length > 32 * 1024 * 1024) return finish(managedControlFailure("PROCESS_EXECUTION_OUTPUT_LIMIT", "Managed response exceeds its bound"));
      const newline = text.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(text.slice(0, newline));
        if (!ManagedProcessMessage.from(response).respondsTo(message)) throw managedControlFailure("PROCESS_EXECUTION_AUTHORITY_MISMATCH", "Managed response does not match its request");
        if (response.payload.error) throw ProcessExecutionControlFailure.fromStored(response.payload.error,
          { executionId: call.executionId, callId: call.callId });
        finish(null, response.payload);
      } catch (error) {
        finish(error instanceof ProcessExecutionControlFailure ? error
          : managedControlFailure("PROCESS_EXECUTION_RESPONSE_INVALID", "Managed launcher returned an invalid response", error));
      }
    });
  });
}

/** One communication operation, including retransmission of its exact request. */
export async function managedRequest(call, operation, payload = {}, {
  deadline = Infinity, abortSignal = null, readSettlement = () => null, onWait = () => {},
  readAcceptance = () => "unknown",
  policy = new ManagedControlPolicy(), now = managedMonotonicNow, wait = delay, request = managedSocketRequest,
  requestId = randomUUID(),
} = {}) {
  if (typeof operation !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(operation)) throw new TypeError("Invalid managed communication operation");
  // Snapshot once: external mutation cannot turn a retry into a different start.
  const message = new ManagedProcessMessage(call, operation, JSON.parse(JSON.stringify(payload)), { requestId });
  const startedAt = now();
  const operationDeadline = Math.min(startedAt + policy.budgetMs, deadline);
  const attempts = [];
  let firstFailure = null;
  const elapsed = () => Math.max(0, now() - startedAt);
  const failure = (cause, cutoff, inspectionDeadline = operationDeadline) => {
    if (!(cause instanceof ProcessExecutionControlFailure)) cause = managedControlFailure("PROCESS_EXECUTION_RESPONSE_INVALID", "Managed control boundary returned invalid state", cause);
    if (attempts.length === 0 && !["PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "PROCESS_EXECUTION_COMMUNICATION_ABORTED"].includes(cause.code)) {
      return cause.withContext(call);
    }
    let acceptance = "unknown";
    try { acceptance = cause.code === "PROCESS_EXECUTION_REQUEST_MISMATCH" ? "rejected" : readAcceptance(message, inspectionDeadline); }
    catch (acceptanceError) {
      if (["PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "PROCESS_EXECUTION_COMMUNICATION_ABORTED"].includes(cause.code)) {
        cause = acceptanceError instanceof ProcessExecutionControlFailure ? acceptanceError
          : managedControlFailure("PROCESS_EXECUTION_RESPONSE_INVALID", "Managed acceptance observation is invalid", acceptanceError);
      } else {
        cause.cause = new AggregateError([cause.cause, acceptanceError].filter(Boolean), "Verified refusal and subsequent acceptance observation failure");
      }
      cutoff = "refused";
    }
    const primary = cause.diagnostic !== null || cause.code !== "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE" ? cause : firstFailure ?? cause;
    return new ProcessExecutionControlFailure(cause.code, cause.message, { cause, executionId: call.executionId, callId: call.callId,
      primaryCause: primary.primaryCause ?? { code: primary.code, message: primary.message, executionId: call.executionId, callId: call.callId },
      communication: ["start", "status", "stop"].includes(operation) ? new ProcessExecutionCommunicationDiagnostic({ operation, budgetMs: policy.budgetMs,
        elapsedMs: elapsed(), cutoff, acceptance,
        stopConfirmation: "unknown", attempts }) : null });
  };
  const cutoff = () => abortSignal?.aborted ? "aborted" : now() >= operationDeadline
    ? (deadline <= startedAt + policy.budgetMs ? "operation-deadline" : "budget-exhausted") : null;
  const check = (inspectionDeadline = operationDeadline) => {
    onWait(inspectionDeadline);
    return readSettlement(inspectionDeadline);
  };
  for (let ordinal = 1; ordinal <= policy.attemptCount; ordinal++) {
    let settled;
    try { settled = check(); }
    catch (cause) { throw failure(cause, "refused"); }
    if (settled !== null) return settled;
    const interrupted = cutoff();
    if (interrupted !== null) throw failure(firstFailure ?? managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed communication ended before a response"), interrupted);
    const attemptStarted = now();
    const responseDeadline = Math.min(startedAt + policy.responseDeadlineMs(ordinal), operationDeadline);
    try {
      const response = await request(call, message, { timeoutMs: responseDeadline - now(), abortSignal,
        onWait: () => onWait(responseDeadline), readSettlement: () => readSettlement(responseDeadline) });
      if (cutoff() !== null) throw managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed response arrived after its operation ended");
      return response;
    } catch (error) {
      const cause = error instanceof ProcessExecutionControlFailure ? error
        : managedControlFailure("PROCESS_EXECUTION_RESPONSE_INVALID", "Managed communication failed its response contract", error);
      const transient = cause.code === "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE";
      const verifiedFailure = !transient && cause.code !== "PROCESS_EXECUTION_COMMUNICATION_ABORTED";
      const stopped = cutoff();
      attempts.push(new ProcessExecutionCommunicationAttempt({ ordinal, responseDeadlineMs: responseDeadline - startedAt,
        elapsedMs: Math.max(0, now() - attemptStarted), outcome: verifiedFailure ? "refused" : stopped === "aborted" ? "aborted"
          : stopped === "operation-deadline" ? "deadline" : !transient ? "refused"
            : now() >= responseDeadline ? "timeout" : "disconnected" }));
      firstFailure ??= cause;
      try { settled = check(responseDeadline); }
      catch (settlementError) { throw failure(verifiedFailure ? cause : settlementError, "refused", responseDeadline); }
      if (verifiedFailure) throw failure(cause, "refused", responseDeadline);
      if (settled !== null) return settled;
      // A full response timeout already consumed its slot. Early disconnects
      // wait only the remainder, with the same output and settlement checks.
      while (now() < responseDeadline && cutoff() === null) {
        try { await wait(Math.min(20, responseDeadline - now()), undefined, { signal: abortSignal ?? undefined }); }
        catch (waitError) { if (!abortSignal?.aborted) throw waitError; }
        try { settled = check(responseDeadline); }
        catch (settlementError) { throw failure(settlementError, "refused", responseDeadline); }
        if (settled !== null) return settled;
      }
      const finalCutoff = cutoff();
      if (finalCutoff !== null || ordinal === policy.attemptCount) {
        throw failure(firstFailure, finalCutoff ?? "budget-exhausted", responseDeadline);
      }
    }
  }
}
