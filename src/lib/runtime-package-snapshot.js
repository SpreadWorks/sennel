import fs from "node:fs";
import path from "node:path";
import { captureRegularFile, RegularFileSnapshot } from "./regular-file-snapshot.js";
import { RuntimeModuleFingerprint } from "../flow/lib/runtime-module-identity.js";
import { RuntimePackageLocation } from "./runtime-package-location.js";
import { RuntimePackageIdentity } from "./runtime-package-identity.js";

/** Captures once; execution and identity consume these same immutable bytes. */
export class RuntimePackageSnapshot {
  #files;
  constructor(root, delivery = null) {
    this.location = new RuntimePackageLocation(fs.realpathSync(root));
    this.root = this.location.root;
    if (delivery !== null) {
      if (!Array.isArray(delivery.resources)) throw new Error("RUNTIME_UNPROVEN: child resources are invalid");
      this.#files = new Map(delivery.resources.map(([key, encoded]) => {
        if (typeof key !== "string" || key !== this.location.key(path.join(this.root, key))
          || !this.location.owns(path.join(this.root, key)) || typeof encoded !== "string") {
          throw new Error("RUNTIME_UNPROVEN: child resource entry is invalid");
        }
        return [key, new RegularFileSnapshot({ filePath: path.join(this.root, key), bytes: Buffer.from(encoded, "base64") })];
      }));
      if (this.#files.size !== delivery.resources.length) throw new Error("RUNTIME_UNPROVEN: duplicate child resource");
    } else {
      const names = ["package.json"];
      const visit = (directory) => {
        for (const entry of fs.readdirSync(path.join(this.root, directory), { withFileTypes: true })) {
          if (["AGENTS.md", "CLAUDE.md"].includes(entry.name)) continue;
          const key = `${directory}/${entry.name}`;
          if (entry.isDirectory()) visit(key);
          else names.push(key);
        }
      };
      visit("src");
      names.sort();
      this.#files = new Map(names.map((key) => [key, captureRegularFile(path.join(this.root, key), {
        label: `runtime package ${key}`, maxBytes: 16 * 1024 * 1024,
      })]));
    }
    this.identity = new RuntimePackageIdentity({
      files: [...this.#files].map(([key, snapshot]) => RuntimeModuleFingerprint.fromSnapshot(key, snapshot)),
    });
    if (delivery !== null) {
      const expected = new RuntimePackageIdentity(delivery.identity);
      if (expected.revision !== this.identity.revision) throw new Error("RUNTIME_REVISION_MISMATCH: inherited runtime bytes differ from the parent proof");
    }
    Object.freeze(this);
  }

  static fromDelivery(delivery) {
    return new RuntimePackageSnapshot(delivery.root, delivery);
  }

  owns(filePath) {
    return this.location.owns(filePath);
  }

  read(filePath) {
    const key = this.location.key(filePath);
    const snapshot = this.#files.get(key);
    if (!snapshot) throw new Error(`RUNTIME_RESOURCE_UNAVAILABLE: ${key} is outside the fixed package set`);
    return snapshot;
  }

  resourcePayload() {
    return [...this.#files].map(([key, snapshot]) => [key, snapshot.bytes.toString("base64")]);
  }
}
