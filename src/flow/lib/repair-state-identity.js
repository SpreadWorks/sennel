import { withManagedProcessScopeSync, withReadOnlyManagedProcessScopeSync } from "../../lib/managed-process.js";
import { GitConfigurationObservation, readGitBoolean } from "../../lib/git-source-observation.js";
import { exactKeys } from "./source-effect-fields.js";
import { LogicalPathSet } from "../../lib/portable-path.js";
import { SourceWorkingFileCapture, observeSourceUntrackedMode, selectedSourceGitRoot } from "./source-working-file-capture.js";
import crypto from "node:crypto";
import { GitSourceEntry, SourceWorkingFile } from "./source-working-file.js";
import { GitNulFields, GitNameStatusDecoder, GitRefObservation, GitPorcelainV2StatusExecution, LoggedGitCommandExecution, runGit, runGitToFile, withGitOutputCleanup } from "../../lib/git-helpers.js";
import { CommandExecutionBatchFailure } from "../../lib/process.js";
import fs from "node:fs";
import path from "node:path";
import { flowStateSpecLocation } from "../../lib/flow-workspace.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { PRODUCT } from "../../lib/product.js";
import { TemporaryPaths } from "../../lib/temporary-paths.js";
import { FlowRepositoryRuntimeArtifactRegistry } from "./flow-repository-runtime-artifacts.js";
import { CurrentFlowContext } from "./current-flow-state.js";
import { captureRegularFile, visitRegularFileChunks, MAX_IN_MEMORY_FILE_BYTES } from "../../lib/regular-file-snapshot.js";
import { AtomicFile } from "../../lib/atomic-file.js";
import { compareText } from "./text-order.js";

export const REPAIR_STATE_VERSION = 4;
export const DEFAULT_REPAIR_CHANGED_PATH_LIMIT = 20_000;
export const MAX_REPAIR_CHANGED_PATH_LIMIT = 1_000_000;
export const REPAIR_TRANSACTION_FILE = "impl-repair-transaction.json";
export const REPAIR_MIGRATION_FILE = "repair-state-migration.json";
export const REPAIR_LOCK_DIR = ".impl-repair.lock";

// Streaming hashes and Git records do not retain the complete file in memory.
const MAX_REPAIR_STREAM_BYTES = Number.MAX_SAFE_INTEGER - 1;
const MAX_PATH_LENGTH = 4096;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const REPAIR_REF_PATTERN = new RegExp(`^refs/${PRODUCT.machineName}/flows/([A-Za-z0-9._-]+)/baseline$`);
const ENTRY_STATUS_PATTERN = /^(?:(?:committed|index|worktree):(?:[ACDMTUXBR]|untracked)|explicit:(?:input|missing)|filesystem:input)$/;

export class RepairStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RepairStateError";
    this.code = requireString(code, "code");
    this.details = Object.freeze({ ...details });
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireHash(value, field) {
  const digest = requireString(value, field);
  if (!HASH_PATTERN.test(digest)) throw new Error(`${field} must be a SHA-256 digest`);
  return digest.toLowerCase();
}

export function normalizeRepairPath(value) {
  const source = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (source.includes("\0")) throw new Error("repair state path must not contain NUL");
  const normalized = path.posix.normalize(source);
  if (!normalized || normalized === ".") throw new Error("repair state path must be non-empty");
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`repair state path must stay inside the repository: ${normalized}`);
  }
  if (normalized.length > MAX_PATH_LENGTH) {
    throw new Error(`repair state path exceeds ${MAX_PATH_LENGTH} characters: ${normalized}`);
  }
  return normalized;
}

