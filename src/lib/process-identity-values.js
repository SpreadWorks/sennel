const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalidLinuxProcessStat(message) {
  const error = new Error(message);
  error.code = "LINUX_PROCESS_STAT_INVALID";
  return error;
}

export class LinuxProcessStat {
  constructor({ pid, state, pgrp, sessionId, startFingerprint }) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Linux process stat pid must be a positive integer");
    if (typeof state !== "string" || state.length !== 1) throw new Error("Linux process stat state must be one character");
    if (!Number.isSafeInteger(pgrp) || pgrp < 0) throw new Error("Linux process stat pgrp must be a non-negative integer");
    if (!Number.isSafeInteger(sessionId) || sessionId < 0) {
      throw new Error("Linux process stat session id must be a non-negative integer");
    }
    if (!Number.isSafeInteger(startFingerprint) || startFingerprint < 0) {
      throw new Error("Linux process stat start fingerprint must be a non-negative integer");
    }
    this.pid = pid;
    this.state = state;
    this.pgrp = pgrp;
    this.sessionId = sessionId;
    this.startFingerprint = startFingerprint;
    Object.freeze(this);
  }

  static parse(stat) {
    if (typeof stat !== "string") throw invalidLinuxProcessStat("Linux process stat must be a string");
    const commandStart = stat.indexOf("(");
    const commandEnd = stat.lastIndexOf(")");
    if (commandStart < 1 || commandEnd <= commandStart) {
      throw invalidLinuxProcessStat("Linux process stat command field is invalid");
    }
    const pid = stat.slice(0, commandStart).trim();
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    if (fields.length <= 19) throw invalidLinuxProcessStat("Linux process stat is truncated");
    if (!/^\d+$/.test(pid)) throw invalidLinuxProcessStat("Linux process stat pid is invalid");
    if (typeof fields[0] !== "string" || fields[0].length !== 1) {
      throw invalidLinuxProcessStat("Linux process stat state is invalid");
    }
    if (!/^\d+$/.test(fields[2])) throw invalidLinuxProcessStat("Linux process stat pgrp is invalid");
    if (!/^\d+$/.test(fields[3])) throw invalidLinuxProcessStat("Linux process stat session id is invalid");
    if (!/^\d+$/.test(fields[19])) {
      throw invalidLinuxProcessStat("Linux process stat start fingerprint is invalid");
    }
    return new LinuxProcessStat({
      pid: Number(pid),
      state: fields[0],
      pgrp: Number(fields[2]),
      sessionId: Number(fields[3]),
      startFingerprint: Number(fields[19]),
    });
  }
}

export class ProcessIdentityObservation {
  constructor(status, reason, stat = null) {
    if (!["live", "stale", "unknown"].includes(status)) throw new Error("process identity observation status is invalid");
    if (typeof reason !== "string" || reason.trim() === "") throw new Error("process identity observation reason is required");
    if (stat !== null && !(stat instanceof LinuxProcessStat)) throw new Error("process identity observation stat is invalid");
    if (status !== "live" && stat !== null) throw new Error("only a live process identity observation can retain its stat");
    this.status = status;
    this.reason = reason;
    this.stat = stat;
    this.terminated = status === "stale" || (stat !== null && (stat.state === "Z" || stat.state === "X"));
    Object.freeze(this);
  }
}

export class ProcessIdentity {
  constructor({ pid, bootIdentity, startFingerprint, ownerToken }) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("process identity pid must be a positive integer");
    if (typeof bootIdentity !== "string" || bootIdentity.trim() === "") {
      throw new Error("process identity boot identity is required");
    }
    if (typeof startFingerprint !== "string" || !/^\d+$/.test(startFingerprint)) {
      throw new Error("process identity start fingerprint must be numeric");
    }
    if (typeof ownerToken !== "string" || !UUID_PATTERN.test(ownerToken)) {
      throw new Error("process identity owner token is invalid");
    }
    this.pid = pid;
    this.bootIdentity = bootIdentity;
    this.startFingerprint = startFingerprint;
    this.ownerToken = ownerToken;
    Object.freeze(this);
  }

  sameBirth(other) {
    return other instanceof ProcessIdentity
      && this.pid === other.pid
      && this.bootIdentity === other.bootIdentity
      && this.startFingerprint === other.startFingerprint;
  }
}
