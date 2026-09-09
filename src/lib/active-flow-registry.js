/**
 * src/lib/active-flow-registry.js
 *
 * Manages `.sennel/.active-flow` — the pointer file listing currently
 * active Spec-Driven Development flows in this repository. Used by FlowManager.
 *
 * @typedef {Object} ActiveFlowEntry
 * @property {string} specId - spec ID (e.g. "086-migrate-flow-state")
 * @property {"worktree"|"branch"|"direct"} mode
 */

import fs from "fs";
import path from "path";
import { managedDir } from "./config.js";
import { runGit } from "./git-helpers.js";
import { ACTIVE_FLOW_FILE } from "./flow-helpers.js";
import { AtomicJsonFile } from "./atomic-json-file.js";
import { FileLock } from "./file-lock.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import {
  RepositoryFlowOperationLock,
  resolveRepositoryLockRoot,
} from "./repository-maintenance-lock.js";
import { FlowSpecId } from "./flow-spec-id.js";
import { FlowVersion } from "./flow-version.js";
import { DEFAULT_FLOW_SPEC_DIR, FlowSpecRoot, FlowWorkspace } from "./flow-workspace.js";

const REGISTRY_LOCK_FILE = ".active-flow.lock";
const VALID_MODES = new Set(["worktree", "branch", "direct"]);

function activeFlowPath(mainRoot) {
  return path.join(managedDir(mainRoot), ACTIVE_FLOW_FILE);
}

class ActiveFlowEntry {
  constructor({ specId, mode }) {
    ActiveFlowEntry.assertValidSpecId(specId);
    if (!VALID_MODES.has(mode)) throw new Error("active-flow entry.mode is invalid");
    this.specId = specId;
    this.mode = mode;
    Object.freeze(this);
  }

  static fromStored(value) {
    if (
      value == null
      || typeof value !== "object"
      || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["mode", "specId"])
    ) {
      throw new Error("active-flow entry has an invalid schema");
    }
    return new ActiveFlowEntry(value);
  }

  static assertValidSpecId(specId) {
    try {
      FlowSpecId.from(specId);
    } catch {
      throw new Error("active-flow entry.specId is invalid");
    }
  }

  toJSON() {
    return { specId: this.specId, mode: this.mode };
  }
}

class ActiveFlowDocument {
  constructor(entries = []) {
    this.entries = entries.map((entry) => entry instanceof ActiveFlowEntry ? entry : ActiveFlowEntry.fromStored(entry));
    const specIds = new Set();
    for (const entry of this.entries) {
      if (specIds.has(entry.specId)) throw new Error(`active-flow contains duplicate specId: ${entry.specId}`);
      specIds.add(entry.specId);
    }
  }

  static fromStored(value) {
    if (!Array.isArray(value)) throw new Error("active-flow authority must contain an array");
    return new ActiveFlowDocument(value);
  }

  add(specId, mode) {
    const existing = this.entries.find((entry) => entry.specId === specId);
    if (existing?.mode === mode) return false;
    if (existing) {
      const error = new Error(`active-flow mode conflicts for spec: ${specId}`);
      error.code = "ACTIVE_FLOW_REGISTRY_MODE_CONFLICT";
      throw error;
    }
    this.assertCanAdd(specId, mode);
    this.entries.push(new ActiveFlowEntry({ specId, mode }));
    return true;
  }

  assertCanAdd(specId, mode) {
    if (mode !== "branch") return;
    const existing = this.entries.find((entry) => entry.mode === "branch" && entry.specId !== specId);
    if (!existing) return;
    const error = new Error(
      `active branch flow already exists: ${existing.specId}. Complete or abort it before starting another branch flow.`,
    );
    error.code = "ACTIVE_FLOW_BRANCH_CONFLICT";
    error.specId = existing.specId;
    throw error;
  }

  remove(specId) {
    const filtered = this.entries.filter((entry) => entry.specId !== specId);
    const changed = filtered.length !== this.entries.length;
    this.entries = filtered;
    return changed;
  }

  toJSON() {
    return this.entries.map((entry) => entry.toJSON());
  }
}

