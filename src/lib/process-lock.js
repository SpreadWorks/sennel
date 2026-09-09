import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ProcessIdentity, ProcessIdentitySource } from "./process-identity.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";

const LOCK_VERSION = 1;
const MAX_LOCK_BYTES = 64 * 1024;
const MAX_ACQUIRE_ATTEMPTS = 4;
const MAX_OWNER_OBSERVATION_ATTEMPTS = 4;
const OWNER_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function defaultErrorFactory(status, message, { lockPath, cause } = {}) {
  const error = new Error(message, { cause });
  error.name = "ProcessLockError";
  error.code = `PROCESS_LOCK_${status.replace(/-/g, "_").toUpperCase()}`;
  error.lockPath = lockPath;
  return error;
}

function stableAuthority(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  let primaryError = null;
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          `directory fsync and descriptor cleanup both failed: ${directory}`,
          { cause: primaryError },
        );
      }
      throw cleanupError;
    }
  }
  if (primaryError) throw primaryError;
}

function orderedFailure(primary, cleanupErrors, message) {
  if (cleanupErrors.length === 0) return primary;
  const primaryErrors = primary instanceof AggregateError && primary.cause === primary.errors[0]
    ? primary.errors
    : [primary];
  return new AggregateError(
    [...primaryErrors, ...cleanupErrors],
    message,
    { cause: primaryErrors[0] },
  );
}

function ownerSnapshot(owner) {
  return owner?.toJSON ? owner.toJSON() : structuredClone(owner ?? null);
}

function residueAt(filePath, cleanupErrors) {
  if (!filePath) return false;
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    cleanupErrors.push(error);
    return true;
  }
}

export class ProcessLockTransitionError extends Error {
  constructor(message, {
    cause,
    code,
    phase,
    lockStatus,
    lockPath,
    owner,
    publishedToVisibleName,
    durabilityUnknown,
    residue,
  }) {
    super(message, { cause });
    this.name = "ProcessLockTransitionError";
    this.code = code;
    this.phase = phase;
    this.lockStatus = lockStatus;
    this.lockPath = lockPath;
    this.owner = ownerSnapshot(owner);
    this.publishedToVisibleName = publishedToVisibleName;
    this.durabilityUnknown = durabilityUnknown;
    this.residue = Object.freeze({ temp: residue.temp === true, visible: residue.visible === true });
  }
}

class ProcessLockOwnerObservationChanged extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = "ProcessLockOwnerObservationChanged";
  }
}

class ProcessLockOwner {
  constructor({ kind, authority, processIdentity }) {
    this.version = LOCK_VERSION;
    this.kind = kind;
    this.authority = authority;
    this.processIdentity = processIdentity instanceof ProcessIdentity
      ? processIdentity
      : new ProcessIdentity(processIdentity ?? {});
  }

  toJSON() {
    return {
      version: this.version,
      kind: this.kind,
      ...this.authority,
      processIdentity: this.processIdentity,
    };
  }
}

export class ProcessLock {
  static ownerTemporaryFileName(fileName, ownerToken) {
    if (typeof fileName !== "string" || fileName === "" || path.basename(fileName) !== fileName) {
      throw new Error("process lock fileName must be a basename");
    }
    if (typeof ownerToken !== "string" || !OWNER_TOKEN_PATTERN.test(ownerToken)) {
      throw new Error("process lock ownerToken must be a UUID");
    }
    return `.${fileName}.${ownerToken}.owner.tmp`;
  }

  static isOwnerTemporaryFileName(fileName, candidate) {
    if (typeof candidate !== "string" || path.basename(candidate) !== candidate) return false;
    const prefix = `.${fileName}.`;
    if (!candidate.startsWith(prefix) || !candidate.endsWith(".owner.tmp")) return false;
    const ownerToken = candidate.slice(prefix.length, -".owner.tmp".length);
    return OWNER_TOKEN_PATTERN.test(ownerToken);
  }

  constructor({
    directoryAuthority,
    fileName,
    kind,
    authority,
    processIdentitySource = new ProcessIdentitySource(),
    errorFactory = defaultErrorFactory,
  }) {
    if (!(directoryAuthority instanceof RealDirectoryAuthority)) {
      throw new Error("process lock directoryAuthority must be a RealDirectoryAuthority");
    }
    this.directoryAuthority = directoryAuthority;
    this.directory = directoryAuthority.directory;
    this.lockPath = path.join(this.directory, fileName);
    this.kind = kind;
    this.authority = authority;
    this.serializedAuthority = stableAuthority(authority);
    this.processIdentitySource = processIdentitySource;
    this.errorFactory = errorFactory;
    this.processIdentity = null;
    this.lockIdentity = null;
  }

