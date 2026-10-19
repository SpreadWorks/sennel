import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AtomicFile } from "./atomic-file.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { appendRegularFile } from "./regular-file-io.js";
import { LogicalRelativePath, isNativePathWithin } from "./portable-path.js";
import { OwnedTemporaryDirectory } from "./owned-temporary-directory.js";

const FACTORY = Symbol("readonly invocation workspace factory");

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

/** Ephemeral invocation scratch; never a registry, canonical state or resume proof. */
export class ReadOnlyInvocationWorkspace {
  #authority;
  #owned;
  #parent;
  #generation;
  #pending = new Set();
  #complete = false;
  #removed = false;
  #directories = new Map();
  #ownedDirectories = new Map();

  constructor(factory, owned, parent) {
    if (factory !== FACTORY) throw new TypeError("use ReadOnlyInvocationWorkspace.create()");
    this.#owned = owned;
    this.#authority = owned.authority;
    this.#directories.set(this.path, this.#authority);
    this.#parent = parent;
    this.#generation = crypto.randomUUID();
  }

  static create() {
    // os.tmpdir uses TMPDIR on POSIX and TEMP/TMP on Windows. Canonicalize the
    // selected Node parent before minting ownership; its spelling grants none.
    const parent = new RealDirectoryAuthority(fs.realpathSync(os.tmpdir()));
    parent.assertStable();
    const owned = OwnedTemporaryDirectory.create(parent, "sennel-inspect-");
    return new ReadOnlyInvocationWorkspace(FACTORY, owned, parent);
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
    this.#assertOpen();
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

  writeFile(file, content) {
    const resolved = this.#validatePath(file);
    const parent = this.ensureDirectory(path.dirname(resolved));
    return new AtomicFile(resolved, {
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

  beginExecution() {
    this.#assertOpen();
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
  #assertOpen() {
    if (this.#complete || this.#removed) throw new ReadOnlyInvocationWorkspaceError("CLOSED", "workspace generation is closed");
  }
  #assertGeneration(generation) {
    if (generation !== this.generation) throw new ReadOnlyInvocationWorkspaceError("GENERATION_MISMATCH", "workspace generation does not match");
  }
  #assertConfirmation({ generation, resourcesReleased, normalExit } = {}) {
    this.#assertGeneration(generation);
    this.#assertOpen();
    if (resourcesReleased !== true || normalExit !== true) {
      throw new ReadOnlyInvocationWorkspaceError("UNCONFIRMED", "resource release and normal exit require explicit confirmation");
    }
  }
}
