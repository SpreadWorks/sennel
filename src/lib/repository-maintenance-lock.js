import path from "node:path";
import { PRODUCT } from "./product.js";
import { runBootstrapGitProbe } from "./bootstrap-process.js";
import { LockOwnerSession, ProcessLock } from "./process-lock.js";
import { RepositoryLockAuthority } from "./repository-control-lock.js";

const MAINTENANCE_KIND = "repository-maintenance";
const FLOW_OPERATION_KIND = "repository-flow-operation";
const MAINTENANCE_FILE = ".repository-maintenance.lock";
const FLOW_OPERATION_FILE = ".repository-flow-operation.lock";

export function resolveRepositoryLockRoot(root) {
  const resolved = path.resolve(root);
  const result = runBootstrapGitProbe("common-directory", { cwd: resolved });
  if (!result.ok) return resolved;
  const commonDirectory = path.resolve(resolved, result.stdout.trim());
  return path.basename(commonDirectory) === ".git" ? path.dirname(commonDirectory) : resolved;
}

export class RepositoryLockError extends Error {
  constructor(code, message, {
    lockStatus = null,
    lockPath,
    owner = null,
    cause,
    contention = null,
  } = {}) {
    super(message, { cause });
    this.name = "RepositoryLockError";
    this.code = code;
    this.lockStatus = lockStatus;
    this.lockPath = lockPath;
    this.owner = owner;
    this.contention = contention;
    this.committed = false;
  }
}

export class RepositoryLockContention {
  constructor({ owner, requester, requesterError = null, operation, boundary }) {
    if (owner != null && typeof owner !== "object") throw new Error("repository lock contention owner must be an object or null");
    if (requester == null && !(requesterError instanceof Error)) {
      throw new Error("repository lock contention requires a requester identity or diagnostic error");
    }
    if (requester != null && typeof requester !== "object") throw new Error("repository lock contention requester must be an object or null");
    if (typeof operation !== "string" || operation === "") throw new Error("repository lock contention requires an operation");
    if (typeof boundary !== "string" || boundary === "") throw new Error("repository lock contention requires a boundary");
    this.owner = owner;
    this.requester = requester;
    this.requesterError = requesterError;
    this.operation = operation;
    this.boundary = boundary;
    Object.freeze(this);
  }
}

function lockCode(kind, status) {
  if (status === "authority-invalid") return "REPOSITORY_LOCK_AUTHORITY_INVALID";
  const prefix = kind === MAINTENANCE_KIND
    ? "REPOSITORY_MAINTENANCE"
    : "REPOSITORY_FLOW_OPERATION";
  if (status === "busy") return `${prefix}_BUSY`;
  if (status === "unknown") return `${prefix}_LOCK_UNKNOWN`;
  if (status === "corrupt") return `${prefix}_LOCK_CORRUPT`;
  if (status === "ownership-changed") return "REPOSITORY_LOCK_OWNERSHIP_CHANGED";
  return "REPOSITORY_LOCK_ACQUIRE_FAILED";
}

function repositoryErrorFactory(kind) {
  return (status, message, { lockPath, owner = null, cause } = {}) => new RepositoryLockError(
    lockCode(kind, status),
    message,
    { lockStatus: status, lockPath, owner, cause },
  );
}

class ProcessRepositoryLock {
  constructor({ repositoryAuthority, kind, fileName }) {
    this.repositoryAuthority = repositoryAuthority;
    this.kind = kind;
    this.fileName = fileName;
    this.core = null;
  }

  get ownerToken() { return this.core?.ownerToken ?? null; }

