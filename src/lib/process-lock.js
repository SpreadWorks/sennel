import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { captureRegularFile, RegularFileLinkCountError } from "./regular-file-snapshot.js";
import { AtomicFile } from "./atomic-file.js";
import { removeRegularFile } from "./regular-file-io.js";
import { FileIdentity, RealDirectoryAuthority, sameFileIdentity as sameFile } from "./real-directory-authority.js";
import { RepositoryLockLocation } from "./repository-control-lock.js";

const LOCK_VERSION = 2;
const SESSION = crypto.randomUUID();
const holdings = new Map();
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

/** Linked bytes never authorize an owner; FileLock may wait within its existing policy. */
export class ProcessLockPublicationPendingError extends Error {
  constructor(error) {
    super(error.message, { cause: error });
    this.name = "ProcessLockPublicationPendingError";
    this.code = error.code;
    this.lockStatus = error.lockStatus;
    this.lockPath = error.lockPath;
    this.owner = null;
  }
}

class ProcessLockOwnerObservationChanged extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = "ProcessLockOwnerObservationChanged";
  }
}

export class LockOwnerSession {
  constructor({ ownerToken, ownerSession }) {
    if (typeof ownerToken !== "string" || typeof ownerSession !== "string"
      || !OWNER_TOKEN_PATTERN.test(ownerToken) || !OWNER_TOKEN_PATTERN.test(ownerSession)) {
      throw new Error("lock owner token and session must be UUIDs");
    }
    this.ownerToken = ownerToken;
    this.ownerSession = ownerSession;
    if (new.target === LockOwnerSession) Object.freeze(this);
  }

  static current() { return new LockOwnerSession({ ownerToken: crypto.randomUUID(), ownerSession: SESSION }); }
  toJSON() { return { ownerToken: this.ownerToken, ownerSession: this.ownerSession }; }
}

class ProcessLockOwner extends LockOwnerSession {
  constructor({ kind, authority, ownerToken, ownerSession }) {
    super({ ownerToken, ownerSession });
    this.version = LOCK_VERSION;
    this.kind = kind;
    this.authority = Object.freeze({ ...authority });
    Object.freeze(this);
  }
  toJSON() { return { version: this.version, kind: this.kind, ...this.authority, ...super.toJSON() }; }
}

export class ProcessLock {
  #owner = null;
  #identity = null;
  constructor({
    location = null,
    directoryAuthority,
    fileName,
    kind,
    authority,
    errorFactory = location?.authority.errorFactory ?? defaultErrorFactory,
  }) {
    if (location !== null && !(location instanceof RepositoryLockLocation)) {
      throw new TypeError("process lock location must be a RepositoryLockLocation");
    }
    if (location !== null && directoryAuthority !== undefined) throw new TypeError("process lock accepts one physical location authority");
    if (location === null && !(directoryAuthority instanceof RealDirectoryAuthority)) {
      throw new Error("process lock directoryAuthority must be a RealDirectoryAuthority");
    }
    fileName = location?.fileName ?? fileName;
    if (typeof fileName !== "string" || fileName === "" || fileName === "." || fileName === ".." || path.basename(fileName) !== fileName) {
      throw new Error("process lock fileName must be a basename");
    }
    this.location = location;
    this.directoryAuthority = location?.resolve({ errorFactory }) ?? directoryAuthority;
    this.directory = location?.directory ?? directoryAuthority.directory;
    this.lockPath = path.join(this.directory, fileName);
    this.kind = kind;
    this.authority = authority;
    this.serializedAuthority = stableAuthority(authority);
    this.errorFactory = errorFactory;
  }

