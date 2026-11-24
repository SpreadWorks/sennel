import { closeFileDescriptor } from "./file-descriptor.js";
import fs from "node:fs";
import path from "node:path";
import { RealDirectoryAuthority, sameFileIdentity } from "./real-directory-authority.js";
import { captureRegularFile, FilePermissionHint, DEFAULT_MAX_FILE_BYTES, MAX_IN_MEMORY_FILE_BYTES, RegularFileSnapshot } from "./regular-file-snapshot.js";

export class RegularFileAppendBaselineChangedError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegularFileAppendBaselineChangedError";
    this.code = "REGULAR_FILE_APPEND_BASELINE_CHANGED";
  }
}

export class RegularFileAppendError extends AggregateError {
  constructor(cause, { bytesWritten, publicationUnknown, cleanupErrors }) {
    super([cause, ...cleanupErrors], cause.message, { cause });
    this.name = "RegularFileAppendError";
    this.code = publicationUnknown ? "REGULAR_FILE_APPEND_UNCONFIRMED" : "REGULAR_FILE_APPEND_FAILED";
    this.bytesWritten = bytesWritten;
    this.publicationUnknown = publicationUnknown;
    this.cleanupFailed = cleanupErrors.length > 0 || cause.cleanupFailed === true;
    this.cleanupErrors = cleanupErrors;
  }
}

/** Append uses no retry or rollback: a partial append must remain observable. */
export function appendRegularFile(filePath, content, {
  maxBytes = MAX_IN_MEMORY_FILE_BYTES, directoryAuthority = null, sync = true, expectedBytes = null,
  expectedSnapshot = undefined, faultInjector = () => {},
  creationMode = 0o666,
  permissionMode = null,
} = {}) {
  const resolved = path.resolve(filePath);
  const bytes = Buffer.isBuffer(content) ? Buffer.from(content) : typeof content === "string" ? Buffer.from(content) : null;
  if (bytes === null) throw new TypeError("regular file append content must be a Buffer or string");
  if (!Number.isInteger(creationMode) || creationMode < 0 || creationMode > 0o777) throw new TypeError("append creationMode must be a permission mask");
  const permissionHint = permissionMode === null ? null : new FilePermissionHint(permissionMode);
  if (permissionHint !== null && permissionHint.mode > 0o777) throw new TypeError("append permissionMode must be a permission mask up to 0777");
  const authority = directoryAuthority ?? new RealDirectoryAuthority(path.dirname(resolved));
  if (!(authority instanceof RealDirectoryAuthority) || authority.directory !== path.dirname(resolved)) throw new Error("append authority must own its direct parent");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) throw new TypeError("append maxBytes must be a non-negative safe integer");
  const capture = () => captureRegularFile(resolved, { label: "append target", maxBytes,
    requireSingleLink: true, directoryAuthority: authority });
  let descriptor = null;
  let bytesWritten = 0;
  let publicationUnknown = false;
  try {
    authority.assertStable();
    let baseline = null;
    let exists = true;
    try { fs.lstatSync(resolved); }
    catch (cause) { if (cause.code !== "ENOENT") throw cause; exists = false; }
    if (exists) baseline = capture();
    if (expectedSnapshot !== undefined) {
      if (expectedSnapshot !== null && (!(expectedSnapshot instanceof RegularFileSnapshot) || expectedSnapshot.identity === null)) {
        throw new TypeError("append expectedSnapshot must be null or a captured regular file snapshot");
      }
      if ((expectedSnapshot === null) !== (baseline === null)
        || (expectedSnapshot !== null && (!sameFileIdentity(expectedSnapshot.identity, baseline.identity) || expectedSnapshot.digest !== baseline.digest))) {
        throw new RegularFileAppendBaselineChangedError("append snapshot baseline changed");
      }
    }
    const previous = baseline?.bytes ?? Buffer.alloc(0);
    if (expectedBytes !== null && (!Buffer.isBuffer(expectedBytes) || !previous.equals(expectedBytes))) throw new RegularFileAppendBaselineChangedError("append baseline bytes changed");
    if (previous.length + bytes.length > maxBytes) throw new Error(`append exceeds ${maxBytes} bytes`);
    faultInjector({ phase: "before-append-open", filePath: resolved });
    descriptor = fs.openSync(resolved, baseline === null ? "ax" : "a", creationMode);
    publicationUnknown = baseline === null;
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || (baseline !== null && !sameFileIdentity(opened, baseline.identity))) {
      throw new Error("append target identity changed while opening");
    }
    authority.assertStable();
    const current = capture();
    if (!sameFileIdentity(opened, current.identity) || !current.bytes.equals(previous)) throw new Error("append target changed before writing");
    // This preserves Node's permission metadata hint. On Windows chmod only
    // affects writability; it does not establish a POSIX or private ACL proof.
    if (permissionHint !== null) permissionHint.applyToDescriptor(descriptor);
    while (bytesWritten < bytes.length) {
      faultInjector({ phase: "before-append-write", filePath: resolved, bytesWritten });
      publicationUnknown = true;
      const count = fs.writeSync(descriptor, bytes, bytesWritten, bytes.length - bytesWritten, null);
      if (count === 0) throw new Error("regular file append made no progress");
      bytesWritten += count;
    }
    if (sync) { faultInjector({ phase: "before-append-fsync", filePath: resolved, bytesWritten }); fs.fsyncSync(descriptor); }
    fs.closeSync(descriptor);
    descriptor = null;
    faultInjector({ phase: "before-append-readback", filePath: resolved, bytesWritten });
    const result = capture();
    if (!sameFileIdentity(opened, result.identity) || !result.bytes.equals(Buffer.concat([previous, bytes]))
      || (permissionHint !== null && !permissionHint.matchesAfterWrite(result.permissionHint))) {
      throw new Error("append readback does not match exact bytes");
    }
    return result;
  } catch (cause) {
    const cleanupErrors = [];
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch (error) { cleanupErrors.push(error); }
    }
    throw new RegularFileAppendError(cause, { bytesWritten, publicationUnknown, cleanupErrors });
  }
}

