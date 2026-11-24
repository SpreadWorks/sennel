import crypto from "node:crypto";
import { LogicalRelativePath, LogicalPathSet } from "./portable-path.js";

const REVISION = 2;
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const order = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export class FileTreeImageRevisionError extends Error {
  constructor(revision) {
    super(`File tree image revision ${revision} requires explicit recovery with its original producer; preserve the original journal and backup before upgrading.`);
    this.name = "FileTreeImageRevisionError";
    this.code = "FILE_TREE_IMAGE_REVISION_UNSUPPORTED";
    this.revision = revision;
    this.requiredRevision = REVISION;
  }
}

export class DirectoryTreeEntry {
  constructor(relativePath) {
    this.path = relativePath === "" ? "" : new LogicalRelativePath(relativePath, "tree directory").toString();
    Object.freeze(this);
  }
  toJSON() { return { kind: "directory", path: this.path }; }
}

export class FileTreeEntry {
  #bytes;
  constructor(relativePath, bytes) {
    this.path = new LogicalRelativePath(relativePath, "tree file").toString();
    if (!Buffer.isBuffer(bytes)) throw new TypeError("tree file bytes must be a Buffer");
    this.#bytes = Buffer.from(bytes);
    this.byteLength = this.#bytes.length;
    this.hash = hash(this.#bytes);
    Object.freeze(this);
  }
  get bytes() { return Buffer.from(this.#bytes); }
  equals(other) { return other instanceof FileTreeEntry && this.#bytes.equals(other.#bytes); }
  toJSON() {
    return { kind: "file", path: this.path, byteLength: this.byteLength, hash: this.hash, bytes: this.#bytes.toString("base64") };
  }
}

/** Immutable, host-independent transaction image. Permissions are not identity. */
export class FileTreeImage {
  constructor(entries) {
    if (!Array.isArray(entries) || entries.some((entry) => !(entry instanceof DirectoryTreeEntry) && !(entry instanceof FileTreeEntry))) {
      throw new TypeError("file tree image requires typed directory and file entries");
    }
    this.entries = Object.freeze([...entries].sort((left, right) => order(left.path, right.path)));
    new LogicalPathSet(this.entries.filter((entry) => entry.path !== "").map((entry) => entry.path), { allowDirectoryPrefixes: true });
    const directories = new Set(this.entries.filter((entry) => entry instanceof DirectoryTreeEntry).map((entry) => entry.path));
    if (!directories.has("") || this.entries.filter((entry) => entry.path === "").length !== 1) {
      throw new Error("file tree image requires exactly one root directory");
    }
    for (const entry of this.entries) {
      if (entry.path === "") continue;
      const separator = entry.path.lastIndexOf("/");
      const parent = separator === -1 ? "" : entry.path.slice(0, separator);
      if (!directories.has(parent)) throw new Error(`file tree image directory ancestry is incomplete: ${entry.path}`);
    }
    this.hash = hash(Buffer.from(JSON.stringify(this.#payload())));
    Object.freeze(this);
  }
  #payload() { return { schemaRevision: REVISION, entries: this.entries.map((entry) => entry.toJSON()) }; }
  toJSON() { return { ...this.#payload(), hash: this.hash }; }
  assertFileTargets(values) {
    const targets = new LogicalPathSet(values).toStrings();
    new LogicalPathSet([...new Set([...this.entries.map((entry) => entry.path).filter(Boolean), ...targets])], { allowDirectoryPrefixes: true });
    new LogicalPathSet([...new Set([...this.entries.filter((entry) => entry instanceof FileTreeEntry).map((entry) => entry.path), ...targets])]);
    const directories = new Set(this.entries.filter((entry) => entry instanceof DirectoryTreeEntry).map((entry) => entry.path));
    if (targets.some((target) => directories.has(target))) throw new Error("file tree publication target is an existing directory");
  }
  static fromStored(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("file tree image must be an object");
    // Old mode-bearing images are refused, never interpreted as new bytes proof.
    if (value.schemaRevision !== REVISION) throw new FileTreeImageRevisionError(value.schemaRevision ?? 1);
    if (Object.keys(value).sort().join(",") !== "entries,hash,schemaRevision" || !Array.isArray(value.entries)) {
      throw new Error("file tree image fields are invalid");
    }
    const entries = value.entries.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("file tree image entry is invalid");
      if (entry.kind === "directory" && Object.keys(entry).sort().join(",") === "kind,path") return new DirectoryTreeEntry(entry.path);
      if (entry.kind !== "file" || Object.keys(entry).sort().join(",") !== "byteLength,bytes,hash,kind,path"
        || typeof entry.bytes !== "string") throw new Error("file tree image entry fields are invalid");
      const bytes = Buffer.from(entry.bytes, "base64");
      if (bytes.toString("base64") !== entry.bytes) throw new Error("file tree image bytes are not canonical base64");
      const image = new FileTreeEntry(entry.path, bytes);
      if (entry.hash !== image.hash || entry.byteLength !== image.byteLength) throw new Error("file tree image bytes do not match their identity");
      return image;
    });
    const result = new FileTreeImage(entries);
    if (value.hash !== result.hash) throw new Error("file tree image hash is invalid");
    return result;
  }
}
