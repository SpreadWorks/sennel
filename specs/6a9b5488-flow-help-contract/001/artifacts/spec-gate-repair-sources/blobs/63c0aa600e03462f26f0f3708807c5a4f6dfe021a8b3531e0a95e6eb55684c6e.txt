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

export function captureRegularFile(filePath, { label, maxBytes }) {
  const resolved = path.resolve(filePath);
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error("regular file snapshot label is required");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("regular file snapshot maxBytes must be a non-negative safe integer");
  }
  let descriptor = null;
  try {
    const visible = fs.lstatSync(resolved);
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
    if (!opened.isFile() || !sameFileIdentity(visible, opened) || opened.size > maxBytes) {
      throw new Error(`${label} identity changed while opening`);
    }
    const bytes = fs.readFileSync(descriptor);
    const completed = fs.fstatSync(descriptor);
    if (!sameFileIdentity(opened, completed) || completed.size !== bytes.length || bytes.length > maxBytes) {
      throw new Error(`${label} changed while reading`);
    }
    return new RegularFileSnapshot({ filePath: resolved, bytes, mode: completed.mode & 0o777 });
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}