  acquire() {
    const initial = fs.existsSync(this.directory) ? this.inspect() : null;
    if (initial) {
      const assessment = this.processIdentitySource.assess(initial.owner.processIdentity);
      if (assessment.status !== "stale") {
        throw this.conflict(initial.owner, assessment);
      }
    }
    this.processIdentitySource.assertAvailable();
    this.directoryAuthority.ensure();
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const existing = this.inspect();
      if (existing) {
        const assessment = this.processIdentitySource.assess(existing.owner.processIdentity);
        if (assessment.status !== "stale") {
          throw this.conflict(existing.owner, assessment);
        }
        if (!this.#removeStale(existing)) continue;
      }
      try {
        return this.#publish();
      } catch (cause) {
        if (cause.code === "EEXIST") continue;
        if (cause?.lockPath === this.lockPath) throw cause;
        throw this.#error("acquire-failed", `process-owned lock acquisition failed: ${cause.message}`, cause);
      }
    }
    const existing = this.inspect();
    if (existing) throw this.conflict(existing.owner);
    throw this.#error("acquire-failed", "process-owned lock acquisition retry limit exceeded");
  }

  inspect() {
    let observationChanged = null;
    for (let attempt = 0; attempt < MAX_OWNER_OBSERVATION_ATTEMPTS; attempt += 1) {
      this.directoryAuthority.assertStable();
      let stat;
      try {
        stat = fs.lstatSync(this.lockPath);
      } catch (cause) {
        if (cause.code === "ENOENT") return null;
        throw this.#error("corrupt", `process-owned lock is unreadable: ${cause.message}`, cause);
      }
      try {
        return { owner: this.#readOwner(stat), stat: { dev: stat.dev, ino: stat.ino } };
      } catch (cause) {
        if (!(cause instanceof ProcessLockOwnerObservationChanged)) throw cause;
        observationChanged = cause;
      }
    }
    throw this.#error(
      "transition-failed",
      `process-owned lock changed during owner observation: ${this.lockPath}`,
      observationChanged,
    );
  }

  conflict(owner, assessment = this.processIdentitySource.assess(owner.processIdentity)) {
    return this.#error(assessment.status, assessment.reason, undefined, owner);
  }

