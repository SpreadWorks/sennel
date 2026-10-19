import { closeFileDescriptor } from "./file-descriptor.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { constants as bufferConstants } from "node:buffer";
import { FileIdentity, RealDirectoryAuthority, sameFileIdentity } from "./real-directory-authority.js";

export { sameFileIdentity } from "./real-directory-authority.js";
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_IN_MEMORY_FILE_BYTES = Math.min(bufferConstants.MAX_LENGTH, Number.MAX_SAFE_INTEGER - 1);

/** Native permission metadata only; this does not prove ownership or ACL privacy. */
export class FilePermissionHint {
  constructor(mode) {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new TypeError("file permission hint must be a permission mask");
    this.mode = mode;
    Object.freeze(this);
  }

  static fromStat(stat) { return new FilePermissionHint(Number(stat.mode) & 0o7777); }
  applyToDescriptor(descriptor) { fs.fchmodSync(descriptor, this.mode); }
  matches(other) {
    if (!(other instanceof FilePermissionHint)) return false;
    // Node's Windows chmod/stat expose writability, without POSIX distinctions.
    return process.platform === "win32"
      ? (this.mode & 0o200) === (other.mode & 0o200)
      : this.mode === other.mode;
  }

  matchesAfterWrite(other) {
    if (process.platform === "win32") return this.matches(other);
    // Like native copyFile, apply before writing: the kernel may clear setid.
    return other instanceof FilePermissionHint
      && (this.mode & 0o1777) === (other.mode & 0o1777)
      && (other.mode & 0o6000 & ~this.mode) === 0;
  }
}

export class RegularFileSnapshot {
  #bytes;

