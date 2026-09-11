/**
 * src/lib/git-helpers.js
 *
 * Shared helpers for Git and GitHub CLI operations.
 * Includes both read-only state queries and GitHub actions (e.g. issue comments).
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { runCmd, formatError, assertOk } from "./process.js";
import { container } from "./container.js";
import { GIT_OBJECT_ID, isGitObjectId, isGitSnapshot } from "./git-snapshot.js";
export { GIT_OBJECT_ID, isGitObjectId, isGitSnapshot } from "./git-snapshot.js";

export function captureGitSnapshot(root) {
  const result = runGit(["-C", root, "rev-parse", "HEAD"]);
  assertOk(result, "git rev-parse HEAD failed while capturing Git snapshot");
  const commit = result.stdout.trim();
  if (commit === "") return { available: false, commit: null };
  if (!isGitObjectId(commit)) throw new Error("git rev-parse HEAD returned an invalid Git object id");
  return { available: true, commit };
}

/**
 * Run a git command and record a JSONL log entry via Logger.
 *
 * All "business" git operations (commit, push, diff, branch, merge, worktree, status, log, etc.)
 * SHOULD go through this wrapper instead of calling `runCmd("git", ...)` directly,
 * so they are uniformly logged.
 *
 * Exception: git invocations that the Logger itself depends on (repo top-level /
 * git-common-dir resolution in `cli.js`) MUST stay on `runCmd` to avoid recursion.
 *
 * @param {string[]} args - git argument array (without the leading "git")
 * @param {Object}   [opts] - same shape as runCmd opts
 * @returns {{ ok: boolean, status: number, stdout: string|Buffer, stderr: string|Buffer, signal: string|null, killed: boolean }}
 */
export function runGit(args, opts = {}) {
  const result = runCmd("git", args, opts);
  if (container.has("logger")) {
    container.get("logger").git({
      cmd: ["git", ...args],
      exitCode: result.status,
      stderr: Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr,
    });
  }
  return result;
}

export class GitCommitPathProbeError extends Error {
  constructor(result) {
    super(`git commit path probe failed: ${result.stderr || result.stdout || "unknown git error"}`);
    this.code = "GIT_COMMIT_PATH_PROBE_FAILED";
    this.result = result;
  }
}

export class GitCommitPathSet {
  constructor(paths) {
    if (
      !Array.isArray(paths)
      || paths.some((entry) => (
        typeof entry !== "string"
        || entry === ""
        || entry.includes("\0")
        || path.isAbsolute(entry)
        || path.normalize(entry) !== entry
        || entry === ".."
        || entry.startsWith(`..${path.sep}`)
      ))
      || new Set(paths).size !== paths.length
    ) {
      throw new Error("git commit path set is invalid");
    }
    this.paths = Object.freeze([...paths]);
    Object.freeze(this);
  }

  static resolve({ root, treeish, candidates }) {
    if (typeof root !== "string" || path.resolve(root) !== root) {
      throw new Error("git commit path root is invalid");
    }
    if (typeof treeish !== "string" || treeish === "") {
      throw new Error("git commit path treeish is invalid");
    }
    const candidateSet = new GitCommitPathSet(candidates);
    if (candidateSet.size === 0) return candidateSet;
    const tracked = runGit([
      "-C",
      root,
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      "--name-only",
      treeish,
      "--",
      ...candidateSet.paths.map((relativePath) => `:(literal)${relativePath}`),
    ]);
    if (!tracked.ok) throw new GitCommitPathProbeError(tracked);
    const treePaths = new Set(tracked.stdout.split("\0").filter(Boolean));
    return new GitCommitPathSet(candidateSet.paths.filter((relativePath) => (
      treePaths.has(relativePath)
      || fs.existsSync(path.join(root, relativePath))
    )));
  }

  get size() {
    return this.paths.length;
  }

  toArray() {
    return [...this.paths];
  }
}

export class GitStatusPathSet {
  constructor(paths) {
    if (
      !Array.isArray(paths)
      || paths.some((entry) => typeof entry !== "string" || entry === "" || entry.includes("\0"))
    ) {
      throw new Error("git status path set is invalid");
    }
    this.paths = Object.freeze([...new Set(paths)]);
    Object.freeze(this);
  }

