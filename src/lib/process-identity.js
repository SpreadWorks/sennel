import crypto from "node:crypto";
import fs from "node:fs";

import { LinuxProcessStat, ProcessIdentity, ProcessIdentityObservation } from "./process-identity-values.js";
export { LinuxProcessStat, ProcessIdentity, ProcessIdentityObservation } from "./process-identity-values.js";

const PROCESS_IDENTITY_MAX_BYTES = 4096;

function processIdentityUnavailable(message, cause) {
  const error = new Error(message, { cause });
  error.code = "PROCESS_IDENTITY_UNAVAILABLE";
  return error;
}

function readBoundedIdentityFile(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(PROCESS_IDENTITY_MAX_BYTES + 1);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes > PROCESS_IDENTITY_MAX_BYTES) {
      throw processIdentityUnavailable(`process identity file exceeds ${PROCESS_IDENTITY_MAX_BYTES} bytes: ${file}`);
    }
    return buffer.toString("utf8", 0, bytes);
  } finally {
    fs.closeSync(descriptor);
  }
}

function defaultBootIdentityReader() {
  return readBoundedIdentityFile("/proc/sys/kernel/random/boot_id").trim();
}

function defaultProcessStatReader(pid) {
  const stat = readBoundedIdentityFile(`/proc/${pid}/stat`);
  try {
    return LinuxProcessStat.parse(stat);
  } catch (cause) {
    throw processIdentityUnavailable(`invalid process start fingerprint for pid ${pid}`, cause);
  }
}

export class ProcessIdentitySource {
  constructor({
    platform = process.platform,
    pid = process.pid,
    readBootIdentity = defaultBootIdentityReader,
    readProcessStat = defaultProcessStatReader,
    readProcessStartFingerprint,
  } = {}) {
    this.platform = platform;
    this.pid = pid;
    this.readBootIdentity = readBootIdentity;
    this.readProcessStat = readProcessStat;
    // A supplied fingerprint reader is a birth-only dependency for lock users.
    // Never combine that independent observation with a second stat snapshot.
    this.birthOnlyReader = readProcessStartFingerprint;
    this.readProcessStartFingerprint = readProcessStartFingerprint
      ?? ((processId) => String(this.#readStat(processId).startFingerprint));
  }

  #readStat(pid) {
    const stat = this.readProcessStat(pid);
    if (!(stat instanceof LinuxProcessStat) || stat.pid !== pid) {
      throw processIdentityUnavailable(`process stat does not identify pid ${pid}`);
    }
    return stat;
  }

  createOwner(ownerToken) {
    if (this.platform !== "linux") {
      throw processIdentityUnavailable(`process identity is unsupported on ${this.platform}`);
    }
    try {
      return new ProcessIdentity({
        pid: this.pid,
        bootIdentity: this.readBootIdentity(),
        startFingerprint: this.readProcessStartFingerprint(this.pid),
        ownerToken,
      });
    } catch (cause) {
      if (cause.code === "PROCESS_IDENTITY_UNAVAILABLE") throw cause;
      throw processIdentityUnavailable("current process identity is unavailable", cause);
    }
  }

  assertAvailable() {
    this.createOwner(crypto.randomUUID());
  }

  assess(owner) {
    return this.observe(owner);
  }

  observe(owner) {
    if (this.platform !== "linux") {
      return new ProcessIdentityObservation("unknown", `process identity is unsupported on ${this.platform}`);
    }
    let bootIdentity;
    try {
      bootIdentity = this.readBootIdentity();
    } catch (cause) {
      return new ProcessIdentityObservation("unknown", `boot identity is unavailable: ${cause.message}`);
    }
    if (bootIdentity !== owner.bootIdentity) {
      return new ProcessIdentityObservation("stale", "lock owner belongs to another system boot");
    }
    let stat = null;
    let startFingerprint;
    try {
      if (this.birthOnlyReader) {
        startFingerprint = this.readProcessStartFingerprint(owner.pid);
      } else {
        stat = this.#readStat(owner.pid);
        startFingerprint = String(stat.startFingerprint);
      }
    } catch (cause) {
      if (cause.code === "ENOENT" || cause.code === "ESRCH") {
        return new ProcessIdentityObservation("stale", `lock owner pid ${owner.pid} no longer exists`);
      }
      return new ProcessIdentityObservation("unknown", `process start fingerprint is unavailable: ${cause.message}`);
    }
    if (startFingerprint !== owner.startFingerprint) {
      return new ProcessIdentityObservation("stale", `lock owner pid ${owner.pid} was reused`);
    }
    return new ProcessIdentityObservation("live", `lock owner pid ${owner.pid} is active`, stat);
  }
}
