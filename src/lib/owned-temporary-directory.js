import fs from "node:fs";
import path from "node:path";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { LogicalRelativePath } from "./portable-path.js";

const FACTORY = Symbol("owned temporary directory factory");

/** A minted directory identity, never reconstructed from an untrusted name. */
export class OwnedTemporaryDirectory {
  #authority;
  #removed = false;

  constructor(factory, authority) {
    if (factory !== FACTORY) throw new TypeError("use OwnedTemporaryDirectory.create()");
    this.#authority = authority;
  }

  static create(parentAuthority, prefix) {
    if (!(parentAuthority instanceof RealDirectoryAuthority)) throw new TypeError("temporary directory requires a parent authority");
    OwnedTemporaryDirectory.validatePrefix(prefix);
    parentAuthority.assertStable();
    const directory = fs.mkdtempSync(path.join(parentAuthority.directory, prefix));
    parentAuthority.assertStable();
    return new OwnedTemporaryDirectory(FACTORY, new RealDirectoryAuthority(directory, { parentAuthority }));
  }

  static validatePrefix(prefix) {
    if (typeof prefix !== "string" || prefix.length === 0 || prefix === "." || prefix === "..") throw new TypeError("temporary prefix must be a non-empty filename prefix");
    const logical = LogicalRelativePath.from(`${prefix}temporary`, "temporary prefix");
    if (logical.segments.length !== 1) throw new TypeError("temporary prefix must be one filename prefix");
  }

  get path() { return this.#authority.directory; }
  get authority() { return this.#authority; }

  cleanup({ recursive = true } = {}) {
    if (this.#removed) return;
    this.#authority.assertStable();
    if (recursive) this.#authority.removeTree();
    else this.#authority.removeEmpty();
    this.#removed = true;
  }
}