  static fromPorcelainV1Z(output) {
    const records = String(output || "").split("\0");
    const paths = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      if (record.length < 4 || record[2] !== " ") {
        throw new Error("git porcelain v1 -z entry is malformed");
      }
      const status = record.slice(0, 2);
      paths.push(record.slice(3));
      if (status.includes("R") || status.includes("C")) {
        const original = records[++index];
        if (!original) throw new Error("git porcelain rename/copy entry is incomplete");
        paths.push(original);
      }
    }
    return new GitStatusPathSet(paths);
  }

  static fromPorcelainV2Z(output) {
    return GitPorcelainV2Status.from(output).pathSet;
  }

  get size() {
    return this.paths.length;
  }

  every(predicate) {
    if (typeof predicate !== "function") throw new Error("git status path predicate is required");
    return this.paths.every(predicate);
  }

  toArray() {
    return [...this.paths];
  }
}

export class GitPorcelainV2StatusError extends Error {
  constructor(message) {
    super(message);
    this.code = "GIT_STATUS_PORCELAIN_V2_INVALID";
  }
}

const GIT_PORCELAIN_V2_MODES = new Set(["000000", "100644", "100755", "120000", "160000"]);

function porcelainV2Path(value, label) {
  if (
    typeof value !== "string"
    || value === ""
    || value.includes("\0")
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value === ".."
    || value.startsWith("../")
  ) {
    throw new GitPorcelainV2StatusError(`${label} is invalid`);
  }
  return value;
}

function porcelainV2Mode(value, label) {
  if (!GIT_PORCELAIN_V2_MODES.has(value)) {
    throw new GitPorcelainV2StatusError(`${label} is invalid`);
  }
  return Number.parseInt(value, 8);
}

function porcelainV2ObjectIds(values) {
  if (values.some((value) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))
    || new Set(values.map((value) => value.length)).size !== 1) {
    throw new GitPorcelainV2StatusError("git porcelain v2 object id is invalid");
  }
}

function porcelainV2SubmoduleState(value) {
  if (!/^(?:N\.\.\.|S[.C][.M][.U])$/.test(value)) {
    throw new GitPorcelainV2StatusError("git porcelain v2 submodule state is invalid");
  }
  return value;
}

/** One typed path observation from `git status --porcelain=v2 -z`. */
export class GitPorcelainV2StatusEntry {
  constructor({
    kind,
    path: relativePath,
    originalPath = null,
    indexStatus = ".",
    worktreeStatus = ".",
    submoduleState = "N...",
    renameScore = null,
    headMode = 0,
    indexMode = 0,
    worktreeMode = 0,
  } = {}) {
    if (!new Set(["ordinary", "renamed", "unmerged", "untracked"]).has(kind)) {
      throw new GitPorcelainV2StatusError("git porcelain v2 entry kind is invalid");
    }
    this.kind = kind;
    this.path = porcelainV2Path(relativePath, "git porcelain v2 path");
    this.originalPath = originalPath === null
      ? null
      : porcelainV2Path(originalPath, "git porcelain v2 original path");
    if ((kind === "renamed") !== (this.originalPath !== null)) {
      throw new GitPorcelainV2StatusError("git porcelain v2 rename path is invalid");
    }
    const xy = `${indexStatus}${worktreeStatus}`;
    if (kind === "ordinary" && (!/^[.MTAD]{2}$/.test(xy) || xy === "..")) {
      throw new GitPorcelainV2StatusError("git porcelain v2 ordinary status is invalid");
    }
    if (kind === "renamed") {
      const markers = [...xy].filter((status) => status === "R" || status === "C");
      const score = typeof renameScore === "string" ? /^([RC])([0-9]{1,3})$/.exec(renameScore) : null;
      if (!/^[.MTADRC]{2}$/.test(xy) || markers.length !== 1 || score === null
        || score[1] !== markers[0] || Number.parseInt(score[2], 10) > 100) {
        throw new GitPorcelainV2StatusError("git porcelain v2 rename/copy status is invalid");
      }
    }
    if (kind === "unmerged" && !new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]).has(xy)) {
      throw new GitPorcelainV2StatusError("git porcelain v2 unmerged status is invalid");
    }
    if (kind === "untracked" && xy !== "??") {
      throw new GitPorcelainV2StatusError("git porcelain v2 untracked status is invalid");
    }
    this.indexStatus = indexStatus;
    this.worktreeStatus = worktreeStatus;
    this.submoduleState = porcelainV2SubmoduleState(submoduleState);
    this.renameScore = renameScore;
    for (const [label, mode] of [["head", headMode], ["index", indexMode], ["worktree", worktreeMode]]) {
      if (!Number.isSafeInteger(mode) || mode < 0) throw new GitPorcelainV2StatusError(`git porcelain v2 ${label} mode is invalid`);
    }
    this.headMode = headMode;
    this.indexMode = indexMode;
    this.worktreeMode = worktreeMode;
    if (kind === "untracked" && (headMode !== 0 || indexMode !== 0 || worktreeMode !== 0
      || submoduleState !== "N..." || renameScore !== null)) {
      throw new GitPorcelainV2StatusError("git porcelain v2 untracked metadata is invalid");
    }
    Object.freeze(this);
  }

  paths() {
    return this.originalPath === null ? [this.path] : [this.path, this.originalPath];
  }
}

