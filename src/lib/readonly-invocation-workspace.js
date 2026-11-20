import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AtomicFile } from "./atomic-file.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { appendRegularFile } from "./regular-file-io.js";
import { captureRegularFile } from "./regular-file-snapshot.js";
import { LogicalRelativePath, isNativePathWithin } from "./portable-path.js";
import { OwnedTemporaryDirectory } from "./owned-temporary-directory.js";

const FACTORY = Symbol("invocation control workspace factory");

export class ReadOnlyInvocationWorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReadOnlyInvocationWorkspaceError";
    this.code = `READONLY_WORKSPACE_${code}`;
  }
}

class WorkspaceExecution {
  constructor(factory, generation) {
    if (factory !== FACTORY) throw new TypeError("workspace executions are factory-owned");
    this.generation = generation;
    this.id = crypto.randomUUID();
    Object.freeze(this);
  }
}

/** Physical control storage; its existing wire tag grants no native effect authority. */
export class ReadOnlyProcessRuntimeStorage {
  #workspace;
  #authority;
  #value;
  #marker;
  constructor(factory, { workspace = null, authority, workspaceAuthority, value = null }) {
    if (factory !== FACTORY) throw new TypeError("runtime storage must be minted by an invocation workspace");
    let ancestor = authority;
    while (ancestor !== null && ancestor !== workspaceAuthority) ancestor = ancestor.parentAuthority;
    if (ancestor === null) throw new TypeError("runtime storage must retain its minted workspace ancestry");
    this.#workspace = workspace;
    this.#authority = authority;
    this.#value = value ?? { schemaVersion: 1, kind: "readonly-invocation", workspaceRoot: workspace.path,
      workspaceGeneration: workspace.generation, directory: authority.directory, token: crypto.randomUUID(),
      workspaceIdentity: { dev: String(workspaceAuthority.identity.dev), ino: String(workspaceAuthority.identity.ino) },
      directoryIdentity: { dev: String(authority.identity.dev), ino: String(authority.identity.ino) } };
    const file = path.join(authority.directory, "storage-authority.json");
    if (value === null) this.#marker = new AtomicFile(file, { directoryAuthority: authority }).write(JSON.stringify(this.#value), { exclusive: true }).snapshot;
    else {
      this.#marker = captureRegularFile(file, { label: "read-only runtime storage authority", maxBytes: 64 * 1024,
        requireSingleLink: true, directoryAuthority: authority });
      if (this.#marker.text() !== JSON.stringify(value)) throw new ReadOnlyInvocationWorkspaceError("STORAGE_AUTHORITY_INVALID", "runtime storage grant differs from its minted authority");
    }
    Object.freeze(this);
  }
  /** Structural decoding is also used for retained endpoint history, without filesystem I/O. */
  static validateGrant(value) {
    const fields = ["schemaVersion", "kind", "workspaceRoot", "workspaceGeneration", "directory", "token", "workspaceIdentity", "directoryIdentity"];
    if (!value || typeof value !== "object" || Object.keys(value).length !== fields.length
      || fields.some((field) => !Object.hasOwn(value, field)) || value.schemaVersion !== 1 || value.kind !== "readonly-invocation"
      || !/^[0-9a-f-]{36}$/.test(value.workspaceGeneration) || !/^[0-9a-f-]{36}$/.test(value.token)
      || !path.isAbsolute(value.workspaceRoot) || value.directory !== path.join(value.workspaceRoot, "control", "process-runtime")) throw new ReadOnlyInvocationWorkspaceError("STORAGE_AUTHORITY_INVALID", "runtime storage grant is unsupported");
    for (const identity of [value.workspaceIdentity, value.directoryIdentity]) {
      if (!identity || typeof identity !== "object" || Object.keys(identity).length !== 2
        || ["dev", "ino"].some((field) => !Object.hasOwn(identity, field) || typeof identity[field] !== "string" || identity[field].length === 0)) {
        throw new ReadOnlyInvocationWorkspaceError("STORAGE_AUTHORITY_INVALID", "runtime storage identity is malformed");
      }
    }
    return value;
  }
  static fromGrant(value) {
    if (value instanceof ReadOnlyProcessRuntimeStorage) return value;
    this.validateGrant(value);
    const workspaceAuthority = new RealDirectoryAuthority(value.workspaceRoot);
    const authority = workspaceAuthority.descendant(value.directory);
    for (const [actual, expected] of [[workspaceAuthority.identity, value.workspaceIdentity], [authority.identity, value.directoryIdentity]]) {
      if (String(actual.dev) !== expected?.dev || String(actual.ino) !== expected?.ino) throw new ReadOnlyInvocationWorkspaceError("STORAGE_AUTHORITY_INVALID", "runtime storage identity changed");
    }
    return new ReadOnlyProcessRuntimeStorage(FACTORY, { authority, workspaceAuthority, value });
  }
  get directory() { return this.#authority.directory; }
  get authority() { this.assertStable(); return this.#authority; }
  assertStable() {
    this.#workspace?.assertOpen();
    // The checked marker reader freshly validates this retained authority and
    // its complete ancestry before and after reading. The constructor binds
    // that chain to the exact minted workspace root.
    const current = captureRegularFile(this.#marker.filePath, { label: "read-only runtime storage authority", maxBytes: 64 * 1024,
      requireSingleLink: true, directoryAuthority: this.#authority, allowMissingDirectory: true, expectedIdentity: this.#marker.identity });
    if (current.digest !== this.#marker.digest) throw new ReadOnlyInvocationWorkspaceError("STORAGE_AUTHORITY_INVALID", "runtime storage authority bytes changed");
  }
  runtime(purpose) {
    this.assertStable();
    return path.join(this.directory, "runtime", ...LogicalRelativePath.from(purpose, "read-only runtime purpose").segments);
  }
  createOwnedDirectory(directory, prefix) {
    this.assertStable();
    const selected = path.resolve(directory);
    if (!isNativePathWithin(this.directory, selected)) throw new ReadOnlyInvocationWorkspaceError("OUTSIDE_ROOT", "runtime delivery leaves its owned storage");
    const parent = this.#authority.descendant(selected, { create: true });
    return OwnedTemporaryDirectory.create(parent, prefix);
  }
  toJSON() { return JSON.parse(JSON.stringify(this.#value)); }
}

/** Owned control scratch; never canonical state or cross-invocation resume proof. */
export class InvocationControlWorkspace {
  #authority;
  #owned;
  #parent;
  #generation;
  #pending = new Set();
  #complete = false;
  #removed = false;
  #directories = new Map();
  #ownedDirectories = new Map();
  #processRuntimeStorage = null;

  constructor(factory, owned, parent) {
    if (factory !== FACTORY) throw new TypeError("use the workspace factory");
    this.#owned = owned;
    this.#authority = owned.authority;
    this.#directories.set(this.path, this.#authority);
    this.#parent = parent;
    this.#generation = crypto.randomUUID();
  }

  static create({ temporaryParent = os.tmpdir(), outsideRoots = [] } = {}) {
    // Node selects the native temporary parent. Read-only control storage must
    // also stay outside the checkouts whose contents the invocation observes.
    // Ascending selects a parent; only the factory below mints ownership.
    let selected = fs.realpathSync(temporaryParent);
    const excluded = outsideRoots.map((root) => fs.realpathSync(root));
    while (excluded.some((root) => isNativePathWithin(root, selected))) {
      const ancestor = path.dirname(selected);
      if (ancestor === selected) throw new ReadOnlyInvocationWorkspaceError("NO_EXTERNAL_PARENT",
        "Read-only temporary storage has no parent outside the selected checkouts");
      selected = ancestor;
    }
    const parent = new RealDirectoryAuthority(selected);
    parent.assertStable();
    const owned = OwnedTemporaryDirectory.create(parent, "sennel-inspect-");
    return new this(FACTORY, owned, parent);
  }

  get path() { return this.#authority.directory; }
  get generation() { return this.#generation; }
  get pendingExecutionCount() { return this.#pending.size; }

  control() { return this.validate(path.join(this.path, "control")); }
  snapshots() { return this.validate(path.join(this.path, "snapshots")); }
  logs() { return this.validate(path.join(this.path, "diagnostics")); }
  runtime(purpose) {
    const logical = LogicalRelativePath.from(purpose, "workspace runtime purpose");
    return this.validate(path.join(this.path, "runtime", ...logical.segments));
  }

  validate(directory) {
    const resolved = this.#validatePath(directory);
    const authority = RealDirectoryAuthority.closestAncestor(resolved, this.#directories.values()).descendant(resolved, { allowMissing: true });
    this.#directories.set(authority.directory, authority);
    return resolved;
  }

  #validatePath(target) {
    this.assertOpen();
    const resolved = path.resolve(this.path, target);
    if (!isNativePathWithin(this.path, resolved)) {
      throw new ReadOnlyInvocationWorkspaceError("OUTSIDE_ROOT", "workspace path leaves its owned directory");
    }
    this.#parent.assertStable();
    this.#authority.assertStable();
    for (const authority of this.#directories.values()) {
      if (isNativePathWithin(authority.directory, resolved)) authority.assertStable();
    }
    if (resolved !== this.path) {
      const parentPath = path.dirname(resolved);
      const parent = RealDirectoryAuthority.closestAncestor(parentPath, this.#directories.values()).descendant(parentPath, { allowMissing: true });
      this.#directories.set(parent.directory, parent);
    }
    return resolved;
  }

  ensureDirectory(directory) {
    const resolved = this.validate(directory);
    const authority = RealDirectoryAuthority.closestAncestor(resolved, this.#directories.values()).descendant(resolved, { create: true });
    this.#directories.set(resolved, authority);
    this.#authority.assertStable();
    return resolved;
  }

  create(directory, prefix) {
    OwnedTemporaryDirectory.validatePrefix(prefix);
    const parent = this.ensureDirectory(directory);
    const owned = OwnedTemporaryDirectory.create(this.#directories.get(parent), prefix);
    this.#directories.set(owned.path, owned.authority);
    this.#ownedDirectories.set(owned.path, owned);
    return owned.path;
  }

  cleanupDirectory(directory, confirmation) {
    this.#assertConfirmation(confirmation);
    this.#assertSettled();
    const resolved = this.validate(directory);
    const owned = this.#ownedDirectories.get(resolved);
    if (!owned) throw new ReadOnlyInvocationWorkspaceError("DIRECTORY_NOT_OWNED", "directory was not minted by this workspace generation");
    for (const [target, authority] of this.#directories) {
      if (isNativePathWithin(resolved, target)) authority.assertStable();
    }
    owned.cleanup();
    for (const target of this.#directories.keys()) {
      if (isNativePathWithin(resolved, target)) this.#directories.delete(target);
    }
    for (const target of this.#ownedDirectories.keys()) {
      if (isNativePathWithin(resolved, target)) this.#ownedDirectories.delete(target);
    }
  }

  writeFile(file, content, { phaseNamespace, faultInjector } = {}) {
    const resolved = this.#validatePath(file);
    const parent = this.ensureDirectory(path.dirname(resolved));
    return new AtomicFile(resolved, {
      phaseNamespace,
      faultInjector,
      directoryAuthority: this.#directories.get(parent),
      commitGuard: () => this.#validatePath(resolved),
    }).write(content);
  }

  appendFile(file, content) {
    const resolved = this.#validatePath(file);
    const parent = this.ensureDirectory(path.dirname(resolved));
    return appendRegularFile(resolved, content, { directoryAuthority: this.#directories.get(parent) });
  }

  readFile(file, fallback = null) {
    const resolved = this.#validatePath(file);
    const authority = this.#directories.get(path.dirname(resolved));
    if (!authority) return fallback;
    return new AtomicFile(resolved, { directoryAuthority: authority }).read(fallback);
  }

  processRuntimeStorage() {
    this.assertOpen();
    if (this.#processRuntimeStorage === null) {
      const directory = this.ensureDirectory(path.join(this.control(), "process-runtime"));
      this.#processRuntimeStorage = new ReadOnlyProcessRuntimeStorage(FACTORY, { workspace: this,
        authority: this.#directories.get(directory), workspaceAuthority: this.#authority });
    }
    this.#processRuntimeStorage.assertStable();
    return this.#processRuntimeStorage;
  }

  beginExecution() {
    this.assertOpen();
    const execution = new WorkspaceExecution(FACTORY, this.generation);
    // Persist the pending marker before exposing its resource-tracking token.
    // This token does not grant execution authority.
    this.#pending.add(execution);
    this.writeFile(this.#executionPath(execution), JSON.stringify({ generation: this.generation, id: execution.id, settled: false }));
    return execution;
  }

  settleExecution(execution, confirmation) {
    this.#assertConfirmation(confirmation);
    if (!(execution instanceof WorkspaceExecution) || !this.#pending.has(execution)) {
      throw new ReadOnlyInvocationWorkspaceError("EXECUTION_UNKNOWN", "execution does not belong to this workspace generation");
    }
    this.writeFile(this.#executionPath(execution), JSON.stringify({ generation: this.generation, id: execution.id, settled: true }));
    this.#pending.delete(execution);
  }

  complete(confirmation) {
    this.#assertConfirmation(confirmation);
    this.#assertSettled();
    this.validate(this.path);
    this.#complete = true;
  }

  cleanup({ generation } = {}) {
    this.#assertGeneration(generation);
    if (this.#removed) return;
    if (!this.#complete || this.#pending.size !== 0) {
      throw new ReadOnlyInvocationWorkspaceError("INCOMPLETE", "resource release and normal completion must be confirmed before cleanup");
    }
    this.#parent.assertStable();
    this.#authority.assertStable();
    for (const authority of this.#directories.values()) authority.assertStable();
    this.#owned.cleanup();
    this.#removed = true;
  }

  #assertSettled() {
    if (this.#pending.size !== 0) throw new ReadOnlyInvocationWorkspaceError("EXECUTION_UNCONFIRMED", "unconfirmed execution evidence must be retained");
  }

  #executionPath(execution) { return path.join(this.control(), `execution-${execution.id}.json`); }
  assertOpen() {
    if (this.#complete || this.#removed) throw new ReadOnlyInvocationWorkspaceError("CLOSED", "workspace generation is closed");
  }
  #assertGeneration(generation) {
    if (generation !== this.generation) throw new ReadOnlyInvocationWorkspaceError("GENERATION_MISMATCH", "workspace generation does not match");
  }
  #assertConfirmation({ generation, resourcesReleased, normalExit } = {}) {
    this.#assertGeneration(generation);
    this.assertOpen();
    if (resourcesReleased !== true || normalExit !== true) {
      throw new ReadOnlyInvocationWorkspaceError("UNCONFIRMED", "resource release and normal exit require explicit confirmation");
    }
  }
}

/** Read-only application invocations may clean up after confirmed success. */
export class ReadOnlyInvocationWorkspace extends InvocationControlWorkspace {}
