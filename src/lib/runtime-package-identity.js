import crypto from "node:crypto";
import { RuntimeModuleFingerprint } from "../flow/lib/runtime-module-identity.js";

/** Ordered, location-independent identity of the bytes available to a runtime. */
export class RuntimePackageIdentity {
  constructor({ files, revision = null }) {
    if (!Array.isArray(files) || files.length === 0) throw new Error("runtime package files are required");
    this.files = Object.freeze(files.map((file) => new RuntimeModuleFingerprint(file)));
    const hash = crypto.createHash("sha256");
    hash.update("runtime-package\0");
    let previous = "";
    for (const file of this.files) {
      if (file.key <= previous) throw new Error("runtime package files must be unique and sorted");
      previous = file.key;
      file.update(hash);
    }
    this.revision = hash.digest("hex");
    if (revision !== null && revision !== this.revision) throw new Error("runtime package revision does not match its files");
    Object.freeze(this);
  }

  toJSON() {
    return { revision: this.revision, files: this.files.map(({ key, digest, bytes }) => ({ key, digest, bytes })) };
  }
}
