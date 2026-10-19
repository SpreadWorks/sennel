import fs from "node:fs";
import path from "node:path";
import { closeDirectoryHandle } from "./file-descriptor.js";
import { isNativePathWithin } from "./portable-path.js";

const CHAIN_CAPTURE = Symbol("directory authority chain capture");
const AUTHORITY_FAILURES = new WeakSet();

export function sameFileIdentity(left, right) {
  return BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino);
}

export class FileIdentity {
  constructor(stat) {
    if (typeof stat.dev !== "bigint" || typeof stat.ino !== "bigint") {
      throw new TypeError("file identity requires exact bigint device and inode values");
    }
    this.dev = stat.dev;
    this.ino = stat.ino;
    Object.freeze(this);
  }
}

function defaultErrorFactory(status, message, { lockPath, cause } = {}) {
  const error = new Error(message, { cause });
  error.name = "RealDirectoryAuthorityError";
  error.code = `REAL_DIRECTORY_AUTHORITY_${status.replace(/-/g, "_").toUpperCase()}`;
  error.lockPath = lockPath;
  return error;
}

export class RealDirectoryOperationError extends Error {
  constructor(cause, { operation, source, destination = null, committedToVisibleName }) {
    super(cause.message, { cause });
    this.name = "RealDirectoryOperationError";
    this.code = committedToVisibleName ? "REAL_DIRECTORY_OPERATION_PUBLICATION_UNCERTAIN" : "REAL_DIRECTORY_OPERATION_FAILED";
    this.operation = operation;
    this.source = source;
    this.destination = destination;
    this.committedToVisibleName = committedToVisibleName;
    this.publicationUnknown = committedToVisibleName;
    this.cleanupFailed = cause.cleanupFailed === true;
  }
}

export class RealDirectoryAuthority {
  #canonical = false;

