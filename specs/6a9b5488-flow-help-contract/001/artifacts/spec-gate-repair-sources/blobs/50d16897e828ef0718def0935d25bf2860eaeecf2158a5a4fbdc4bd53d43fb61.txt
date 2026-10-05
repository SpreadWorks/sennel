import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_MODULE_BYTES = 2 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export class RuntimeModuleFingerprint {
  constructor({ key, digest, bytes }) {
    this.key = requireString(key, "runtime module fingerprint key");
    this.digest = requireString(digest, "runtime module fingerprint digest");
    if (!/^[a-f0-9]{64}$/.test(this.digest)) {
      throw new Error("runtime module fingerprint digest must be a SHA-256 digest");
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("runtime module fingerprint bytes must be a non-negative safe integer");
    }
    this.bytes = bytes;
    Object.freeze(this);
  }

  update(hash) {
    hash.update("runtime-module\0");
    hash.update(this.key);
    hash.update("\0");
    hash.update(this.digest);
    hash.update("\0");
    hash.update(String(this.bytes));
    hash.update("\0");
  }
}

export class RuntimeModuleIdentity {
  constructor({ key, moduleUrl, maxBytes = DEFAULT_MAX_MODULE_BYTES }) {
    this.key = requireString(key, "runtime module identity key");
    if (!(moduleUrl instanceof URL) || moduleUrl.protocol !== "file:") {
      throw new Error("runtime module identity requires a file URL");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("runtime module identity maxBytes must be a positive safe integer");
    }
    this.moduleUrl = moduleUrl;
    this.maxBytes = maxBytes;
    Object.freeze(this);
  }

  fingerprint() {
    const modulePath = fileURLToPath(this.moduleUrl);
    const stat = fs.statSync(modulePath);
    if (!stat.isFile()) {
      throw new Error(`runtime module identity target is not a file: ${this.key}`);
    }
    if (stat.size > this.maxBytes) {
      throw new Error(`runtime module identity exceeds ${this.maxBytes} bytes: ${this.key}`);
    }

    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    const descriptor = fs.openSync(modulePath, "r");
    let bytes = 0;
    try {
      while (bytes < stat.size) {
        const length = Math.min(buffer.length, stat.size - bytes);
        const read = fs.readSync(descriptor, buffer, 0, length, bytes);
        if (read === 0) break;
        hash.update(buffer.subarray(0, read));
        bytes += read;
      }
    } finally {
      fs.closeSync(descriptor);
    }
    if (bytes !== stat.size) {
      throw new Error(`runtime module identity changed during read: ${this.key}`);
    }
    return new RuntimeModuleFingerprint({
      key: this.key,
      digest: hash.digest("hex"),
      bytes,
    });
  }
}