function canonicalHash(parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(String(part));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function baselineIdentity(baseline) {
  return {
    kind: baseline.kind,
    objectFormat: baseline.objectFormat,
    commitOid: baseline.commitOid,
    treeOid: baseline.treeOid,
  };
}

function requiredGitOutput(result, label) {
  if (!result.ok) throw new Error(`${label}: ${result.stderr || result.stdout}`.trim());
  return result.stdout;
}

function runGitRequired(root, args, label) {
  return requiredGitOutput(runGit(args, { cwd: root }), label);
}

/** One native observation of the repository format and an optional revision. */
class GitRevisionObservation {
  constructor(result) {
    const records = result.stdout.trim().split("\n");
    this.objectFormat = records.shift();
    if (!this.objectFormat) throw new RepairStateError("REPAIR_GIT_UNAVAILABLE", "Git object format could not be read");
    if (this.objectFormat !== "sha1" && this.objectFormat !== "sha256") {
      throw new Error(`unsupported Git object format: ${this.objectFormat}`);
    }
    this.ok = result.ok;
    if (this.ok && records.length !== 1) throw new Error("Git revision observation must contain one object id");
    this.oid = this.ok ? requireOid(records[0], "revisionOid", this.objectFormat) : null;
    this.stdout = records.join("\n");
    this.stderr = result.stderr;
    Object.freeze(this);
  }

  static read(root, revision) {
    return new this(runGit(["rev-parse", "--show-object-format", "--verify", "--end-of-options", revision], { cwd: root }));
  }
}

function oidPattern(format) {
  return format === "sha256" ? /^[a-f0-9]{64}$/i : /^[a-f0-9]{40}$/i;
}

function requireOid(value, field, format) {
  const oid = requireString(value, field);
  if (!oidPattern(format).test(oid)) throw new Error(`${field} is not a ${format} object id`);
  return oid.toLowerCase();
}

export class ImmutableGitBaseline {
  constructor(input = {}) {
    this.kind = input.kind || "git";
    if (this.kind !== "git" && this.kind !== "filesystem") {
      throw new Error(`unsupported repair baseline kind: ${this.kind}`);
    }
    this.objectFormat = this.kind === "git" ? requireString(input.objectFormat, "objectFormat") : "sha256";
    if (this.kind === "git" && this.objectFormat !== "sha1" && this.objectFormat !== "sha256") {
      throw new Error(`unsupported Git object format: ${this.objectFormat}`);
    }
    this.commitOid = this.kind === "git"
      ? requireOid(input.commitOid, "commitOid", this.objectFormat)
      : requireHash(input.commitOid, "commitOid");
    this.treeOid = this.kind === "git"
      ? requireOid(input.treeOid, "treeOid", this.objectFormat)
      : requireHash(input.treeOid, "treeOid");
    this.sourceRef = requireString(input.sourceRef, "sourceRef");
    this.ref = input.ref == null ? null : requireString(input.ref, "ref");
    if (this.kind === "git" && this.ref != null) {
      const match = REPAIR_REF_PATTERN.exec(this.ref);
      if (!match || match[1] === "." || match[1] === "..") {
        throw new Error(`repair baseline ref must use the refs/${PRODUCT.machineName}/flows/<runId>/baseline namespace`);
      }
    }
    this.createdRef = input.createdRef === true;
    this.capturedAt = requireString(input.capturedAt, "capturedAt");
    if (Number.isNaN(Date.parse(this.capturedAt))) throw new Error("capturedAt must be an ISO timestamp");
    Object.freeze(this);
  }

  toJSON() {
    return {
      kind: this.kind,
      objectFormat: this.objectFormat,
      commitOid: this.commitOid,
      treeOid: this.treeOid,
      sourceRef: this.sourceRef,
      ref: this.ref,
      capturedAt: this.capturedAt,
    };
  }
}

export class CanonicalRepairEntry {
  constructor(input = {}) {
    this.path = normalizeRepairPath(input.path);
    this.oldPath = input.oldPath == null ? null : normalizeRepairPath(input.oldPath);
    this.statuses = Object.freeze([...new Set((input.statuses || []).map((entry) => requireString(entry, "status")))].sort());
    if (this.statuses.length === 0) throw new Error(`repair state entry has no status: ${this.path}`);
    if (!this.statuses.every((status) => ENTRY_STATUS_PATTERN.test(status))) throw new Error(`invalid repair entry status: ${this.path}`);
    this.working = input.working instanceof SourceWorkingFile ? input.working : SourceWorkingFile.fromStored(input.working);
    this.git = input.git === null ? null : input.git instanceof GitSourceEntry ? input.git : GitSourceEntry.fromStored(input.git);
    Object.freeze(this);
  }

  get mode() { return this.git?.worktreeMode ?? this.working.kind; }
  get indexOid() { return this.git?.indexOid ?? null; }
  get contentHash() { return this.working.digest ?? canonicalHash([this.working.kind]); }
  toJSON() { return { path: this.path, oldPath: this.oldPath, statuses: [...this.statuses],
    working: this.working.toJSON(), git: this.git?.toJSON() ?? null }; }
  canonicalParts() { return [this.path, this.oldPath || "", this.mode, this.contentHash]; }
}

class RepairFingerprintManifestBase {
  constructor(input, { version, entryParts }) {
    if (input.version !== version) {
      throw new Error(`repair fingerprint version must be ${version}`);
    }
    this.version = version;
    this.baseline = input.baseline instanceof ImmutableGitBaseline
      ? input.baseline
      : new ImmutableGitBaseline(input.baseline);
    this.headOid = this.baseline.kind === "git"
      ? requireOid(input.headOid, "headOid", this.baseline.objectFormat)
      : requireHash(input.headOid, "headOid");
    this.headTreeOid = this.baseline.kind === "git"
      ? requireOid(input.headTreeOid, "headTreeOid", this.baseline.objectFormat)
      : requireHash(input.headTreeOid, "headTreeOid");
    this.environmentHash = requireHash(input.environmentHash, "environmentHash");
    if (!Array.isArray(input.entries)) throw new Error("repair fingerprint entries must be an array");
    this.entries = Object.freeze(input.entries.map((entry) => (
      entry instanceof CanonicalRepairEntry ? entry : (() => {
        exactKeys(entry, ["path", "oldPath", "statuses", "working", "git"], "repair source entry");
        return new CanonicalRepairEntry(entry);
      })()
    )).sort((a, b) => compareText(a.path, b.path)));
    new LogicalPathSet(this.entries.map((entry) => entry.path), { allowDirectoryPrefixes: true });
    const parts = [
      this.version,
      JSON.stringify(baselineIdentity(this.baseline)),
      this.environmentHash,
      ...this.entries.flatMap((entry) => entryParts(entry)),
    ];
    const expectedHash = canonicalHash(parts);
    if (input.hash != null && requireHash(input.hash, "hash") !== expectedHash) {
      throw new Error("repair fingerprint hash does not match its canonical state");
    }
    this.hash = expectedHash;
    Object.freeze(this);
  }

  toJSON() {
    return {
      version: this.version,
      hash: this.hash,
      baseline: this.baseline.toJSON(),
      headOid: this.headOid,
      headTreeOid: this.headTreeOid,
      environmentHash: this.environmentHash,
      entries: this.entries.map((entry) => entry.toJSON()),
    };
  }
}

export class RepairFingerprintManifest extends RepairFingerprintManifestBase {
  constructor(input = {}) {
    super(input, {
      version: REPAIR_STATE_VERSION,
      entryParts: (entry) => entry.canonicalParts(),
    });
  }

}

export class RepairArtifactRegistry {
  #runtimeArtifacts;

  constructor(specPath) {
    this.specPath = normalizeRepairPath(specPath);
    this.specDir = path.posix.dirname(this.specPath);
    this.reviewWorkUnitRoot = `${PRODUCT.managedPath("review-work-units")}/`;
    this.#runtimeArtifacts = new FlowRepositoryRuntimeArtifactRegistry();
    Object.freeze(this);
  }

  owns(value) {
    const relPath = normalizeRepairPath(value);
    if (this.#runtimeArtifacts.owns(relPath)) return true;
    if (relPath.startsWith(this.reviewWorkUnitRoot)) return true;
    if (!relPath.startsWith(`${this.specDir}/`)) return false;
    const versionRelativePath = relPath.slice(this.specDir.length + 1);
    let contract;
    try {
      contract = FLOW_ARTIFACT_CONTRACTS.classify(versionRelativePath);
    } catch {
      return false;
    }
    return !new Set(["spec.record", "tests.source"]).has(contract.logicalKey.toString());
  }

  gitPathspecExcludes() {
    return Object.freeze([
      ...this.#runtimeArtifacts.gitPathspecExcludes(),
      `:(exclude,top,glob)${this.reviewWorkUnitRoot}**`,
      `:(exclude,top,glob)${this.specDir}/**`,
    ]);
  }
}

export class FinalizeFlowArtifactRegistry extends RepairArtifactRegistry {
  owns(value) {
    const relPath = normalizeRepairPath(value);
    return super.owns(relPath)
      || relPath === this.specPath
      || relPath.startsWith(`${this.specDir}/artifacts/tests/`);
  }
}

export class FlowDispatchArtifactRegistry extends RepairArtifactRegistry {
  gitPathspecExcludes() {
    const specRoot = path.posix.dirname(this.specDir);
    return Object.freeze([
      ...super.gitPathspecExcludes(),
      `:(exclude,top,glob)${specRoot}/**`,
    ]);
  }
}

function assertSafeRunId(runId) {
  const value = requireString(runId, "runId");
  if (!RUN_ID_PATTERN.test(value) || value === "." || value === "..") {
    throw new Error("runId is not safe for a repair baseline ref");
  }
  return value;
}

function resolveSingleMergeBase(root, baseRef) {
  const result = runGit(["merge-base", "--all", "HEAD", baseRef], { cwd: root });
  if (!result.ok) {
    throw new RepairStateError(
      "REPAIR_BASELINE_UNRESOLVABLE",
      `failed to resolve repair baseline merge-base: ${result.stderr || result.stdout}`.trim(),
      { baseRef },
    );
  }
  const candidates = result.stdout.trim().split("\n").filter(Boolean);
  if (candidates.length !== 1) {
    throw new RepairStateError(
      "REPAIR_BASELINE_AMBIGUOUS",
      `repair baseline requires exactly one merge-base; observed ${candidates.length}`,
      { candidateCount: candidates.length },
    );
  }
  return candidates[0];
}

export function captureRepairBaseline(options) {
  return withManagedProcessScopeSync({ executionRoot: options.root }, () => captureGitRepairBaseline(options));
}

function captureGitRepairBaseline({ root, baseRef, runId, useMergeBase = false, pin = true }) {
  const sourceRef = requireString(baseRef, "baseRef");
  const ref = pin ? PRODUCT.flowBaselineRef(assertSafeRunId(runId)) : null;
  const pinned = ref ? GitRevisionObservation.read(root, ref) : null;
  const source = pinned?.ok ? null : GitRevisionObservation.read(root, `${sourceRef}^{commit}`);
  const objectFormat = (pinned ?? source).objectFormat;
  let commitCandidate = pinned?.ok ? pinned.oid : null;
  if (commitCandidate == null) {
    if (!source.ok) {
      throw new RepairStateError(
        "REPAIR_BASELINE_UNRESOLVABLE",
        `failed to resolve repair baseline source ${sourceRef}: ${source.stderr || source.stdout}`.trim(),
        { sourceRef },
      );
    }
    const sourceCommit = source.oid;
    commitCandidate = useMergeBase ? resolveSingleMergeBase(root, sourceCommit) : sourceCommit;
  }
  const commitOid = requireOid(commitCandidate, "commitOid", objectFormat);
  const tree = runGit(["rev-parse", "--verify", `${commitOid}^{tree}`], { cwd: root });
  if (!tree.ok) {
    throw new RepairStateError(
      "REPAIR_BASELINE_OBJECT_MISSING",
      `failed to resolve repair baseline tree for ${commitOid}: ${tree.stderr || tree.stdout}`.trim(),
      { commitOid },
    );
  }
  const treeOid = requireOid(tree.stdout.trim(), "treeOid", objectFormat);
  if (ref) {
    if (!pinned.ok) {
      const created = runGit(["update-ref", ref, commitOid, ""], { cwd: root });
      if (!created.ok) {
        throw new RepairStateError(
          "REPAIR_BASELINE_PIN_FAILED",
          `failed to pin repair baseline ${ref}: ${created.stderr || created.stdout}`.trim(),
          { ref, commitOid },
        );
      }
    }
  }
  return new ImmutableGitBaseline({
    kind: "git",
    objectFormat,
    commitOid,
    treeOid,
    sourceRef,
    ref,
    createdRef: Boolean(ref && !pinned.ok),
    capturedAt: new Date().toISOString(),
  });
}

export function deleteRepairBaselineForFlow(root, flowState) {
  const runId = assertSafeRunId(flowState?.runId);
  const ref = PRODUCT.flowBaselineRef(runId);
  const existing = runGit(["rev-parse", "--verify", ref], { cwd: root });
  if (!existing.ok) return false;
  const commitOid = existing.stdout.trim();
  runGitRequired(root, ["update-ref", "-d", ref, commitOid], "failed to delete repair baseline ref");
  return true;
}


function readConfiguredBoundary(root) {
  const file = path.join(root, PRODUCT.managedDirName, "config.json");
  if (!fs.existsSync(file)) return { maxChangedPaths: DEFAULT_REPAIR_CHANGED_PATH_LIMIT, include: [] };
  const config = JSON.parse(captureRegularFile(file, { label: "repair fingerprint configuration", maxBytes: MAX_IN_MEMORY_FILE_BYTES }).text());
  const input = config?.flow?.repairFingerprint || {};
  for (const key of Object.keys(input)) {
    if (!new Set(["maxChangedPaths", "include"]).has(key)) {
      throw new Error(`unknown flow.repairFingerprint setting: ${key}`);
    }
  }
  const maxChangedPaths = input.maxChangedPaths ?? DEFAULT_REPAIR_CHANGED_PATH_LIMIT;
  if (!Number.isSafeInteger(maxChangedPaths) || maxChangedPaths < 1 || maxChangedPaths > MAX_REPAIR_CHANGED_PATH_LIMIT) {
    throw new Error(`flow.repairFingerprint.maxChangedPaths must be an integer between 1 and ${MAX_REPAIR_CHANGED_PATH_LIMIT}`);
  }
  if (input.include != null && !Array.isArray(input.include)) {
    throw new Error("flow.repairFingerprint.include must be an array");
  }
  return {
    maxChangedPaths,
    include: Object.freeze((input.include || []).map(normalizeRepairPath)),
  };
}

function forEachGitNulField(root, directory, args, label, visit) {
  const outputPath = path.join(directory, "stdout.bin");
  return withGitOutputCleanup(() => {
    const result = runGitToFile(args, { cwd: root, outputPath });
    if (!result.ok) throw new Error(`${label}: ${result.stderr}`.trim());
    let pending = Buffer.alloc(0);
    visitRegularFileChunks(outputPath, {
      label, maxBytes: MAX_REPAIR_STREAM_BYTES,
      visit(buffer) {
        const chunk = pending.length === 0 ? Buffer.from(buffer) : Buffer.concat([pending, buffer]);
        let start = 0;
        for (let index = 0; index < chunk.length; index += 1) {
          if (chunk[index] !== 0) continue;
          visit(GitNulFields.decodeField(chunk.subarray(start, index), label));
          start = index + 1;
        }
        pending = Buffer.from(chunk.subarray(start));
        if (pending.length > (MAX_PATH_LENGTH * 4) + 128) throw new Error(`${label}: Git emitted an overlong field`);
      },
    });
    if (pending.length !== 0) throw new Error(`${label}: Git output is not NUL terminated`);
  }, () => new AtomicFile(outputPath).remove());
}

class MutableChangedPath {
  constructor(relPath) {
    this.path = normalizeRepairPath(relPath);
    this.oldPath = null;
    this.statuses = new Set();
  }

  addStatus(scope, status, oldPath = null) {
    this.statuses.add(`${scope}:${status}`);
    if (oldPath != null) this.oldPath = normalizeRepairPath(oldPath);
  }
}

function changedPathEntry(changed, relPath, boundary) {
  const normalized = normalizeRepairPath(relPath);
  let entry = changed.get(normalized);
  if (entry) return entry;
  entry = new MutableChangedPath(normalized);
  changed.set(normalized, entry);
  if (changed.size > boundary.maxChangedPaths) {
    throw new RepairStateError(
      "REPAIR_CHANGED_PATH_LIMIT",
      `repair state changed path count ${changed.size} exceeds configured limit ${boundary.maxChangedPaths}; adjust flow.repairFingerprint.maxChangedPaths`,
      { observed: changed.size, limit: boundary.maxChangedPaths, setting: "flow.repairFingerprint.maxChangedPaths" },
    );
  }
  return entry;
}

function streamNameStatus(root, directory, args, scope, changed, boundary, registry) {
  const decoder = new GitNameStatusDecoder(`malformed ${scope} Git name-status output`);
  forEachGitNulField(root, directory, args, `failed to collect ${scope} repair delta`, (field) => {
    const observed = decoder.accept(field);
    if (observed !== null && !registry.owns(observed.path)) {
      const entry = changedPathEntry(changed, observed.path, boundary);
      entry.addStatus(scope, observed.rawStatus[0], observed.originalPath);
    }
  });
  decoder.finish();
}

function collectGitChangedPaths(root, directory, baseline, boundary, registry, status) {
  const changed = new Map();
  const scratchRelative = path.relative(root, directory).split(path.sep).join("/");
  streamNameStatus(root, directory, [
    "diff", "--name-status", "-z", "--no-ext-diff", "--find-renames", baseline.commitOid, "HEAD",
  ], "committed", changed, boundary, registry);
  streamNameStatus(root, directory, [
    "diff", "--cached", "--name-status", "-z", "--no-ext-diff", "--find-renames", "HEAD",
  ], "index", changed, boundary, registry);
  // Porcelain verifies content without refreshing the real index; name-status
  // can retain stat-only worktree candidates after bytes return to their baseline.
  for (const statusEntry of status.entries) {
    if (statusEntry.kind !== "untracked" && statusEntry.worktreeStatus === ".") continue;
    const relPath = statusEntry.path;
    if ((statusEntry.kind === "untracked" && relPath.startsWith(`${scratchRelative}/`))
      || registry.owns(relPath)) continue;
    const entry = changedPathEntry(changed, relPath, boundary);
    entry.addStatus("worktree", statusEntry.kind === "untracked" ? "untracked" : statusEntry.worktreeStatus);
  }
  return changed;
}

function collectIndexState(root, directory, objectFormat, paths) {
  const state = new Map();
  const input = [...paths];
  for (let offset = 0; offset < input.length; offset += 512) {
    const batch = input.slice(offset, offset + 512);
    forEachGitNulField(root, directory, ["ls-files", "--stage", "-z", "--", ...batch], "failed to read Git index", (record) => {
      const match = record.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/i);
      if (!match) throw new Error("malformed Git index entry");
      const [, mode, rawOid, stage, rawPath] = match;
      const relPath = normalizeRepairPath(rawPath);
      if (stage !== "0") throw new Error(`unmerged Git index entry is not valid repair evidence: ${relPath}`);
      const zeroOid = /^0+$/.test(rawOid);
      const oid = zeroOid ? rawOid : requireOid(rawOid, `indexOid.${relPath}`, objectFormat);
      if (state.has(relPath)) throw new Error(`duplicate Git index entry: ${relPath}`);
      state.set(relPath, { mode, oid });
    });
  }
  return state;
}

function assertSupportedIndexFlags(root, directory) {
  const sparseConfig = runGit(["config", "--bool", "core.sparseCheckout"], { cwd: root });
  const sparse = sparseConfig.ok && sparseConfig.stdout.trim() === "true";
  const skipWorktreePaths = [];
  forEachGitNulField(root, directory, ["ls-files", "-v", "-z"], "failed to inspect Git index flags", (record) => {
    const tag = record[0];
    const relPath = normalizeRepairPath(record.slice(2));
    if (/[a-z]/.test(tag)) {
      throw new RepairStateError(
        "REPAIR_INDEX_FLAG_UNSUPPORTED",
        `assume-unchanged index entry is not valid repair evidence: ${relPath}`,
        { path: relPath, flag: "assume-unchanged" },
      );
    }
    if (tag === "S" && !sparse) {
      throw new RepairStateError(
        "REPAIR_INDEX_FLAG_UNSUPPORTED",
        `manual skip-worktree entry is not valid repair evidence: ${relPath}`,
        { path: relPath, flag: "skip-worktree" },
      );
    }
    if (tag === "S" && fs.lstatSync(path.join(root, relPath), { throwIfNoEntry: false })) {
      throw new RepairStateError(
        "REPAIR_INDEX_FLAG_UNSUPPORTED",
        `materialized skip-worktree entry is not valid repair evidence: ${relPath}`,
        { path: relPath, flag: "skip-worktree-materialized" },
      );
    }
    if (tag === "S") skipWorktreePaths.push(relPath);
  });
  return new RepairIndexFlagObservation(skipWorktreePaths, sparse);
}

class RepairIndexFlagObservation {
  constructor(paths, sparseEnabled) {
    if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== "string") || typeof sparseEnabled !== "boolean") throw new TypeError("Git index flags require paths and a sparse policy observation");
    this.skipWorktreePaths = Object.freeze([...paths].sort(compareText));
    this.sparseEnabled = sparseEnabled;
    Object.freeze(this);
  }
}