  #resolve() {
    if (this.core !== null) return this.core;
    const location = this.repositoryAuthority.location({ fileName: this.fileName,
      legacyPaths: [path.join(this.repositoryAuthority.mainRoot, PRODUCT.managedPath(this.fileName))] });
    this.core = new ProcessLock({ location,
      kind: this.kind, authority: { mainRoot: this.repositoryAuthority.mainRoot },
      errorFactory: repositoryErrorFactory(this.kind) });
    return this.core;
  }

  acquire() { return this.#resolve().acquire(); }
  release() { this.core?.release(); }
  inspect() { return this.#resolve()?.inspect()?.owner ?? null; }
  isOwnerCurrent(owner) { return this.core?.isOwnerCurrent(owner) ?? false; }
  conflict(owner) { return this.core.conflict(owner); }
}

function inspectForeign(lock, allowedOwnerToken) {
  const owner = lock.inspect();
  if (!owner) return null;
  if (allowedOwnerToken && owner.ownerToken === allowedOwnerToken && lock.isOwnerCurrent(owner)) return null;
  return lock.conflict(owner);
}

function acquisitionCleanupError(message, primaryError, cleanupError, residue) {
  const error = new AggregateError(
    [primaryError, cleanupError],
    message,
    { cause: primaryError },
  );
  error.residue = Object.freeze({ ...residue });
  return error;
}

export function assertRepositoryMaintenanceAvailable({
  mainRoot,
  maintenanceOwnerToken = null,
}) {
  const repositoryAuthority = new RepositoryLockAuthority(mainRoot, { errorFactory: repositoryErrorFactory(MAINTENANCE_KIND) });
  const maintenance = new ProcessRepositoryLock({
    repositoryAuthority,
    kind: MAINTENANCE_KIND,
    fileName: MAINTENANCE_FILE,
  });
  const conflict = inspectForeign(maintenance, maintenanceOwnerToken);
  if (conflict) throw conflict;
}

export class RepositoryMaintenanceLock {
  constructor({ mainRoot }) {
    const repositoryAuthority = new RepositoryLockAuthority(mainRoot, { errorFactory: repositoryErrorFactory(MAINTENANCE_KIND) });
    this.lock = new ProcessRepositoryLock({
      repositoryAuthority,
      kind: MAINTENANCE_KIND,
      fileName: MAINTENANCE_FILE,
    });
    this.flowOperation = new ProcessRepositoryLock({
      repositoryAuthority,
      kind: FLOW_OPERATION_KIND,
      fileName: FLOW_OPERATION_FILE,
    });
  }

  static pathFor(mainRoot) {
    return RepositoryLockAuthority.pathFor(mainRoot, { fileName: MAINTENANCE_FILE });
  }

  get ownerToken() {
    return this.lock.ownerToken ?? null;
  }

  acquire() {
    const token = this.lock.acquire();
    try {
      const conflict = inspectForeign(this.flowOperation, null);
      if (conflict) throw conflict;
      return token;
    } catch (primaryError) {
      try {
        this.lock.release();
      } catch (cleanupError) {
        throw acquisitionCleanupError(
          "repository maintenance acquisition and cleanup both failed",
          primaryError,
          cleanupError,
          { maintenanceLock: true },
        );
      }
      throw primaryError;
    }
  }

  release() {
    this.lock.release();
  }
}

export class RepositoryFlowOperationLock {
  constructor({
    mainRoot,
    maintenanceOwnerToken = null,
    operationOwnerToken = null,
  }) {
    const repositoryAuthority = new RepositoryLockAuthority(mainRoot, { errorFactory: repositoryErrorFactory(MAINTENANCE_KIND) });
    this.lockPath = repositoryAuthority.location({ fileName: FLOW_OPERATION_FILE }).path;
    this.maintenanceOwnerToken = maintenanceOwnerToken;
    this.operationOwnerToken = operationOwnerToken;
    this.borrowed = false;
    this.acquiredOwnerToken = null;
    this.maintenance = new ProcessRepositoryLock({
      repositoryAuthority,
      kind: MAINTENANCE_KIND,
      fileName: MAINTENANCE_FILE,
    });
    this.lock = new ProcessRepositoryLock({
      repositoryAuthority,
      kind: FLOW_OPERATION_KIND,
      fileName: FLOW_OPERATION_FILE,
    });
  }

  #attachContention(error, owner) {
    if (
      !(error instanceof RepositoryLockError)
      || error.contention
    ) return error;
    error.contention = new RepositoryLockContention({
      owner: owner ? new LockOwnerSession(owner) : null,
      requester: LockOwnerSession.current(),
      operation: FLOW_OPERATION_KIND,
      boundary: "acquire",
    });
    return error;
  }

  acquire() {
    const before = inspectForeign(this.maintenance, this.maintenanceOwnerToken);
    if (before) throw before;
    let existing;
    try {
      existing = this.lock.inspect();
    } catch (error) {
      throw this.#attachContention(error, null);
    }
    if (this.operationOwnerToken) {
      if (
        existing
        && existing.ownerToken === this.operationOwnerToken
      ) {
        if (this.lock.isOwnerCurrent(existing)) {
          this.borrowed = true;
          this.acquiredOwnerToken = this.operationOwnerToken;
          return this.operationOwnerToken;
        }
        throw this.#attachContention(this.lock.conflict(existing), existing);
      }
      if (!existing) {
        throw repositoryErrorFactory(FLOW_OPERATION_KIND)(
          "ownership-changed",
          "repository flow-operation owner token no longer identifies the canonical lock",
          { lockPath: this.lockPath },
        );
      }
      throw this.#attachContention(
        this.lock.conflict(existing),
        existing,
      );
    }
    let token;
    try {
      token = this.lock.acquire();
    } catch (error) {
      throw this.#attachContention(error, existing);
    }
    try {
      const after = inspectForeign(this.maintenance, this.maintenanceOwnerToken);
      if (after) throw after;
      this.acquiredOwnerToken = token;
      return token;
    } catch (primaryError) {
      try {
        this.lock.release();
      } catch (cleanupError) {
        throw acquisitionCleanupError(
          "repository flow-operation acquisition and cleanup both failed",
          primaryError,
          cleanupError,
          { flowOperationLock: true },
        );
      }
      throw primaryError;
    }
  }

  inspectConflict() {
    return inspectForeign(this.maintenance, this.maintenanceOwnerToken)
      || inspectForeign(this.lock, this.operationOwnerToken);
  }

  get owner() { return new LockOwnerSession(this.#owned()); }

  assertOwned() { return this.#owned().ownerToken; }

  #owned() {
    const owner = this.lock.inspect();
    if (
      this.acquiredOwnerToken == null
      || owner == null
      || owner.ownerToken !== this.acquiredOwnerToken
      || !this.lock.isOwnerCurrent(owner)
    ) {
      throw repositoryErrorFactory(FLOW_OPERATION_KIND)(
        "ownership-changed",
        "repository flow-operation ownership changed",
        { lockPath: this.lockPath, owner: owner?.toJSON() ?? null },
      );
    }
    return owner;
  }

  release() {
    if (this.borrowed) {
      this.borrowed = false;
      this.acquiredOwnerToken = null;
      return;
    }
    this.lock.release();
    this.acquiredOwnerToken = null;
  }
}
