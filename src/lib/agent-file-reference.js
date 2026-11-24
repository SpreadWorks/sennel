import { isNativePathWithin } from "./portable-path.js";
import path from "node:path";
import { TemporaryPaths } from "./temporary-paths.js";
import { AtomicFile } from "./atomic-file.js";
import { captureRegularFile, RegularFileSnapshot } from "./regular-file-snapshot.js";
import { AgentFileInputFailure } from "./agent-file-input-failure.js";

/** Owns the exact, temporary input bytes for a provider file reference. */
export class TemporaryAgentFileInput {
  constructor({ directory, ownership, logicalName, reference, label = logicalName }) {
    this.directory = directory;
    this.ownership = ownership;
    this.logicalName = logicalName;
    this.reference = reference;
    this.label = label;
    this.filePath = reference.absolutePath;
    Object.freeze(this);
  }

  static create({ projectRoot, runtimeRoot, text, logicalName, label = logicalName, prefix = "input-" }) {
    const bytes = Buffer.from(text, "utf8");
    let directory = null;
    let ownership = null;
    try {
      const temporaryPaths = new TemporaryPaths(projectRoot);
      ownership = temporaryPaths.createOwnedDirectory(runtimeRoot, prefix);
      directory = ownership.path;
      const filePath = path.join(directory, logicalName);
      new AtomicFile(filePath, { directoryAuthority: ownership.authority }).write(bytes);
      const expected = new RegularFileSnapshot({ filePath, bytes });
      const reference = AgentFileReference.resolve({ projectRoot: temporaryPaths.root, filePath,
        label, maxBytes: bytes.length, directoryAuthority: ownership.authority });
      if (reference.digest !== expected.digest || reference.byteLength !== expected.byteLength) {
        throw new AgentFileInputFailure("Temporary input bytes differ from the caller-owned exact input", { reference: expected });
      }
      return new this({ directory, ownership, logicalName, reference, label });
    } catch (error) {
      if (ownership && !error.cleanupFailed) {
        try { ownership.cleanup(); }
        catch (cleanupError) { throw new AgentFileInputFailure(`Unable to materialize ${label}: ${error.message}`, {
          cause: new AggregateError([error, cleanupError], "temporary agent input and cleanup both failed", { cause: error }),
        }); }
      }
      if (error instanceof AgentFileInputFailure) throw error;
      throw new AgentFileInputFailure(`Unable to materialize ${label}: ${error.message}`, { cause: error });
    }
  }

  assertUnchanged() {
    return this.reference.assertUnchanged({ label: this.label, maxBytes: this.reference.byteLength,
      directoryAuthority: this.ownership.authority });
  }

  dispose() { this.ownership.cleanup(); }
}

/** A reference to exact caller-owned bytes, resolved only against an explicit root. */
export class AgentFileReference {
  constructor({ projectRoot, snapshot }) {
    if (!path.isAbsolute(projectRoot) || !(snapshot instanceof RegularFileSnapshot)) {
      throw new AgentFileInputFailure("Agent file reference requires an absolute project root and regular file snapshot");
    }
    const root = path.normalize(projectRoot);
    const relative = path.relative(root, snapshot.filePath);
    if (relative === "" || !isNativePathWithin(root, snapshot.filePath)) {
      throw new AgentFileInputFailure("Agent file reference must stay inside its project root");
    }
    this.projectRoot = root;
    this.absolutePath = snapshot.filePath;
    this.projectRelativePath = relative;
    this.digest = snapshot.digest;
    this.byteLength = snapshot.byteLength;
    Object.freeze(this);
  }

  static fromSnapshot({ projectRoot, snapshot }) {
    return new AgentFileReference({ projectRoot, snapshot });
  }

  static resolve({ projectRoot, filePath, label, maxBytes, directoryAuthority = null }) {
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)
      || typeof filePath !== "string" || !filePath) {
      throw new AgentFileInputFailure("Agent file reference requires an explicit absolute project root and file path");
    }
    const absolutePath = path.resolve(projectRoot, filePath);
    // Reject escape before touching the filesystem.
    const relative = path.relative(projectRoot, absolutePath);
    if (relative === "" || !isNativePathWithin(projectRoot, absolutePath)) {
      throw new AgentFileInputFailure("Agent file reference must stay inside its project root");
    }
    try {
      return AgentFileReference.fromSnapshot({ projectRoot,
        snapshot: captureRegularFile(absolutePath, { label, maxBytes, directoryAuthority }) });
    } catch (cause) {
      throw new AgentFileInputFailure(`Unable to capture ${label}: ${cause.message}`, { cause });
    }
  }

  assertUnchanged({ label, maxBytes, directoryAuthority = null }) {
    let current;
    try {
      current = AgentFileReference.resolve({ projectRoot: this.projectRoot,
        filePath: this.absolutePath, label, maxBytes, directoryAuthority });
    } catch (cause) {
      throw new AgentFileInputFailure(`Referenced input is unavailable: ${cause.message}`, { cause, reference: this });
    }
    if (current.digest !== this.digest || current.byteLength !== this.byteLength) {
      throw new AgentFileInputFailure("Referenced input bytes changed after capture", { reference: this });
    }
    return this;
  }

  toPromptText() {
    return [
      `Project root: ${this.projectRoot}`,
      `Absolute file path: ${this.absolutePath}`,
      `Project-root-relative file path: ${this.projectRelativePath}`,
      "Both paths identify the same file. Prefer the absolute path exactly as written.",
      "Resolve the relative path only against the project root above, never against your current working directory. Do not rewrite the absolute path as a cwd-relative path.",
      `SHA-256 of exact UTF-8 bytes: ${this.digest}`,
      `Byte length: ${this.byteLength}`,
    ].join("\n");
  }
}
