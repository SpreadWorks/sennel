import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { TemporaryPaths } from "./temporary-paths.js";
import { LogicalRelativePath } from "./portable-path.js";
import { ReadOnlyProcessRuntimeStorage } from "./readonly-invocation-workspace.js";

const LOCATION_FACTORY = Symbol("repository lock location");

export class RepositoryLegacyLockError extends Error {
  constructor(message, { lockPath, cause } = {}) {
    super(message, { cause });
    this.name = "RepositoryLegacyLockError";
    this.code = "REPOSITORY_LOCK_UNKNOWN";
    this.lockPath = lockPath;
    this.lockStatus = "unknown";
    this.reason = "legacy-owner-format";
  }
}

/** A known old producer path is exclusion evidence, never recovery authority. */
class LegacyLockExclusion {
  #ancestor;
  constructor(authority, absolute, directory) {
    if (typeof absolute !== "string" || !path.isAbsolute(absolute)) throw new TypeError("legacy lock paths must be explicit absolute paths");
    this.path = path.resolve(absolute);
    this.directory = directory;
    const root = [authority.root, authority.storageRoot].find((candidate) => {
      const relative = path.relative(candidate.directory, this.path);
      return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    if (!root) throw new TypeError("legacy lock path must belong to the exact repository or minted storage root");
    this.#ancestor = root.descendant(path.dirname(this.path), { allowMissing: true });
    Object.freeze(this);
  }

  assertAbsent(errorFactory) {
    const parent = path.dirname(this.path);
    this.#ancestor = this.#ancestor.descendant(parent, { allowMissing: true });
    if (this.#ancestor.directory !== parent) return;
    let present;
    try {
      const stat = fs.lstatSync(this.path, { throwIfNoEntry: false });
      present = stat !== undefined && (!this.directory || !stat.isDirectory()
        || this.#ancestor.descendant(this.path).entries().length > 0);
      if (!present && !this.directory) {
        const prefix = `.${path.basename(this.path)}.`;
        present = this.#ancestor.entries().some((name) => name.startsWith(prefix) && name.endsWith(".owner.tmp"));
      }
    } catch (cause) {
      if (cause.code === "ENOENT") return;
      throw this.#refusal(errorFactory, "Legacy lock exclusion cannot be inspected", cause);
    }
    if (!present) return;
    const message = "Legacy lock exclusion remains; its owner cannot be verified or automatically reclaimed";
    throw this.#refusal(errorFactory, message);
  }

  #refusal(errorFactory, message, cause) {
    const error = errorFactory?.("unknown", message, { lockPath: this.path, cause })
      ?? new RepositoryLegacyLockError(message, { lockPath: this.path, cause });
    error.reason ??= "legacy-owner-format";
    error.lockReason = "legacy-owner-format";
    error.lockStatus = "unknown";
    return error;
  }
}

function relativeLockPath({ namespace = null, identity = null, fileName }) {
  if (typeof fileName !== "string" || !fileName || fileName === "." || fileName === ".."
    || /[\\/]/.test(fileName)) throw new TypeError("repository lock fileName must be a basename");
  if (namespace === null && identity === null) return fileName;
  const segments = LogicalRelativePath.from(namespace, "repository lock namespace").segments;
  if (typeof identity !== "string" || !identity) throw new TypeError("repository lock identity must be nonempty text");
  return path.join(...segments, crypto.createHash("sha256").update(identity).digest("hex"), fileName);
}

/** One retained repository authority owns every repository exclusion path. */
export class RepositoryLockAuthority {
  constructor(mainRoot, { rootAuthority = null, storagePolicy = null, errorFactory } = {}) {
    this.mainRoot = path.resolve(mainRoot);
    this.root = rootAuthority ?? new RealDirectoryAuthority(this.mainRoot, { errorFactory });
    if (!(this.root instanceof RealDirectoryAuthority) || this.root.directory !== this.mainRoot) {
      throw new TypeError("repository lock authority requires the exact repository root authority");
    }
    this.root.assertStable();
    if (storagePolicy !== null && !(storagePolicy instanceof ReadOnlyProcessRuntimeStorage)) {
      throw new TypeError("repository lock storage must be minted by a read-only workspace");
    }
    this.storagePolicy = storagePolicy;
    this.storageRoot = storagePolicy?.authority ?? this.root;
    this.path = storagePolicy?.runtime("repository-control")
      ?? TemporaryPaths.runtimePath(this.mainRoot, "repository-control");
    this.errorFactory = errorFactory;
    Object.freeze(this);
  }

  static pathFor(mainRoot, options) {
    return path.join(TemporaryPaths.runtimePath(mainRoot, "repository-control"), relativeLockPath(options));
  }

  static relativePathFor(options) {
    const root = path.resolve(".");
    return path.relative(root, this.pathFor(root, options));
  }

  assertStable() { this.root.assertStable(); this.storagePolicy?.assertStable(); }

  location(options) {
    this.assertStable();
    return new RepositoryLockLocation(LOCATION_FACTORY, this, relativeLockPath(options), options);
  }
}

/** Inspecting a missing location creates nothing; acquisition creates its branch. */
export class RepositoryLockLocation {
  #ancestor;
  #legacy;
  constructor(factory, authority, relative, { legacyPaths = [], legacyDirectories = [] }) {
    if (factory !== LOCATION_FACTORY) throw new TypeError("repository lock locations are authority-owned");
    this.authority = authority;
    this.path = path.join(authority.path, relative);
    this.directory = path.dirname(this.path);
    this.fileName = path.basename(this.path);
    this.#legacy = Object.freeze([
      ...legacyPaths.map((file) => new LegacyLockExclusion(authority, file, false)),
      ...legacyDirectories.map((directory) => new LegacyLockExclusion(authority, directory, true)),
    ]);
    this.#ancestor = authority.storageRoot.descendant(this.directory, {
      allowMissing: true, errorFactory: authority.errorFactory,
    });
    Object.freeze(this);
  }

  resolve({ create = false, errorFactory = this.authority.errorFactory } = {}) {
    this.authority.assertStable();
    for (const legacy of this.#legacy) legacy.assertAbsent(errorFactory);
    const observed = this.#ancestor.descendant(this.directory, {
      create, allowMissing: !create, errorFactory: this.authority.errorFactory,
    });
    this.#ancestor = observed;
    return observed.directory === this.directory ? observed : null;
  }
}
