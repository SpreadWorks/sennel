import path from "node:path";
import { AtomicFile } from "./atomic-file.js";
import { NativeAbsolutePath } from "./native-path.js";
import { retainPluginDirectory } from "./plugin-directory-authority.js";
import { LogicalPathSet, LogicalRelativePath } from "./portable-path.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { captureRegularFile, FilePermissionHint } from "./regular-file-snapshot.js";

const BLOCK_BYTES = 512;
const MIB = 1024 * 1024;
const validatedArchive = Symbol("validated Git plugin archive");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class GitPluginArchiveError extends Error {
  constructor(message, { cause } = {}) {
    super(`Invalid Git plugin archive: ${message}`, { cause });
    this.name = "GitPluginArchiveError";
    this.code = "GIT_PLUGIN_ARCHIVE_INVALID";
  }
}

/** Finite ceilings include metadata headers and their payloads. */
export class GitPluginArchiveLimits {
  constructor({ archiveBytes = 256 * MIB, entryBytes = 64 * MIB, totalBytes = 256 * MIB, entries = 10000 } = {}) {
    for (const [name, value, ceiling] of [
      ["archiveBytes", archiveBytes, 256 * MIB], ["entryBytes", entryBytes, 64 * MIB],
      ["totalBytes", totalBytes, 256 * MIB], ["entries", entries, 10000],
    ]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) throw new TypeError(`archive ${name} must be between 0 and ${ceiling}`);
      this[name] = value;
    }
    Object.freeze(this);
  }
}

