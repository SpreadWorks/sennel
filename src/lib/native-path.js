import fs from "node:fs";
import path from "node:path";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { LogicalRelativePath, PortablePathError, isNativePathWithin } from "./portable-path.js";

function assertAuthority(authority, target) {
  if (!(authority instanceof RealDirectoryAuthority)) throw new PortablePathError("native conversion requires a RealDirectoryAuthority");
  if (!isNativePathWithin(authority.directory, target)) throw new PortablePathError("native path is outside the directory authority");
  const parent = authority.descendant(path.dirname(target), { allowMissing: true });
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new PortablePathError("native conversion target must not be a symbolic link");
    if (fs.realpathSync(target) !== target) {
      throw new PortablePathError("native conversion target must retain its real path spelling");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  parent.assertStable();
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
    if (!(authority instanceof RealDirectoryAuthority)) throw new PortablePathError("native conversion requires a RealDirectoryAuthority");
    const native = new NativeAbsolutePath(path.join(authority.directory, ...logical.segments));
    assertAuthority(authority, native.value);
    return native;
  }
  toLogical(authority) {
    assertAuthority(authority, this.value);
    return new LogicalRelativePath(path.relative(authority.directory, this.value).split(path.sep).join("/"));
  }
  toString() { return this.value; }
}