export class ActiveFlowRegistrySnapshot {
  constructor({ entries, revision }) {
    this.entries = Object.freeze(entries.map((entry) => Object.freeze(
      entry instanceof ActiveFlowEntry ? entry.toJSON() : ActiveFlowEntry.fromStored(entry).toJSON(),
    )));
    if (revision != null && typeof revision !== "string") {
      throw new Error("active-flow registry snapshot revision must be a string or null");
    }
    this.revision = revision;
    Object.freeze(this);
  }

  toJSON() {
    return {
      entries: this.entries.map((entry) => ({ ...entry })),
      revision: this.revision,
    };
  }
}

function registryRevision(bytes) {
  return bytes == null ? null : `${bytes.length}:${Buffer.from(bytes).toString("base64")}`;
}

class ActiveFlowReadRaceError extends Error {
  constructor(filePath) {
    super(`active-flow authority changed twice while reading: ${filePath}`);
    this.code = "ACTIVE_FLOW_REGISTRY_BUSY";
    this.registryPath = filePath;
  }
}

function activeFlowPathStat(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(filePath) !== path.resolve(filePath)) {
    throw new Error(`active-flow authority must be one real non-hardlinked file: ${filePath}`);
  }
  return stat;
}

function readActiveFlowAuthorityOnce(filePath) {
  const stat = activeFlowPathStat(filePath);
  if (stat == null) return { revision: null, document: new ActiveFlowDocument() };
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === "ENOENT") return { revision: null, document: new ActiveFlowDocument() };
    throw error;
  }
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink > 1) {
      throw new Error(`active-flow authority changed to a non-real file while reading: ${filePath}`);
    }
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink === 0) {
      throw new ActiveFlowReadRaceError(`active-flow authority identity changed while reading: ${filePath}`);
    }
    const bytes = fs.readFileSync(descriptor);
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`active-flow authority is malformed: ${error.message}`, { cause: error });
    }
    const document = ActiveFlowDocument.fromStored(value);
    const visible = activeFlowPathStat(filePath);
    if (visible == null || visible.dev !== opened.dev || visible.ino !== opened.ino) {
      throw new ActiveFlowReadRaceError(filePath);
    }
    return {
      revision: registryRevision(bytes),
      document,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readActiveFlowAuthority(filePath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return readActiveFlowAuthorityOnce(filePath);
    } catch (error) {
      if (!(error instanceof ActiveFlowReadRaceError) || attempt === 1) throw error;
    }
  }
  throw new ActiveFlowReadRaceError(filePath);
}

function removeDurably(filePath) {
  fs.unlinkSync(filePath);
  const descriptor = fs.openSync(path.dirname(filePath), "r");
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
          `active-flow removal durability and descriptor cleanup both failed: ${filePath}`,
          { cause: primaryError },
        );
      }
      throw cleanupError;
    }
  }
  if (primaryError) throw primaryError;
}

function runGitBoolean(args, predicate, contextLabel) {
  const res = runGit(args);
  if (!res.ok) {
    const error = new Error(
      `${contextLabel}: git ${args.join(" ")} failed: ${res.stderr.trim() || "unknown error"}`,
    );
    error.code = "ACTIVE_FLOW_REGISTRY_GIT_PROBE_FAILED";
    throw error;
  }
  return predicate(res.stdout);
}

function worktreeExists(mainRoot, branch) {
  return runGitBoolean(
    ["-C", mainRoot, "worktree", "list", "--porcelain"],
    (stdout) => stdout.split("\n").includes(`branch refs/heads/${branch}`),
    "worktreeExists",
  );
}

function branchExists(mainRoot, branch) {
  return runGitBoolean(
    ["-C", mainRoot, "branch", "--list", branch],
    (stdout) => stdout.trim().length > 0,
    "branchExists",
  );
}

