import path from "node:path";
import { AtomicFile } from "./atomic-file.js";
import { FileIdentity, sameFileIdentity } from "./file-identity.js";
import { LayoutFileContent } from "./layout-file-content.js";
import { LogicalRelativePath } from "./portable-path.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { MAX_IN_MEMORY_FILE_BYTES, RegularFileReadReceipt, captureRegularFile, visitRegularFileChunks } from "./regular-file-snapshot.js";
import { TemporaryPaths } from "./temporary-paths.js";
import { combineProcessExecutionFailures } from "./process-execution-completion.js";

const EVIDENCE_PREFIX = "sennel-layout-evidence-";

export class LayoutBeforeImageRequest {
  constructor(sourcePath, content) {
    this.sourcePath = LogicalRelativePath.from(sourcePath).toString();
    if (!(content instanceof LayoutFileContent)) throw new TypeError("before-image request requires completed source content evidence");
    this.content = content;
    Object.freeze(this);
  }
}

class LayoutBeforeImageReceipt {
  constructor({ sourcePath, name, identity, byteLength, digest }) {
    this.sourcePath = LogicalRelativePath.from(sourcePath).toString();
    if (typeof name !== "string" || !/^(?:0|[1-9][0-9]*)\.bytes(?![\s\S])/.test(name)
      || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_IN_MEMORY_FILE_BYTES
      || typeof digest !== "string" || !/^[0-9a-f]{64}(?![\s\S])/.test(digest)) throw new Error("layout before-image receipt is invalid");
    this.name = name;
    this.identity = identity instanceof FileIdentity ? identity : FileIdentity.fromStored(identity);
    this.byteLength = byteLength;
    this.digest = digest;
    Object.freeze(this);
  }

  static fromRead(sourcePath, name, receipt) {
    if (!(receipt instanceof RegularFileReadReceipt)) throw new TypeError("before-image publication requires its physical receipt");
    return new this({ sourcePath, name, identity: receipt.identity, byteLength: receipt.byteLength, digest: receipt.digest });
  }

  static fromJSON(value) {
    if (JSON.stringify(Object.keys(value ?? {}).sort()) !== JSON.stringify(["byteLength", "digest", "identity", "name", "sourcePath"])) {
      throw new Error("layout before-image receipt format is invalid");
    }
    return new this(value);
  }

  toJSON() { return { sourcePath: this.sourcePath, name: this.name, identity: this.identity.toJSON(), byteLength: this.byteLength, digest: this.digest }; }
}

/** Durable raw payloads, independent of both the source and staging cleanup. */
export class LayoutMigrationEvidence {
  constructor({ repositoryRoot, relativeDirectory, directoryIdentity, parentIdentity, files }) {
    this.repositoryRoot = path.resolve(repositoryRoot);
    this.relativeDirectory = LogicalRelativePath.from(relativeDirectory).toString();
    if (!/^\.tmp\/runtime\/migrate-layout\/sennel-layout-evidence-[A-Za-z0-9]{6}(?![\s\S])/.test(this.relativeDirectory)) {
      throw new Error("layout before-image directory is outside its migration scope");
    }
    this.directoryIdentity = directoryIdentity instanceof FileIdentity ? directoryIdentity : FileIdentity.fromStored(directoryIdentity);
    this.parentIdentity = parentIdentity instanceof FileIdentity ? parentIdentity : FileIdentity.fromStored(parentIdentity);
    if (!Array.isArray(files) || files.some(file => !(file instanceof LayoutBeforeImageReceipt))
      || new Set(files.map(file => file.name)).size !== files.length
      || new Set(files.map(file => file.sourcePath)).size !== files.length) throw new Error("layout before-images require unique typed receipts");
    this.files = Object.freeze([...files]);
    new TemporaryPaths(this.repositoryRoot).validate(this.directory);
    Object.freeze(this);
  }

  get directory() { return path.join(this.repositoryRoot, this.relativeDirectory); }

  static create(repositoryRoot, requests) {
    if (!Array.isArray(requests) || requests.some(request => !(request instanceof LayoutBeforeImageRequest))) {
      throw new TypeError("before-image creation requires captured source requests");
    }
    const paths = new TemporaryPaths(repositoryRoot);
    const directory = paths.create(paths.runtime("migrate-layout"), EVIDENCE_PREFIX);
    const authority = new RealDirectoryAuthority(directory);
    const files = [];
    const captured = () => new this({
      repositoryRoot, relativeDirectory: path.relative(repositoryRoot, directory).split(path.sep).join("/"),
      directoryIdentity: authority.identity, parentIdentity: authority.parentAuthority.identity, files,
    });
    try {
      for (const [index, request] of requests.entries()) {
        const name = `${index}.bytes`;
        const publication = request.content.writeBeforeImage(path.join(directory, name), { directoryAuthority: authority });
        files.push(LayoutBeforeImageReceipt.fromRead(request.sourcePath, name, publication.receipt));
      }
      const evidence = captured();
      evidence.assertIntact();
      return evidence;
    } catch (error) {
      // A created directory does not confer authority over foreign entries or
      // a payload whose publication response was lost. Retain both on refusal.
      try { captured().discardPrepared(); }
      catch (cleanupError) { throw combineProcessExecutionFailures(error, cleanupError); }
      throw error;
    }
  }