  constructor({ filePath, bytes, identity = null, permissionHint = null }) {
    if (!path.isAbsolute(filePath) || !Buffer.isBuffer(bytes)) {
      throw new Error("regular file snapshot requires an absolute path and Buffer bytes");
    }
    if (permissionHint !== null && !(permissionHint instanceof FilePermissionHint)) throw new TypeError("snapshot permission hint must be captured metadata");
    this.permissionHint = permissionHint;
    this.filePath = filePath;
    this.#bytes = Buffer.from(bytes);
    this.digest = crypto.createHash("sha256").update(this.#bytes).digest("hex");
    this.byteLength = this.#bytes.length;
    this.identity = identity === null ? null : new FileIdentity(identity);
    Object.freeze(this);
  }

  get bytes() { return Buffer.from(this.#bytes); }
  text() { return this.#bytes.toString("utf8"); }
}

export class RegularFileReadError extends Error {
  constructor(message, { reason, cause } = {}) {
    super(message, { cause });
    this.name = "RegularFileReadError";
    this.reason = reason;
    this.code = reason === "limit" ? "REGULAR_FILE_READ_LIMIT" : "REGULAR_FILE_READ_IDENTITY";
  }
}

export class RegularFileLinkCountError extends RegularFileReadError {
  constructor(message) {
    super(message, { reason: "identity" });
    this.name = "RegularFileLinkCountError";
  }
}

export class RegularFileReadReceipt {
  constructor({ filePath, identity, byteLength, digest, permissionHint = null }) {
    this.filePath = filePath;
    if (permissionHint !== null && !(permissionHint instanceof FilePermissionHint)) throw new TypeError("receipt permission hint must be captured metadata");
    this.permissionHint = permissionHint;
    this.identity = new FileIdentity(identity);
    this.byteLength = byteLength;
    this.digest = digest;
    Object.freeze(this);
  }
}

export function captureRegularFile(filePath, options) {
  const chunks = [];
  let snapshot = null;
  visitRegularFileChunks(filePath, { ...options, visit(chunk) { chunks.push(Buffer.from(chunk)); },
    onComplete(receipt) {
      snapshot = new RegularFileSnapshot({ filePath: receipt.filePath, bytes: Buffer.concat(chunks, receipt.byteLength), identity: receipt.identity, permissionHint: receipt.permissionHint });
      options.validateSnapshot?.(snapshot);
    },
  });
  return snapshot;
}

/** Observed authority checks are portable; this does not prevent arbitrary hostile tree races. */
export function visitRegularFileChunks(filePath, options) {
  try { return readRegularFileChunks(filePath, options); }
  catch (cause) {
    if (cause.code?.startsWith("REAL_DIRECTORY_AUTHORITY_")) {
      throw new RegularFileReadError(cause.message, { reason: "identity", cause });
    }
    throw cause;
  }
}

function readRegularFileChunks(filePath, {
  label, maxBytes, requireSingleLink = false, expectedLinkCount = null, onRead = null, directoryAuthority = null,
  visit, faultInjector = () => {}, phaseNamespace = "file", expectedIdentity = null, onComplete = null, allowMissing = false,
}) {
  const resolved = path.resolve(filePath);
  if (typeof label !== "string" || label.trim() === "") throw new Error("regular file snapshot label is required");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new Error("regular file snapshot maxBytes must be a non-negative safe integer below MAX_SAFE_INTEGER");
  }
  if (typeof requireSingleLink !== "boolean") throw new Error("regular file snapshot requireSingleLink must be boolean");
  if (onRead !== null && typeof onRead !== "function") throw new Error("regular file snapshot onRead must be a function");
  if (typeof visit !== "function") throw new TypeError("regular file chunk visitor is required");
  if (expectedLinkCount !== null && (!Number.isSafeInteger(expectedLinkCount) || expectedLinkCount < 1)) throw new TypeError("regular file expectedLinkCount must be positive");
  const links = requireSingleLink ? 1 : expectedLinkCount;
  const authority = directoryAuthority ?? new RealDirectoryAuthority(path.dirname(resolved));
  if (!(authority instanceof RealDirectoryAuthority) || authority.directory !== path.dirname(resolved)) {
    throw new Error("regular file snapshot authority must own its direct parent");
  }
  authority.assertStable();
  let descriptor = null;
  let failure = null;
  try {
    let visible;
    try { visible = fs.lstatSync(resolved, { bigint: true }); }
    catch (cause) {
      if (!allowMissing || cause.code !== "ENOENT") throw cause;
      authority.assertStable();
      return null;
    }
    const validate = (stat) => {
      if (links !== null && stat.nlink !== BigInt(links)) throw new RegularFileLinkCountError(`${label} must not be hard linked`);
      if (stat.size > BigInt(maxBytes)) throw new RegularFileReadError(`${label} must be a regular real file up to ${maxBytes} bytes`, { reason: "limit" });
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new RegularFileReadError(`${label} must be a regular real file up to ${maxBytes} bytes`, { reason: "identity" });
      }
    };
    validate(visible);
    if (expectedIdentity !== null && !sameFileIdentity(visible, expectedIdentity)) throw new RegularFileReadError(`${label} identity changed before reading`, { reason: "identity" });
    if (fs.realpathSync(resolved) !== resolved) throw new RegularFileReadError(`${label} must be a regular real file up to ${maxBytes} bytes`, { reason: "identity" });
    // O_NOFOLLOW is unavailable on Windows. Identity, kind, canonical path and
    // ancestor checks define the common contract rather than optional flags.
    faultInjector({ phase: `before-${phaseNamespace}-read-open`, filePath: resolved });
    descriptor = fs.openSync(resolved, "r");
    const opened = fs.fstatSync(descriptor, { bigint: true });
    validate(opened);
    if (!sameFileIdentity(visible, opened)) throw new RegularFileReadError(`${label} identity changed while opening`, { reason: "identity" });
    const hash = crypto.createHash("sha256");
    let length = 0;
    faultInjector({ phase: `before-${phaseNamespace}-read`, filePath: resolved });
    while (length <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - length));
      let count;
      try { count = fs.readSync(descriptor, chunk, 0, chunk.length, length); }
      catch (cause) { onRead?.(maxBytes); throw cause; }
      if (count === 0) break;
      length += count;
      const part = chunk.subarray(0, count);
      hash.update(part);
      try { visit(part); }
      catch (cause) { onRead?.(length); throw cause; }
    }
    onRead?.(length);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(resolved, { bigint: true });
    validate(completed);
    validate(current);
    authority.assertStable();
    if (!sameFileIdentity(opened, completed) || !sameFileIdentity(completed, current)
      || fs.realpathSync(resolved) !== resolved || completed.size !== BigInt(length)
      || current.size !== completed.size || opened.mtimeNs !== completed.mtimeNs
      || opened.ctimeNs !== completed.ctimeNs || current.mtimeNs !== completed.mtimeNs
      || current.ctimeNs !== completed.ctimeNs || opened.mode !== completed.mode
      || current.mode !== completed.mode || length > maxBytes) {
      throw new RegularFileReadError(`${label} changed while reading`, { reason: "identity" });
    }
    const receipt = new RegularFileReadReceipt({ filePath: resolved, byteLength: length, digest: hash.digest("hex"), identity: completed, permissionHint: FilePermissionHint.fromStat(completed) });
    onComplete?.(receipt);
    return receipt;
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    if (descriptor !== null) closeFileDescriptor(descriptor, failure);
  }
}
