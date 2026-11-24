import fs from "node:fs";
import path from "node:path";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { isCanonicalRealPath } from "./canonical-real-path.js";
import { LogicalRelativePath, PortablePathError, isNativePathWithin } from "./portable-path.js";

function assertDirectoryAuthority(authority) {
  if (!(authority instanceof RealDirectoryAuthority)) throw new PortablePathError("native conversion requires a RealDirectoryAuthority");
}

function assertContained(authority, target) {
  assertDirectoryAuthority(authority);
  if (!isNativePathWithin(authority.directory, target)) throw new PortablePathError("native path is outside the directory authority");
}

function assertTarget(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new PortablePathError("native conversion target must not be a symbolic link");
    if (!isCanonicalRealPath(target)) {
      throw new PortablePathError("native conversion target must retain its real path spelling");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function assertAuthority(authority, target) {
  assertContained(authority, target);
  const parent = authority.descendant(path.dirname(target), { allowMissing: true });
  assertTarget(target);
  parent.assertStable();
  return parent;
}

function resolution(authority, native, parent) {
  const logical = new LogicalRelativePath(path.relative(authority.directory, native.value).split(path.sep).join("/"));
  return new NativePathResolution(logical, parent.directory === path.dirname(native.value) ? parent : null);
}

/** A portable name and the already observed direct parent, when it exists. */
export class NativePathResolution {
  constructor(logicalPath, directoryAuthority) {
    if (!(logicalPath instanceof LogicalRelativePath)
      || (directoryAuthority !== null && !(directoryAuthority instanceof RealDirectoryAuthority))) {
      throw new TypeError("native path resolution requires a logical path and an optional directory authority");
    }
    this.logicalPath = logicalPath;
    this.directoryAuthority = directoryAuthority;
    Object.freeze(this);
  }
}

/** Host absolute names, distinct from serialized logical names. */
export class NativeAbsolutePath {
  constructor(value) {
    if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)
      || (path === path.win32 && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(value))) {
      throw new PortablePathError("native path must be fully absolute on this host");
    }
    this.value = path.resolve(value);
    Object.freeze(this);
  }
  static fromLogical(authority, value) {
    const logical = LogicalRelativePath.from(value);
    assertDirectoryAuthority(authority);
    const native = new NativeAbsolutePath(path.join(authority.directory, ...logical.segments));
    assertAuthority(authority, native.value);
    return native;
  }
  static resolveAuthorities(authority, paths) {
    if (!Array.isArray(paths) || paths.some(value => !(value instanceof NativeAbsolutePath))) {
      throw new TypeError("native resolution requires native absolute path values");
    }
    for (const native of paths) assertContained(authority, native.value);
    assertDirectoryAuthority(authority);
    const parents = authority.observeDescendants(paths.map(native => path.dirname(native.value)), { allowMissing: true });
    for (const native of paths) assertTarget(native.value);
    RealDirectoryAuthority.assertAllStable(parents);
    return Object.freeze(paths.map((native, index) => resolution(authority, native, parents[index])));
  }
  resolveAuthority(authority) {
    return resolution(authority, this, assertAuthority(authority, this.value));
  }
  toLogical(authority) { return this.resolveAuthority(authority).logicalPath; }
  toString() { return this.value; }
}