/** Exact native HEAD/tree pair from the existing bounded command. */
class RepairGitHeadObservation {
  constructor(result, objectFormat) {
    const records = requiredGitOutput(result, "failed to resolve repair state HEAD and tree").trim().split("\n");
    if (records.length !== 2) throw new Error("repair state HEAD and tree evidence is invalid");
    this.headOid = requireOid(records[0], "headOid", objectFormat);
    this.headTreeOid = requireOid(records[1], "headTreeOid", objectFormat);
    Object.freeze(this);
  }
}

/** Independent bounded native reads; interpretation keeps the original order. */
class RepairGitMetadataObservation {
  #statusRead;
  #results;
  constructor(statusRead, results) {
    if (!(statusRead instanceof GitPorcelainV2StatusExecution)) throw new TypeError("Repair metadata requires its native status query");
    this.#statusRead = statusRead; this.#results = results;
    Object.freeze(this);
  }
  static read(root) {
    const status = new GitPorcelainV2StatusExecution(root, { repositoryRoot: root, forceFileMode: false });
    const configuration = new LoggedGitCommandExecution(["config", "--null", "--get-regexp", "^(core\\.(autocrlf|eol|symlinks|filemode|ignorecase|precomposeunicode)|filter\\..*\\.(clean|smudge|process|required))$"], { cwd: root });
    const head = new LoggedGitCommandExecution(["rev-parse", "HEAD", "HEAD^{tree}"], { cwd: root });
    let results;
    try { results = LoggedGitCommandExecution.runTogether([status, configuration, head]); }
    catch (cause) {
      if (cause instanceof CommandExecutionBatchFailure) {
        const control = cause.controlFailure();
        if (control !== null) throw control;
      }
      throw cause;
    }
    return new this(status, results);
  }
  get status() { return this.#statusRead.parseResult(this.#results[0]); }
  get filterConfiguration() {
    const config = this.#results[1];
    if (!config.ok && config.status !== 1) throw new Error(`failed to inspect Git filter environment: ${config.stderr}`);
    return config;
  }
  head(objectFormat) { return new RepairGitHeadObservation(this.#results[2], objectFormat); }
}

function environmentHash(root, flags, config) {
  const sparseEnabled = flags.sparseEnabled;
  const skipWorktreePaths = flags.skipWorktreePaths;
  const sparse = sparseEnabled ? runGit(["sparse-checkout", "list"], { cwd: root }) : null;
  if (sparseEnabled && !sparse.ok) throw new Error(`failed to inspect sparse checkout definition: ${sparse.stderr || sparse.stdout}`);
  return canonicalHash([
    config.ok ? config.stdout : "",
    sparse?.ok ? sparse.stdout : "sparse-checkout:disabled",
    ...skipWorktreePaths,
  ]);
}

function contentIdentity(root, relPath, indexEntry, { observedModes = new Map(), symlinks = true, filemode = true, skipWorktree = false, gitRepository = false } = {}) {
  const { working } = SourceWorkingFileCapture.capture(root, relPath, { maxBytes: MAX_REPAIR_STREAM_BYTES });
  const git = !gitRepository || working.kind === "directory" ? null : new GitSourceEntry({ logicalMode: indexEntry?.mode ?? null, indexOid: indexEntry?.oid ?? null,
    assumeUnchanged: false, skipWorktree, worktreeMode: working.kind === "missing" ? null
      : observedModes.get(relPath) ?? indexEntry?.mode ?? observeSourceUntrackedMode(root, relPath, { filemode, maxBytes: MAX_REPAIR_STREAM_BYTES }) });
  git?.assertRepresentation(working, { symlinks });
  return { working, git };
}

function collectExplicitTree(root, relPath, changed, registry, boundary) {
  const normalized = normalizeRepairPath(relPath);
  if (registry.owns(normalized)) return;
  const absolute = path.resolve(root, normalized);
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat || stat.isFile() || stat.isSymbolicLink()) {
    const entry = changedPathEntry(changed, normalized, boundary);
    entry.addStatus("explicit", stat ? "input" : "missing");
    return;
  }
  if (!stat.isDirectory()) throw new Error(`unsupported explicit repair input: ${normalized}`);
  for (const dirent of fs.readdirSync(absolute, { withFileTypes: true })) {
    collectExplicitTree(root, path.posix.join(normalized, dirent.name), changed, registry, boundary);
  }
}

function buildFilesystemManifest({ root, specPath, boundary, registry }) {
  const changed = new Map();
  const walk = (absolute, relative = "") => {
    for (const dirent of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relPath = normalizeRepairPath(path.posix.join(relative, dirent.name));
      if (registry.owns(relPath) || relPath === ".git" || relPath.startsWith(".git/")) continue;
      const full = path.join(absolute, dirent.name);
      if (dirent.isDirectory()) walk(full, relPath);
      else {
        const entry = changedPathEntry(changed, relPath, boundary);
        entry.addStatus("filesystem", "input");
      }
    }
  };
  walk(root);
  const entries = [...changed.values()].map((entry) => {
    const identity = contentIdentity(root, entry.path, null);
    return new CanonicalRepairEntry({
      path: entry.path,
      oldPath: entry.oldPath,
      statuses: [...entry.statuses],
      working: identity.working, git: null,
    });
  });
  if (entries.length > boundary.maxChangedPaths) {
    throw new RepairStateError(
      "REPAIR_CHANGED_PATH_LIMIT",
      `repair state changed path count ${entries.length} exceeds configured limit ${boundary.maxChangedPaths}; adjust flow.repairFingerprint.maxChangedPaths`,
      { observed: entries.length, limit: boundary.maxChangedPaths, setting: "flow.repairFingerprint.maxChangedPaths" },
    );
  }
  const treeHash = canonicalHash(entries.flatMap((entry) => entry.canonicalParts()));
  const baseline = new ImmutableGitBaseline({
    kind: "filesystem",
    commitOid: canonicalHash(["filesystem-baseline", specPath]),
    treeOid: canonicalHash(["filesystem-tree", specPath]),
    sourceRef: "filesystem",
    ref: null,
    capturedAt: new Date(0).toISOString(),
  });
  return new RepairFingerprintManifest({
    version: REPAIR_STATE_VERSION,
    baseline,
    headOid: treeHash,
    headTreeOid: treeHash,
    environmentHash: canonicalHash(["filesystem"]),
    entries,
  });
}

/** Read existing historical authority; fingerprint capture never pins a Git ref. */
function baselineFromStateOrRepository({ root, state, pinMissingBaseline }) {
  if (state?.runId) {
    const runId = assertSafeRunId(state.runId);
    const ref = PRODUCT.flowBaselineRef(runId);
    const pinned = GitRefObservation.resolve({ root, ref });
    let baseOid = null;
    if (!pinMissingBaseline && state.context !== undefined) {
      if (!(state.context instanceof CurrentFlowContext)) {
        throw new RepairStateError("REPAIR_BASELINE_UNRESOLVABLE", "repair baseline requires typed canonical context");
      }
      baseOid = state.context.baseOid;
    }
    if (baseOid !== null && pinned.present && pinned.oid !== baseOid.toLowerCase()) {
      throw new RepairStateError("REPAIR_BASELINE_UNRESOLVABLE", "Flow preparation base conflicts with its existing run baseline");
    }
    const source = baseOid ?? pinned.oid;
    if (source === null) {
      // The direct Manifest API retains its existing lazy-pinning producer.
      // The value API instead falls through to its original fresh repository
      // observation; no creation-time historical identity is asserted there.
      if (pinMissingBaseline) {
        return repositoryBaseline(root, state, true);
      }
      return repositoryBaseline(root);
    }
    const commit = GitRevisionObservation.read(root, `${source}^{commit}`);
    if (!commit.ok || commit.oid !== source.toLowerCase()) {
      throw new RepairStateError("REPAIR_BASELINE_OBJECT_MISSING", "Flow historical baseline commit is unavailable");
    }
    const treeOid = requireOid(runGitRequired(root, ["rev-parse", "--verify", `${commit.oid}^{tree}`],
      "failed to read Flow historical baseline tree").trim(), "treeOid", commit.objectFormat);
    return new ImmutableGitBaseline({ kind: "git", objectFormat: commit.objectFormat,
      commitOid: commit.oid, treeOid,
      sourceRef: baseOid === null ? state.baseBranch || "pinned" : state.execution?.baseBranch || baseOid,
      ref: pinned.present ? ref : null,
      capturedAt: state.createdAt || new Date().toISOString() });
  }
  return repositoryBaseline(root, pinMissingBaseline ? state : null, pinMissingBaseline);
}

function repositoryBaselineRef(root) {
  for (const candidate of ["main", "master"]) {
    if (runGit(["show-ref", "--verify", `refs/heads/${candidate}`], { cwd: root }).ok) return candidate;
  }
  return "HEAD";
}

/** Select the existing repository source; only the direct producer may pin it. */
function repositoryBaseline(root, state = null, pinMissingBaseline = false) {
  const baseRef = state?.baseBranch || repositoryBaselineRef(root);
  const runId = state?.runId || "unbound";
  return captureRepairBaseline({ root, baseRef, runId, useMergeBase: baseRef !== "HEAD",
    pin: pinMissingBaseline && Boolean(state?.runId) });
}

export function buildRepairStateManifest({ root, artifactRoot = null, specPath, state = null, pinMissingBaseline = true }) {
  requireString(root, "root");
  const normalizedSpec = normalizeRepairPath(specPath);
  const registry = new RepairArtifactRegistry(normalizedSpec);
  const resolvedArtifactRoot = path.resolve(
    artifactRoot || flowStateSpecLocation(state)?.repositoryRoot || root,
  );
  const boundary = readConfiguredBoundary(root);
  if (!selectedSourceGitRoot(root)) return buildFilesystemManifest({ root, specPath: normalizedSpec, boundary, registry });
  const captureBaseline = pinMissingBaseline ? withManagedProcessScopeSync : withReadOnlyManagedProcessScopeSync;
  const scope = pinMissingBaseline ? { executionRoot: root }
    : { mainRoot: resolvedArtifactRoot, executionRoot: root };
  const baseline = captureBaseline(scope, () => baselineFromStateOrRepository({ root, state, pinMissingBaseline }));
  return withReadOnlyManagedProcessScopeSync({ mainRoot: root, executionRoot: root }, () => buildGitRepairStateManifest({
    root, resolvedArtifactRoot, normalizedSpec, state, baseline, boundary, registry,
  }));
}

function buildGitRepairStateManifest({ root, resolvedArtifactRoot, normalizedSpec, state, baseline, boundary, registry }) {
  const temporaryPaths = new TemporaryPaths(resolvedArtifactRoot);
  const temporaryDirectory = state?.specId && state?.runId
    ? temporaryPaths.flow(state.specId, state.runId)
    : temporaryPaths.runtime("repair-git");
  const directory = temporaryPaths.create(temporaryDirectory, PRODUCT.temporaryPrefix("repair-git"));
  return withGitOutputCleanup(() => {
    const flags = assertSupportedIndexFlags(root, directory);
    const skipWorktreePaths = flags.skipWorktreePaths;
    const metadata = RepairGitMetadataObservation.read(root);
    const status = metadata.status;
    const changed = collectGitChangedPaths(root, directory, baseline, boundary, registry, status);
    collectExplicitTree(root, PRODUCT.managedPath("config.json"), changed, registry, boundary);
    collectExplicitTree(root, PRODUCT.managedPath("config.local.json"), changed, registry, boundary);
    collectExplicitTree(resolvedArtifactRoot, normalizedSpec, changed, registry, boundary);
    const testSourceDirectory = path.posix.join(path.posix.dirname(normalizedSpec), "artifacts/tests");
    collectExplicitTree(resolvedArtifactRoot, testSourceDirectory, changed, registry, boundary);
    for (const relPath of boundary.include) collectExplicitTree(root, relPath, changed, registry, boundary);
    for (const relPath of [...changed.keys()]) {
      if (registry.owns(relPath)) changed.delete(relPath);
    }
    if (changed.size > boundary.maxChangedPaths) {
      throw new RepairStateError(
        "REPAIR_CHANGED_PATH_LIMIT",
        `repair state changed path count ${changed.size} exceeds configured limit ${boundary.maxChangedPaths}; adjust flow.repairFingerprint.maxChangedPaths`,
        { observed: changed.size, limit: boundary.maxChangedPaths, setting: "flow.repairFingerprint.maxChangedPaths" },
      );
    }
    const index = collectIndexState(root, directory, baseline.objectFormat, changed.keys());
    const observedModes = new Map(status.entries.filter((entry) => entry.worktreeMode > 0)
      .map((entry) => [entry.path, entry.worktreeMode.toString(8)]));
    const filterConfiguration = metadata.filterConfiguration;
    const configuration = GitConfigurationObservation.fromRecords(Buffer.from(filterConfiguration.ok ? filterConfiguration.stdout : ""));
    const symlinks = configuration.boolean("core.symlinks", true, () => readGitBoolean(root, "core.symlinks", true, { execute: runGit }));
    const filemode = configuration.boolean("core.filemode", true, () => readGitBoolean(root, "core.filemode", true, { execute: runGit }));
    const sparsePaths = new Set(skipWorktreePaths);
    const entries = [...changed.values()].map((entry) => {
      const indexEntry = index.get(entry.path) || null;
      const isSpecInput = entry.path === normalizedSpec
        || entry.path.startsWith(`${testSourceDirectory}/`);
      const identity = contentIdentity(isSpecInput ? resolvedArtifactRoot : root, entry.path, indexEntry, { observedModes, symlinks, filemode, skipWorktree: sparsePaths.has(entry.path), gitRepository: !isSpecInput || resolvedArtifactRoot === path.resolve(root) });
      return new CanonicalRepairEntry({
        path: entry.path,
        oldPath: entry.oldPath,
        statuses: [...entry.statuses],
        working: identity.working, git: identity.git,
      });
    });
    const { headOid, headTreeOid } = metadata.head(baseline.objectFormat);
    return new RepairFingerprintManifest({
      version: REPAIR_STATE_VERSION,
      baseline,
      headOid,
      headTreeOid,
      environmentHash: environmentHash(root, flags, filterConfiguration),
      entries,
    });
  }, () => temporaryPaths.cleanup(directory));
}