/** Complete typed parser result for the NUL-delimited porcelain v2 boundary. */
export class GitPorcelainV2Status {
  constructor(entries) {
    if (!Array.isArray(entries) || entries.some((entry) => !(entry instanceof GitPorcelainV2StatusEntry))) {
      throw new GitPorcelainV2StatusError("git porcelain v2 status entries are invalid");
    }
    const paths = entries.flatMap((entry) => entry.paths());
    if (new Set(paths).size !== paths.length) {
      throw new GitPorcelainV2StatusError("git porcelain v2 status paths are duplicate or ambiguous");
    }
    this.entries = Object.freeze([...entries]);
    this.pathSet = new GitStatusPathSet(paths);
    Object.freeze(this);
  }

  static from(output) {
    const bytes = Buffer.isBuffer(output) ? output : Buffer.from(String(output ?? ""), "utf8");
    if (bytes.length === 0) return new GitPorcelainV2Status([]);
    if (bytes.at(-1) !== 0) throw new GitPorcelainV2StatusError("git porcelain v2 -z output is not NUL terminated");
    const decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(bytes)) {
      throw new GitPorcelainV2StatusError("git porcelain v2 -z output is not valid UTF-8");
    }
    const records = decoded.slice(0, -1).split("\0");
    const entries = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      let match;
      if ((match = /^1 ([^ ])([^ ]) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([\s\S]+)$/.exec(record)) !== null) {
        porcelainV2ObjectIds([match[7], match[8]]);
        entries.push(new GitPorcelainV2StatusEntry({
          kind: "ordinary", path: match[9], indexStatus: match[1], worktreeStatus: match[2],
          submoduleState: match[3],
          headMode: porcelainV2Mode(match[4], "git porcelain v2 head mode"),
          indexMode: porcelainV2Mode(match[5], "git porcelain v2 index mode"),
          worktreeMode: porcelainV2Mode(match[6], "git porcelain v2 worktree mode"),
        }));
        continue;
      }
      if ((match = /^2 ([^ ])([^ ]) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([\s\S]+)$/.exec(record)) !== null) {
        const originalPath = records[++index];
        if (originalPath === undefined || originalPath === "") {
          throw new GitPorcelainV2StatusError("git porcelain v2 rename/copy entry is incomplete");
        }
        porcelainV2ObjectIds([match[7], match[8]]);
        entries.push(new GitPorcelainV2StatusEntry({
          kind: "renamed", path: match[10], originalPath,
          indexStatus: match[1], worktreeStatus: match[2],
          submoduleState: match[3], renameScore: match[9],
          headMode: porcelainV2Mode(match[4], "git porcelain v2 head mode"),
          indexMode: porcelainV2Mode(match[5], "git porcelain v2 index mode"),
          worktreeMode: porcelainV2Mode(match[6], "git porcelain v2 worktree mode"),
        }));
        continue;
      }
      if ((match = /^u ([^ ])([^ ]) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([\s\S]+)$/.exec(record)) !== null) {
        porcelainV2ObjectIds([match[8], match[9], match[10]]);
        entries.push(new GitPorcelainV2StatusEntry({
          kind: "unmerged", path: match[11], indexStatus: match[1], worktreeStatus: match[2],
          submoduleState: match[3],
          headMode: porcelainV2Mode(match[4], "git porcelain v2 head mode"),
          indexMode: porcelainV2Mode(match[5], "git porcelain v2 index mode"),
          worktreeMode: porcelainV2Mode(match[7], "git porcelain v2 worktree mode"),
        }));
        continue;
      }
      if (record.startsWith("? ")) {
        entries.push(new GitPorcelainV2StatusEntry({
          kind: "untracked", path: record.slice(2), indexStatus: "?", worktreeStatus: "?",
        }));
        continue;
      }
      throw new GitPorcelainV2StatusError("git porcelain v2 -z entry is malformed");
    }
    return new GitPorcelainV2Status(entries);
  }
}