  get ownerToken() { return this.#owner?.ownerToken ?? null; }
  get ownerSession() { return this.#owner?.ownerSession ?? null; }
  get lockIdentity() { return this.#identity; }

  isOwnerCurrent(owner) {
    const holder = holdings.get(owner?.ownerToken);
    if (!holder || owner.ownerSession !== SESSION || holder.ownerSession !== owner.ownerSession) return false;
    const current = this.inspect();
    return current !== null && current.owner.ownerToken === owner.ownerToken
      && current.owner.ownerSession === owner.ownerSession && sameFile(current.stat, holder.lockIdentity);
  }

  acquire() {
    if (this.location !== null) this.directoryAuthority = this.location.resolve({ create: true, errorFactory: this.errorFactory });
    this.directoryAuthority.ensure();
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const existing = this.inspect();
      if (existing) throw this.conflict(existing.owner);
      try { return this.#publish(); }
      catch (cause) {
        if (cause.code === "EEXIST") continue;
        if (cause?.lockPath === this.lockPath) throw cause;
        throw this.#error("acquire-failed", `lock acquisition failed: ${cause.message}`, cause);
      }
    }
    const existing = this.inspect();
    if (existing) throw this.conflict(existing.owner);
    throw this.#error("acquire-failed", "lock acquisition retry limit exceeded");
  }

  inspect() {
    if (this.location !== null) {
      this.directoryAuthority = this.location.resolve({ errorFactory: this.errorFactory });
      if (this.directoryAuthority === null) return null;
    }
    let observationChanged = null;
    for (let attempt = 0; attempt < MAX_OWNER_OBSERVATION_ATTEMPTS; attempt += 1) {
      if (this.directoryAuthority.identity === null) {
        let ancestor = this.directoryAuthority.parentAuthority;
        while (ancestor?.identity === null) ancestor = ancestor.parentAuthority;
        const observed = ancestor.descendant(this.directory, { allowMissing: true });
        if (observed.directory !== this.directory) return null;
      }
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

  conflict(owner) {
    return this.#error("busy", "lock is held by a published owner token; process liveness is unknown", undefined, owner);
  }

  release() {
    if (this.#owner == null) return;
    this.directoryAuthority.assertStable();
    const current = this.inspect();
    if (
      !current
      || !sameFile(current.stat, this.lockIdentity)
      || current.owner.ownerToken !== this.ownerToken
      || current.owner.ownerSession !== this.ownerSession
      || holdings.get(this.ownerToken) !== this
    ) {
      throw this.#error("ownership-changed", "process-owned lock ownership changed");
    }
    try {
      removeRegularFile(this.lockPath, { expectedIdentity: current.stat, maxBytes: MAX_LOCK_BYTES,
        directoryAuthority: this.directoryAuthority, commitGuard: () => {
          const visible = this.inspect();
          if (!visible || visible.owner.ownerToken !== this.ownerToken || visible.owner.ownerSession !== this.ownerSession) {
            throw this.#error("ownership-changed", "lock owner changed before release");
          }
        } });
    } catch (cause) {
      holdings.delete(this.ownerToken);
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
    holdings.delete(this.ownerToken);
    this.#owner = null;
    this.#identity = null;
    this.directoryAuthority.assertStable();
  }

  #publish() {
    const owner = new ProcessLockOwner({ kind: this.kind, authority: this.authority, ...LockOwnerSession.current() });
    const stageName = `.${path.basename(this.lockPath)}.${owner.ownerToken}.tmp`;
    const stagePath = path.join(this.directory, stageName);
    const file = new AtomicFile(this.lockPath, { maxBytes: MAX_LOCK_BYTES, directoryAuthority: this.directoryAuthority });
    try {
      // Publish only a closed, complete owner record. The exclusive link cannot
      // overwrite another owner; linked bytes remain unreadable until stage removal.
      const stage = file.createStage(`${JSON.stringify(owner.toJSON(), null, 2)}\n`, { stageName, exclusive: true });
      const snapshot = file.publishStage(stage, { exclusive: true }).snapshot;
      this.#owner = owner;
      this.#identity = snapshot.identity;
      holdings.set(owner.ownerToken, this);
      return owner.ownerToken;
    } catch (cause) {
      if (!cause.publicationUnknown && !cause.cleanupFailed && cause.cause?.code === "EEXIST") {
        throw Object.assign(new Error("lock appeared during exclusive publication", { cause }), { code: "EEXIST" });
      }
      const cleanupErrors = [];
      const temp = residueAt(stagePath, cleanupErrors);
      const visible = residueAt(this.lockPath, cleanupErrors);
      throw this.#transitionError({ phase: "owner-create", cause: orderedFailure(cause, cleanupErrors,
        "lock creation and residue observation failed"), owner,
        publishedToVisibleName: cause.committedToVisibleName === true,
        publicationUnknown: cause.publicationUnknown === true, residue: { temp, visible } });
    }
  }

  #readOwner(stat) {
    let owner = null;
    try {
      let value;
      captureRegularFile(this.lockPath, { label: "process-owned lock", maxBytes: MAX_LOCK_BYTES,
        expectedIdentity: stat, requireSingleLink: true, directoryAuthority: this.directoryAuthority,
        validateSnapshot(snapshot) { value = JSON.parse(snapshot.text()); } });
      if (value.version !== LOCK_VERSION) throw this.#error("unknown", "unsupported lock owner record; explicit investigation is required");
      const expectedKeys = ["version", "kind", "ownerToken", "ownerSession", ...Object.keys(this.authority)].sort();
      if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
        throw new Error("lock owner record has unexpected or missing fields");
      }
      const actualAuthority = Object.fromEntries(Object.keys(this.authority).map((key) => [key, value[key]]));
      if (value.kind !== this.kind || stableAuthority(actualAuthority) !== this.serializedAuthority) {
        throw new Error("process-owned lock authority is invalid");
      }
      owner = new ProcessLockOwner({ kind: value.kind, authority: actualAuthority, ownerToken: value.ownerToken, ownerSession: value.ownerSession });
      return owner;
    } catch (cause) {
      if (cause?.lockPath === this.lockPath) throw cause;
      if (cause instanceof RegularFileLinkCountError && stat.nlink === 2n) {
        // A normal exclusive publication has a brief two-link interval. A
        // persistent or foreign link is equally unreadable: never parse/adopt it.
        throw new ProcessLockPublicationPendingError(this.#error(
          "publication-pending", "process-owned lock is linked; owner publication is not readable", cause,
        ));
      }
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
