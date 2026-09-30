import path from "node:path";
import { captureRegularFile, RegularFileSnapshot } from "./regular-file-snapshot.js";
import { AgentFileInputFailure } from "./agent-file-input-failure.js";

/** A reference to exact caller-owned bytes, resolved only against an explicit root. */
export class AgentFileReference {
  constructor({ projectRoot, snapshot }) {
    if (!path.isAbsolute(projectRoot) || !(snapshot instanceof RegularFileSnapshot)) {
      throw new AgentFileInputFailure("Agent file reference requires an absolute project root and regular file snapshot");
    }
    const root = path.normalize(projectRoot);
    const relative = path.relative(root, snapshot.filePath);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
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

  static resolve({ projectRoot, filePath, label, maxBytes }) {
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)
      || typeof filePath !== "string" || !filePath) {
      throw new AgentFileInputFailure("Agent file reference requires an explicit absolute project root and file path");
    }
    const absolutePath = path.resolve(projectRoot, filePath);
    // Reject escape before touching the filesystem.
    const relative = path.relative(projectRoot, absolutePath);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new AgentFileInputFailure("Agent file reference must stay inside its project root");
    }
    try {
      return AgentFileReference.fromSnapshot({ projectRoot,
        snapshot: captureRegularFile(absolutePath, { label, maxBytes }) });
    } catch (cause) {
      throw new AgentFileInputFailure(`Unable to capture ${label}: ${cause.message}`, { cause });
    }
  }

  assertUnchanged({ label, maxBytes }) {
    let current;
    try {
      current = AgentFileReference.resolve({ projectRoot: this.projectRoot,
        filePath: this.absolutePath, label, maxBytes });
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
