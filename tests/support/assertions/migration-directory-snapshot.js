import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FileIdentity, RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { captureRegularFile, MAX_IN_MEMORY_FILE_BYTES } from "../../../src/lib/regular-file-snapshot.js";
import { isNativePathWithin } from "../../../src/lib/portable-path.js";

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

class MigrationDirectoryEntry {
  constructor({ name, kind, identity, revision }) {
    if (!(identity instanceof FileIdentity)) throw new TypeError("directory observation requires exact file identity");
    this.name = name;
    this.kind = kind;
    this.dev = identity.dev.toString();
    this.ino = identity.ino.toString();
    this.revision = revision;
    Object.freeze(this);
  }

  toJSON() {
    return { name: this.name, kind: this.kind, dev: this.dev, ino: this.ino, revision: this.revision };
  }
}

/** Test-only physical evidence, independent of a Flow document's format. */
export class OfflineMigrationDirectorySnapshot {
  constructor({ root, relativePath, includedNames, entries }) {
    this.root = root;
    this.relativePath = relativePath;
    this.includedNames = includedNames === null ? null : Object.freeze([...includedNames].sort());
    this.entries = Object.freeze(entries);
    this.digest = hash(JSON.stringify(entries.map((entry) => entry.toJSON())));
    Object.freeze(this);
  }

  static capture(root, directory, { includedNames = null } = {}) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(directory);
    if (resolvedRoot === resolved || !isNativePathWithin(resolvedRoot, resolved)) {
      throw new Error(`migration directory observation is outside the repository: ${directory}`);
    }
    const authority = RealDirectoryAuthority.resolve(resolved);
    const filter = includedNames === null ? null : new Set(includedNames);
    const entries = authority.entries().filter((name) => filter === null || filter.has(name)).sort().map((name) => {
      const filePath = path.join(resolved, name);
      const stat = fs.lstatSync(filePath, { bigint: true });
      const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other";
      const snapshot = kind === "file" ? captureRegularFile(filePath, {
        directoryAuthority: authority, expectedIdentity: stat, maxBytes: MAX_IN_MEMORY_FILE_BYTES,
        label: "migration directory observation",
      }) : null;
      return new MigrationDirectoryEntry({ name, kind, identity: snapshot?.identity ?? new FileIdentity(stat),
        revision: snapshot?.digest ?? null });
    });
    authority.assertStable();
    return new OfflineMigrationDirectorySnapshot({ root: resolvedRoot,
      relativePath: path.relative(resolvedRoot, resolved).split(path.sep).join("/"),
      includedNames: filter === null ? null : [...filter], entries });
  }

  assertUnchanged({ identity = true, mutablePaths = [] } = {}) {
    const current = OfflineMigrationDirectorySnapshot.capture(this.root, path.join(this.root, this.relativePath), {
      includedNames: this.includedNames,
    });
    const mutable = new Set(mutablePaths);
    const project = (entry) => {
      if (mutable.has(path.posix.join(this.relativePath, entry.name))) return { name: entry.name, kind: entry.kind };
      return { name: entry.name, kind: entry.kind, revision: entry.revision,
        ...(identity ? { dev: entry.dev, ino: entry.ino } : {}) };
    };
    const expectedNames = new Set(this.entries.map((entry) => entry.name));
    const actual = current.entries.filter((entry) => expectedNames.has(entry.name)
      || !mutable.has(path.posix.join(this.relativePath, entry.name))).map(project);
    if (JSON.stringify(actual) !== JSON.stringify(this.entries.map(project))) {
      throw new Error(`migration closed-world snapshot changed after planning: ${this.relativePath}`);
    }
  }

  toJSON() {
    return { relativePath: this.relativePath, includedNames: this.includedNames,
      entries: this.entries.map((entry) => entry.toJSON()), digest: this.digest };
  }
}
