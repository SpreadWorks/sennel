import { compareText } from "./text-order.js";
import { FileIdentity } from "../../lib/file-identity.js";
import fs from "node:fs";
import path from "node:path";
import { runGit } from "../../lib/git-command-execution.js";
import { GitRepositoryPolicy } from "../../lib/git-repository-environment.js";
import { assertOk } from "../../lib/process.js";
import { RealDirectoryAuthority } from "../../lib/real-directory-authority.js";
import { FilePermissionHint, captureRegularFile, visitRegularFileChunks } from "../../lib/regular-file-snapshot.js";
import { LogicalRelativePath, LogicalPathSet } from "../../lib/portable-path.js";
import { SourceWorkingFile, WorkerArtifactRepositoryEntry } from "./source-working-file.js";

/** External acquisition of the pure source representation and optional raw before-image. */
export class SourceWorkingFileCapture {
  constructor(working, snapshot, permissionHint = null) {
    if (permissionHint !== null && (!(permissionHint instanceof FilePermissionHint) || working.kind !== "file")) {
      throw new TypeError("source permission metadata requires a regular-file observation");
    }
    this.working = working;
    this.snapshot = snapshot;
    this.permissionHint = permissionHint;
    Object.freeze(this);
  }
  observeGitMode({ platform = process.platform, observeNative }) {
    if (this.working.kind !== "file" || this.permissionHint === null) throw new TypeError("Git mode requires captured regular-file permission metadata");
    // Git's POSIX canon_mode uses the owner execute bit. Windows Git owns its
    // native executable semantics; Node's writable permission hint cannot.
    if (platform === "win32") return observeNative();
    return this.permissionHint.mode & 0o100 ? "100755" : "100644";
  }
  static projectGitPaths(root, physicalEntries, indexPaths, { maxBytes } = {}) {
    new LogicalPathSet(physicalEntries.map((entry) => entry.path), { allowDirectoryPrefixes: true });
    new LogicalPathSet(physicalEntries.filter((entry) => entry.kind === "file").map((entry) => entry.path));
    const indexed = new LogicalPathSet(indexPaths);
    const projected = new Map();
    const ordered = [...physicalEntries].sort((left, right) => left.path.split("/").length - right.path.split("/").length
      || compareText(left.path, right.path));
    for (const entry of ordered) {
      const native = entry.workingPath;
      const parent = projected.get(path.posix.dirname(native));
      let logical = parent === undefined ? native : path.posix.join(parent.path, path.posix.basename(native));
      const preferred = indexed.spellingFor(native);
      if (preferred !== null) logical = preferred;
      if (logical !== native) {
        // The inventory supplies native spelling; Node realpath preserves the
        // requested spelling. Only exact no-follow physical identity proves
        // that the host treats both names as this same source entry.
        const observed = this.capture(root, logical, { maxBytes });
        if (!entry.working.sameContent(observed.working)
          || entry.working.generation === null || !entry.working.generation.equals(observed.working.generation)) {
          new LogicalPathSet([native, logical]);
        }
      }
      projected.set(native, new WorkerArtifactRepositoryEntry({ path: logical, workingPath: native, working: entry.working }));
    }
    const entries = [...projected.values()].sort((left, right) => compareText(left.path, right.path));
    new LogicalPathSet(entries.map((entry) => entry.path), { allowDirectoryPrefixes: true });
    return entries;
  }
  static capture(root, relativePath, { maxBytes, budget = null, retainBytes = false, requireExisting = false } = {}) {
    const logical = LogicalRelativePath.from(relativePath, "source working path");
    const absolute = path.join(root, ...logical.segments);
    let parent;
    try { parent = RealDirectoryAuthority.resolve(path.dirname(absolute), { allowMissing: true }); }
    catch (cause) {
      if (!RealDirectoryAuthority.isAuthorityFailure(cause)) throw cause;
      const blocker = path.relative(root, cause.lockPath).split(path.sep).join("/");
      if (!logical.value.startsWith(`${blocker}/`) || blocker === "") throw cause;
      // A directory replaced by a regular file makes its former children
      // absent. Reuse the full no-follow capture to prove that file; never
      // infer absence from an OS error or accept a symlink-blocked ancestor.
      const captured = this.capture(root, blocker, { maxBytes });
      if (captured.working.kind !== "file") throw cause;
      return this.#missing(relativePath, requireExisting);
    }
    const stat = fs.lstatSync(absolute, { bigint: true, throwIfNoEntry: false });
    // Non-file observations do not enter the regular-file reader's parent check.
    if (stat === undefined || !stat.isFile()) parent.assertStable();
    if (stat === undefined) return this.#missing(relativePath, requireExisting);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new TypeError(`source path has an unsupported native type: ${relativePath}`);
    if (stat.isDirectory()) return new this(new SourceWorkingFile({ kind: "directory", generation: FileIdentity.capture(stat) }), null);
    const options = { label: `source working bytes ${relativePath}`, maxBytes,
      directoryAuthority: parent, requireSingleLink: true, expectedIdentity: stat };
    const snapshot = retainBytes ? captureRegularFile(absolute, options)
      : visitRegularFileChunks(absolute, { ...options, visit() {} });
    if (budget !== null) {
      budget.bytes += snapshot.byteLength;
      if (budget.bytes > budget.limit) throw new Error(`source raw content exceeds ${budget.limit} bytes`);
    }
    return new this(new SourceWorkingFile({ kind: "file", digest: snapshot.digest, generation: FileIdentity.capture(snapshot.identity) }), retainBytes ? snapshot : null, snapshot.permissionHint);
  }

