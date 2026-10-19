import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ProcessIdentity, ProcessIdentitySource } from "./process-identity.js";
import { AtomicFile } from "./atomic-file.js";
import { captureRegularFile } from "./regular-file-snapshot.js";
import { removeRegularFile } from "./regular-file-io.js";
import { FileIdentity, RealDirectoryAuthority, sameFileIdentity as sameFile } from "./real-directory-authority.js";

const LOCK_VERSION = 1;
const MAX_LOCK_BYTES = 64 * 1024;
const MAX_ACQUIRE_ATTEMPTS = 4;
const MAX_OWNER_OBSERVATION_ATTEMPTS = 4;
const OWNER_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;


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
    publicationUnknown,
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
    this.publicationUnknown = publicationUnknown;
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

  acquire({ reclaimStale = true } = {}) {
    const initial = fs.existsSync(this.directory) ? this.inspect() : null;
    if (initial) {
      const assessment = this.processIdentitySource.assess(initial.owner.processIdentity);
      if (!reclaimStale || assessment.status !== "stale") {
        throw this.conflict(initial.owner, assessment);
      }
    }
    this.processIdentitySource.assertAvailable();
    this.directoryAuthority.ensure();
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const existing = this.inspect();
      if (existing) {
        const assessment = this.processIdentitySource.assess(existing.owner.processIdentity);
        if (!reclaimStale || assessment.status !== "stale") {
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
        stat = fs.lstatSync(this.lockPath, { bigint: true });
      } catch (cause) {
        if (cause.code === "ENOENT") return null;
        throw this.#error("corrupt", `process-owned lock is unreadable: ${cause.message}`, cause);
      }
      try {
        return { owner: this.#readOwner(stat), stat: new FileIdentity(stat) };
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
      removeRegularFile(this.lockPath, { expectedIdentity: current.stat, maxBytes: MAX_LOCK_BYTES, directoryAuthority: this.directoryAuthority });
    } catch (cause) {
      const cleanupErrors = [];
      const visibleResidue = residueAt(this.lockPath, cleanupErrors);
      throw this.#transitionError({
        phase: cause.publicationUnknown ? "release-readback" : "release-unlink",
        cause: orderedFailure(
          cause,
          cleanupErrors,
          `process-owned lock release and residue inspection both failed: ${this.lockPath}`,
        ),
        owner: current.owner,
        publishedToVisibleName: false,
        publicationUnknown: cause.publicationUnknown === true,
        residue: { temp: false, visible: visibleResidue },
      });
    }
    this.processIdentity = null;
    this.lockIdentity = null;
    this.directoryAuthority.assertStable();
  }

  #publish() {
    const token = crypto.randomUUID();
    const tempPath = path.join(this.directory, ProcessLock.ownerTemporaryFileName(path.basename(this.lockPath), token));
    let owner = null;
    let stage = null;
    let published = false;
    let phase = "owner-create";
    const writer = new AtomicFile(this.lockPath, { maxBytes: MAX_LOCK_BYTES,
      directoryAuthority: this.directoryAuthority, phaseNamespace: "owner" });
    try {
      this.processIdentity = this.processIdentitySource.createOwner(token);
      owner = new ProcessLockOwner({ kind: this.kind, authority: this.authority, processIdentity: this.processIdentity });
      phase = "owner-file-write";
      stage = writer.createStage(`${JSON.stringify(owner.toJSON(), null, 2)}\n`, {
        stageName: ProcessLock.ownerTemporaryFileName(path.basename(this.lockPath), token),
        exclusive: true,
      });
      this.lockIdentity = stage.identity;
      phase = "publish-link";
      writer.publishStage(stage, { exclusive: true });
      published = true;
      return this.processIdentity.ownerToken;
    } catch (primaryError) {
      published ||= primaryError.committedToVisibleName === true;
      const cleanupErrors = [];
      if (published && stage !== null) {
        try {
          removeRegularFile(this.lockPath, { expectedIdentity: stage.identity,
            expectedLinkCount: primaryError.cleanupFailed ? 2 : 1, maxBytes: MAX_LOCK_BYTES,
            directoryAuthority: this.directoryAuthority });
        } catch (error) { cleanupErrors.push(error); }
      }
      const residue = { temp: residueAt(tempPath, cleanupErrors), visible: residueAt(this.lockPath, cleanupErrors) };
      const primary = primaryError.cause?.code === "EEXIST" && !primaryError.cleanupFailed ? primaryError.cause : primaryError;
      const cause = orderedFailure(primary, cleanupErrors, `process-owned lock publication and cleanup failed: ${this.lockPath}`);
      this.processIdentity = null;
      this.lockIdentity = null;
      if ((primary.code === "PROCESS_IDENTITY_UNAVAILABLE" || primary.code === "EEXIST")
        && cleanupErrors.length === 0 && !residue.temp && !published) throw primary;
      throw this.#transitionError({ phase: primaryError.phase ?? phase, cause, owner,
        publishedToVisibleName: published, publicationUnknown: primaryError.publicationUnknown === true, residue });
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
      removeRegularFile(this.lockPath, { expectedIdentity: current.stat, maxBytes: MAX_LOCK_BYTES, directoryAuthority: this.directoryAuthority });
    } catch (cause) {
      const cleanupErrors = [];
      const visibleResidue = residueAt(this.lockPath, cleanupErrors);
      throw this.#transitionError({
        phase: cause.publicationUnknown ? "stale-remove-readback" : "stale-remove-unlink",
        cause: orderedFailure(
          cause,
          cleanupErrors,
          `stale process-owned lock removal and residue inspection both failed: ${this.lockPath}`,
        ),
        owner: current.owner,
        publishedToVisibleName: false,
        publicationUnknown: cause.publicationUnknown === true,
        residue: { temp: false, visible: visibleResidue },
      });
    }
    this.directoryAuthority.assertStable();
    return true;
  }

  #readOwner(stat) {
    let owner = null;
    try {
      let value;
      captureRegularFile(this.lockPath, { label: "process-owned lock", maxBytes: MAX_LOCK_BYTES,
        expectedIdentity: stat, directoryAuthority: this.directoryAuthority,
        validateSnapshot(snapshot) { value = JSON.parse(snapshot.text()); } });
      const actualAuthority = Object.fromEntries(Object.keys(this.authority).map((key) => [key, value[key]]));
      if (value.version !== LOCK_VERSION || value.kind !== this.kind || stableAuthority(actualAuthority) !== this.serializedAuthority) {
        throw new Error("process-owned lock authority is invalid");
      }
      owner = new ProcessLockOwner({ kind: value.kind, authority: actualAuthority, processIdentity: value.processIdentity });
      return owner;
    } catch (cause) {
      if (cause instanceof AggregateError && cause.errors[0]?.reason === "identity") {
        const observation = new ProcessLockOwnerObservationChanged("process-owned lock changed while reading its owner record", { cause: cause.errors[0] });
        cause = new AggregateError([observation, ...cause.errors.slice(1)], cause.message, { cause: observation });
      }
      if (cause.code === "ENOENT" || /identity changed|changed while reading/.test(cause.message)) {
        throw new ProcessLockOwnerObservationChanged("process-owned lock changed while reading its owner record", { cause });
      }
      throw this.#error("corrupt", `process-owned lock is corrupt: ${cause.message}`, cause, owner);
    }
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
    publicationUnknown,
    residue,
  }) {
    const status = publicationUnknown ? "publication-unconfirmed" : "transition-failed";
    const message = publicationUnknown
      ? `process-owned lock publication is unconfirmed during ${phase}: ${this.lockPath}`
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
      publicationUnknown,
      residue,
    });
  }
}