  /** A proven authority refusal remains unsafe through operation wrappers. */
  static isAuthorityFailure(error) {
    const pending = [error];
    const seen = new Set();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current == null || seen.has(current)) continue;
      seen.add(current);
      if (AUTHORITY_FAILURES.has(current)) return true;
      if (current instanceof AggregateError) pending.push(...current.errors);
      pending.push(current.cause);
    }
    return false;
  }

  /** Select a retained ancestor; descendant() still owns physical validation. */
  static closestAncestor(directory, authorities) {
    let closest = null;
    for (const authority of authorities) {
      if (isNativePathWithin(authority.directory, directory)
        && (closest === null || authority.directory.length > closest.directory.length)) closest = authority;
    }
    return closest;
  }

  static createExclusive(directory, { parentAuthority = null, creationMode = 0o777 } = {}) {
    const resolved = path.resolve(directory);
    const parent = parentAuthority ?? new RealDirectoryAuthority(path.dirname(resolved));
    if (!(parent instanceof RealDirectoryAuthority) || parent.directory !== path.dirname(resolved)) throw new Error("exclusive directory creation requires its direct parent authority");
    return parent.createExclusiveChild(path.basename(resolved), { creationMode });
  }

  static resolve(directory, { create = false, allowMissing = false, parentAuthority = null, creationMode = 0o777, errorFactory = defaultErrorFactory } = {}) {
    const resolved = path.resolve(directory);
    const anchor = parentAuthority?.directory ?? path.parse(resolved).root;
    const relative = path.relative(anchor, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("directory authority descendant must stay within its parent");
    }
    let current = parentAuthority ?? new RealDirectoryAuthority(anchor, { errorFactory });
    current.assertStable();
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      const next = new RealDirectoryAuthority(path.join(current.directory, segment), {
        create, parentAuthority: current, creationMode, errorFactory, [CHAIN_CAPTURE]: true,
      });
      if (create && next.identity === null) next.ensure();
      else if (!create && allowMissing && next.identity === null) {
        current.assertStable();
        return current;
      }
      current = next;
    }
    current.assertStable();
    return current;
  }

  descendant(directory, options = {}) {
    return RealDirectoryAuthority.resolve(directory, { ...options, parentAuthority: this });
  }

  entries(options = {}) {
    this.assertStable();
    const entries = fs.readdirSync(this.directory, options);
    this.assertStable();
    return entries;
  }

  forEachEntry(visitor) {
    if (typeof visitor !== "function") throw new TypeError("directory entry visitor must be a function");
    this.assertStable();
    const handle = fs.opendirSync(this.directory);
    let failure = null;
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) visitor(entry);
      this.assertStable();
    } catch (cause) { failure = cause; throw cause; }
    finally { closeDirectoryHandle(handle, failure); }
  }

  exists() {
    const exists = this.#assertChain(true);
    if (exists) this.#assertCanonical();
    return exists;
  }

  removeTree() { return this.remove({ recursive: true }); }

  remove({ recursive = false, force = false } = {}) {
    let committedToVisibleName = false;
    try {
      if (this.parentAuthority === null) throw new Error("cannot remove a filesystem root authority");
      if (force && !this.exists()) return { committed: false, path: this.directory };
      this.assertStable();
      if (recursive) fs.rmSync(this.directory, { recursive: true, force });
      else fs.rmdirSync(this.directory);
      committedToVisibleName = true;
      this.parentAuthority.assertStable();
      this.#assertSourceAbsent("removal");
      return { committed: true, path: this.directory };
    } catch (cause) {
      throw new RealDirectoryOperationError(cause, { operation: "remove", source: this.directory, committedToVisibleName });
    }
  }

  moveTo(destination, { commitGuard = () => {} } = {}) {
    const resolved = path.resolve(destination);
    let committedToVisibleName = false;
    try {
      if (this.parentAuthority === null) throw new Error("cannot move a filesystem root authority");
      const parent = new RealDirectoryAuthority(path.dirname(resolved));
      const assertAbsent = () => {
        try { fs.lstatSync(resolved); }
        catch (cause) { if (cause.code === "ENOENT") return; throw cause; }
        throw Object.assign(new Error(`directory move destination already exists: ${resolved}`), { code: "EEXIST" });
      };
      this.assertStable();
      parent.assertStable();
      assertAbsent();
      commitGuard();
      this.assertStable();
      parent.assertStable();
      assertAbsent();
      fs.renameSync(this.directory, resolved);
      committedToVisibleName = true;
      const moved = new RealDirectoryAuthority(resolved, { parentAuthority: parent });
      moved.assertStable();
      this.parentAuthority.assertStable();
      if (!sameFileIdentity(this.identity, moved.identity)) moved.#fail("authority-invalid", "directory move readback identity changed");
      this.#assertSourceAbsent("move");
      return moved;
    } catch (cause) {
      throw new RealDirectoryOperationError(cause, { operation: "move", source: this.directory,
        destination: resolved, committedToVisibleName });
    }
  }

  #assertSourceAbsent(operation) {
    try { fs.lstatSync(this.directory); }
    catch (cause) {
      if (cause.code === "ENOENT") return;
      this.#fail("authority-invalid", `directory ${operation} readback failed: ${this.directory}`, cause);
    }
    this.#fail("authority-invalid", `directory ${operation} readback found a source replacement: ${this.directory}`);
  }

  createExclusiveChild(name, { creationMode = 0o777 } = {}) {
    if (typeof name !== "string" || name === "" || name === "." || name === ".." || path.basename(name) !== name) throw new Error("directory child name must be a basename");
    this.assertStable();
    const directory = path.join(this.directory, name);
    fs.mkdirSync(directory, { mode: creationMode });
    const child = new RealDirectoryAuthority(directory, { parentAuthority: this });
    child.assertStable();
    return child;
  }

  removeEmpty() { return this.remove(); }

  constructor(directory, {
    create = false,
    parentAuthority = null,
    errorFactory = defaultErrorFactory,
    creationMode = 0o777,
    [CHAIN_CAPTURE]: chainCapture = false,
  } = {}) {
    this.directory = path.resolve(directory);
    if (parentAuthority !== null && !(parentAuthority instanceof RealDirectoryAuthority)) {
      throw new Error("lock directory parent authority must be a RealDirectoryAuthority");
    }
    if (parentAuthority !== null && path.dirname(this.directory) !== parentAuthority.directory) {
      throw new Error("lock directory parent authority must own its direct parent");
    }
    this.create = create;
    if (!Number.isInteger(creationMode) || creationMode < 0 || creationMode > 0o777) throw new TypeError("directory creation mode must be an integer permission mask");
    this.creationMode = creationMode;
    const parent = path.dirname(this.directory);
    this.parentAuthority = parentAuthority ?? (parent === this.directory ? null : new RealDirectoryAuthority(parent, { errorFactory, [CHAIN_CAPTURE]: true }));
    this.errorFactory = errorFactory;
    this.identity = null;
    this.#captureIfPresent();
    if (!chainCapture) {
      let anchor = this;
      while (anchor.identity === null && anchor.parentAuthority !== null) anchor = anchor.parentAuthority;
      anchor.assertStable();
    }
  }

  ensure() {
    this.parentAuthority?.assertStable();
    if (this.identity == null) {
      if (!this.create) this.#fail("authority-invalid", `lock directory is unavailable: ${this.directory}`);
      try {
        fs.mkdirSync(this.directory, { mode: this.creationMode });
      } catch (cause) {
        if (cause.code !== "EEXIST") this.#fail("authority-invalid", `lock directory creation failed: ${this.directory}`, cause);
      }
      this.#capture();
    }
    this.assertStable();
    return this.directory;
  }

  assertStable() {
    this.#assertChain(false);
    this.#assertCanonical();
    return this.directory;
  }

  #assertChain(allowMissing) {
    if (this.parentAuthority !== null && !this.parentAuthority.#assertChain(allowMissing)) {
      if (this.identity !== null) this.#fail("authority-invalid", `directory ancestor disappeared: ${this.directory}`);
      return false;
    }
    const identity = this.#validatedIdentity({ allowMissing: allowMissing && this.identity === null });
    if (identity === null) return false;
    this.#observeIdentity(identity);
    return true;
  }

  #assertCanonical() {
    if (this.#canonical) return;
    try {
      if (fs.realpathSync(this.directory) !== this.directory) throw new Error("directory authority path must be canonical");
    } catch (cause) { this.#fail("authority-invalid", `invalid directory authority: ${this.directory}`, cause); }
    this.#canonical = true;
  }

  #observeIdentity(identity) {
    if (this.identity && !sameFileIdentity(identity, this.identity)) {
      this.#fail("authority-invalid", `lock directory identity changed: ${this.directory}`);
    }
    if (this.identity === null) this.identity = identity;
  }

  #captureIfPresent() {
    this.identity = this.#validatedIdentity({ allowMissing: true });
  }

  #capture() {
    this.identity = this.#validatedIdentity();
  }

  #validatedIdentity({ allowMissing = false } = {}) {
    const stat = this.#validatedStat({ allowMissing });
    if (stat === null) return null;
    // Node converts the same native dev/ino fields directly to Number or BigInt.
    // Only safe nonnegative integers can be converted back without precision loss.
    if (Number.isSafeInteger(stat.dev) && stat.dev >= 0
      && Number.isSafeInteger(stat.ino) && stat.ino >= 0) {
      return new FileIdentity({ dev: BigInt(stat.dev), ino: BigInt(stat.ino) });
    }
    // Initial presence was observed: disappearance during fallback must refuse.
    return new FileIdentity(this.#validatedStat({ bigint: true }));
  }

  #validatedStat({ allowMissing = false, bigint = false } = {}) {
    let stat;
    try {
      stat = fs.lstatSync(this.directory, { bigint });
    } catch (cause) {
      if (allowMissing && cause.code === "ENOENT") return null;
      this.#fail("authority-invalid", `invalid lock directory authority: ${this.directory}`, cause);
    }
    if (stat.isSymbolicLink()) {
      this.#fail("authority-invalid", `directory authority must not contain a symbolic link: ${this.directory}`);
    }
    if (!stat.isDirectory()) this.#fail("authority-invalid", `directory authority must be a real directory: ${this.directory}`);
    return stat;
  }

  #fail(status, message, cause) {
    const error = this.errorFactory(status, message, { lockPath: this.directory, cause });
    error.lockStatus = status;
    error.lockPath = this.directory;
    error.owner = null;
    if (!("cause" in error)) error.cause = cause ?? null;
    AUTHORITY_FAILURES.add(error);
    throw error;
  }
}
