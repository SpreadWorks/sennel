import fs from "node:fs";
import path from "node:path";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { AtomicFile } from "./atomic-file.js";
import { FlowSpecId } from "./flow-spec-id.js";
import { FlowRunId } from "./flow-run-id.js";
import { isTmpfsDirectory } from "./filesystem-type.js";

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function directoryAuthority(directory, create, authorities = new Map()) {
  const resolved = path.resolve(directory);
  const anchor = path.parse(resolved).root;
  let current = authorities.get(anchor);
  if (!current) {
    current = new RealDirectoryAuthority(anchor);
    authorities.set(anchor, current);
  }
  current.assertStable();
  for (const segment of path.relative(anchor, resolved).split(path.sep).filter(Boolean)) {
    const child = path.join(current.directory, segment);
    let next = authorities.get(child);
    if (!next || next.identity === null) {
      next = new RealDirectoryAuthority(child, { create, parentAuthority: current });
      authorities.set(child, next);
    }
    if (create) {
      next.create = true;
      next.ensure();
    } else {
      if (next.identity === null) return current;
      next.assertStable();
    }
    current = next;
  }
  return current;
}

/** Project-owned scratch paths. Execution checkout and durable stores stay caller-owned. */
export class TemporaryPaths {
  #authorities = new Map();

  constructor(root) {
    this.root = fs.realpathSync(path.resolve(root));
    this.temporaryRoot = path.join(this.root, ".tmp");
    this.#authorities.set(this.root, new RealDirectoryAuthority(this.root));
  }

  flow(specId, runId) {
    return this.validate(path.join(this.temporaryRoot, "flows", FlowSpecId.from(specId).toString(), FlowRunId.from(runId).toString()));
  }

  static runtimePath(root, purpose) { return path.resolve(root, ".tmp", "runtime", purpose); }
  runtime(purpose) { return this.validate(TemporaryPaths.runtimePath(this.root, purpose)); }
  logs(directory = null) { return this.validate(directory ?? path.join(this.temporaryRoot, "logs")); }
  tests() { return this.validate(path.join(this.temporaryRoot, "tests")); }
  operator() { return this.validate(path.join(this.temporaryRoot, "operator")); }

  validate(directory) {
    const resolved = path.resolve(this.root, directory);
    const existing = directoryAuthority(resolved, false, this.#authorities);
    if (!isWithin(this.temporaryRoot, resolved) && !isTmpfsDirectory(existing.directory)) {
      const error = new Error(`Temporary directory must stay inside ${this.temporaryRoot} or a verified tmpfs: ${resolved}`);
      error.code = "TEMPORARY_PATH_OUTSIDE_PROJECT";
      throw error;
    }
    return resolved;
  }

  ensureDirectory(directory) {
    const resolved = this.validate(directory);
    directoryAuthority(resolved, true, this.#authorities).assertStable();
    return resolved;
  }

  create(directory, prefix) {
    return fs.mkdtempSync(path.join(this.ensureDirectory(directory), prefix));
  }

  /** For already selected internal write paths; callers own containment validation. */
  static ensureRealDirectory(directory) {
    return directoryAuthority(directory, true);
  }

  static validateRealDirectory(directory) {
    return directoryAuthority(directory, false);
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

  static appendFile(file, content) {
    const authority = TemporaryPaths.ensureRealDirectory(path.dirname(file));
    TemporaryPaths.assertRegularFile(file);
    authority.assertStable();
    const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o644);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1) {
        const error = new Error(`Temporary append target must have one regular file link: ${file}`);
        error.code = "TEMPORARY_FILE_INVALID";
        throw error;
      }
      authority.assertStable();
      fs.writeFileSync(descriptor, content);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  static writeFile(file, content) {
    TemporaryPaths.ensureRealDirectory(path.dirname(file)).assertStable();
    TemporaryPaths.assertRegularFile(file);
    new AtomicFile(file).write(content);
  }
}
