import { assertWorkerArtifactStoredValue } from "./worker-artifact-input-format.js";
import { exactKeys, normalizedRelativePath } from "./source-effect-fields.js";
import { FileIdentity } from "../../lib/file-identity.js";
import { LogicalPathSet } from "../../lib/portable-path.js";
import { isGitObjectId } from "../../lib/git-snapshot.js";

const MODES = new Set(["100644", "100755", "120000"]);
const HASH = /^[a-f0-9]{64}$/;

/** Raw host representation. No Git mode is inferred from native permission bits. */
export class SourceWorkingFile {
  constructor({ kind, digest = null, generation = null }) {
    if (!new Set(["file", "missing", "directory"]).has(kind)) throw new TypeError(`unsupported source host representation: ${kind}`);
    if ((kind === "file") !== (typeof digest === "string" && HASH.test(digest))) throw new TypeError("source regular file requires its raw SHA-256 digest");
    if (kind !== "file" && digest !== null) throw new TypeError("non-file source cannot carry a raw digest");
    this.kind = kind; this.digest = digest;
    this.generation = generation === null ? null : generation instanceof FileIdentity ? generation : FileIdentity.fromStored(generation);
    if ((kind === "missing") !== (this.generation === null)) throw new TypeError("source representation requires its observed physical generation");
    Object.freeze(this);
  }
  static fromStored(value) { exactKeys(value, ["kind", "digest", "generation"], "source working file"); return new this(value); }
  sameContent(other) { return other instanceof SourceWorkingFile && this.kind === other.kind && this.digest === other.digest; }
  toJSON() { return { kind: this.kind, digest: this.digest, generation: this.generation?.toJSON() ?? null }; }
  contentJSON() { return { kind: this.kind, digest: this.digest }; }
}

/** Logical index type and observed worktree mode remain independent of host kind. */
export class GitSourceEntry {
  constructor({ logicalMode, indexOid, assumeUnchanged, skipWorktree, worktreeMode }) {
    if (logicalMode !== null && !MODES.has(logicalMode)) throw new TypeError(`unsupported Git logical source mode: ${logicalMode}`);
    if ((logicalMode === null) !== (indexOid === null)
      || (indexOid !== null && !isGitObjectId(indexOid))) throw new TypeError("Git source index mode and OID must be bound");
    if (typeof assumeUnchanged !== "boolean" || typeof skipWorktree !== "boolean") throw new TypeError("Git source index flags are required");
    if (logicalMode === null && (assumeUnchanged || skipWorktree)) throw new TypeError("untracked source cannot have index flags");
    if (worktreeMode !== null && !MODES.has(worktreeMode)) throw new TypeError(`unsupported Git observed source mode: ${worktreeMode}`);
    this.logicalMode = logicalMode; this.indexOid = indexOid;
    this.assumeUnchanged = assumeUnchanged; this.skipWorktree = skipWorktree; this.worktreeMode = worktreeMode;
    Object.freeze(this);
  }
  static fromStored(value) {
    exactKeys(value, ["logicalMode", "indexOid", "assumeUnchanged", "skipWorktree", "worktreeMode"], "Git source entry");
    return new this(value);
  }
  assertRepresentation(working, { symlinks }) {
    if (!(working instanceof SourceWorkingFile)) throw new TypeError("Git source requires typed raw host facts");
    if ((working.kind === "file") !== (this.worktreeMode !== null)) throw new TypeError("Git observed mode differs from its raw host representation");
    if (working.kind === "file" && (this.logicalMode === "120000") !== (this.worktreeMode === "120000")) throw new TypeError("Git logical link mode differs from its observed representation");
    if (this.logicalMode === "120000" && working.kind === "file" && symlinks) throw new TypeError("logical symlink has an inconsistent regular host representation");
    return this;
  }
  get visibleMode() { return this.worktreeMode === null ? null : this.worktreeMode === "120000" ? 0o777 : this.worktreeMode === "100755" ? 0o755 : 0o644; }
  get materializationMode() { return this.worktreeMode === "100755" ? "100755" : "100644"; }
  indexJSON() { return { logicalMode: this.logicalMode, indexOid: this.indexOid, assumeUnchanged: this.assumeUnchanged, skipWorktree: this.skipWorktree }; }
  toJSON() { return { ...this.indexJSON(), worktreeMode: this.worktreeMode }; }
}


export class SourceGitDirectoryGenerations {
  constructor({ git, common }) {
    this.git = git instanceof FileIdentity ? git : FileIdentity.fromStored(git);
    this.common = common instanceof FileIdentity ? common : FileIdentity.fromStored(common);
    Object.freeze(this);
  }
  static fromStored(value) { exactKeys(value, ["git", "common"], "source Git directory generations"); return new this(value); }
  toJSON() { return { git: this.git.toJSON(), common: this.common.toJSON() }; }
}

