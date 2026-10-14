import crypto from "node:crypto";
import fs from "node:fs";

import { LinuxProcessStat, ProcessIdentity } from "./process-identity-values.js";
export { LinuxProcessStat, ProcessIdentity } from "./process-identity-values.js";

const PROCESS_IDENTITY_MAX_BYTES = 4096;

function processIdentityUnavailable(message, cause) {
  const error = new Error(message, { cause });
  error.code = "PROCESS_IDENTITY_UNAVAILABLE";
  return error;
}

function readBoundedIdentityFile(file) {
  const content = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(content) > PROCESS_IDENTITY_MAX_BYTES) {
    throw processIdentityUnavailable(`process identity file exceeds ${PROCESS_IDENTITY_MAX_BYTES} bytes: ${file}`);
  }
  return content;
}

function defaultBootIdentityReader() {
  return readBoundedIdentityFile("/proc/sys/kernel/random/boot_id").trim();
}

function defaultProcessStartFingerprintReader(pid) {
  const stat = readBoundedIdentityFile(`/proc/${pid}/stat`);
  try {
    return String(LinuxProcessStat.parse(stat).startFingerprint);
  } catch (cause) {
    throw processIdentityUnavailable(`invalid process start fingerprint for pid ${pid}`, cause);
  }
}

class ProcessIdentityAssessment {
  constructor(status, reason) {
    this.status = status;
    this.reason = reason;
    Object.freeze(this);
  }
}

export class ProcessIdentitySource {
  constructor({
    platform = process.platform,
    pid = process.pid,
    readBootIdentity = defaultBootIdentityReader,
    readProcessStartFingerprint = defaultProcessStartFingerprintReader,
  } = {}) {
    this.platform = platform;
    this.pid = pid;
    this.readBootIdentity = readBootIdentity;
    this.readProcessStartFingerprint = readProcessStartFingerprint;
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
    if (this.platform !== "linux") {
      return new ProcessIdentityAssessment("unknown", `process identity is unsupported on ${this.platform}`);
    }
    let bootIdentity;
    try {
      bootIdentity = this.readBootIdentity();
    } catch (cause) {
      return new ProcessIdentityAssessment("unknown", `boot identity is unavailable: ${cause.message}`);
    }
    if (bootIdentity !== owner.bootIdentity) {
      return new ProcessIdentityAssessment("stale", "lock owner belongs to another system boot");
    }
    let startFingerprint;
    try {
      startFingerprint = this.readProcessStartFingerprint(owner.pid);
    } catch (cause) {
      if (cause.code === "ENOENT" || cause.code === "ESRCH") {
        return new ProcessIdentityAssessment("stale", `lock owner pid ${owner.pid} no longer exists`);
      }
      return new ProcessIdentityAssessment("unknown", `process start fingerprint is unavailable: ${cause.message}`);
    }
    if (startFingerprint !== owner.startFingerprint) {
      return new ProcessIdentityAssessment("stale", `lock owner pid ${owner.pid} was reused`);
    }
    return new ProcessIdentityAssessment("live", `lock owner pid ${owner.pid} is active`);
  }
}
