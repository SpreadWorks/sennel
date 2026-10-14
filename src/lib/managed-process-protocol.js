import net from "node:net";
import path from "node:path";
import { FileLock } from "./file-lock.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import fs from "node:fs";
import { AtomicFile } from "./atomic-file.js";
import { ProcessIdentity, ProcessIdentitySource } from "./process-identity.js";
import { ProcessExecutionControlFailure, ProcessExecutionFailureDiagnostic } from "./process-execution-values.js";
import { readLinuxProcessGroupMembers } from "./process-supervisor.js";

export class ManagedProcessMessage {
  constructor(call, operation, payload = {}) {
    this.executionId = call.executionId;
    this.callId = call.callId;
    this.ownerToken = call.ownerToken;
    this.capability = call.capability;
    this.operation = operation;
    this.payload = payload;
  }
  matches(call) {
    return this.executionId === call.executionId && this.callId === call.callId
      && this.ownerToken === call.ownerToken && this.capability === call.capability;
  }
  static from(value) {
    return new ManagedProcessMessage(value, value.operation, value.payload);
  }
}

export function managedControlFailure(code, message, cause) {
  return new ProcessExecutionControlFailure(code, message, { cause });
}

function managedRecordLock(file) {
  return new FileLock({ directoryAuthority: new RealDirectoryAuthority(path.dirname(file)),
    fileName: `${path.basename(file)}.lock`, kind: "managed-process-record", authority: { file: path.resolve(file) } });
}

export function readManagedBinary(file, { maximum = 16 * 1024 * 1024 } = {}) {
  try {
    return managedRecordLock(file).runExclusive(() => {
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

export function readManagedRecord(file) {
  const bytes = readManagedBinary(file);
  try { return bytes === null ? null : JSON.parse(bytes); }
  catch (cause) { throw managedControlFailure("PROCESS_EXECUTION_RECORD_UNREADABLE", `Managed JSON cannot be read: ${file}`, cause); }
}

export function writeManagedBinary(file, bytes, identity, { faultInjector } = {}) {
  try {
    managedRecordLock(file).runExclusive(() => {
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

export function managedRequest(call, operation, payload = {}, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(call.endpoint);
    let text = "";
    const timer = setTimeout(() => finish(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed launcher did not respond")), timeoutMs);
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.on("error", (cause) => finish(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed launcher connection failed", cause)));
    socket.on("end", () => { if (!done) finish(managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed launcher disconnected before its response")); });
    socket.on("connect", () => socket.write(`${JSON.stringify(new ManagedProcessMessage(call, operation, payload))}\n`));
    socket.on("data", (bytes) => {
      text += bytes;
      if (text.length > 32 * 1024 * 1024) return finish(managedControlFailure("PROCESS_EXECUTION_OUTPUT_LIMIT", "Managed response exceeds its bound"));
      const newline = text.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(text.slice(0, newline));
        if (!ManagedProcessMessage.from(response).matches(call)) throw managedControlFailure("PROCESS_EXECUTION_AUTHORITY_MISMATCH", "Managed response belongs to another execution");
        if (response.payload.error) throw ProcessExecutionControlFailure.fromStored(response.payload.error,
          { executionId: call.executionId, callId: call.callId });
        finish(null, response.payload);
      } catch (error) { finish(error); }
    });
  });
}