/** Read the repository difference authority with executable-bit observation enabled. */
export function getPorcelainV2Status(cwd) {
  const result = runGit([
    "--no-optional-locks",
    "-c",
    "core.fileMode=true",
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ], { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (!result.ok) {
    const error = new Error(`git porcelain v2 status failed: ${result.stderr || result.stdout || "unknown git error"}`);
    error.code = "GIT_STATUS_PORCELAIN_V2_FAILED";
    error.result = result;
    throw error;
  }
  return GitPorcelainV2Status.from(result.stdout);
}

/**
 * Run Git with stdout directed to an exclusive caller-owned file. This keeps
 * large machine-readable listings off the process heap while preserving the
 * same logging authority as runGit().
 */
export function runGitToFile(args, { cwd, outputPath, timeout } = {}) {
  const descriptor = fs.openSync(outputPath, "wx", 0o600);
  let result;
  try {
    const processResult = spawnSync("git", args, {
      cwd,
      timeout,
      encoding: "utf8",
      stdio: ["ignore", descriptor, "pipe"],
      maxBuffer: 1024 * 1024,
    });
    result = {
      ok: processResult.status === 0 && !processResult.signal,
      status: processResult.status ?? 1,
      stdout: "",
      stderr: String(processResult.stderr || processResult.error?.message || ""),
      signal: processResult.signal ?? null,
      killed: Boolean(processResult.error && processResult.error.code === "ETIMEDOUT"),
    };
  } finally {
    fs.closeSync(descriptor);
  }
  if (container.has("logger")) {
    container.get("logger").git({ cmd: ["git", ...args], exitCode: result.status, stderr: result.stderr });
  }
  return result;
}

/** @returns {{ dirty: boolean, dirtyFiles: string[] }} */
export function getWorktreeStatus(cwd) {
  const res = runGit(["status", "--short"], { cwd });
  if (!res.ok) return { dirty: false, dirtyFiles: [] };
  const files = res.stdout.trim().split("\n").filter(Boolean);
  return { dirty: files.length > 0, dirtyFiles: files };
}

/** @returns {string|null} */
export function getCurrentBranch(cwd) {
  const res = runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return res.ok ? res.stdout.trim() : null;
}

/** @returns {number} */
export function getAheadCount(cwd, baseBranch) {
  const res = runGit(["rev-list", "--count", `${baseBranch}..HEAD`], { cwd });
  return res.ok ? parseInt(res.stdout.trim(), 10) || 0 : 0;
}

/**
 * Resolve the merge-base between HEAD and a base branch.
 *
 * @param {string} root - Repository root
 * @param {string} baseBranch - Base branch name or ref
 * @returns {string}
 */
export function resolveMergeBase(root, baseBranch) {
  const res = runGit(["merge-base", "HEAD", baseBranch], { cwd: root });
  if (!res.ok) {
    throw new Error(`git merge-base HEAD ${baseBranch} failed: ${res.stderr.trim()}`);
  }
  const sha = res.stdout.trim();
  if (!sha) {
    throw new Error(
      `git merge-base HEAD ${baseBranch} produced empty output (stderr: ${res.stderr.trim()})`,
    );
  }
  return sha;
}

/** @returns {string|null} */
export function getLastCommit(cwd) {
  const res = runGit(["log", "-1", "--oneline"], { cwd });
  return res.ok ? res.stdout.trim() : null;
}

/** @returns {boolean} */
export function isGhAvailable() {
  return runCmd("gh", ["--version"], { timeout: 5000 }).ok;
}

/**
 * Collect diff stat and commit messages between base and HEAD.
 * @param {string} root - Working directory
 * @param {string} baseBranch - Base branch name
 * @returns {{ diffStat: string, commitMessages: string[] }}
 */
export function collectGitSummary(root, baseBranch) {
  let diffStat = "";
  let commitMessages = [];
  const diffRes = runGit(["diff", "--stat", `${baseBranch}...HEAD`], { cwd: root });
  if (diffRes.ok) diffStat = diffRes.stdout.trim();
  const logRes = runGit(["log", "--format=%s", `${baseBranch}..HEAD`], { cwd: root });
  if (logRes.ok) commitMessages = logRes.stdout.trim().split("\n").filter(Boolean);
  return { diffStat, commitMessages };
}

/**
 * Fetch a branch from a remote. Non-throwing: returns runGit's result envelope.
 * @param {string} remote
 * @param {string} branch
 * @param {{cwd?: string}} [opts]
 */
export function fetchBranch(remote, branch, opts = {}) {
  return runGit(["fetch", remote, branch], opts);
}

/**
 * Run `git rebase <baseRef>`. Returns { ok: true } on success, or
 * { ok: false, reason, conflictFiles, stderr } on failure.
 * `reason` is "dirty" when the working tree has uncommitted changes
 * (rebase never started — no abort needed), or "conflict" for actual
 * merge conflicts (caller must call abortRebase()).
 * @param {string} baseRef
 * @param {{cwd?: string, autostash?: boolean}} [opts]
 */
export function rebaseOnto(baseRef, opts = {}) {
  const { autostash = false, ...runOpts } = opts;
  const res = runGit(["rebase", ...(autostash ? ["--autostash"] : []), baseRef], runOpts);
  if (res.ok) return { ok: true };
  const stderr = res.stderr || "";
  const isDirty = /unstaged changes|uncommitted changes/.test(stderr);
  if (isDirty) {
    return { ok: false, reason: "dirty", conflictFiles: [], stderr };
  }
  const statusRes = runGit(["diff", "--name-only", "--diff-filter=U"], runOpts);
  const conflictFiles = statusRes.ok
    ? statusRes.stdout.trim().split("\n").filter(Boolean)
    : [];
  return { ok: false, reason: "conflict", conflictFiles, stderr };
}

/** @param {{cwd?: string}} [opts] */
export function abortRebase(opts = {}) {
  return runGit(["rebase", "--abort"], opts);
}

/**
 * Count commits reachable from head but not from base (`git rev-list --count base..head`).
 *
 * Throws (via assertOk) when git itself fails — e.g. unresolvable ref, not a repo —
 * because those are programmer / environment errors that must be surfaced.
 * A legitimate "no commits in range" yields `0` via stdout, not a failure.
 *
 * @param {string} base
 * @param {string} head
 * @param {{cwd?: string}} [opts]
 * @returns {number}
 */
export function countCommitsBetween(base, head, opts = {}) {
  const res = runGit(["rev-list", "--count", `${base}..${head}`], opts);
  assertOk(res, `countCommitsBetween failed for ${base}..${head}`);
  const n = parseInt(res.stdout.trim(), 10);
  if (!Number.isFinite(n)) {
    throw new Error(
      `countCommitsBetween: unexpected non-numeric output for ${base}..${head}: ${JSON.stringify(res.stdout)}`,
    );
  }
  return n;
}

/**
 * List uncommitted (modified, added, untracked) files via `git status --porcelain`.
 *
 * Throws (via assertOk) when git itself fails. Empty output (no uncommitted files)
 * is a success and yields an empty array.
 *
 * @param {{cwd?: string}} [opts]
 * @returns {string[]}
 */
export function listUncommittedFiles(opts = {}) {
  const res = runGit(["status", "--porcelain"], opts);
  assertOk(res, "listUncommittedFiles failed");
  return res.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function normalizeStatus(rawStatus) {
  if (rawStatus === "??") return "untracked";
  if (rawStatus.includes("R")) return "renamed";
  if (rawStatus.includes("D")) return "deleted";
  if (rawStatus.includes("A")) return "added";
  return "modified";
}

function normalizeGitPath(p) {
  return p.replace(/^"|"$/g, "").split("\\").join("/");
}

function parsePorcelainLine(line) {
  const rawStatus = line.slice(0, 2);
  const body = line.slice(3).trim();
  const status = normalizeStatus(rawStatus);
  if (status === "renamed" && body.includes(" -> ")) {
    const [oldPath, newPath] = body.split(" -> ");
    return { status, old_path: normalizeGitPath(oldPath), path: normalizeGitPath(newPath) };
  }
  return { status, path: normalizeGitPath(body) };
}

export const DEFAULT_MAX_CHANGED_FILE_ENTRIES = 2000;

/**
 * List changed files with stable status details for regression evidence.
 *
 * Includes committed changes against baseBranch, working tree changes, and
 * untracked files. Returned entries are root-relative POSIX paths sorted by
 * path/status.
 *
 * @param {{cwd?: string, baseBranch?: string, untrackedFiles?: "normal"|"all", maxChangedFileEntries?: number}} [opts]
 * @returns {Array<{status:string,path:string,old_path?:string}>}
 */
export function listChangedFilesDetailed(opts = {}) {
  const cwd = opts.cwd;
  const maxChangedFileEntries = normalizeChangedFilesLimit(opts.maxChangedFileEntries);
  const untrackedFiles = normalizeUntrackedFilesMode(opts.untrackedFiles);
  const byKey = new Map();
  const add = (entry) => {
    if (!entry?.path) return;
    const key = `${entry.status}:${entry.old_path || ""}:${entry.path}`;
    byKey.set(key, entry);
    if (byKey.size > maxChangedFileEntries) {
      throw new Error(`listChangedFilesDetailed returned more than ${maxChangedFileEntries} entries`);
    }
  };

  if (opts.baseBranch) {
    const committed = runGit(["diff", "--name-status", `${opts.baseBranch}...HEAD`], { cwd });
    assertOk(committed, "listChangedFilesDetailed committed diff failed");
    for (const line of splitBoundedGitOutput(committed.stdout, maxChangedFileEntries, "committed diff")) {
      const parts = line.split("\t");
      if (parts[0]?.startsWith("R")) add({ status: "renamed", old_path: normalizeGitPath(parts[1]), path: normalizeGitPath(parts[2]) });
      else if (parts[0] === "A") add({ status: "added", path: normalizeGitPath(parts[1]) });
      else if (parts[0] === "D") add({ status: "deleted", path: normalizeGitPath(parts[1]) });
      else add({ status: "modified", path: normalizeGitPath(parts[1]) });
    }
  }

  const statusArgs = ["status", "--porcelain", `--untracked-files=${untrackedFiles}`];
  const porcelain = runGit(statusArgs, { cwd });
  assertOk(porcelain, "listChangedFilesDetailed status failed");
  for (const line of splitBoundedGitOutput(porcelain.stdout, maxChangedFileEntries, "status")) {
    add(parsePorcelainLine(line));
  }

  return [...byKey.values()].sort((a, b) => {
    const ap = `${a.path}:${a.status}:${a.old_path || ""}`;
    const bp = `${b.path}:${b.status}:${b.old_path || ""}`;
    return ap.localeCompare(bp);
  });
}

function normalizeChangedFilesLimit(value) {
  const limit = value ?? DEFAULT_MAX_CHANGED_FILE_ENTRIES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) {
    throw new Error("listChangedFilesDetailed maxChangedFileEntries must be a positive safe integer <= 10000");
  }
  return limit;
}

function normalizeUntrackedFilesMode(value) {
  const mode = value ?? "normal";
  if (mode !== "normal" && mode !== "all") {
    throw new Error("listChangedFilesDetailed untrackedFiles must be 'normal' or 'all'");
  }
  return mode;
}

function splitBoundedGitOutput(stdout, maxEntries, label) {
  const lines = stdout.split("\n").filter(Boolean);
  if (lines.length > maxEntries) {
    throw new Error(`listChangedFilesDetailed ${label} returned ${lines.length} entries (max ${maxEntries})`);
  }
  return lines;
}

/**
 * Post a comment to a GitHub issue.
 * @param {number|string} issueNumber
 * @param {string} body - Comment body text
 * @param {string} [cwd] - Working directory
 * @returns {{ ok: boolean, error?: string }}
 */
export function commentOnIssue(issueNumber, body, cwd) {
  const res = runCmd("gh", ["issue", "comment", String(issueNumber), "--body", body], {
    cwd,
    timeout: 30000,
  });
  return res.ok ? { ok: true } : { ok: false, error: formatError(res) };
}

/**
 * Post a report comment exactly once for a stable flow outbox identity.
 * A read failure is terminal because posting without proving absence could
 * duplicate a comment after a process crash.
 */
export function commentOnIssueOnce(issueNumber, body, cwd, idempotencyKey) {
  if (typeof idempotencyKey !== "string" || idempotencyKey === "") {
    throw new Error("issue comment idempotencyKey is required");
  }
  const marker = `<!-- sennel:${idempotencyKey} -->`;
  const existing = runCmd("gh", [
    "issue", "view", String(issueNumber),
    "--json", "comments",
    "--jq", ".comments[].body",
  ], { cwd, timeout: 30000 });
  if (!existing.ok) return { ok: false, error: formatError(existing) };
  if (existing.stdout.includes(marker)) return { ok: true, resumed: true };
  const posted = commentOnIssue(issueNumber, `${body}\n\n${marker}`, cwd);
  return posted.ok ? { ...posted, resumed: false } : posted;
}