export class RegularFileRemovalError extends Error {
  constructor(cause, removed) {
    super(cause.message, { cause });
    this.name = "RegularFileRemovalError";
    this.code = removed ? "REGULAR_FILE_REMOVAL_UNCONFIRMED" : "REGULAR_FILE_REMOVAL_FAILED";
    this.committedToVisibleName = removed;
    this.publicationUnknown = removed;
    this.cleanupFailed = cause.cleanupFailed === true;
  }
}

/** Closed-descriptor identity checked unlink, including the two-link publication boundary. */
export function removeRegularFile(filePath, {
  expectedIdentity = null, expectedLinkCount = 1, maxBytes = DEFAULT_MAX_FILE_BYTES,
  directoryAuthority = null, commitGuard = () => {},
} = {}) {
  const resolved = path.resolve(filePath);
  const authority = directoryAuthority ?? new RealDirectoryAuthority(path.dirname(resolved));
  const capture = () => captureRegularFile(resolved, { label: "removal target", maxBytes,
    expectedLinkCount, expectedIdentity, directoryAuthority: authority });
  let removed = false;
  try {
    const before = capture();
    commitGuard();
    const after = capture();
    if (!sameFileIdentity(before.identity, after.identity) || before.digest !== after.digest) throw new Error("removal target changed before unlink");
    authority.assertStable();
    fs.unlinkSync(resolved);
    removed = true;
    authority.assertStable();
    try { fs.lstatSync(resolved); }
    catch (cause) { if (cause.code === "ENOENT") return before; throw cause; }
    throw new Error("removal readback found a visible replacement");
  } catch (cause) { throw new RegularFileRemovalError(cause, removed); }
}

/** A validated descriptor with explicit lifetime for inherited child input. */
export class RegularFileReadHandle {
  #descriptor;
  constructor(filePath, { maxBytes = DEFAULT_MAX_FILE_BYTES, directoryAuthority = null } = {}) {
    const resolved = path.resolve(filePath);
    const authority = directoryAuthority ?? new RealDirectoryAuthority(path.dirname(resolved));
    this.snapshot = captureRegularFile(resolved, { label: "inherited input", maxBytes,
      requireSingleLink: true, directoryAuthority: authority });
    this.#descriptor = fs.openSync(resolved, "r");
    try {
      if (!sameFileIdentity(this.snapshot.identity, fs.fstatSync(this.#descriptor, { bigint: true }))) throw new Error("inherited input identity changed while opening");
      const current = captureRegularFile(resolved, { label: "inherited input", maxBytes,
        requireSingleLink: true, directoryAuthority: authority });
      if (!sameFileIdentity(current.identity, this.snapshot.identity) || current.digest !== this.snapshot.digest) throw new Error("inherited input bytes changed while opening");
    } catch (cause) {
      closeFileDescriptor(this.#descriptor, cause);
      this.#descriptor = null;
      throw cause;
    }
  }
  get descriptor() {
    if (this.#descriptor === null) throw new Error("inherited input descriptor is closed");
    return this.#descriptor;
  }
  close() {
    if (this.#descriptor === null) return;
    closeFileDescriptor(this.#descriptor);
    this.#descriptor = null;
  }
}
