import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TemporaryPaths } from "../../../src/lib/temporary-paths.js";
import { AtomicFile } from "../../../src/lib/atomic-file.js";

// Observe real file I/O without replacing Git or the fingerprint algorithm.
export class GitOutputObserver {
  constructor(t, root) {
    const outputParent = TemporaryPaths.runtimePath(root, "final-regression-git");
    this.directories = [];
    this.existingBeforeWrite = [];
    this.readDescriptors = [];
    this.publications = [];
    const publications = this.publications;
    const directories = this.directories;
    const publish = AtomicFile.prototype.publishStage;
    t.mock.method(AtomicFile.prototype, "publishStage", function (...args) {
      const publication = publish.apply(this, args);
      if (directories.includes(path.dirname(publication.path))) publications.push(publication);
      return publication;
    });
    this.peakBytes = 0;
    const create = fs.mkdtempSync;
    const open = fs.openSync;
    const close = fs.closeSync;
    const writes = new Set();
    t.mock.method(fs, "mkdtempSync", (...args) => {
      const directory = create(...args);
      if (path.dirname(directory) === outputParent) this.directories.push(directory);
      return directory;
    });
    t.mock.method(fs, "openSync", (file, flags, ...args) => {
      const owned = this.directories.includes(path.dirname(file));
      if (owned && (flags === "wx" || flags === "wx+")) {
        this.existingBeforeWrite.push(fs.readdirSync(path.dirname(file)));
      }
      const descriptor = open(file, flags, ...args);
      if (owned && (flags === "wx" || flags === "wx+")) writes.add(descriptor);
      if (owned && flags === "r") this.readDescriptors.push(descriptor);
      return descriptor;
    });
    t.mock.method(fs, "closeSync", (descriptor) => {
      close(descriptor);
      if (writes.delete(descriptor)) {
        const bytes = this.directories.reduce((sum, directory) => sum
          + fs.readdirSync(directory).reduce((total, name) => total
            + fs.statSync(path.join(directory, name)).size, 0), 0);
        this.peakBytes = Math.max(this.peakBytes, bytes);
      }
    });
  }

  assertRemoved() {
    assert.equal(this.directories.length, 1, "One calculation owns one temporary directory");
    assert.equal(fs.existsSync(this.directories[0]), false);
  }
}