function reject(message) { throw new GitPluginArchiveError(message); }
function allZero(bytes) { return bytes.every((byte) => byte === 0); }
function decode(bytes) {
  let value;
  try { value = utf8.decode(bytes); }
  catch (cause) { throw new GitPluginArchiveError("invalid UTF-8", { cause }); }
  if (value.includes("\0")) reject("NUL in text");
  return value;
}
function textField(bytes) {
  const end = bytes.indexOf(0);
  if (end < 0) return decode(bytes);
  if (!allZero(bytes.subarray(end))) reject("nonzero bytes after header text terminator");
  return decode(bytes.subarray(0, end));
}
function octal(bytes, label, { empty = false } = {}) {
  // Git writes POSIX octal fields; GNU/base-256 extensions are not accepted.
  const text = bytes.toString("latin1");
  if (empty && /^[\0 ]*$/.test(text)) return 0;
  if (!/^[ ]*[0-7]+[\0 ]*$/.test(text)) reject(`invalid octal ${label}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) reject(`unsafe ${label}`);
  return value;
}
function logicalPath(value, directory = false) {
  return new LogicalRelativePath(directory && value.endsWith("/") ? value.slice(0, -1) : value, "archive path");
}

class GitArchiveHeader {
  constructor(bytes) {
    const expected = octal(bytes.subarray(148, 156), "checksum");
    let checksum = 0;
    for (let index = 0; index < BLOCK_BYTES; index++) checksum += index >= 148 && index < 156 ? 32 : bytes[index];
    if (checksum !== expected) reject("header checksum mismatch");
    if (!bytes.subarray(257, 265).equals(Buffer.from("ustar\0" + "00", "latin1"))) reject("unsupported tar format");
    if (!allZero(bytes.subarray(500))) reject("unsupported header extension");
    this.type = String.fromCharCode(bytes[156]);
    if (!["0", "\0", "5", "x", "g"].includes(this.type)) reject(`unsupported entry type ${JSON.stringify(this.type)}`);
    if (textField(bytes.subarray(157, 257)) !== "") reject("link target is unsupported");
    this.mode = octal(bytes.subarray(100, 108), "mode");
    if (this.mode > 0o777) reject("unsupported permission bits");
    this.size = octal(bytes.subarray(124, 136), "size");
    octal(bytes.subarray(108, 116), "uid");
    octal(bytes.subarray(116, 124), "gid");
    octal(bytes.subarray(136, 148), "mtime");
    if (octal(bytes.subarray(329, 337), "device major", { empty: true }) !== 0
      || octal(bytes.subarray(337, 345), "device minor", { empty: true }) !== 0) reject("device metadata is unsupported");
    textField(bytes.subarray(265, 297));
    textField(bytes.subarray(297, 329));
    const name = textField(bytes.subarray(0, 100));
    const prefix = textField(bytes.subarray(345, 500));
    this.path = prefix ? `${prefix}/${name}` : name;
    logicalPath(this.path, this.type === "5");
    Object.freeze(this);
  }
  get metadata() { return this.type === "x" || this.type === "g"; }
}

class GitArchivePax {
  #values;
  constructor(bytes = Buffer.alloc(0)) {
    this.#values = new Map();
    for (let offset = 0; offset < bytes.length;) {
      const space = bytes.indexOf(32, offset);
      if (space < 0) reject("missing PAX record length");
      const digits = bytes.subarray(offset, space).toString("latin1");
      if (!/^[1-9][0-9]*$/.test(digits)) reject("invalid PAX record length");
      const length = Number(digits);
      const end = offset + length;
      if (!Number.isSafeInteger(length) || end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) reject("invalid PAX record framing");
      const record = decode(bytes.subarray(space + 1, end - 1));
      const equal = record.indexOf("=");
      if (equal <= 0) reject("invalid PAX key/value");
      const key = record.slice(0, equal);
      const value = record.slice(equal + 1);
      if (!["path", "size", "mtime", "comment"].includes(key)) reject(`unsupported PAX key ${key}`);
      if (this.#values.has(key)) reject(`duplicate PAX key ${key}`);
      if (key === "path") logicalPath(value, true);
      if (key === "size" && (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))) reject("invalid PAX size");
      if (key === "mtime" && !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) reject("invalid PAX mtime");
      this.#values.set(key, value);
      offset = end;
    }
    Object.freeze(this);
  }
  get(key) { return this.#values.get(key); }
  merge(other) {
    for (const [key, value] of other.#values) this.#values.set(key, value);
  }
}

class GitArchiveEntry {
  #bytes;
  constructor(header, global, local, bytes) {
    this.directory = header.type === "5";
    this.logical = logicalPath(local?.get("path") ?? global.get("path") ?? header.path, this.directory);
    this.permissionHint = new FilePermissionHint(header.mode);
    if (this.directory && bytes.length !== 0) reject("directory entry has content");
    this.#bytes = bytes;
    Object.freeze(this);
  }
  extract(root, authorities) {
    const target = String(NativeAbsolutePath.fromLogical(root, this.logical));
    if (this.directory) {
      retainPluginDirectory(target, authorities, { create: true, creationMode: this.permissionHint.mode });
      return;
    }
    const parent = retainPluginDirectory(path.dirname(target), authorities, { create: true });
    new AtomicFile(target, { directoryAuthority: parent, permissionHint: this.permissionHint,
      maxBytes: this.#bytes.length }).write(this.#bytes, { exclusive: true });
  }
}

/** Validated Git tar/PAX only. Extraction never reparses mutable source bytes. */
export class GitPluginArchive {
  #entries;
  constructor(token, entries, byteLength, comment) {
    if (token !== validatedArchive) throw new TypeError("use GitPluginArchive.fromFile or fromBuffer");
    this.#entries = entries;
    this.entryCount = entries.length;
    this.byteLength = byteLength;
    this.comment = comment;
    Object.freeze(this);
  }
  static fromFile(archivePath, { limits = new GitPluginArchiveLimits(), directoryAuthority = null } = {}) {
    if (!(limits instanceof GitPluginArchiveLimits)) throw new TypeError("archive limits must be GitPluginArchiveLimits");
    const snapshot = captureRegularFile(archivePath, { label: "Git plugin archive", maxBytes: limits.archiveBytes,
      requireSingleLink: true, directoryAuthority });
    return GitPluginArchive.fromBuffer(snapshot.bytes, { limits });
  }
  static fromBuffer(bytes, { limits = new GitPluginArchiveLimits() } = {}) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError("Git plugin archive requires Buffer bytes");
    if (!(limits instanceof GitPluginArchiveLimits)) throw new TypeError("archive limits must be GitPluginArchiveLimits");
    if (bytes.length > limits.archiveBytes) reject("archive byte limit exceeded");
    if (bytes.length % BLOCK_BYTES !== 0) reject("incomplete archive block");
    const captured = Buffer.from(bytes);
    const entries = [];
    const global = new GitArchivePax();
    let local = null;
    let count = 0;
    let total = 0;
    let ended = false;
    for (let offset = 0; offset < captured.length;) {
      const block = captured.subarray(offset, offset + BLOCK_BYTES);
      if (allZero(block)) {
        if (captured.length - offset < 2 * BLOCK_BYTES || !allZero(captured.subarray(offset))) reject("invalid archive end blocks");
        if (local !== null) reject("orphan PAX entry header");
        ended = true;
        break;
      }
      if (++count > limits.entries) reject("entry count limit exceeded");
      const header = new GitArchiveHeader(block);
      if (header.size > limits.entryBytes) reject("header size limit exceeded");
      const size = header.metadata ? header.size : Number(local?.get("size") ?? global.get("size") ?? header.size);
      if (size > limits.entryBytes) reject("entry size limit exceeded");
      total += size;
      if (total > limits.totalBytes) reject("total payload limit exceeded");
      const start = offset + BLOCK_BYTES;
      const end = start + size;
      const next = start + Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
      if (next > captured.length) reject("truncated entry content");
      if (!allZero(captured.subarray(end, next))) reject("nonzero entry padding");
      const content = captured.subarray(start, end);
      if (header.metadata) {
        if (local !== null) reject("PAX entry header must precede an entry");
        const pax = new GitArchivePax(content);
        if (header.type === "g") global.merge(pax);
        else local = pax;
      } else {
        entries.push(new GitArchiveEntry(header, global, local, content));
        local = null;
      }
      offset = next;
    }
    if (!ended) reject("missing archive end blocks");
    new LogicalPathSet(entries.map((entry) => entry.logical), { allowDirectoryPrefixes: true });
    const files = new Set(entries.filter((entry) => !entry.directory).map((entry) => String(entry.logical)));
    for (const entry of entries) {
      const parents = [...entry.logical.segments];
      parents.pop();
      while (parents.length > 0) {
        if (files.has(parents.join("/"))) reject("file path prefixes another entry");
        parents.pop();
      }
    }
    return new GitPluginArchive(validatedArchive, entries, captured.length, global.get("comment") ?? null);
  }
  /** Caller owns an empty staging directory and its cleanup/transaction. */
  extractTo(packageRoot, { directoryAuthority = null } = {}) {
    const root = directoryAuthority ?? new RealDirectoryAuthority(packageRoot);
    if (!(root instanceof RealDirectoryAuthority) || root.directory !== path.resolve(packageRoot)) throw new TypeError("archive extraction authority must own the package root");
    if (root.entries().length !== 0) throw new Error("archive extraction requires an empty staging directory");
    const authorities = new Map([[root.directory, root]]);
    for (const entry of this.#entries) entry.extract(root, authorities);
    for (const authority of authorities.values()) authority.assertStable();
  }
}