function canonicalFlowExists(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || fs.realpathSync(filePath) !== path.resolve(filePath)
  ) {
    throw new Error(`active canonical flow authority must be one real non-hardlinked file: ${filePath}`);
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== stat.dev
      || opened.ino !== stat.ino
    ) {
      throw new Error(`active canonical flow authority changed while probing: ${filePath}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return true;
}

function canonicalFlowStatePath(mainRoot, specRoot, specId) {
  return new FlowWorkspace({
    repositoryRoot: mainRoot,
    executionRoot: mainRoot,
    specRoot,
  }).canonicalVersion(specId, new FlowVersion(1)).flowStateFile;
}

export class ActiveFlowRegistry {
  /**
   * @param {Object} opts
   * @param {string} opts.mainRoot - main repo root (resolved from worktree if applicable)
   */
  constructor({ mainRoot, specRoot = DEFAULT_FLOW_SPEC_DIR, processIdentitySource } = {}) {
    this._mainRoot = resolveRepositoryLockRoot(mainRoot);
    this._specRoot = FlowSpecRoot.from(specRoot);
    this._processIdentitySource = processIdentitySource;
    const rootErrorFactory = (status, message, { lockPath, cause } = {}) => {
      const error = new Error(message, { cause });
      error.code = status === "live" || status === "timeout"
        ? "ACTIVE_FLOW_REGISTRY_BUSY"
        : `ACTIVE_FLOW_REGISTRY_LOCK_${status.replace(/-/g, "_").toUpperCase()}`;
      error.lockPath = lockPath;
      return error;
    };
    const rootAuthority = new RealDirectoryAuthority(this._mainRoot, { errorFactory: rootErrorFactory });
    const directoryAuthority = new RealDirectoryAuthority(managedDir(this._mainRoot), {
      create: true,
      parentAuthority: rootAuthority,
      errorFactory: rootErrorFactory,
    });
    this._lock = new FileLock({
      directoryAuthority,
      fileName: REGISTRY_LOCK_FILE,
      kind: "active-flow-registry",
      authority: {
        mainRoot: path.resolve(this._mainRoot),
        registryPath: activeFlowPath(this._mainRoot),
      },
      ...(processIdentitySource && { processIdentitySource }),
      errorFactory: rootErrorFactory,
    });
  }

  static lockPathFor(mainRoot) {
    return path.join(managedDir(resolveRepositoryLockRoot(mainRoot)), REGISTRY_LOCK_FILE);
  }

  /** @returns {ActiveFlowEntry[]} */
  load() {
    return readActiveFlowAuthority(activeFlowPath(this._mainRoot)).document.toJSON();
  }

  snapshot(options = {}) {
    return this.#withMutationLock(() => {
      const snapshot = readActiveFlowAuthority(activeFlowPath(this._mainRoot));
      return new ActiveFlowRegistrySnapshot({
        entries: snapshot.document.entries,
        revision: snapshot.revision,
      });
    }, options);
  }

  /**
   * @param {string} specId
   * @param {"worktree"|"branch"|"direct"} mode
   */
  add(specId, mode, options = {}) {
    ActiveFlowEntry.assertValidSpecId(specId);
    return this.#withMutationLock(() => {
      const snapshot = readActiveFlowAuthority(activeFlowPath(this._mainRoot));
      if (!snapshot.document.add(specId, mode)) return;
      this.#write(snapshot.document, snapshot.revision);
    }, options);
  }

  /**
   * Verify that an active-flow entry can be added without changing the
   * registry. Prepare uses this before switching the shared checkout.
   *
   * @param {string} specId
   * @param {"worktree"|"branch"|"direct"} mode
   */
  assertCanAdd(specId, mode, options = {}) {
    ActiveFlowEntry.assertValidSpecId(specId);
    return this.#withMutationLock(() => {
      const snapshot = readActiveFlowAuthority(activeFlowPath(this._mainRoot));
      snapshot.document.assertCanAdd(specId, mode);
    }, options);
  }

  /**
   * @param {string} specId
   */
  remove(specId, options = {}) {
    ActiveFlowEntry.assertValidSpecId(specId);
    return this.#withMutationLock(() => {
      const snapshot = readActiveFlowAuthority(activeFlowPath(this._mainRoot));
      if (!snapshot.document.remove(specId)) return;
      if (snapshot.document.entries.length === 0) {
        this.#remove(snapshot.revision);
        return;
      }
      this.#write(snapshot.document, snapshot.revision);
    }, options);
  }

  /**
   * Remove stale entries from .active-flow.
   * @returns {ActiveFlowEntry[]} cleaned active flows
   */
  cleanStale(options = {}) {
    return this.#withMutationLock(() => {
      const snapshot = readActiveFlowAuthority(activeFlowPath(this._mainRoot));
      const valid = snapshot.document.entries.filter((entry) => {
        const statePath = canonicalFlowStatePath(this._mainRoot, this._specRoot, entry.specId);
        if (!canonicalFlowExists(statePath)) {
          const error = new Error(
            `active flow state is missing at the configured spec root: ${statePath}. `
            + "Restore flow.specDir or resolve the active flow explicitly before continuing.",
          );
          error.code = "ACTIVE_FLOW_STATE_AUTHORITY_MISSING";
          error.specId = entry.specId;
          error.statePath = statePath;
          throw error;
        }
        const branch = `feature/${entry.specId}`;
        if (entry.mode === "worktree") return worktreeExists(this._mainRoot, branch);
        if (entry.mode === "branch") return branchExists(this._mainRoot, branch);
        return true;
      });
      if (valid.length !== snapshot.document.entries.length) {
        const document = new ActiveFlowDocument(valid);
        if (valid.length === 0) this.#remove(snapshot.revision);
        else this.#write(document, snapshot.revision);
      }
      return valid.map((entry) => entry.toJSON());
    }, options);
  }

  #write(document, expectedRevision) {
    const filePath = activeFlowPath(this._mainRoot);
    const fresh = readActiveFlowAuthority(filePath);
    if (fresh.revision !== expectedRevision) {
      const error = new Error("active-flow registry revision changed concurrently");
      error.code = "ACTIVE_FLOW_REGISTRY_REVISION_CONFLICT";
      throw error;
    }
    return new AtomicJsonFile(filePath).write(document.toJSON());
  }

  #remove(expectedRevision) {
    const filePath = activeFlowPath(this._mainRoot);
    const fresh = readActiveFlowAuthority(filePath);
    if (fresh.revision !== expectedRevision || fresh.revision == null) {
      const error = new Error("active-flow registry revision changed before removal");
      error.code = "ACTIVE_FLOW_REGISTRY_REVISION_CONFLICT";
      throw error;
    }
    removeDurably(filePath);
  }

  #withMutationLock(body, { maintenanceOwnerToken = null, operationOwnerToken = null } = {}) {
    const operationLock = new RepositoryFlowOperationLock({
      mainRoot: this._mainRoot,
      maintenanceOwnerToken,
      operationOwnerToken,
      ...(this._processIdentitySource && { processIdentitySource: this._processIdentitySource }),
    });
    return this.#withOwnedLock(
      () => {
        try {
          operationLock.acquire();
        } catch (cause) {
          if (cause.code !== "REPOSITORY_FLOW_OPERATION_BUSY") throw cause;
          const error = new Error("active-flow registry is blocked by another flow operation", { cause });
          error.code = "ACTIVE_FLOW_REGISTRY_BUSY";
          error.lockStatus = cause.lockStatus;
          error.lockPath = cause.lockPath;
          error.owner = cause.owner;
          if (cause.waitedMs !== undefined) error.waitedMs = cause.waitedMs;
          if (cause.retryable !== undefined) error.retryable = cause.retryable;
          throw error;
        }
      },
      () => operationLock.release(),
      () => this.#withRegistryLock(body),
      "active-flow registry mutation and repository flow-operation release both failed",
    );
  }

  #withRegistryLock(body) {
    // Registry mutations always acquire repository flow-operation first.
    // A caller may already hold an unrelated outer transaction lock.
    return this._lock.runExclusive(body);
  }

  #withOwnedLock(acquire, release, body, aggregateMessage) {
    acquire();
    let result;
    let primaryError = null;
    try {
      result = body();
    } catch (error) {
      primaryError = error;
    }
    let releaseError = null;
    try {
      release();
    } catch (error) {
      releaseError = error;
    }
    if (primaryError && releaseError) {
      throw new AggregateError(
        [primaryError, releaseError],
        aggregateMessage,
        { cause: primaryError },
      );
    }
    if (primaryError) throw primaryError;
    if (releaseError) throw releaseError;
    return result;
  }
}
