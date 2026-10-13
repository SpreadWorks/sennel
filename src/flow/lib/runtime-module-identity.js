import { captureRegularFile } from "../../lib/regular-file-snapshot.js";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_MODULE_BYTES = 2 * 1024 * 1024;

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
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

  static fromSnapshot(key, snapshot) {
    return new RuntimeModuleFingerprint({ key, digest: snapshot.digest, bytes: snapshot.byteLength });
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
    const snapshot = captureRegularFile(fileURLToPath(this.moduleUrl), {
      label: this.key,
      maxBytes: this.maxBytes,
    });
    return RuntimeModuleFingerprint.fromSnapshot(this.key, snapshot);
  }
}
