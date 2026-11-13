import { isCanonicalRealPath } from "./canonical-real-path.js";
import { closeFileDescriptor } from "./file-descriptor.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { constants as bufferConstants } from "node:buffer";
import { FileIdentity, RealDirectoryAuthority, sameFileIdentity } from "./real-directory-authority.js";
import { sameObservedFileMetadata } from "./file-identity.js";

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

/** Exclusive assembled bytes from this module's completed physical read. */
class CapturedRegularFileContent {
  #bytes;

  constructor(bytes, receipt) {
    if (!Buffer.isBuffer(bytes) || !(receipt instanceof RegularFileReadReceipt) || bytes.length !== receipt.byteLength) {
      throw new TypeError("captured file content requires its complete read receipt");
    }
    this.#bytes = bytes;
    this.receipt = receipt;
    Object.freeze(this);
  }

  takeBytes() {
    if (this.#bytes === null) throw new Error("captured file content was already transferred");
    const bytes = this.#bytes;
    this.#bytes = null;
    return bytes;
  }
}

export class RegularFileSnapshot {
  #bytes;

  constructor({ filePath, bytes, identity = null, permissionHint = null }) {
    const captured = bytes instanceof CapturedRegularFileContent ? bytes : null;
    if (!path.isAbsolute(filePath) || !Buffer.isBuffer(bytes) && captured === null) {
      throw new Error("regular file snapshot requires an absolute path and Buffer bytes");
    }
    if (permissionHint !== null && !(permissionHint instanceof FilePermissionHint)) throw new TypeError("snapshot permission hint must be captured metadata");
    this.permissionHint = permissionHint;
    this.filePath = filePath;
    this.#bytes = captured === null ? Buffer.from(bytes) : captured.takeBytes();
    this.digest = captured === null ? crypto.createHash("sha256").update(this.#bytes).digest("hex") : captured.receipt.digest;
    this.byteLength = this.#bytes.length;
    this.identity = identity === null ? null : new FileIdentity(identity);
    Object.freeze(this);
  }

  /** Exact physical version and bytes; the caller owns its path authority. */
  hasSameFileVersion(other) {
    return other instanceof RegularFileSnapshot && this.identity !== null && other.identity !== null
      && sameFileIdentity(this.identity, other.identity) && this.digest === other.digest
      && this.#bytes.equals(other.#bytes);
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

  /** Physical generation and streamed content; permissions remain copy hints. */
  hasSameFileVersion(other) {
    return other instanceof RegularFileReadReceipt && sameFileIdentity(this.identity, other.identity)
      && this.byteLength === other.byteLength && this.digest === other.digest;
  }
}

export function captureRegularFile(filePath, options) {
  return captureRegularFileObserved(filePath, options, null);
}

function captureRegularFileObserved(filePath, options, directoryObservation) {
  const chunks = [];
  let snapshot = null;
  // Each read owns a fresh buffer; these private views never reach a visitor.
  observeRegularFileChunks(filePath, { ...options, visit(chunk) { chunks.push(chunk); },
    onComplete(receipt) {
      const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, receipt.byteLength);
      snapshot = new RegularFileSnapshot({ filePath: receipt.filePath, bytes: new CapturedRegularFileContent(bytes, receipt), identity: receipt.identity, permissionHint: receipt.permissionHint });
      options.validateSnapshot?.(snapshot);
    },
  }, true, directoryObservation);
  return snapshot;
}

/** Observed authority checks are portable; this does not prevent arbitrary hostile tree races. */
export function visitRegularFileChunks(filePath, options) {
  return observeRegularFileChunks(filePath, options, false);
}

function observeRegularFileChunks(filePath, options, capturing, directoryObservation = null) {
  // Optional reads own their initial parent observation here, preserving the
  // directory refusal itself. The reader consumes it immediately on this
  // stack, before any effect or injected callback, and still checks after IO.
  let observedAuthority = directoryObservation?.authorityFor(options.directoryAuthority) ?? null;
  if (options.allowMissingDirectory === true) {
    observedAuthority = regularFileAuthority(path.resolve(filePath), options.directoryAuthority);
    if (!observedAuthority.exists()) return null;
  }
  try { return readRegularFileChunks(filePath, options, observedAuthority, capturing, directoryObservation); }
  catch (cause) { throw regularFileCaptureFailure(cause); }
}

function regularFileAuthority(resolved, directoryAuthority) {
  const authority = directoryAuthority ?? new RealDirectoryAuthority(path.dirname(resolved));
  if (!(authority instanceof RealDirectoryAuthority) || authority.directory !== path.dirname(resolved)) {
    throw new Error("regular file snapshot authority must own its direct parent");
  }
  return authority;
}

function assertRegularFileReadOptions({ label, maxBytes, requireSingleLink = false, onRead = null, visit, expectedLinkCount = null }) {
  if (typeof label !== "string" || label.trim() === "") throw new Error("regular file snapshot label is required");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new Error("regular file snapshot maxBytes must be a non-negative safe integer below MAX_SAFE_INTEGER");
  }
  if (typeof requireSingleLink !== "boolean") throw new Error("regular file snapshot requireSingleLink must be boolean");
  if (onRead !== null && typeof onRead !== "function") throw new Error("regular file snapshot onRead must be a function");
  if (typeof visit !== "function") throw new TypeError("regular file chunk visitor is required");
  if (expectedLinkCount !== null && (!Number.isSafeInteger(expectedLinkCount) || expectedLinkCount < 1)) throw new TypeError("regular file expectedLinkCount must be positive");
}

function readRegularFileChunks(filePath, {
  label, maxBytes, requireSingleLink = false, expectedLinkCount = null, onRead = null, directoryAuthority = null,
  visit, faultInjector = () => {}, phaseNamespace = "file", expectedIdentity = null, onComplete = null, allowMissing = false,
}, observedAuthority, capturing, directoryObservation) {
  const resolved = path.resolve(filePath);
  assertRegularFileReadOptions({ label, maxBytes, requireSingleLink, onRead, visit, expectedLinkCount });
  const links = requireSingleLink ? 1 : expectedLinkCount;
  const authority = observedAuthority ?? regularFileAuthority(resolved, directoryAuthority);
  if (observedAuthority === null) authority.assertStable();
  let descriptor = null;
  let failure = null;
  try {
    let visible;
    try { visible = fs.lstatSync(resolved, { bigint: true }); }
    catch (cause) {
      if (!allowMissing || cause.code !== "ENOENT") throw cause;
      if (directoryObservation === null) authority.assertStable();
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
    if (!isCanonicalRealPath(resolved)) throw new RegularFileReadError(`${label} must be a regular real file up to ${maxBytes} bytes`, { reason: "identity" });
    // O_NOFOLLOW is unavailable on Windows. Identity, kind, canonical path and
    // ancestor checks define the common contract rather than optional flags.
    faultInjector({ phase: `before-${phaseNamespace}-read-open`, filePath: resolved });
    descriptor = fs.openSync(resolved, "r");
    const opened = fs.fstatSync(descriptor, { bigint: true });
    validate(opened);
    if (!sameFileIdentity(visible, opened)) throw new RegularFileReadError(`${label} identity changed while opening`, { reason: "identity" });
    const hash = crypto.createHash("sha256");
    let length = 0;
    // A snapshot already retains the complete file. Larger bounded reads avoid
    // many native calls when the same large source must be freshly recaptured.
    // The initial size only sizes a buffer: EOF and the maxBytes + 1 growth
    // probe still control completion. Streaming visitors retain 64 KiB chunks.
    const chunkBytes = capturing ? Math.min(1024 * 1024, Number(visible.size) + 1) : 64 * 1024;
    faultInjector({ phase: `before-${phaseNamespace}-read`, filePath: resolved });
    while (length <= maxBytes) {
      const observedRemaining = Number(opened.size) - length;
      const readChunkBytes = capturing && observedRemaining >= 0
        ? Math.min(chunkBytes, observedRemaining + 1) : chunkBytes;
      const chunk = Buffer.allocUnsafe(Math.min(readChunkBytes, maxBytes + 1 - length));
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
    if (directoryObservation === null) authority.assertStable();
    if (!sameFileIdentity(opened, completed) || !sameFileIdentity(completed, current)
      || !isCanonicalRealPath(resolved) || completed.size !== BigInt(length)
      || current.size !== completed.size || !sameObservedFileMetadata(opened, completed)
      || !sameObservedFileMetadata(current, completed) || length > maxBytes) {
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

const snapshotGroupToken = Symbol("completed regular file snapshot group");

/** One fixed read contract. Grouped captures expose no callbacks or partial data. */
export class RegularFileCaptureRequest {
  #options;
  constructor(filePath, { label, maxBytes, requireSingleLink = false, directoryAuthority = null, allowMissing = false } = {}) {
    this.filePath = path.resolve(filePath);
    this.directoryAuthority = regularFileAuthority(this.filePath, directoryAuthority);
    assertRegularFileReadOptions({ label, maxBytes, requireSingleLink, visit() {} });
    if (typeof allowMissing !== "boolean") throw new TypeError("regular file capture allowMissing must be boolean");
    this.#options = Object.freeze({ label, maxBytes, requireSingleLink,
      directoryAuthority: this.directoryAuthority, allowMissing });
    Object.freeze(this);
  }
  capture(observation = null) {
    if (observation !== null && !(observation instanceof CapturedDirectoryForest)) throw new TypeError("Regular file group requires its owned directory observation");
    return captureRegularFileObserved(this.filePath, this.#options, observation);
  }
}

/** Shared ancestry is observed freshly around one synchronous, effect-free read.
 * Every file keeps its own open descriptor, identity, timestamps, hash and limit.
 * A complete second forest observation is required before any value can escape.
 */
class CapturedDirectoryForest {
  #authorities;
  #observation;
  #active = true;
  constructor(authorities) {
    this.#authorities = new Set(authorities);
    this.#observation = RealDirectoryAuthority.beginObservation(this.#authorities);
  }
  authorityFor(authority) {
    if (!this.#active || !this.#authorities.has(authority)) throw new TypeError("File is outside its active directory observation");
    return authority;
  }
  assertComplete() { this.#observation.complete(); }
  close() { this.#active = false; this.#observation.discard(); }
}

export class RegularFileSnapshotGroup {
  #snapshots;
  constructor(token, snapshots) {
    if (token !== snapshotGroupToken) throw new TypeError("Snapshot groups require a complete physical capture");
    this.#snapshots = snapshots;
    Object.freeze(this);
  }
  static capture(requests) {
    const snapshots = this.#observe(requests, (entries, observation) =>
      new Map(entries.map(request => [request.filePath, request.capture(observation)])));
    return new RegularFileSnapshotGroup(snapshotGroupToken, snapshots);
  }
  /** All files are freshly read even after a mismatch; no fresh payload is retained. */
  static matches(requests, expectedSnapshots) {
    return this.#observe(requests, (entries, observation) => {
      if (!(expectedSnapshots instanceof Map) || expectedSnapshots.size !== entries.length
        || entries.some(request => !expectedSnapshots.has(request.filePath)
          || expectedSnapshots.get(request.filePath) !== null
            && !(expectedSnapshots.get(request.filePath) instanceof RegularFileSnapshot))) {
        throw new TypeError("Snapshot comparison requires one original snapshot or absence per request");
      }
      let same = true;
      for (const request of entries) {
        const expected = expectedSnapshots.get(request.filePath);
        const current = request.capture(observation);
        if (current === null ? expected !== null : !current.hasSameFileVersion(expected)) same = false;
      }
      return same;
    });
  }
  // Only the two fixed operations above can run within this private read scope.
  static #observe(requests, read) {
    requests = [...requests];
    if (requests.some(request => !(request instanceof RegularFileCaptureRequest))
      || new Set(requests.map(request => request.filePath)).size !== requests.length) {
      throw new TypeError("Snapshot group requires unique typed capture requests");
    }
    let observation;
    try {
      observation = new CapturedDirectoryForest(requests.map(request => request.directoryAuthority));
      const result = read(requests, observation);
      observation.assertComplete();
      return result;
    } catch (cause) { throw regularFileCaptureFailure(cause); }
    finally { observation?.close(); }
  }
  get(filePath) {
    if (!this.#snapshots.has(filePath)) throw new Error("File was not captured in this snapshot group");
    return this.#snapshots.get(filePath);
  }
}

function regularFileCaptureFailure(cause) {
  return cause.code?.startsWith("REAL_DIRECTORY_AUTHORITY_")
    ? new RegularFileReadError(cause.message, { reason: "identity", cause }) : cause;
}