  release() {
    if (this.processIdentity == null) return;
    this.directoryAuthority.assertStable();
    const current = this.inspect();
    if (
      !current
      || !sameFile(current.stat, this.lockIdentity)
      || current.owner.processIdentity.ownerToken !== this.processIdentity.ownerToken
    ) {
      throw this.#error("ownership-changed", "process-owned lock ownership changed");
    }
    try {
      fs.unlinkSync(this.lockPath);
    } catch (cause) {
      const cleanupErrors = [];
      const visibleResidue = residueAt(this.lockPath, cleanupErrors);
      throw this.#transitionError({
        phase: "release-unlink",
        cause: orderedFailure(
          cause,
          cleanupErrors,
          `process-owned lock release and residue inspection both failed: ${this.lockPath}`,
        ),
        owner: current.owner,
        publishedToVisibleName: false,
        durabilityUnknown: false,
        residue: { temp: false, visible: visibleResidue },
      });
    }
    this.processIdentity = null;
    this.lockIdentity = null;
    try {
      fsyncDirectory(this.directory);
    } catch (cause) {
      const cleanupErrors = [];
      const visibleResidue = residueAt(this.lockPath, cleanupErrors);
      throw this.#transitionError({
        phase: "release-directory-fsync",
        cause: orderedFailure(
          cause,
          cleanupErrors,
          `process-owned lock release durability and residue inspection both failed: ${this.lockPath}`,
        ),
        owner: current.owner,
        publishedToVisibleName: false,
        durabilityUnknown: true,
        residue: { temp: false, visible: visibleResidue },
      });
    }
  }

  #publish() {
    const token = crypto.randomUUID();
    const tempPath = path.join(
      this.directory,
      ProcessLock.ownerTemporaryFileName(path.basename(this.lockPath), token),
    );
    let descriptor = null;
    let published = false;
    let owner = null;
    let phase = "owner-temp-open";
    try {
      this.processIdentity = this.processIdentitySource.createOwner(token);
      owner = new ProcessLockOwner({
        kind: this.kind,
        authority: this.authority,
        processIdentity: this.processIdentity,
      });
      descriptor = fs.openSync(tempPath, "wx", 0o600);
      phase = "owner-file-write";
      fs.writeFileSync(descriptor, `${JSON.stringify(owner.toJSON(), null, 2)}\n`);
      phase = "owner-file-mode";
      fs.fchmodSync(descriptor, 0o600);
      phase = "owner-file-fsync";
      fs.fsyncSync(descriptor);
      phase = "owner-file-stat";
      const tempStat = fs.fstatSync(descriptor);
      this.lockIdentity = { dev: tempStat.dev, ino: tempStat.ino };
      phase = "owner-file-close";
      fs.closeSync(descriptor);
      descriptor = null;
      this.directoryAuthority.assertStable();
      phase = "publish-link";
      fs.linkSync(tempPath, this.lockPath);
      published = true;
      phase = "publish-identity-validate";
      if (!sameFile(fs.lstatSync(this.lockPath), this.lockIdentity)) {
        throw this.#error("ownership-changed", "published process-owned lock identity changed");
      }
      phase = "publish-temp-unlink";
      fs.unlinkSync(tempPath);
      phase = "publish-directory-fsync";
      fsyncDirectory(this.directory);
      return this.processIdentity.ownerToken;
    } catch (primaryError) {
      const cleanupErrors = [];
      let cleanupUnlinked = false;
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch (error) { cleanupErrors.push(error); }
      }
      try {
        fs.unlinkSync(tempPath);
        cleanupUnlinked = true;
      } catch (error) {
        if (error.code !== "ENOENT") cleanupErrors.push(error);
      }
      if (published) {
        try {
          const stat = fs.lstatSync(this.lockPath);
          if (sameFile(stat, this.lockIdentity)) {
            fs.unlinkSync(this.lockPath);
            cleanupUnlinked = true;
          } else {
            cleanupErrors.push(new Error(`published process-owned lock identity changed during cleanup: ${this.lockPath}`));
          }
        } catch (error) {
          if (error.code !== "ENOENT") cleanupErrors.push(error);
        }
      }
      if (cleanupUnlinked) {
        try { fsyncDirectory(this.directory); } catch (error) { cleanupErrors.push(error); }
      }
      const residue = {
        temp: residueAt(tempPath, cleanupErrors),
        visible: residueAt(this.lockPath, cleanupErrors),
      };
      const cause = orderedFailure(
        primaryError,
        cleanupErrors,
        `process-owned lock publish and cleanup both failed: ${this.lockPath}`,
      );
      if (
        primaryError.code === "PROCESS_IDENTITY_UNAVAILABLE"
        && cleanupErrors.length === 0
        && residue.temp === false
        && residue.visible === false
        && published === false
      ) {
        this.processIdentity = null;
        this.lockIdentity = null;
        throw primaryError;
      }
      if (primaryError.code === "EEXIST" && cleanupErrors.length === 0 && residue.temp === false && published === false) {
        this.processIdentity = null;
        this.lockIdentity = null;
        throw primaryError;
      }
      const transitionError = this.#transitionError({
        phase,
        cause,
        owner,
        publishedToVisibleName: published,
        durabilityUnknown: phase === "publish-directory-fsync",
        residue,
      });
      this.processIdentity = null;
      this.lockIdentity = null;
      throw transitionError;
    }
  }

  #removeStale(existing) {
    this.directoryAuthority.assertStable();
    let current;
    try {
      current = this.inspect();
    } catch (error) {
      throw error;
    }
    if (!current) return false;
    if (
      !sameFile(current.stat, existing.stat)
      || current.owner.processIdentity.ownerToken !== existing.owner.processIdentity.ownerToken
    ) return false;
    const assessment = this.processIdentitySource.assess(current.owner.processIdentity);
    if (assessment.status !== "stale") throw this.conflict(current.owner, assessment);
    try {
      fs.unlinkSync(this.lockPath);
    } catch (cause) {
      const cleanupErrors = [];
      const visibleResidue = residueAt(this.lockPath, cleanupErrors);
      throw this.#transitionError({
        phase: "stale-remove-unlink",
        cause: orderedFailure(
          cause,
          cleanupErrors,
          `stale process-owned lock removal and residue inspection both failed: ${this.lockPath}`,
        ),
        owner: current.owner,
        publishedToVisibleName: false,
        durabilityUnknown: false,
        residue: { temp: false, visible: visibleResidue },
      });
    }
    try {
      fsyncDirectory(this.directory);
    } catch (cause) {
      const cleanupErrors = [];
      const visibleResidue = residueAt(this.lockPath, cleanupErrors);
      throw this.#transitionError({
        phase: "stale-remove-directory-fsync",
        cause: orderedFailure(
          cause,
          cleanupErrors,
          `stale process-owned lock durability and residue inspection both failed: ${this.lockPath}`,
        ),
        owner: current.owner,
        publishedToVisibleName: false,
        durabilityUnknown: true,
        residue: { temp: false, visible: visibleResidue },
      });
    }
    return true;
  }

  #readOwner(stat) {
    let descriptor = null;
    let owner = null;
    let failure = null;
    try {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LOCK_BYTES) {
        throw new Error("process-owned lock must be a bounded regular file");
      }
      try {
        descriptor = fs.openSync(
          this.lockPath,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
        );
      } catch (cause) {
        if (cause.code === "ENOENT") {
          throw new ProcessLockOwnerObservationChanged("process-owned lock disappeared while opening its owner record", { cause });
        }
        throw cause;
      }
      const openedStat = fs.fstatSync(descriptor);
      if (!sameFile(stat, openedStat)) {
        throw new ProcessLockOwnerObservationChanged("process-owned lock identity changed while opening its owner record");
      }
      if (!openedStat.isFile() || openedStat.size > MAX_LOCK_BYTES) {
        throw new Error("process-owned lock must be a bounded regular file");
      }
      const value = JSON.parse(fs.readFileSync(descriptor, "utf8"));
      const actualAuthority = Object.fromEntries(
        Object.keys(this.authority).map((key) => [key, value[key]]),
      );
      if (
        value.version !== LOCK_VERSION
        || value.kind !== this.kind
        || stableAuthority(actualAuthority) !== this.serializedAuthority
      ) {
        throw new Error("process-owned lock authority is invalid");
      }
      owner = new ProcessLockOwner({
        kind: value.kind,
        authority: actualAuthority,
        processIdentity: value.processIdentity,
      });
    } catch (cause) {
      failure = cause;
    }
    if (descriptor != null) {
      try {
        fs.closeSync(descriptor);
      } catch (cleanupError) {
        failure = failure
          ? orderedFailure(failure, [cleanupError], "process lock owner read and descriptor cleanup both failed")
          : cleanupError;
      }
    }
    if (failure instanceof ProcessLockOwnerObservationChanged) throw failure;
    if (failure) throw this.#error("corrupt", `process-owned lock is corrupt: ${failure.message}`, failure, owner);
    let currentStat;
    try {
      currentStat = fs.lstatSync(this.lockPath);
    } catch (cause) {
      if (cause.code === "ENOENT") {
        throw new ProcessLockOwnerObservationChanged("process-owned lock disappeared while reading its owner record", { cause });
      }
      throw this.#error("corrupt", `process-owned lock is unreadable: ${cause.message}`, cause, owner);
    }
    if (!sameFile(stat, currentStat)) {
      throw new ProcessLockOwnerObservationChanged("process-owned lock identity changed while reading its owner record");
    }
    return owner;
  }

  #error(status, message, cause, owner = null) {
    const error = this.errorFactory(status, message, { lockPath: this.lockPath, cause });
    error.lockStatus = status;
    error.lockPath = this.lockPath;
    error.owner = ownerSnapshot(owner);
    if (!("cause" in error)) error.cause = cause ?? null;
    return error;
  }

  #transitionError({
    phase,
    cause,
    owner,
    publishedToVisibleName,
    durabilityUnknown,
    residue,
  }) {
    const status = durabilityUnknown ? "durability-uncertain" : "transition-failed";
    const message = durabilityUnknown
      ? `process-owned lock durability is uncertain during ${phase}: ${this.lockPath}`
      : `process-owned lock transition failed during ${phase}: ${this.lockPath}`;
    const mapped = this.errorFactory(status, message, { lockPath: this.lockPath, cause });
    return new ProcessLockTransitionError(message, {
      cause,
      code: mapped.code || `PROCESS_LOCK_${status.replace(/-/g, "_").toUpperCase()}`,
      phase,
      lockStatus: status,
      lockPath: this.lockPath,
      owner,
      publishedToVisibleName,
      durabilityUnknown,
      residue,
    });
  }
}
