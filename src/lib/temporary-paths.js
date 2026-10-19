import fs from "node:fs";
import path from "node:path";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { AtomicFile } from "./atomic-file.js";
import { FlowSpecId } from "./flow-spec-id.js";
import { FlowRunId } from "./flow-run-id.js";
import { appendRegularFile } from "./regular-file-io.js";
import { LogicalRelativePath, isNativePathWithin } from "./portable-path.js";
import { OwnedTemporaryDirectory } from "./owned-temporary-directory.js";

/** Project-owned scratch paths. Execution checkout and durable stores stay caller-owned. */
export class TemporaryPaths {
  #authorities = new Map();
  #ownedDirectories = new Map();

  constructor(root) {
    this.root = fs.realpathSync(path.resolve(root));
    this.temporaryRoot = path.join(this.root, ".tmp");
    this.#authorities.set(this.root, new RealDirectoryAuthority(this.root));
  }

  flow(specId, runId) {
    return this.validate(path.join(this.temporaryRoot, "flows", FlowSpecId.from(specId).toString(), FlowRunId.from(runId).toString()));
  }

  static runtimePath(root, purpose) {
    const logical = LogicalRelativePath.from(purpose, "temporary runtime purpose");
    return path.resolve(root, ".tmp", "runtime", ...logical.segments);
  }
  runtime(purpose) { return this.validate(TemporaryPaths.runtimePath(this.root, purpose)); }
  logs(directory = null) { return this.validate(directory ?? path.join(this.temporaryRoot, "logs")); }
  tests() { return this.validate(path.join(this.temporaryRoot, "tests")); }
  operator() { return this.validate(path.join(this.temporaryRoot, "operator")); }

  validate(directory) {
    const resolved = path.resolve(this.root, directory);
    if (!isNativePathWithin(this.temporaryRoot, resolved)) {
      const error = new Error(`Temporary directory must stay inside ${this.temporaryRoot}: ${resolved}`);
      error.code = "TEMPORARY_PATH_OUTSIDE_PROJECT";
      throw error;
    }
    for (const authority of this.#authorities.values()) {
      if (isNativePathWithin(authority.directory, resolved)) authority.assertStable();
    }
    const authority = RealDirectoryAuthority.closestAncestor(resolved, this.#authorities.values()).descendant(resolved, { allowMissing: true });
    this.#authorities.set(authority.directory, authority);
    return resolved;
  }

  ensureDirectory(directory) {
    const resolved = this.validate(directory);
    const authority = RealDirectoryAuthority.closestAncestor(resolved, this.#authorities.values()).descendant(resolved, { create: true });
    this.#authorities.set(resolved, authority);
    authority.assertStable();
    return resolved;
  }

  create(directory, prefix) {
    return this.createOwnedDirectory(directory, prefix).path;
  }

  createOwnedDirectory(directory, prefix) {
    OwnedTemporaryDirectory.validatePrefix(prefix);
    const parent = this.ensureDirectory(directory);
    const owned = OwnedTemporaryDirectory.create(this.#authorities.get(parent), prefix);
    this.#authorities.set(owned.path, owned.authority);
    this.#ownedDirectories.set(owned.path, owned);
    return owned;
  }

  cleanup(directory, { recursive = true } = {}) {
    const resolved = this.validate(directory);
    const owned = this.#ownedDirectories.get(resolved);
    if (!owned) {
      const error = new Error("temporary cleanup requires a directory created by this owner");
      error.code = "TEMPORARY_DIRECTORY_NOT_OWNED";
      throw error;
    }
    for (const [target, authority] of this.#authorities) {
      if (isNativePathWithin(resolved, target)) authority.assertStable();
    }
    owned.cleanup({ recursive });
    for (const target of this.#authorities.keys()) {
      if (isNativePathWithin(resolved, target)) this.#authorities.delete(target);
    }
    this.#ownedDirectories.delete(resolved);
  }

  /** For already selected internal write paths; callers own containment validation. */
  static ensureRealDirectory(directory) {
    return RealDirectoryAuthority.resolve(directory, { create: true });
  }

  static validateRealDirectory(directory) {
    return RealDirectoryAuthority.resolve(directory, { allowMissing: true });
  }

  static assertRegularFile(file) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        const error = new Error(`Temporary file must be a regular real file: ${file}`);
        error.code = "TEMPORARY_FILE_INVALID";
        throw error;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  static isBoundaryError(error) {
    return error.code?.startsWith("TEMPORARY_")
      || (error.code?.startsWith("REAL_DIRECTORY_AUTHORITY_") && error.cause?.syscall !== "mkdir");
  }

  static appendFile(file, content, { maxBytes } = {}) {
    const authority = TemporaryPaths.ensureRealDirectory(path.dirname(file));
    TemporaryPaths.assertRegularFile(file);
    authority.assertStable();
    return appendRegularFile(file, content, { directoryAuthority: authority, maxBytes });
  }

  static writeFile(file, content, { maxBytes } = {}) {
    const directoryAuthority = TemporaryPaths.ensureRealDirectory(path.dirname(file));
    directoryAuthority.assertStable();
    TemporaryPaths.assertRegularFile(file);
    return new AtomicFile(file, { maxBytes, directoryAuthority }).write(content);
  }
}