const GIT_CONTROL_NAMES = Object.freeze(["head", "index", "commonConfig", "worktreeConfig"]);

/** Exact named repository controls; hashes retain no configuration plaintext. */
export class SourceGitControlFiles {
  constructor(values) {
    for (const name of GIT_CONTROL_NAMES) {
      const working = values[name] instanceof SourceWorkingFile ? values[name] : SourceWorkingFile.fromStored(values[name]);
      if (working.kind === "directory" || name === "head" && working.kind !== "file") {
        throw new TypeError(`Git ${name} control has an invalid physical representation`);
      }
      this[name] = working;
    }
    Object.freeze(this);
  }
  static fromStored(value) { exactKeys(value, GIT_CONTROL_NAMES, "source Git control files"); return new this(value); }
  toJSON() { return Object.fromEntries(GIT_CONTROL_NAMES.map((name) => [name, this[name].toJSON()])); }
}

/** Materialization policy and repository control are read-only source facts. */
export class SourceGitState {
  constructor({ filemode, symlinks, configDigest, refsDigest, flagsDigest, attributesDigest, workingAttributesDigest, directories, controlFiles }) {
    if (typeof filemode !== "boolean" || typeof symlinks !== "boolean") throw new TypeError("Git materialization policy requires effective booleans");
    for (const value of [configDigest, refsDigest, flagsDigest, attributesDigest, workingAttributesDigest]) if (typeof value !== "string" || !HASH.test(value)) throw new TypeError("Git control state requires exact digests");
    this.filemode = filemode; this.symlinks = symlinks; this.configDigest = configDigest;
    this.refsDigest = refsDigest; this.flagsDigest = flagsDigest; this.attributesDigest = attributesDigest; this.workingAttributesDigest = workingAttributesDigest;
    this.controlFiles = controlFiles instanceof SourceGitControlFiles ? controlFiles : SourceGitControlFiles.fromStored(controlFiles);
    this.directories = directories instanceof SourceGitDirectoryGenerations ? directories : SourceGitDirectoryGenerations.fromStored(directories);
    Object.freeze(this);
  }
  static fromStored(value) { exactKeys(value, ["filemode", "symlinks", "configDigest", "refsDigest", "flagsDigest", "attributesDigest", "workingAttributesDigest", "directories", "controlFiles"], "source Git state"); return new this(value); }
  toJSON() { return { ...this.contentJSON(), directories: this.directories.toJSON(), controlFiles: this.controlFiles.toJSON() }; }
  controlJSON() { const { workingAttributesDigest, ...control } = this.toJSON(); return control; }
  contentJSON() { return { filemode: this.filemode, symlinks: this.symlinks, configDigest: this.configDigest,
    refsDigest: this.refsDigest, flagsDigest: this.flagsDigest, attributesDigest: this.attributesDigest, workingAttributesDigest: this.workingAttributesDigest }; }
}


export class WorkerArtifactRepositoryEntry {
  constructor({ path: relativePath, workingPath, working, git = null }) {
    this.path = normalizedRelativePath(relativePath, "source repository path");
    this.workingPath = normalizedRelativePath(workingPath, "source native working path");
    if (new LogicalPathSet([this.path]).spellingFor(this.workingPath) !== this.path) {
      throw new TypeError("source native spelling must represent its logical path");
    }
    this.working = working instanceof SourceWorkingFile ? working : SourceWorkingFile.fromStored(working);
    this.git = git === null ? null : git instanceof GitSourceEntry ? git : GitSourceEntry.fromStored(git);
    Object.freeze(this);
  }
  get kind() { return this.working.kind; }
  get digest() { return this.working.digest; }
  get mode() { return this.git?.visibleMode ?? null; }
  toJSON() { return { path: this.path, workingPath: this.workingPath, working: this.working.toJSON(), git: this.git?.toJSON() ?? null }; }
  contentJSON() { return { path: this.path, working: this.working.contentJSON(), git: this.git?.toJSON() ?? null }; }
  static fromStored(value) {
    exactKeys(value, ["path", "workingPath", "working", "git"], "source repository entry");
    const entry = new this(value);
    assertWorkerArtifactStoredValue(value, entry.toJSON(), "source repository entry");
    return entry;
  }
  static missing(relativePath, workingPath = relativePath) { return new this({ path: relativePath, workingPath, working: new SourceWorkingFile({ kind: "missing" }) }); }
}
