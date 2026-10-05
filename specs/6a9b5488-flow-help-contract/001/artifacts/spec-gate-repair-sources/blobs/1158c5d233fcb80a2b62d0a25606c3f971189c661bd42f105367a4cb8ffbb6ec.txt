import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RealDirectoryAuthority } from "./real-directory-authority.js";

export function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  let primaryError = null;
  try {
    fs.fsyncSync(descriptor);
  } catch (cause) {
    primaryError = cause;
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          "Directory durability sync and descriptor cleanup both failed",
          { cause: primaryError },
        );
      }
      throw cleanupError;
    }
  }
  if (primaryError) throw primaryError;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export class AtomicFileWriteError extends Error {
  constructor(message, { cause, phase, committedToVisibleName, durabilityUnknown }) {
    super(message, { cause });
    this.name = "AtomicFileWriteError";
    this.code = durabilityUnknown
      ? "ATOMIC_FILE_DURABILITY_UNCERTAIN"
      : "ATOMIC_FILE_WRITE_FAILED";
    this.phase = phase;
    this.committedToVisibleName = committedToVisibleName;
    this.durabilityUnknown = durabilityUnknown;
    this.committed = committedToVisibleName;
  }
}

export class AtomicFile {
  constructor(filePath, {
    faultInjector = () => {},
    phaseNamespace = "file",
    commitGuard = () => {},
  } = {}) {
    if (typeof phaseNamespace !== "string" || phaseNamespace.trim() === "") {
      throw new Error("atomic file phase namespace must be a non-empty string");
    }
    if (typeof commitGuard !== "function") {
      throw new TypeError("atomic file commitGuard must be a function");
    }
    this.filePath = path.resolve(filePath);
    this.directory = path.dirname(this.filePath);
    this.directoryAuthority = new RealDirectoryAuthority(this.directory);
    this.faultInjector = faultInjector;
    this.phaseNamespace = phaseNamespace;
    this.commitGuard = commitGuard;
  }

  read(fallback = null) {
    this.directoryAuthority.assertStable();
    let descriptor = null;
    let stat;
    try {
      stat = fs.lstatSync(this.filePath);
    } catch (cause) {
      if (cause.code === "ENOENT") {
        return Buffer.isBuffer(fallback) ? Buffer.from(fallback) : fallback;
      }
      throw cause;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(this.filePath) !== this.filePath) {
      throw new Error(`file authority must be a regular real file: ${this.filePath}`);
    }
    try {
      descriptor = fs.openSync(
        this.filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      const openedStat = fs.fstatSync(descriptor);
      if (!sameFile(stat, openedStat) || !openedStat.isFile()) {
        throw new Error(`file authority changed while reading: ${this.filePath}`);
      }
      return fs.readFileSync(descriptor);
    } finally {
      if (descriptor != null) fs.closeSync(descriptor);
    }
  }

  write(content) {
    const bytes = Buffer.isBuffer(content)
      ? Buffer.from(content)
      : typeof content === "string"
        ? Buffer.from(content)
        : null;
    if (!bytes) throw new TypeError("atomic file content must be a Buffer or string");

    this.directoryAuthority.assertStable();
    const tempPath = path.join(this.directory, `.${path.basename(this.filePath)}.${crypto.randomUUID()}.tmp`);
    let descriptor = null;
    let mode = 0o644;
    let phase = "inspect-visible-file";
    let committedToVisibleName = false;
    try {
      try {
        const current = fs.lstatSync(this.filePath);
        if (!current.isFile() || current.isSymbolicLink() || fs.realpathSync(this.filePath) !== this.filePath) {
          throw new Error(`file authority must be a regular real file: ${this.filePath}`);
        }
        mode = current.mode & 0o777;
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
      }
      phase = `before-${this.phaseNamespace}-temp-open`;
      this.faultInjector({ phase, filePath: this.filePath, tempPath });
      descriptor = fs.openSync(tempPath, "wx", mode);
      phase = `before-${this.phaseNamespace}-temp-write`;
      this.faultInjector({ phase, filePath: this.filePath, tempPath });
      fs.writeFileSync(descriptor, bytes);
      fs.fchmodSync(descriptor, mode);
      phase = `before-${this.phaseNamespace}-fsync`;
      this.faultInjector({ phase, filePath: this.filePath, tempPath });
      fs.fsyncSync(descriptor);
      phase = `before-${this.phaseNamespace}-temp-close`;
      this.faultInjector({ phase, filePath: this.filePath, tempPath });
      fs.closeSync(descriptor);
      descriptor = null;
      this.directoryAuthority.assertStable();
      phase = `before-${this.phaseNamespace}-rename`;
      this.faultInjector({ phase, filePath: this.filePath, tempPath });
      this.commitGuard({ phase, filePath: this.filePath, tempPath });
      fs.renameSync(tempPath, this.filePath);
      committedToVisibleName = true;
      phase = `before-${this.phaseNamespace}-directory-fsync`;
      this.faultInjector({ phase, filePath: this.filePath });
      fsyncDirectory(this.directory);
      return { committed: true, path: this.filePath };
    } catch (cause) {
      const cleanupErrors = [];
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      if (!committedToVisibleName) {
        try { fs.unlinkSync(tempPath); } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") cleanupErrors.push(cleanupError);
        }
      }
      if (committedToVisibleName) {
        throw this.createWriteError(
          `file write reached the visible name but durability is uncertain: ${this.filePath}`,
          {
            cause: cleanupErrors.length > 0
              ? new AggregateError([cause, ...cleanupErrors], "file durability and cleanup failed", { cause })
              : cause,
            phase,
            committedToVisibleName: true,
            durabilityUnknown: true,
          },
        );
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [cause, ...cleanupErrors],
          `file write failed before commit and cleanup also failed: ${this.filePath}`,
          { cause },
        );
      }
      throw cause;
    }
  }

  remove() {
    this.directoryAuthority.assertStable();
    let stat;
    try {
      stat = fs.lstatSync(this.filePath);
    } catch (cause) {
      if (cause.code === "ENOENT") return { committed: false, path: this.filePath };
      throw cause;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(this.filePath) !== this.filePath) {
      throw new Error(`file authority must be a regular real file: ${this.filePath}`);
    }
    let phase = `before-${this.phaseNamespace}-unlink`;
    let committedToVisibleName = false;
    try {
      this.faultInjector({ phase, filePath: this.filePath });
      this.commitGuard({ phase, filePath: this.filePath });
      fs.unlinkSync(this.filePath);
      committedToVisibleName = true;
      phase = `before-${this.phaseNamespace}-directory-fsync`;
      this.faultInjector({ phase, filePath: this.filePath });
      fsyncDirectory(this.directory);
      return { committed: true, path: this.filePath };
    } catch (cause) {
      if (!committedToVisibleName) throw cause;
      throw this.createWriteError(
        `file removal reached the visible name but durability is uncertain: ${this.filePath}`,
        {
          cause,
          phase,
          committedToVisibleName: true,
          durabilityUnknown: true,
        },
      );
    }
  }

  createWriteError(message, details) {
    return new AtomicFileWriteError(message, details);
  }
}
