import { workerArtifactDigest } from "./worker-artifact-input-format.js";
import { exactKeys } from "./source-effect-fields.js";
import path from "node:path";
import { AtomicFile } from "../../lib/atomic-file.js";
import { TemporaryPaths } from "../../lib/temporary-paths.js";
import { GitOwnedStagePolicy } from "../../lib/git-repository-environment.js";
import { runGit } from "../../lib/git-command-execution.js";
import { assertOk } from "../../lib/process.js";
import { ProcessExecutionControlFailure } from "../../lib/process-execution-values.js";
import { retainExecutionCompletion, completeManagedOperationSync } from "../../lib/process-execution-completion.js";
import { captureRegularFile } from "../../lib/regular-file-snapshot.js";
import { SourceGitState } from "./source-working-file.js";

/** Evidence that Git actually materialized every raw before-image under its source policy. */
export class SourceRestoreCapability {
  constructor({ version = 1, snapshotDigest, entriesDigest, gitState }) {
    if (version !== 1 || typeof snapshotDigest !== "string" || typeof entriesDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(snapshotDigest) || !/^[a-f0-9]{64}$/.test(entriesDigest)) throw new TypeError("source restore capability is invalid");
    this.version = version; this.snapshotDigest = snapshotDigest; this.entriesDigest = entriesDigest;
    this.gitState = gitState === null ? null : gitState instanceof SourceGitState ? gitState : SourceGitState.fromStored(gitState);
    Object.freeze(this);
  }
  static fromStored(value) { exactKeys(value, ["version", "snapshotDigest", "entriesDigest", "gitState"], "source restore capability"); return new this(value); }
  toJSON() { return { version: this.version, snapshotDigest: this.snapshotDigest, entriesDigest: this.entriesDigest, gitState: this.gitState?.toJSON() ?? null }; }
}

/** A disposable independent repository. It never borrows the source index or object database. */
export class SourceGitRestoreStage {
  #temporary;
  #owned;
  #policy;
  #files = new Map();
  #retained = false;
  constructor({ root, gitState, entries, maxBytes, targetWorkingPaths = new Map() }) {
    if (!(gitState instanceof SourceGitState)) throw new TypeError("Git restore stage requires the captured source policy");
    this.#temporary = new TemporaryPaths(root);
    this.#owned = this.#temporary.createOwnedDirectory(this.#temporary.runtime("source-restore"), "git-");
    this.maxBytes = maxBytes;
    try {
      const directory = this.#owned.path;
      const workTree = this.#owned.authority.descendant(path.join(directory, "work"), { create: true }).directory;
      const templates = this.#owned.authority.descendant(path.join(directory, "templates"), { create: true }).directory;
      const emptyAttributes = path.join(directory, "attributes");
      new AtomicFile(emptyAttributes).write(Buffer.alloc(0));
      this.#policy = new GitOwnedStagePolicy({ repositoryRoot: directory, workTree,
        gitDir: path.join(directory, "repository.git"), indexFile: path.join(directory, "index"),
        templateDirectory: templates, attributesFile: emptyAttributes, restore: true });
      this.#run(["init", "--quiet", `--template=${templates}`]);
      this.#owned.authority.descendant(path.join(directory, "repository.git", "info"), { create: true });
      new AtomicFile(path.join(directory, "repository.git", "info", "attributes"))
        .write("* -text -filter -ident -working-tree-encoding\n");
      this.#run(["config", "core.filemode", String(gitState.filemode)]);
      this.#run(["config", "core.symlinks", "false"]);
      let ordinal = 0;
      const objects = new Map();
      const itemPaths = new Map();
      const rawDigests = new Map();
      let indexArguments = [];
      const flushIndex = () => { if (indexArguments.length > 0) { this.#run(["update-index", "--add", ...indexArguments]); indexArguments = []; } };
      for (const entry of entries) {
        if (entry.entry.kind !== "file") continue;
        const bytes = entry.bytes;
        const rawDigest = workerArtifactDigest(bytes);
        let oid = objects.get(rawDigest);
        if (oid === undefined) {
          oid = this.#run(["hash-object", "-w", "--no-filters", "--stdin"], bytes).trim();
          objects.set(rawDigest, oid);
        }
        const item = `item-${ordinal++}/${path.posix.basename(targetWorkingPaths.get(entry.entry.path) ?? entry.entry.workingPath)}`;
        const mode = entry.entry.git?.materializationMode ?? "100644";
        indexArguments.push("--cacheinfo", mode, oid, item);
        if (indexArguments.reduce((length, value) => length + value.length + 3, 0) >= 20_000) flushIndex();
        itemPaths.set(entry.entry.path, item);
        rawDigests.set(entry.entry.path, rawDigest);
      }
      flushIndex();
      this.#run(["checkout-index", "--all", `--prefix=${workTree}${path.sep}`]);
      for (const [relativePath, item] of itemPaths) {
        const snapshot = captureRegularFile(path.join(workTree, item), { label: "Git-produced source restore", maxBytes, requireSingleLink: true });
        if (snapshot.digest !== rawDigests.get(relativePath)) throw new Error(`Git materialization changed raw source bytes: ${relativePath}`);
        this.#files.set(relativePath, snapshot);
      }
      // status reads worktree modes using the captured effective core.filemode.
      // Empty status proves the materialized modes, not merely private index data.
      this.#run(["update-index", "--refresh"]);
      const status = this.#run(["diff-files", "--raw", "--no-ext-diff", "--no-textconv"]);
      if (status !== "") throw new Error("Git materialization worktree mode/readback differs from its private index");
      this.#owned.authority.assertStable();
    } catch (cause) {
      if (cause instanceof ProcessExecutionControlFailure) {
        this.#retained = true;
        const retained = cause.withCause(new AggregateError([cause], `source Git restore stage retained at ${this.#owned.path}`));
        retainExecutionCompletion(retained, cause);
        throw retained;
      }
      completeManagedOperationSync(() => { throw cause; }, () => this.dispose());
    }
  }
  #run(args, input = undefined) {
    this.#owned.authority.assertStable();
    const result = runGit(args, { cwd: this.#policy.workTree, gitPolicy: this.#policy,
      input, maxBuffer: this.maxBytes });
    assertOk(result, "owned source restore Git command failed");
    return result.stdout;
  }
  snapshot(relativePath) {
    this.#owned.authority.assertStable();
    const snapshot = this.#files.get(relativePath);
    if (snapshot === undefined) throw new Error(`Git restore lacks ${relativePath}`);
    const current = captureRegularFile(snapshot.filePath, { label: "Git restore stage readback", maxBytes: this.maxBytes, requireSingleLink: true,
      expectedIdentity: snapshot.identity });
    if (current.digest !== snapshot.digest || !current.bytes.equals(snapshot.bytes)
      || !snapshot.permissionHint.matches(current.permissionHint)) throw new Error("Git source restore stage changed after verification");
    return current;
  }
  dispose() { if (!this.#retained && this.#owned !== undefined) { this.#temporary.cleanup(this.#owned.path); this.#owned = undefined; } }
}