  static #missing(relativePath, requireExisting) {
    if (requireExisting) throw new Error(`source inventory entry disappeared before capture: ${relativePath}`);
    return new this(new SourceWorkingFile({ kind: "missing" }), null);
  }
}

/** Observe fresh file metadata at this boundary, with native Windows Git semantics. */
export function observeSourceUntrackedMode(root, relativePath, { filemode, maxBytes, maxBuffer = 64 * 1024 * 1024 }) {
  if (!filemode) return "100644";
  // The earlier inventory may precede other native operations. Never borrow
  // its permission metadata or infer stability across those operations.
  const captured = SourceWorkingFileCapture.capture(root, relativePath, { maxBytes, requireExisting: true });
  return captured.observeGitMode({ observeNative: () => {
    // /dev/null is Git no-index syntax on every supported OS.
    const result = runGit(["diff", "--no-index", "--raw", "--no-abbrev", "--no-ext-diff", "--no-textconv", "--", "/dev/null", path.join(root, relativePath)], {
      cwd: root, gitPolicy: new GitRepositoryPolicy({ repositoryRoot: root, readOnly: true }), maxBuffer,
    });
    if (result.status !== 0 && result.status !== 1) assertOk(result, "failed to observe source Git mode");
    const match = /^:000000 (100644|100755) /.exec(result.stdout);
    if (match === null) throw new Error(`Git did not observe the source mode of ${relativePath}`);
    return match[1];
  } });
}

function readSelectedSourceGitRepository(root, repositoryRoot, args, maxBuffer) {
  const directory = new RealDirectoryAuthority(path.resolve(root));
  directory.assertStable();
  const marker = fs.lstatSync(path.join(directory.directory, ".git"), { bigint: true, throwIfNoEntry: false });
  if (marker === undefined) return null;
  if (!marker.isDirectory() && !marker.isFile()) throw new TypeError("selected source .git boundary has an unsupported native type");
  const result = runGit(["rev-parse", "--show-toplevel", ...args], { cwd: root,
    gitPolicy: new GitRepositoryPolicy({ repositoryRoot, readOnly: true }), maxBuffer });
  assertOk(result, "failed to resolve selected source Git repository");
  return result.stdout;
}

function assertSelectedSourceGitTopLevel(root, topLevel) {
  if (Buffer.byteLength(topLevel, "utf8") + 1 > 1024 * 1024) throw new Error("selected source Git root exceeds its output bound");
  if (fs.realpathSync(topLevel) !== fs.realpathSync(root)) throw new Error("source Git boundary differs from its selected root");
}

/** One fresh native observation of the selected repository and its named controls. */
export class SelectedSourceGitRepository {
  constructor(root, output) {
    const records = output.trim().split("\n");
    if (records.length !== 6) throw new Error("Git physical directory evidence is invalid");
    assertSelectedSourceGitTopLevel(root, records.shift());
    this.physicalPaths = Object.freeze(records);
    Object.freeze(this);
  }

  static read(root, { repositoryRoot = root, maxBuffer = 1024 * 1024 } = {}) {
    const output = readSelectedSourceGitRepository(root, repositoryRoot, ["--absolute-git-dir", "--git-common-dir",
      "--git-path", "info/sparse-checkout", "--git-path", "HEAD", "--git-path", "index"], maxBuffer);
    return output === null ? null : new this(root, output);
  }
}

/** Select Git only from the requested physical repository boundary, never by ancestor discovery. */
export function selectedSourceGitRoot(root, repositoryRoot = root) {
  const output = readSelectedSourceGitRepository(root, repositoryRoot, [], 1024 * 1024);
  if (output === null) return false;
  assertSelectedSourceGitTopLevel(root, output.trim());
  return true;
}
