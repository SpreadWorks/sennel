import fs from "node:fs";
import path from "node:path";

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function defaultErrorFactory(status, message, { lockPath, cause } = {}) {
  const error = new Error(message, { cause });
  error.name = "RealDirectoryAuthorityError";
  error.code = `REAL_DIRECTORY_AUTHORITY_${status.replace(/-/g, "_").toUpperCase()}`;
  error.lockPath = lockPath;
  return error;
}

export class RealDirectoryAuthority {
  constructor(directory, {
    create = false,
    parentAuthority = null,
    errorFactory = defaultErrorFactory,
  } = {}) {
    this.directory = path.resolve(directory);
    if (parentAuthority !== null && !(parentAuthority instanceof RealDirectoryAuthority)) {
      throw new Error("lock directory parent authority must be a RealDirectoryAuthority");
    }
    if (parentAuthority !== null && path.dirname(this.directory) !== parentAuthority.directory) {
      throw new Error("lock directory parent authority must own its direct parent");
    }
    this.create = create;
    this.parentAuthority = parentAuthority;
    this.errorFactory = errorFactory;
    this.identity = null;
    this.#captureIfPresent();
  }

  ensure() {
    this.parentAuthority?.assertStable();
    if (this.identity == null) {
      if (!this.create) this.#fail("authority-invalid", `lock directory is unavailable: ${this.directory}`);
      try {
        fs.mkdirSync(this.directory);
      } catch (cause) {
        if (cause.code !== "EEXIST") this.#fail("authority-invalid", `lock directory creation failed: ${this.directory}`, cause);
      }
      this.#capture();
    }
    this.assertStable();
    return this.directory;
  }

  assertStable() {
    this.parentAuthority?.assertStable();
    const stat = this.#validatedStat();
    if (this.identity && !sameFile(stat, this.identity)) {
      this.#fail("authority-invalid", `lock directory identity changed: ${this.directory}`);
    }
    if (this.identity == null) this.identity = { dev: stat.dev, ino: stat.ino };
    return this.directory;
  }

  #captureIfPresent() {
    try {
      fs.lstatSync(this.directory);
    } catch (cause) {
      if (cause.code === "ENOENT") return;
      this.#fail("authority-invalid", `lock directory is unavailable: ${this.directory}`, cause);
    }
    this.#capture();
  }

  #capture() {
    const stat = this.#validatedStat();
    this.identity = { dev: stat.dev, ino: stat.ino };
  }

  #validatedStat() {
    let stat;
    try {
      stat = fs.lstatSync(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (this.parentAuthority === null && fs.realpathSync(this.directory) !== this.directory)) {
        throw new Error("lock authority must be a real directory");
      }
    } catch (cause) {
      this.#fail("authority-invalid", `invalid lock directory authority: ${this.directory}`, cause);
    }
    return stat;
  }

  #fail(status, message, cause) {
    const error = this.errorFactory(status, message, { lockPath: this.directory, cause });
    error.lockStatus = status;
    error.lockPath = this.directory;
    error.owner = null;
    if (!("cause" in error)) error.cause = cause ?? null;
    throw error;
  }
}
