import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { MAX_IN_MEMORY_FILE_BYTES } from "./regular-file-snapshot.js";

// Match the existing inherited runtime-snapshot response frame ceiling.
const MAX_DELIVERY_BYTES = 32 * 1024 * 1024;

/** Immutable representation of already captured runtime bytes, without authority. */
export class RuntimePackageWireDelivery {
  constructor(serialized, revision) {
    if (typeof serialized !== "string" || typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
      throw new TypeError("Runtime wire delivery requires captured JSON and its revision");
    }
    const bytes = Buffer.from(serialized);
    if (bytes.length === 0 || bytes.length > MAX_IN_MEMORY_FILE_BYTES) throw new Error("Runtime delivery exceeds its existing decoded byte bound");
    this.schemaVersion = 1;
    this.encoding = "gzip-base64";
    this.revision = revision;
    this.decodedByteLength = bytes.length;
    this.digest = createHash("sha256").update(bytes).digest("hex");
    // Compress the captured envelope once for repeated inherited launches and
    // durable replay; smaller bytes also reduce fresh physical verification IO.
    this.body = gzipSync(bytes, { level: 6 }).toString("base64");
    Object.freeze(this);
  }
  compressedBytes() { return Buffer.from(this.body, "base64"); }
  toJSON() {
    if (this.decodedByteLength > MAX_DELIVERY_BYTES) throw new Error("Runtime delivery exceeds its existing decoded byte bound");
    return { schemaVersion: this.schemaVersion, encoding: this.encoding, revision: this.revision,
      decodedByteLength: this.decodedByteLength, digest: this.digest, body: this.body };
  }
}
