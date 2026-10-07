import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export class RegularFileSnapshot {
  #bytes;

  constructor({ filePath, bytes, mode = 0o644 }) {
    if (!path.isAbsolute(filePath) || !Buffer.isBuffer(bytes) || !Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
      throw new Error("regular file snapshot requires an absolute path and Buffer bytes");
    }
    this.filePath = filePath;
    this.#bytes = Buffer.from(bytes);
    this.digest = crypto.createHash("sha256").update(this.#bytes).digest("hex");
    this.byteLength = this.#bytes.length;
    this.mode = mode;
    Object.freeze(this);
  }

  get bytes() {
    return Buffer.from(this.#bytes);
  }

  text() {
    return this.#bytes.toString("utf8");
  }
}

export function captureRegularFile(filePath, { label, maxBytes, requireSingleLink = false, onRead = null }) {
  const resolved = path.resolve(filePath);
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error("regular file snapshot label is required");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("regular file snapshot maxBytes must be a non-negative safe integer");
  }
  if (typeof requireSingleLink !== "boolean") throw new Error("regular file snapshot requireSingleLink must be boolean");
  if (onRead !== null && typeof onRead !== "function") throw new Error("regular file snapshot onRead must be a function");
  let descriptor = null;
  try {
    const visible = fs.lstatSync(resolved);
    if (requireSingleLink && visible.nlink !== 1) throw new Error(`${label} must not be hard linked`);
    if (
      !visible.isFile()
      || visible.isSymbolicLink()
      || fs.realpathSync(resolved) !== resolved
      || visible.size > maxBytes
    ) {
      throw new Error(`${label} must be a regular real file up to ${maxBytes} bytes`);
    }
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFileIdentity(visible, opened) || opened.size > maxBytes
      || (requireSingleLink && opened.nlink !== 1)) {
      throw new Error(`${label} identity changed while opening`);
    }
    let bytes;
    try {
      bytes = fs.readFileSync(descriptor);
    } catch (error) {
      // The read may already have consumed bytes before throwing. Its bounded
      // attempt is the conservative charge when no returned length exists.
      onRead?.(maxBytes);
      throw error;
    }
    // Account irreversible I/O before post-read identity checks can refuse it.
    // Keep callback failures outside the read catch so they are charged once.
    onRead?.(bytes.length);
    const completed = fs.fstatSync(descriptor);
    if (!sameFileIdentity(opened, completed) || completed.size !== bytes.length || bytes.length > maxBytes
      || (requireSingleLink && completed.nlink !== 1)) {
      throw new Error(`${label} changed while reading`);
    }
    return new RegularFileSnapshot({ filePath: resolved, bytes, mode: completed.mode & 0o777 });
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}