  static fromJSON(repositoryRoot, value) {
    if (JSON.stringify(Object.keys(value ?? {}).sort()) !== JSON.stringify(["directoryIdentity", "files", "parentIdentity", "path", "schemaVersion"])
      || value.schemaVersion !== 1 || !Array.isArray(value.files)) throw new Error("layout before-image store format is invalid");
    return new this({ repositoryRoot, relativeDirectory: value.path, directoryIdentity: value.directoryIdentity,
      parentIdentity: value.parentIdentity, files: value.files.map(file => LayoutBeforeImageReceipt.fromJSON(file)) });
  }

  matchesSource(entries) {
    const files = entries.filter(entry => entry.kind === "file");
    return files.length === this.files.length && files.every((file, index) => {
      const saved = this.files[index];
      return file.path === saved.sourcePath && file.hash === saved.digest && file.byteLength === saved.byteLength;
    });
  }

  receipt(sourcePath) {
    const logical = LogicalRelativePath.from(sourcePath).toString();
    const file = this.files.find(entry => entry.sourcePath === logical);
    if (file === undefined) throw new Error(`layout before-image is not registered: ${logical}`);
    return file;
  }

  readBytes(sourcePath) {
    const file = this.receipt(sourcePath);
    const authority = this.#authority(false);
    const captured = captureRegularFile(path.join(this.directory, file.name), {
      label: "layout raw before-image", maxBytes: file.byteLength, requireSingleLink: true,
      directoryAuthority: authority, expectedIdentity: file.identity,
    });
    this.#assertContent(file, captured);
    return captured.bytes;
  }

  #authority(allowMissing) {
    const authority = new RealDirectoryAuthority(this.directory);
    if (authority.parentAuthority.identity === null || !sameFileIdentity(authority.parentAuthority.identity, this.parentIdentity)) throw new Error("layout before-image parent generation changed");
    if (!authority.exists()) {
      if (allowMissing) return null;
      throw new Error("layout raw before-image directory is missing before completion");
    }
    if (!sameFileIdentity(authority.identity, this.directoryIdentity)) throw new Error("layout before-image directory generation changed");
    return authority;
  }

  #read(file, authority, allowMissing) {
    const receipt = visitRegularFileChunks(path.join(this.directory, file.name), {
      label: "layout raw before-image", maxBytes: file.byteLength, requireSingleLink: true,
      directoryAuthority: authority, expectedIdentity: file.identity, allowMissing, visit() {},
    });
    if (receipt === null) return null;
    this.#assertContent(file, receipt);
    return receipt;
  }

  #assertContent(file, receipt) {
    if (receipt.digest !== file.digest || receipt.byteLength !== file.byteLength) throw new Error("layout raw before-image bytes changed");
  }

  #observe(allowMissing) {
    const authority = this.#authority(allowMissing);
    if (authority === null) return null;
    const names = authority.entries();
    const expected = new Set(this.files.map(file => file.name));
    if (names.some(name => !expected.has(name)) || !allowMissing && names.length !== expected.size) {
      throw new Error("layout before-image directory has foreign or missing evidence");
    }
    for (const file of this.files) this.#read(file, authority, allowMissing);
    authority.assertStable();
    return authority;
  }

  assertIntact() { this.#observe(false); }

  discardPrepared() { this.#removeOwned(false); }

  /** Only a confirmed terminal cleanup cutoff can authorize missing payloads. */
  removeAfterCompletion() { this.#removeOwned(true); }

  #removeOwned(allowMissing) {
    const authority = this.#observe(allowMissing);
    if (authority === null) return;
    for (const file of this.files) {
      new AtomicFile(path.join(this.directory, file.name), { directoryAuthority: authority,
        commitGuard: () => this.#read(file, authority, false) }).remove({ streaming: true });
    }
    authority.removeEmpty();
  }

  toJSON() { return { schemaVersion: 1, path: this.relativeDirectory, directoryIdentity: this.directoryIdentity.toJSON(),
    parentIdentity: this.parentIdentity.toJSON(), files: this.files.map(file => file.toJSON()) }; }
}
