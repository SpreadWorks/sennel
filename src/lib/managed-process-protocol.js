import net from "node:net";
import path from "node:path";
import { FileLock } from "./file-lock.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import fs from "node:fs";
import { AtomicFile } from "./atomic-file.js";
import { ProcessIdentity, ProcessIdentitySource, LinuxProcessStat } from "./process-identity.js";
import { ProcessExecutionControlFailure } from "./process-execution-values.js";
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

export function captureManagedMembers(pgid, ownerToken) {
  let unavailable;
  const stats = readLinuxProcessGroupMembers(pgid, (error) => { unavailable = error; });
  if (unavailable || stats === null) {
    const reason = unavailable ? `${unavailable.code || unavailable.name}: ${unavailable.message}` : "no group observation";
    throw managedControlFailure("PROCESS_EXECUTION_OBSERVATION_UNKNOWN", `Managed group membership is unavailable (${reason})`, unavailable);
  }
  const bootIdentity = new ProcessIdentitySource().readBootIdentity();
  return stats.map((stat) => new ProcessIdentity({ pid: stat.pid, bootIdentity,
    startFingerprint: String(stat.startFingerprint), ownerToken }));
}

/** Signal zero is an observation only. Recovery never signals a persisted PID. */
export function verifyManagedProcessStopped(record) {
  if (!Number.isSafeInteger(record.pgid) || record.pgid < 1 || !record.launcherIdentity) {
    throw managedControlFailure("PROCESS_EXECUTION_IDENTITY_UNKNOWN", "Managed group identity is incomplete");
  }
  try { process.kill(-record.pgid, 0); return false; }
  catch (cause) {
    if (cause.code !== "ESRCH") throw managedControlFailure("PROCESS_EXECUTION_OBSERVATION_UNKNOWN", "Managed group absence cannot be observed", cause);
  }
  const identities = [record.launcherIdentity, ...(record.members || [])];
  for (const value of identities) {
    const member = value instanceof ProcessIdentity ? value : new ProcessIdentity(value);
    const assessment = new ProcessIdentitySource().assess(member);
    if (assessment.status === "unknown") throw managedControlFailure("PROCESS_EXECUTION_OBSERVATION_UNKNOWN", assessment.reason);
    if (assessment.status === "live") return false;
  }
  return true;
}

export function assertManagedLauncherIdentity(record) {
  const identity = record.launcherIdentity instanceof ProcessIdentity
    ? record.launcherIdentity : new ProcessIdentity(record.launcherIdentity);
  const assessment = new ProcessIdentitySource().assess(identity);
  if (assessment.status !== "live") throw managedControlFailure("PROCESS_EXECUTION_IDENTITY_UNKNOWN", assessment.reason);
  let stat;
  try { stat = LinuxProcessStat.parse(fs.readFileSync(`/proc/${identity.pid}/stat`, "utf8")); }
  catch (cause) { throw managedControlFailure("PROCESS_EXECUTION_OBSERVATION_UNKNOWN", "Launcher membership is unavailable", cause); }
  if (stat.pgrp !== record.pgid || stat.pid !== record.pgid) {
    throw managedControlFailure("PROCESS_EXECUTION_IDENTITY_UNKNOWN", "Launcher no longer owns its registered group");
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
        if (response.payload.error) throw managedControlFailure(response.payload.error.code, response.payload.error.message);
        finish(null, response.payload);
      } catch (error) { finish(error); }
    });
  });
}
