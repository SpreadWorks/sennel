import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/**
 * src/flow/lib/run-finalize-cleanup.js
 *
 * finalize-cleanup removes the selected worktree and feature branch, then
 * records completion in the shared base-side spec directory. The dispatcher
 * closes the runtime log and creates the target-spec + docs completion commit
 * after this command returns; only then is the active entry cleared.
 *
 * Recovery paths:
 *  - --auto-rescue: cherry-pick orphan commits onto baseBranch on the main
 *    repo, with detached-worktree fallback when baseBranch is locked, and
 *    `cherry-pick --skip` for empty-patch (duplicate) cases. Conflicts trigger
 *    `cherry-pick --abort` and CHERRY_PICK_CONFLICT halt.
 *  - --force: emit FORCED_ORPHAN_DROP warning, persist the dropped commit list
 *    to issue-log, then proceed to teardown.
 */

import fs from "fs";
import crypto from "node:crypto";
import os from "os";
import path from "path";
import { Envelope } from "../../lib/flow-envelope.js";
import { runGit } from "../../lib/git-helpers.js";
import { FlowCommand } from "./base-command.js";
import {
  commitFinalizeCompletion,
  writeLastFinalizedPointer,
} from "./run-finalize.js";
import { CanonicalLatestReport } from "./run-report-show.js";
import { flattenSteps } from "./step-tree.js";
import { FinalizeCleanupStateResolution } from "./finalize-cleanup-state.js";
import { FinalizeFlowStateOwner } from "./finalize-flow-state-owner.js";
import { IssueLogDocument } from "./issue-log-store.js";
import { issueLogStoreForVersion } from "./set-issue-log.js";
import {
  CanonicalFlowArtifactWrite,
  CurrentFlowVersionStore,
} from "./current-flow-state.js";
import { buildCurrentFlowDefinition } from "../definition.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { discoverFlowCommandHooks, runFlowCommandHooks } from "../../lib/plugin-registry.js";
import { AtomicJsonFile } from "../../lib/atomic-json-file.js";
import { PRODUCT } from "../../lib/product.js";
import {
  FlowOutboxStore,
  finalizationOutboxIdentity,
} from "./flow-outbox.js";
import { FlowCompletion } from "./flow-completion.js";
import {
  RepositoryFlowOperationLock,
  resolveRepositoryLockRoot,
} from "../../lib/repository-maintenance-lock.js";
import {
  WorktreeFlowBindingStore,
  WorktreeFlowIdentity,
} from "../../lib/worktree-flow-binding.js";
import { createLifecycleStepTransition } from "./lifecycle-step-transition.js";
import {
  DEFAULT_FLOW_SPEC_DIR,
  FlowSpecRoot,
  FlowWorkspace,
  flowStateSpecLocation,
} from "../../lib/flow-workspace.js";
import { FlowVersion } from "../../lib/flow-version.js";
import { deleteRepairBaselineForFlow } from "./repair-state-identity.js";

const ORPHAN_COMMIT_LIST_LIMIT = 50;
const SUBMODULE_DIAGNOSTIC_LIMIT = 50;
const SUBMODULE_ERROR_TEXT_LIMIT = 1000;
const RECOVERY_OPTIONS_DETECT = ["cherry-pick", "abort", "force-continue"];
const RECOVERY_OPTIONS_BASELINE = ["archive-and-manual-cherry-pick", "force-continue"];
const RECOVERY_OPTIONS_RESCUE_FAIL = ["archive-and-manual-cherry-pick", "retry-without-rescue"];
const RECOVERY_OPTIONS_DIRTY = ["commit-or-stash-first", "retry-without-rescue"];
const SUBMODULE_RECOVERY_OPTIONS_DIRTY = ["commit-or-stash-first", "clean-submodules-and-retry", "manual-remove-after-review"];
const SUBMODULE_RECOVERY_OPTIONS_STATUS = ["inspect-status-manually", "clean-submodules-and-retry", "manual-remove-after-review"];
const SUBMODULE_RECOVERY_OPTIONS_FORCE = ["inspect-worktree-manually", "manual-remove-after-review", "retry-after-fixing-git-error"];
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const AUTO_RESCUE_CLEANUP_VERSION = 6;
const AUTO_RESCUE_CLEANUP_PHASES = new Set([
  "staged",
  "worktree-added",
  "ref-update-prepared",
  "body-failed",
  "abort-failed",
  "base-updated",
  "worktree-materialized",
  "cleanup-failed",
  "completed",
]);

function requiredSpecLocation(state) {
  const location = flowStateSpecLocation(state);
  if (!location) throw new Error("finalize cleanup spec location is unavailable");
  return location;
}

function canonicalFlowLocation(repositoryRoot, specRoot, specId) {
  return new FlowWorkspace({
    repositoryRoot,
    executionRoot: repositoryRoot,
    specRoot,
  }).canonicalVersion(specId, new FlowVersion(1));
}

function assertExactObjectKeys(value, keys, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has an invalid schema`);
}

class FinalizeDroppedCommit {
  constructor({ sha, subject = null }) {
    if (!GIT_OBJECT_ID.test(String(sha))) throw new Error("forced finalize dropped commit.sha is invalid");
    if (subject != null && typeof subject !== "string") throw new Error("forced finalize dropped commit.subject is invalid");
    this.sha = sha;
    this.subject = subject;
    Object.freeze(this);
  }

  static fromStored(value) {
    assertExactObjectKeys(value, ["sha", "subject"], "forced finalize dropped commit");
    return new FinalizeDroppedCommit(value);
  }

  toJSON() {
    return { sha: this.sha, subject: this.subject };
  }
}

class FinalizeTeardownAuthorization {
  constructor({
    route,
    mergeStrategy,
    forceAuthorized,
    auditId,
    baseline,
    diverged,
    droppedCommits,
    droppedCount,
    droppedTruncated,
  }) {
    if (!new Set(["standard", "forced"]).has(route)) throw new Error("finalize authorization.route is invalid");
    if (![null, "pr", "squash"].includes(mergeStrategy)) throw new Error("finalize authorization.mergeStrategy is invalid");
    if (typeof forceAuthorized !== "boolean") throw new Error("finalize authorization.forceAuthorized is invalid");
    if (baseline != null && !GIT_OBJECT_ID.test(String(baseline))) throw new Error("finalize authorization.baseline is invalid");
    if (typeof diverged !== "boolean") throw new Error("finalize authorization.diverged is invalid");
    if (!Array.isArray(droppedCommits)) throw new Error("finalize authorization.droppedCommits is invalid");
    if (!Number.isSafeInteger(droppedCount) || droppedCount < droppedCommits.length) {
      throw new Error("finalize authorization.droppedCount is invalid");
    }
    if (typeof droppedTruncated !== "boolean") throw new Error("finalize authorization.droppedTruncated is invalid");
    if (route === "forced") {
      if (!forceAuthorized || typeof auditId !== "string" || auditId === "") {
        throw new Error("forced finalize authorization is incomplete");
      }
    } else if (forceAuthorized || auditId != null || baseline != null || diverged || droppedCount !== 0 || droppedTruncated || droppedCommits.length > 0) {
      throw new Error("standard finalize authorization contains forced provenance");
    }
    this.route = route;
    this.mergeStrategy = mergeStrategy;
    this.forceAuthorized = forceAuthorized;
    this.auditId = auditId;
    this.baseline = baseline;
    this.diverged = diverged;
    this.droppedCommits = Object.freeze(droppedCommits.map((commit) => (
      commit instanceof FinalizeDroppedCommit ? commit : new FinalizeDroppedCommit(commit)
    )));
    this.droppedCount = droppedCount;
    this.droppedTruncated = droppedTruncated;
    Object.freeze(this);
  }

  static standard(state) {
    return new FinalizeTeardownAuthorization({
      route: "standard",
      mergeStrategy: state.state?.mergeStrategy ?? null,
      forceAuthorized: false,
      auditId: null,
      baseline: null,
      diverged: false,
      droppedCommits: [],
      droppedCount: 0,
      droppedTruncated: false,
    });
  }

  static forced(state, input) {
    return new FinalizeTeardownAuthorization({
      route: "forced",
      mergeStrategy: state.state?.mergeStrategy ?? null,
      forceAuthorized: true,
      auditId: input.auditId,
      baseline: input.baseline ?? null,
      diverged: input.diverged === true,
      droppedCommits: input.droppedCommits ?? [],
      droppedCount: input.droppedCount ?? input.droppedCommits?.length ?? 0,
      droppedTruncated: input.droppedTruncated === true,
    });
  }

  static fromStored(value) {
    assertExactObjectKeys(value, [
      "route",
      "mergeStrategy",
      "forceAuthorized",
      "auditId",
      "baseline",
      "diverged",
      "droppedCommits",
      "droppedCount",
      "droppedTruncated",
    ], "finalize authorization");
    if (!Array.isArray(value.droppedCommits)) throw new Error("finalize authorization.droppedCommits is invalid");
    return new FinalizeTeardownAuthorization({
      ...value,
      droppedCommits: value.droppedCommits.map((commit) => FinalizeDroppedCommit.fromStored(commit)),
    });
  }

  toJSON() {
    return {
      route: this.route,
      mergeStrategy: this.mergeStrategy,
      forceAuthorized: this.forceAuthorized,
      auditId: this.auditId,
      baseline: this.baseline,
      diverged: this.diverged,
      droppedCommits: this.droppedCommits.map((commit) => commit.toJSON()),
      droppedCount: this.droppedCount,
      droppedTruncated: this.droppedTruncated,
    };
  }
}

function gitValue(root, args, label) {
  const result = runGit(["-C", root, ...args]);
  if (!result.ok) {
    throw new Error(`${label} could not be resolved: ${result.stderr || result.stdout || "unknown git error"}`);
  }
  return result.stdout.trim();
}

function gitFailure(code, message, result) {
  const error = new Error(`${message}: ${result.stderr || result.stdout || "unknown git error"}`);
  error.code = code;
  return error;
}

function assertInitialFinalizeGitAuthority({ targetRoot, state, worktreePath = null }) {
  const resolvedTargetRoot = fs.realpathSync(targetRoot);
  const headRef = gitValue(resolvedTargetRoot, ["symbolic-ref", "-q", "HEAD"], "finalize HEAD ref");
  const head = gitValue(resolvedTargetRoot, ["rev-parse", "HEAD"], "finalize parent");
  const baseRef = gitValue(resolvedTargetRoot, ["rev-parse", state.baseBranch], "finalize base ref");
  gitValue(resolvedTargetRoot, ["rev-parse", state.featureBranch], "finalize feature ref");
  if (headRef !== `refs/heads/${state.baseBranch}`) {
    throw new Error(`finalize HEAD must be the configured base branch: ${state.baseBranch}`);
  }
  if (head !== baseRef) throw new Error("finalize HEAD parent must equal the configured base ref");
  if (worktreePath != null) {
    const resolvedWorktreePath = fs.realpathSync(worktreePath);
    gitValue(resolvedWorktreePath, ["rev-parse", "HEAD"], "finalize worktree HEAD");
  }
}

function pathExistsStrict(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function assertPointerReality(reportRoot, specId) {
  const pointerPath = path.join(reportRoot, PRODUCT.managedPath("last-finalized-spec"));
  let stat;
  try {
    stat = fs.lstatSync(pointerPath);
  } catch (error) {
    throw new Error(`finalize persisted pointer reality is unavailable: ${error.message}`, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("finalize persisted pointer reality is not one real file");
  }
  if (fs.readFileSync(pointerPath, "utf8").trim() !== specId) {
    throw new Error("finalize persisted pointer reality targets a different spec");
  }
}

function ensureRealDirectory(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory && !fs.existsSync(parent)) ensureRealDirectory(parent);
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) {
    throw new Error(`finalize teardown recovery authority must be a real directory: ${directory}`);
  }
}

function buildReportField(mainRoot, specRoot) {
  // The embedded cleanup report is the same report-show text generated from
  // validated v2 test-execute-result/test-result-review artifacts, including
  // projectRegression data. Missing or malformed report data is surfaced as
  // REPORT_MISSING instead of fabricated.
  try {
    const report = CanonicalLatestReport.read({ mainRoot, specRoot, consumerNodeId: "finalize-cleanup" });
    return { report: { path: report.path, text: report.text() }, missing: null };
  } catch (err) {
    return { report: null, missing: err };
  }
}

function attachReport(env, mainRoot, specRoot) {
  const { report, missing } = buildReportField(mainRoot, specRoot);
  env.data.report = report;
  if (missing) {
    env.addWarning("REPORT_MISSING", missing.message);
  }
  return env;
}

class AutoRescueIssueLogAllowance {
  constructor({ mainRepoPath, specRoot, specId, idempotencyKey }) {
    this.mainRepoPath = mainRepoPath;
    this.location = canonicalFlowLocation(mainRepoPath, specRoot, specId);
    this.relativePath = this.location.relativeIssueLogFile;
    this.idempotencyKey = idempotencyKey;
  }

  allowsCurrentDocument() {
    if (typeof this.idempotencyKey !== "string" || this.idempotencyKey === "") return false;
    let current;
    try {
      current = issueLogStoreForVersion(this.location).read().document;
    } catch {
      return false;
    }
    const ownedEntries = current.entries.filter((entry) => (
      entry?.issueLogId === this.idempotencyKey || entry?.grantId === this.idempotencyKey
    ));
    if (ownedEntries.length !== 1) return false;
    current = new IssueLogDocument({
      entries: current.entries.filter((entry) => (
        entry?.issueLogId !== this.idempotencyKey && entry?.grantId !== this.idempotencyKey
      )),
    });

    const exists = runGit([
      "-C", this.mainRepoPath, "ls-tree", "--name-only", "--full-tree", "HEAD", "--", this.relativePath,
    ]);
    let committed;
    if (!exists.ok) return false;
    const committedPath = exists.stdout.trim();
    if (committedPath === this.relativePath) {
      const show = runGit(["-C", this.mainRepoPath, "show", `HEAD:${this.relativePath}`]);
      if (!show.ok) return false;
      try {
        committed = new IssueLogDocument(JSON.parse(show.stdout));
      } catch {
        return false;
      }
    } else if (committedPath === "") {
      committed = new IssueLogDocument({ entries: [] });
    } else {
      return false;
    }
    return JSON.stringify(current.toJSON()) === JSON.stringify(committed.toJSON());
  }
}

class FinalizeFlowMetadataAllowance {
  constructor({ mainRepoPath, specRoot, specId }) {
    this.mainRepoPath = mainRepoPath;
    this.specId = specId;
    this.location = canonicalFlowLocation(mainRepoPath, specRoot, specId);
    this.flowPaths = [
      this.location.relativeFlowStateFile,
      this.location.relativeActivitiesFile,
      this.location.relativeCatalogFile,
    ];
    this.issueLogPath = this.location.relativeIssueLogFile;
    this.versionStore = new CurrentFlowVersionStore({
      location: this.location,
      definition: buildCurrentFlowDefinition(),
    });
  }

  allowsCurrentFlowMetadata() {
    try {
      const snapshot = this.versionStore.loadSnapshot();
      return snapshot !== null && snapshot.state.specId === this.specId;
    } catch {
      return false;
    }
  }

  allowsCurrentIssueLogAppend() {
    let current;
    try {
      current = issueLogStoreForVersion(this.location).read().document;
    } catch {
      return false;
    }
    const exists = runGit([
      "-C", this.mainRepoPath, "ls-tree", "--name-only", "--full-tree", "HEAD", "--", this.issueLogPath,
    ]);
    if (!exists.ok) return false;
    let committed;
    if (exists.stdout.trim() === this.issueLogPath) {
      const show = runGit(["-C", this.mainRepoPath, "show", `HEAD:${this.issueLogPath}`]);
      if (!show.ok) return false;
      try {
        committed = new IssueLogDocument(JSON.parse(show.stdout));
      } catch {
        return false;
      }
    } else if (exists.stdout.trim() === "") {
      committed = new IssueLogDocument({ entries: [] });
    } else {
      return false;
    }
    if (current.entries.length <= committed.entries.length) return false;
    const committedPrefix = JSON.stringify(current.entries.slice(0, committed.entries.length));
    if (committedPrefix !== JSON.stringify(committed.entries)) return false;
    return current.entries.slice(committed.entries.length).every((entry) => (
      entry?.step === "finalize-cleanup" && typeof entry.issueLogId === "string" && entry.issueLogId !== ""
    ));
  }
}

/**
 * R14: a retry may ignore only the exact stable-ID audit mutation produced by
 * its prior CHERRY_PICK_CONFLICT halt. Any other issue-log edit remains dirty.
 */
function listMainRepoDirtyFiles(
  mainRepoPath,
  specId,
  allowedIssueLogId = null,
  { allowFinalizeMetadata = false, specRoot = DEFAULT_FLOW_SPEC_DIR } = {},
) {
  const location = canonicalFlowLocation(mainRepoPath, specRoot, specId);
  const issueLogPath = location.relativeIssueLogFile;
  const flowPaths = [
    location.relativeFlowStateFile,
    location.relativeActivitiesFile,
    location.relativeCatalogFile,
  ];
  const res = runGit([
    "-C",
    mainRepoPath,
    "status",
    "--porcelain",
    "--",
    ".",
    `:!${issueLogPath}`,
    ...flowPaths.map((flowPath) => `:!${flowPath}`),
  ]);
  if (!res.ok) {
    const error = new Error(`main repository status probe failed: ${res.stderr || res.stdout || "unknown Git error"}`);
    error.code = "MAIN_REPO_STATUS_FAILED";
    throw error;
  }
  const dirtyFiles = res.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3));
  const metadataAllowance = allowFinalizeMetadata
    ? new FinalizeFlowMetadataAllowance({ mainRepoPath, specRoot, specId })
    : null;
  for (const flowPath of flowPaths) {
    const flowStatus = runGit([
      "-C",
      mainRepoPath,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      flowPath,
    ]);
    if (!flowStatus.ok) {
      const error = new Error(`main repository Flow metadata status probe failed: ${flowStatus.stderr || flowStatus.stdout || "unknown Git error"}`);
      error.code = "MAIN_REPO_STATUS_FAILED";
      throw error;
    }
    if (flowStatus.stdout.trim() && !metadataAllowance?.allowsCurrentFlowMetadata()) {
      dirtyFiles.push(flowPath);
    }
  }
  const issueStatus = runGit([
    "-C",
    mainRepoPath,
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    issueLogPath,
  ]);
  if (!issueStatus.ok) {
    const error = new Error(`main repository issue-log status probe failed: ${issueStatus.stderr || issueStatus.stdout || "unknown Git error"}`);
    error.code = "MAIN_REPO_STATUS_FAILED";
    throw error;
  }
  if (issueStatus.stdout.trim()) {
    const allowance = new AutoRescueIssueLogAllowance({
      mainRepoPath,
      specRoot,
      specId,
      idempotencyKey: allowedIssueLogId,
    });
    if (!allowance.allowsCurrentDocument() && !metadataAllowance?.allowsCurrentIssueLogAppend()) {
      dirtyFiles.push(issueLogPath);
    }
  }
  return dirtyFiles;
}

function listOtherDirtyFlowJsonPaths(mainRepoPath, specRoot, specId) {
  const normalizedSpecRoot = FlowSpecRoot.from(specRoot).toString();
  const version = new FlowVersion(1);
  const stateArtifact = FLOW_ARTIFACT_CONTRACTS.resolve("flow.state").relativePath;
  const res = runGit([
    "-C",
    mainRepoPath,
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    `:(glob)${normalizedSpecRoot}/*/${version.pathSegment}/${stateArtifact}`,
  ]);
  if (!res.ok) {
    throw new Error(res.stderr || res.stdout || "git status failed");
  }
  const targetPath = canonicalFlowLocation(mainRepoPath, normalizedSpecRoot, specId).relativeFlowStateFile;
  const paths = [];
  const seen = new Set();
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    const relPath = line.slice(3).trim();
    if (!relPath || relPath === targetPath || seen.has(relPath)) continue;
    seen.add(relPath);
    paths.push(relPath);
  }
  return paths;
}

function attachOtherFlowMetadataWarning(env, mainRepoPath, specRoot, specId) {
  let paths;
  try {
    paths = listOtherDirtyFlowJsonPaths(mainRepoPath, specRoot, specId);
  } catch (err) {
    env.addWarning(
      "OTHER_FLOW_METADATA_STATUS_FAILED",
      `Failed to inspect other flow metadata dirtiness: ${err.message}`,
    );
    return env;
  }
  if (paths.length === 0) return env;
  env.addWarning(
    "OTHER_FLOW_METADATA_DIRTY",
    [
      "Other active flow metadata remains dirty in the main repository:",
      ...paths.map((p) => `  - ${p}`),
    ],
  );
  return env;
}

function boundedEntries(entries, limit = SUBMODULE_DIAGNOSTIC_LIMIT) {
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
  };
}

function boundedText(text, limit = SUBMODULE_ERROR_TEXT_LIMIT) {
  const s = String(text || "");
  return {
    text: s.length > limit ? s.slice(0, limit) : s,
    truncated: s.length > limit,
  };
}

function parsePorcelainPaths(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function statusFailure(scope, targetPath, res) {
  const stderr = boundedText(res.stderr || "");
  const stdout = boundedText(res.stdout || "");
  return {
    failure: {
      scope,
      path: targetPath,
      stderr: stderr.text,
      stdout: stdout.text,
    },
    truncated: stderr.truncated || stdout.truncated,
  };
}

function isSubmoduleWorktreeRemoveFailure(res) {
  const text = `${res.stdout || ""}\n${res.stderr || ""}`;
  return /working trees containing submodules cannot be moved or removed/i.test(text);
}

function listInitializedSubmodules(worktreePath, runGitFn = runGit) {
  const res = runGitFn(["-C", worktreePath, "submodule", "status"]);
  if (!res.ok) {
    const failure = statusFailure("submodule-list", worktreePath, res);
    return { ok: false, statusFailures: [failure.failure], truncated: failure.truncated };
  }
  const paths = res.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line[0] !== "-")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
  return { ok: true, paths };
}

function inspectSubmoduleWorktreeCleanliness(worktreePath, runGitFn = runGit) {
  let truncated = false;
  const rootStatus = runGitFn(["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"]);
  if (!rootStatus.ok) {
    const failure = statusFailure("worktree", worktreePath, rootStatus);
    return { ok: false, statusFailures: [failure.failure], truncated: failure.truncated };
  }

  const root = boundedEntries(parsePorcelainPaths(rootStatus.stdout));
  truncated = truncated || root.truncated;

  const submodules = listInitializedSubmodules(worktreePath, runGitFn);
  if (!submodules.ok) return submodules;

  const dirtySubmodules = [];
  const statusFailures = [];
  for (const submodulePath of submodules.paths) {
    const absPath = path.join(worktreePath, submodulePath);
    const res = runGitFn(["-C", absPath, "status", "--porcelain", "--untracked-files=all"]);
    if (!res.ok) {
      const failure = statusFailure("submodule", submodulePath, res);
      statusFailures.push(failure.failure);
      truncated = truncated || failure.truncated;
      continue;
    }
    const dirtyFiles = boundedEntries(parsePorcelainPaths(res.stdout));
    truncated = truncated || dirtyFiles.truncated;
    if (dirtyFiles.entries.length > 0) {
      dirtySubmodules.push({ path: submodulePath, dirtyFiles: dirtyFiles.entries });
    }
  }

  const failures = boundedEntries(statusFailures);
  truncated = truncated || failures.truncated;
  if (failures.entries.length > 0) {
    return { ok: false, statusFailures: failures.entries, truncated };
  }

  const dirtyModules = boundedEntries(dirtySubmodules);
  return {
    ok: true,
    dirtyRootFiles: root.entries,
    dirtySubmodules: dirtyModules.entries,
    dirty: root.entries.length > 0 || dirtyModules.entries.length > 0,
    truncated: truncated || dirtyModules.truncated,
  };
}

function worktreeDirtyEnvelope({ worktreePath, featureBranch, inspection }) {
  return Envelope.fail(
    "run",
    "finalize-cleanup",
    "WORKTREE_DIRTY",
    [
      "Worktree cleanup stopped because the worktree or an initialized submodule is dirty.",
      "Commit, stash, or remove the dirty changes, then retry finalize-cleanup.",
      "The worktree and feature branch were retained for recovery.",
    ],
    {
      worktreePath,
      featureBranch,
      dirtyRootFiles: inspection.dirtyRootFiles,
      dirtySubmodules: inspection.dirtySubmodules,
      truncated: inspection.truncated,
      recoveryOptions: SUBMODULE_RECOVERY_OPTIONS_DIRTY,
    },
  );
}

function worktreeStatusFailedEnvelope({ worktreePath, featureBranch, inspection }) {
  return Envelope.fail(
    "run",
    "finalize-cleanup",
    "WORKTREE_STATUS_FAILED",
    [
      "Worktree cleanup stopped because cleanliness could not be confirmed.",
      "Inspect the reported git status failure, clean the worktree or submodules, then retry finalize-cleanup.",
      "The worktree and feature branch were retained for recovery.",
    ],
    {
      worktreePath,
      featureBranch,
      statusFailures: inspection.statusFailures,
      truncated: inspection.truncated,
      recoveryOptions: SUBMODULE_RECOVERY_OPTIONS_STATUS,
    },
  );
}

function worktreeForceRemoveFailedEnvelope({ worktreePath, featureBranch, res }) {
  const stderr = boundedText(res.stderr || "");
  const stdout = boundedText(res.stdout || "");
  return Envelope.fail(
    "run",
    "finalize-cleanup",
    "WORKTREE_FORCE_REMOVE_FAILED",
    [
      "Worktree cleanup stopped because clean-confirmed force removal failed.",
      "Inspect the git error, resolve the worktree removal problem manually, then retry finalize-cleanup.",
      "Branch deletion was not attempted; the feature branch was retained for recovery.",
    ],
    {
      worktreePath,
      featureBranch,
      stderr: stderr.text,
      stdout: stdout.text,
      truncated: stderr.truncated || stdout.truncated,
      recoveryOptions: SUBMODULE_RECOVERY_OPTIONS_FORCE,
    },
  );
}

function preflightWorktreeRemoval({ worktreePath, featureBranch, authorizedDirtyRootFiles, runGit: runGitFn }) {
  const inspection = inspectSubmoduleWorktreeCleanliness(worktreePath, runGitFn);
  if (!inspection.ok) {
    return {
      ok: false,
      env: worktreeStatusFailedEnvelope({ worktreePath, featureBranch, inspection }),
    };
  }
  const authorizedPaths = new Set(authorizedDirtyRootFiles);
  const unauthorizedRootFiles = inspection.dirtyRootFiles
    .filter((filePath) => !authorizedPaths.has(filePath));
  if (inspection.truncated || unauthorizedRootFiles.length > 0 || inspection.dirtySubmodules.length > 0) {
    return {
      ok: false,
      env: worktreeDirtyEnvelope({
        worktreePath,
        featureBranch,
        inspection: {
          ...inspection,
          dirtyRootFiles: unauthorizedRootFiles,
          dirty: true,
        },
      }),
    };
  }
  return {
    ok: true,
    authorizedResiduePresent: inspection.dirtyRootFiles.length > 0,
  };
}

function removeGitWorktreeForCleanup({
  mainRepoPath,
  worktreePath,
  featureBranch,
  force,
  authorizedDirtyRootFiles = [],
  runGit: runGitFn,
}) {
  // --force is the caller's explicit authority to bypass normal dirty-tree
  // protection. Ordinary cleanup must prove its worktree is clean before the
  // first destructive Git operation.
  const preflight = force
    ? { ok: true, authorizedResiduePresent: false }
    : preflightWorktreeRemoval({
      worktreePath,
      featureBranch,
      authorizedDirtyRootFiles,
      runGit: runGitFn,
    });
  if (!preflight.ok) return preflight;

  const forceRemoval = force || preflight.authorizedResiduePresent;
  const removeArgs = ["-C", mainRepoPath, "worktree", "remove"];
  if (forceRemoval) removeArgs.push("--force");
  removeArgs.push(worktreePath);
  const removeRes = runGitFn(removeArgs);
  if (removeRes.ok) return { ok: true };

  const submoduleRemoval = isSubmoduleWorktreeRemoveFailure(removeRes);
  if (!submoduleRemoval) {
    return {
      ok: false,
      env: Envelope.fail("run", "finalize-cleanup", "WORKTREE_REMOVE_FAILED", [
        `git worktree remove failed: ${removeRes.stderr || removeRes.stdout || "unknown"}`,
        "Common cause: untracked files or uncommitted changes in the worktree.",
        "Resolve the dirty state and retry cleanup.",
      ]),
    };
  }

  if (forceRemoval) {
    return {
      ok: false,
      env: worktreeForceRemoveFailedEnvelope({ worktreePath, featureBranch, res: removeRes }),
    };
  }

  const forceRes = runGitFn(["-C", mainRepoPath, "worktree", "remove", "--force", worktreePath]);
  if (!forceRes.ok) {
    return {
      ok: false,
      env: worktreeForceRemoveFailedEnvelope({ worktreePath, featureBranch, res: forceRes }),
    };
  }
  return { ok: true };
}

function bindingFailure(code, error) {
  return {
    ok: false,
    env: Envelope.fail("run", "finalize-cleanup", code, error.message),
  };
}

function verifyExactWorktreeBinding(expectedBinding, missingBindingRecoveryAuthorized) {
  const store = new WorktreeFlowBindingStore({ worktreePath: expectedBinding.worktreePath });
  store.withLock(() => {
    if (!store.exists && missingBindingRecoveryAuthorized) return;
    const current = store.loadOwned().identity;
    if (!current.equals(expectedBinding)) {
      throw new Error("worktree flow binding changed before finalize teardown");
    }
  });
}

export function removeWorktreeForCleanup({
  mainRepoPath,
  worktreePath,
  featureBranch,
  force = false,
  runGit: runGitFn = runGit,
  expectedBinding = null,
  missingBindingRecoveryAuthorized = false,
  authorizedDirtyRootFiles = [],
}) {
  if (typeof missingBindingRecoveryAuthorized !== "boolean") {
    throw new Error("worktree cleanup missing-binding recovery authority must be boolean");
  }
  if (missingBindingRecoveryAuthorized && expectedBinding == null) {
    throw new Error("worktree cleanup missing-binding recovery requires an expected binding");
  }
  if (expectedBinding != null) {
    if (!(expectedBinding instanceof WorktreeFlowIdentity)) {
      throw new Error("worktree cleanup expected binding must be a worktree flow identity");
    }
    try {
      verifyExactWorktreeBinding(expectedBinding, missingBindingRecoveryAuthorized);
    } catch (error) {
      return bindingFailure("WORKTREE_FLOW_BINDING_REMOVE_FAILED", error);
    }
  }

  return removeGitWorktreeForCleanup({
    mainRepoPath,
    worktreePath,
    featureBranch,
    force,
    authorizedDirtyRootFiles,
    runGit: runGitFn,
  });
}

export function deleteFeatureBranchForCleanup({
  mainRepoPath,
  featureBranch,
  expectedSha,
  runGit: runGitFn = runGit,
}) {
  if (!GIT_OBJECT_ID.test(String(expectedSha))) throw new Error("feature branch deletion requires an expected OID");
  const ref = `refs/heads/${featureBranch}`;
  const worktrees = runGitFn(["-C", mainRepoPath, "worktree", "list", "--porcelain"]);
  if (!worktrees.ok) {
    return {
      ok: false,
      env: Envelope.fail("run", "finalize-cleanup", "BRANCH_DELETE_FAILED", [
        `Feature branch worktree ownership could not be verified: ${worktrees.stderr || worktrees.stdout || "unknown"}`,
      ]),
    };
  }
  if (worktrees.stdout.split("\n").some((line) => line === `branch ${ref}`)) {
    return {
      ok: false,
      env: Envelope.fail("run", "finalize-cleanup", "BRANCH_DELETE_FAILED", [
        `Feature branch is still checked out in a registered worktree: ${featureBranch}`,
      ]),
    };
  }
  const branchRes = runGitFn(["-C", mainRepoPath, "update-ref", "-d", ref, expectedSha]);
  if (!branchRes.ok) {
    const current = runGitFn(["-C", mainRepoPath, "rev-parse", "--verify", ref]);
    if (!current.ok) return { ok: true };
    return {
      ok: false,
      env: Envelope.fail("run", "finalize-cleanup", "BRANCH_DELETE_FAILED", [
        `git update-ref -d ${ref} failed its expected-OID check: ${branchRes.stderr || branchRes.stdout || "unknown"}`,
      ]),
    };
  }
  return { ok: true };
}

export function recordFinalizeCleanupPostCommandMetadata({
  flowManager,
  specId,
  metrics = [],
  runtimeLog = null,
  notes = [],
  issueLogEntries = [],
  pluginArtifacts = [],
  report = null,
  recoveryEnvelope = null,
  operationOwnerToken = null,
} = {}) {
  if (!flowManager) throw new Error("flowManager is required");
  const specLocation = flowManager.specLocation(specId);
  const writtenPaths = [];
  const surfaces = new Set();
  const callerVisible = {};

  function appendCatalogedEntries(logicalKey, key, entries) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    let existing = [];
    try {
      const artifact = flowManager.readArtifact({
        specId,
        logicalKey,
        consumerNodeId: "finalize-cleanup",
        optional: true,
      });
      if (artifact !== null) {
        const current = JSON.parse(artifact.bytes.toString("utf8"));
        if (Array.isArray(current?.[key])) existing = current[key];
      }
    } catch (error) {
      throw new Error(`canonical finalize-cleanup ${logicalKey} is invalid: ${error.message}`, { cause: error });
    }
    return new CanonicalFlowArtifactWrite({
      logicalKey,
      mediaType: "application/json",
      bytes: `${JSON.stringify({ version: 1, [key]: [...existing, ...entries] }, null, 2)}\n`,
    });
  }

  const artifactWrites = [
    appendCatalogedEntries("finalize.cleanup.agent-metrics", "entries", metrics),
    appendCatalogedEntries("finalize.cleanup.notes", "entries", notes),
    appendCatalogedEntries("finalize.cleanup.plugin-artifacts", "artifacts", pluginArtifacts),
  ].filter(Boolean);
  if (artifactWrites.length > 0) {
    flowManager.publishArtifacts({
      specId,
      nodeId: "finalize-cleanup",
      artifactWrites,
    });
    for (const write of artifactWrites) writtenPaths.push(specLocation.resolve(write.artifact.relativePath));
    if (metrics.length > 0) surfaces.add("agent-metrics");
    if (notes.length > 0) surfaces.add("notes");
  }
  if (runtimeLog) {
    flowManager.writeRuntimeArtifact({
      specId,
      nodeId: "finalize-cleanup",
      artifact: {
        logicalKey: "finalize.cleanup.runtime-log",
        mediaType: "application/json",
        bytes: `${JSON.stringify({ version: 1, runtimeLog }, null, 2)}\n`,
      },
    });
    surfaces.add("runtime-log");
  }
  if (issueLogEntries.length > 0) {
    const timestamp = new Date().toISOString();
    issueLogStoreForVersion(specLocation, { operationOwnerToken }).appendMany(issueLogEntries.map((entry) => {
      const normalized = { ...entry, timestamp: entry?.timestamp || timestamp };
      const idempotencyKey = finalizeLifecycleIssueLogId(entry);
      return { entry: normalized, idempotencyKey };
    }));
    writtenPaths.push(specLocation.issueLogFile);
    surfaces.add("issue-log");
  }
  if (pluginArtifacts.length > 0) {
    callerVisible.plugin = {
      warnings: pluginArtifacts.flatMap((a) => a?.data?.warnings || []),
      followUps: pluginArtifacts.flatMap((a) => a?.data?.followUps || []),
      artifacts: pluginArtifacts,
    };
    surfaces.add("plugin-hook-output");
  }
  if (report) {
    // Envelopes are command-return values, not Flow evidence.  Keeping them
    // on disk created a second, non-catalog finalize authority.
    callerVisible.report = report;
  }
  if (recoveryEnvelope) {
    callerVisible.recoveryEnvelope = recoveryEnvelope;
  }

  return {
    writtenPaths,
    surfaces: [...surfaces],
    callerVisible,
  };
}

function finalizeLifecycleIssueLogId(entry) {
  return entry?.issueLogId || `finalize-cleanup-lifecycle-${crypto
    .createHash("sha256")
    .update(JSON.stringify(entry))
    .digest("hex")}`;
}

export function finalizeCleanupPluginLifecycleContext({ root, state, worktreePath, mainRepoPath, specId }) {
  const completion = new FlowCompletion(state).toJSON();
  const specLocation = requiredSpecLocation(state);
  const inCleanupWorktree = Boolean(state?.worktree && worktreePath && mainRepoPath);
  if (!inCleanupWorktree) {
    return {
      root,
      artifactRepositoryRoot: specLocation.repositoryRoot,
      flow: { ...state, completion, specRoot: specLocation.relativeRoot },
      artifactPath: specLocation.relativeDirectory,
    };
  }

  // Plugin hooks retain their existing artifact-root input contract.  The
  // bound Version location is already repository-relative; resolving a
  // made-up `plugin-artifacts` logical key would bypass the catalog contract
  // and fails for V1 because collection members require an exact path.
  const artifactPath = specLocation.relativeDirectory;
  return {
    root: worktreePath,
    artifactRepositoryRoot: mainRepoPath,
    flow: { ...state, completion, specRoot: specLocation.relativeRoot },
    artifactPath,
  };
}

function finalizeCleanupPrePluginLifecycleContext({ root, state, worktreePath, mainRepoPath, specId }) {
  return finalizeCleanupPluginLifecycleContext({ root, state, worktreePath, mainRepoPath, specId });
}

function canonicalPluginArtifactContext(context, flowManager, specId) {
  return {
    ...context,
    artifactReader: (request) => flowManager.readArtifact({
      specId,
      consumerNodeId: "flow",
      ...request,
    }),
    publishArtifacts(writes) {
      if (!Array.isArray(writes) || writes.length === 0) return;
      flowManager.publishPluginArtifacts({
        specId,
        artifactWrites: writes.map((write) => new CanonicalFlowArtifactWrite(write)),
      });
    },
  };
}

function finalizePluginLifecycleFailure(error) {
  return Envelope.fail(
    "run",
    "finalize-cleanup",
    "PLUGIN_LIFECYCLE_FAILED",
    `Plugin finalize-cleanup lifecycle failed: ${error.message}`,
    { causeCode: error.code || null, pluginLifecycle: error.outcome || null },
  );
}

function finalizeRequiredPluginHookFailure(pluginLifecycle) {
  return Envelope.fail(
    "run",
    "finalize-cleanup",
    "PLUGIN_HOOK_REQUIRED_FAILED",
    `Plugin finalize-cleanup lifecycle failed: ${pluginLifecycle.outcome?.failure?.message || "required plugin hook failed"}`,
    { pluginLifecycle },
  );
}

function composeFinalizePluginLifecycle(pre, post) {
  return {
    ok: post.ok,
    outcome: post.outcome.kind === "business-failure" ? post.outcome : pre.outcome,
    data: {
      pluginHooks: [...pre.hookData, ...post.hookData],
      followUps: [...pre.followUps, ...post.followUps],
    },
    warnings: [...pre.warnings, ...post.warnings],
    issueLogEntries: [...pre.issueLogEntries, ...post.issueLogEntries],
  };
}

/**
 * Plugin side effects are outside the finalize-cleanup transaction boundary.
 * A pre hook may inspect state and veto cleanup, but sennel does not snapshot or
 * restore files or external systems changed by the plugin. Plugins that choose
 * to mutate state own idempotency, retry, recovery, and cleanup for that work.
 */
async function runFinalizePreHooks(pluginContext, state) {
  let pluginPre;
  try {
    const hooks = await discoverFlowCommandHooks(pluginContext.root);
    pluginPre = await runFlowCommandHooks(pluginContext.root, hooks, {
      command: "finalize-cleanup",
      hook: "pre",
      flow: pluginContext.flow,
      result: {},
      artifactRepositoryRoot: pluginContext.artifactRepositoryRoot || pluginContext.root,
      artifactReader: pluginContext.artifactReader,
    });
  } catch (err) {
    return { ok: false, env: finalizePluginLifecycleFailure(err) };
  }
  if (!pluginPre.ok) {
    return { ok: false, env: finalizeRequiredPluginHookFailure(pluginPre) };
  }
  pluginContext.publishArtifacts?.(pluginPre.artifactWrites);
  return { ok: true, pluginPre };
}

/**
 * Post-hook side effects are plugin-owned as well. A required failure remains
 * typed and stops Flow completion, but does not roll back plugin artifacts or
 * core cleanup that already crossed its durable teardown boundaries.
 */
async function runFinalizePostHooks(pluginContext, state, pluginPre, result) {
  try {
    const hooks = await discoverFlowCommandHooks(pluginContext.root);
    const pluginPost = await runFlowCommandHooks(pluginContext.root, hooks, {
      command: "finalize-cleanup", hook: "post", flow: pluginContext.flow, result,
      artifactRepositoryRoot: pluginContext.artifactRepositoryRoot || pluginContext.root,
      artifactReader: pluginContext.artifactReader,
    });
    if (pluginPost.ok) pluginContext.publishArtifacts?.(pluginPost.artifactWrites);
    return { ok: true, pluginLifecycle: composeFinalizePluginLifecycle(pluginPre, pluginPost) };
  } catch (err) {
    return { ok: false, env: finalizePluginLifecycleFailure(err) };
  }
}

/**
 * R1/R3/R6: parse `git log --reverse <baseline>..<featureBranch>` output into
 * { sha, subject } pairs and apply the 50-commit cap.
 */
function readOrphanCommits(repoPath, baseline, featureBranch) {
  const res = runGit([
    "-C",
    repoPath,
    "log",
    "--reverse",
    "--pretty=format:%H%x09%s",
    `${baseline}..${featureBranch}`,
  ]);
  if (!res.ok) {
    return { ok: false, reason: res.stderr || res.stdout || "git log failed" };
  }
  const lines = res.stdout.split("\n").filter(Boolean);
  const total = lines.length;
  const slice = lines.slice(0, ORPHAN_COMMIT_LIST_LIMIT);
  const commits = slice.map((line) => {
    const tabIdx = line.indexOf("\t");
    if (tabIdx === -1) return { sha: line, subject: null };
    return { sha: line.slice(0, tabIdx), subject: line.slice(tabIdx + 1) };
  });
  return {
    ok: true,
    commits,
    count: total,
    truncated: total > ORPHAN_COMMIT_LIST_LIMIT,
  };
}

/**
 * R14/R15: append a single audit-log entry while keeping a snapshot of the
 * pre-write content so commit-time rollback restores the file exactly. Writes
 * unconditionally to the main repo (not the worktree, which may be deleted by
 * later teardown).
 */
function appendForcedFinalizeAudit(flowManager, state, authorization) {
  const droppedCommits = authorization.droppedCommits.map((commit) => commit.toJSON());
  flowManager.appendIssueLog({
    specId: state.specId,
    idempotencyKey: authorization.auditId,
    entry: {
      step: "finalize-cleanup",
      reason: "FORCED_ORPHAN_DROP: feature branch deleted via --force despite orphan / divergent state",
      trigger: "sennel flow run finalize-cleanup --force",
      resolution: droppedCommits.length > 0
        ? `dropped ${authorization.droppedCount} commit(s); top sha=${droppedCommits[0]?.sha?.slice(0, 12) || "n/a"}`
        : authorization.diverged
        ? "baseline diverged (history rewrite); branch deleted without rescue"
        : "baseline missing; branch deleted without rescue",
      droppedCommits,
      droppedCount: authorization.droppedCount,
      droppedTruncated: authorization.droppedTruncated,
      taskId: null,
      timestamp: new Date().toISOString(),
    },
  });
}

function attachForcedFinalizeContext(env, authorization) {
  if (!env.ok || authorization.route !== "forced") return env;
  env.data.droppedCommits = authorization.droppedCommits.map((commit) => commit.toJSON());
  env.data.count = authorization.droppedCount;
  env.data.truncated = authorization.droppedTruncated;
  env.data.forceAuthorization = {
    auditId: authorization.auditId,
    mergeStrategy: authorization.mergeStrategy,
    baseline: authorization.baseline,
    diverged: authorization.diverged,
  };
  env.addWarning("FORCED_ORPHAN_DROP", [
    `Feature branch deleted with --force despite ${authorization.droppedCount} unsaved commit(s).`,
    "The dropped commit list has been recorded in issue-log.json for audit.",
  ]);
  return env;
}

function finalizeAuditId(kind, state, details = {}) {
  return `finalize-cleanup-${crypto
    .createHash("sha256")
    .update(JSON.stringify({
      kind,
      runId: state.runId,
      specId: state.specId,
      issue: state.issue ?? null,
      ...details,
    }))
    .digest("hex")}`;
}

class AutoRescueAbortFailure {
  constructor({
    code = "CHERRY_PICK_ABORT_FAILED",
    status,
    stdout,
    stderr,
    signal,
    killed,
  }) {
    if (code !== "CHERRY_PICK_ABORT_FAILED") throw new Error("auto-rescue abort failure.code is invalid");
    if (status !== null && !Number.isInteger(status)) throw new Error("auto-rescue abort failure.status is invalid");
    if (typeof stdout !== "string" || typeof stderr !== "string") {
      throw new Error("auto-rescue abort failure output is invalid");
    }
    if (signal !== null && typeof signal !== "string") throw new Error("auto-rescue abort failure.signal is invalid");
    if (typeof killed !== "boolean") throw new Error("auto-rescue abort failure.killed is invalid");
    this.code = code;
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
    this.signal = signal;
    this.killed = killed;
    Object.freeze(this);
  }

  static fromGitResult(result) {
    return new AutoRescueAbortFailure({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      signal: result.signal,
      killed: result.killed,
    });
  }

  static fromStored(value) {
    assertExactObjectKeys(
      value,
      ["code", "status", "stdout", "stderr", "signal", "killed"],
      "auto-rescue abort failure",
    );
    return new AutoRescueAbortFailure(value);
  }

  toError() {
    const error = new Error(
      `cherry-pick abort failed: ${this.stderr || this.stdout || `git exited ${this.status}`}`,
    );
    error.code = this.code;
    error.gitResult = this.toJSON();
    return error;
  }

  toJSON() {
    return {
      code: this.code,
      status: this.status,
      stdout: this.stdout,
      stderr: this.stderr,
      signal: this.signal,
      killed: this.killed,
    };
  }
}

class AutoRescueOutcome {
  constructor({ ok, code = null, conflictFiles = [], abortFailure = null }) {
    if (typeof ok !== "boolean") throw new Error("auto-rescue outcome.ok is invalid");
    if (ok && code !== null) throw new Error("successful auto-rescue outcome cannot have a code");
    if (!ok && !["MAIN_REPO_LOCKED", "CHERRY_PICK_CONFLICT"].includes(code)) {
      throw new Error("failed auto-rescue outcome.code is invalid");
    }
    if (!Array.isArray(conflictFiles) || conflictFiles.some((entry) => typeof entry !== "string")) {
      throw new Error("auto-rescue outcome.conflictFiles is invalid");
    }
    const parsedAbortFailure = abortFailure == null
      ? null
      : abortFailure instanceof AutoRescueAbortFailure
        ? abortFailure
        : AutoRescueAbortFailure.fromStored(abortFailure);
    if (parsedAbortFailure && (ok || code !== "CHERRY_PICK_CONFLICT")) {
      throw new Error("auto-rescue abort failure requires a cherry-pick conflict outcome");
    }
    this.ok = ok;
    this.code = code;
    this.conflictFiles = Object.freeze([...conflictFiles]);
    this.abortFailure = parsedAbortFailure;
    Object.freeze(this);
  }

  static success() {
    return new AutoRescueOutcome({ ok: true });
  }

  static failure(code, conflictFiles = [], abortFailure = null) {
    return new AutoRescueOutcome({ ok: false, code, conflictFiles, abortFailure });
  }

  static fromStored(value) {
    assertExactObjectKeys(value, ["ok", "code", "conflictFiles", "abortFailure"], "auto-rescue outcome");
    return new AutoRescueOutcome(value);
  }

  static fromResult(value) {
    return value.ok
      ? AutoRescueOutcome.success()
      : AutoRescueOutcome.failure(value.code, value.conflictFiles || [], value.abortFailure || null);
  }

  toJSON() {
    return {
      ok: this.ok,
      code: this.code,
      conflictFiles: [...this.conflictFiles],
      abortFailure: this.abortFailure?.toJSON() ?? null,
    };
  }
}

class AutoRescueWorktreeAuthority {
  constructor({ worktreeDev, worktreeIno, gitDirPath, gitDirDev, gitDirIno, headSha }) {
    for (const [name, value] of Object.entries({ worktreeDev, worktreeIno, gitDirDev, gitDirIno })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`auto-rescue ${name} authority is invalid`);
    }
    if (typeof gitDirPath !== "string" || !path.isAbsolute(gitDirPath)) {
      throw new Error("auto-rescue git directory authority is invalid");
    }
    if (!GIT_OBJECT_ID.test(headSha)) throw new Error("auto-rescue worktree HEAD authority is invalid");
    this.worktreeDev = worktreeDev;
    this.worktreeIno = worktreeIno;
    this.gitDirPath = path.resolve(gitDirPath);
    this.gitDirDev = gitDirDev;
    this.gitDirIno = gitDirIno;
    this.headSha = headSha;
    Object.freeze(this);
  }

  static fromStored(value) {
    assertExactObjectKeys(
      value,
      ["worktreeDev", "worktreeIno", "gitDirPath", "gitDirDev", "gitDirIno", "headSha"],
      "auto-rescue worktree authority",
    );
    return new AutoRescueWorktreeAuthority(value);
  }

  sameGeneration(other) {
    const current = other instanceof AutoRescueWorktreeAuthority
      ? other
      : AutoRescueWorktreeAuthority.fromStored(other);
    return JSON.stringify(this.toJSON()) === JSON.stringify(current.toJSON());
  }

  toJSON() {
    return {
      worktreeDev: this.worktreeDev,
      worktreeIno: this.worktreeIno,
      gitDirPath: this.gitDirPath,
      gitDirDev: this.gitDirDev,
      gitDirIno: this.gitDirIno,
      headSha: this.headSha,
    };
  }
}

class AutoRescueWorktreeAuthoritySource {
  constructor(mainRepoPath) {
    this.mainRepoPath = path.resolve(mainRepoPath);
  }

  capture(worktreePath, expectedHeadSha = null) {
    const resolvedWorktree = path.resolve(worktreePath);
    const worktreeStat = fs.lstatSync(resolvedWorktree);
    if (
      !worktreeStat.isDirectory()
      || worktreeStat.isSymbolicLink()
      || fs.realpathSync(resolvedWorktree) !== resolvedWorktree
    ) {
      throw new Error("auto-rescue worktree generation is not a real directory");
    }
    const dotGitPath = path.join(resolvedWorktree, ".git");
    const dotGitStat = fs.lstatSync(dotGitPath);
    if (!dotGitStat.isFile() || dotGitStat.isSymbolicLink() || dotGitStat.nlink !== 1) {
      throw new Error("auto-rescue worktree Git pointer is not one real file");
    }
    const match = /^gitdir: (.+)\r?\n?$/.exec(fs.readFileSync(dotGitPath, "utf8"));
    if (!match) throw new Error("auto-rescue worktree Git pointer is malformed");
    const gitDirPath = path.resolve(path.dirname(dotGitPath), match[1]);
    const worktreesRoot = fs.realpathSync(path.join(this.mainRepoPath, ".git", "worktrees"));
    const realGitDirPath = fs.realpathSync(gitDirPath);
    if (path.dirname(realGitDirPath) !== worktreesRoot) {
      throw new Error("auto-rescue worktree Git directory is outside the repository authority");
    }
    const gitDirStat = fs.lstatSync(realGitDirPath);
    if (!gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) {
      throw new Error("auto-rescue worktree Git directory is not a real directory");
    }
    const headSha = fs.readFileSync(path.join(realGitDirPath, "HEAD"), "utf8").trim();
    if (expectedHeadSha !== null && headSha !== expectedHeadSha) {
      throw new Error("auto-rescue worktree HEAD differs from the expected generation");
    }
    return new AutoRescueWorktreeAuthority({
      worktreeDev: worktreeStat.dev,
      worktreeIno: worktreeStat.ino,
      gitDirPath: realGitDirPath,
      gitDirDev: gitDirStat.dev,
      gitDirIno: gitDirStat.ino,
      headSha,
    });
  }

  assertCurrent(worktreePath, expected) {
    const authority = expected instanceof AutoRescueWorktreeAuthority
      ? expected
      : AutoRescueWorktreeAuthority.fromStored(expected);
    if (!authority.sameGeneration(this.capture(worktreePath, authority.headSha))) {
      throw new Error("auto-rescue temporary worktree generation changed before cleanup");
    }
  }

  assertAbsent(worktreePath, expected) {
    if (!pathIsAbsent(worktreePath) || !pathIsAbsent(expected.gitDirPath)) {
      throw new Error("auto-rescue temporary worktree generation remains after cleanup");
    }
  }
}

class AutoRescueCleanupJournal {
  constructor({
    identity,
    phase,
    expectedBaseSha,
    expectedUpdatedSha = null,
    tempWorktreePath,
    worktreeAuthority = null,
    materializeBase,
    outcome,
    updatedAt,
  }) {
    assertExactObjectKeys(
      identity,
      [
        "mainRepoPath",
        "baseBranch",
        "baseline",
        "featureBranch",
        "specRoot",
        "specId",
        "allowedIssueLogId",
        "allowFinalizeMetadata",
      ],
      "auto-rescue cleanup identity",
    );
    if (identity.allowedIssueLogId !== null && (
      typeof identity.allowedIssueLogId !== "string" || identity.allowedIssueLogId === ""
    )) {
      throw new Error("auto-rescue issue-log allowance authority is invalid");
    }
    if (typeof identity.allowFinalizeMetadata !== "boolean") {
      throw new Error("auto-rescue finalize metadata allowance is invalid");
    }
    const specRoot = FlowSpecRoot.from(identity.specRoot).toString();
    if (!AUTO_RESCUE_CLEANUP_PHASES.has(phase)) throw new Error("auto-rescue cleanup phase is invalid");
    if (!GIT_OBJECT_ID.test(expectedBaseSha)) throw new Error("auto-rescue expected base OID is invalid");
    if (expectedUpdatedSha !== null && !GIT_OBJECT_ID.test(expectedUpdatedSha)) {
      throw new Error("auto-rescue expected updated OID is invalid");
    }
    if (typeof materializeBase !== "boolean") throw new Error("auto-rescue materialization authority is invalid");
    const parsedWorktreeAuthority = worktreeAuthority == null
      ? null
      : worktreeAuthority instanceof AutoRescueWorktreeAuthority
        ? worktreeAuthority
        : AutoRescueWorktreeAuthority.fromStored(worktreeAuthority);
    const temporaryRoot = path.resolve(os.tmpdir());
    const relativeTemp = path.relative(temporaryRoot, path.resolve(tempWorktreePath));
    if (
      relativeTemp === ""
      || relativeTemp.startsWith("..")
      || path.isAbsolute(relativeTemp)
      || !path.basename(tempWorktreePath).startsWith(PRODUCT.temporaryPrefix("rescue-tmp"))
    ) {
      throw new Error("auto-rescue temporary worktree authority is invalid");
    }
    const parsedOutcome = outcome == null
      ? null
      : outcome instanceof AutoRescueOutcome ? outcome : AutoRescueOutcome.fromStored(outcome);
    if (["staged", "worktree-added"].includes(phase) && parsedOutcome !== null) {
      throw new Error("unfinished auto-rescue cleanup journal cannot have an outcome");
    }
    if (
      !["staged", "body-failed", "cleanup-failed", "completed"].includes(phase)
      && parsedWorktreeAuthority == null
    ) {
      throw new Error("auto-rescue cleanup phase requires worktree generation authority");
    }
    if (phase === "body-failed" && parsedOutcome?.ok !== false) {
      throw new Error("body-failed auto-rescue cleanup journal needs a failed outcome");
    }
    if (phase === "abort-failed" && parsedOutcome?.abortFailure == null) {
      throw new Error("abort-failed auto-rescue cleanup journal needs an abort failure");
    }
    if (["base-updated", "worktree-materialized"].includes(phase) && parsedOutcome?.ok !== true) {
      throw new Error(`${phase} auto-rescue cleanup journal needs a successful outcome`);
    }
    if (phase === "completed" && parsedOutcome == null) {
      throw new Error("completed auto-rescue cleanup journal needs a terminal outcome");
    }
    if (phase === "ref-update-prepared" && (parsedOutcome?.ok !== true || expectedUpdatedSha == null)) {
      throw new Error("ref-update-prepared auto-rescue journal needs the successful expected OID");
    }
    if (typeof updatedAt !== "string" || updatedAt === "") throw new Error("auto-rescue cleanup timestamp is invalid");
    this.identity = Object.freeze({
      ...identity,
      mainRepoPath: path.resolve(identity.mainRepoPath),
      specRoot,
    });
    this.phase = phase;
    this.expectedBaseSha = expectedBaseSha;
    this.expectedUpdatedSha = expectedUpdatedSha;
    this.tempWorktreePath = path.resolve(tempWorktreePath);
    this.worktreeAuthority = parsedWorktreeAuthority;
    this.materializeBase = materializeBase;
    this.outcome = parsedOutcome;
    this.updatedAt = updatedAt;
  }

  static create(identity, expectedBaseSha, tempWorktreePath, materializeBase) {
    return new AutoRescueCleanupJournal({
      identity,
      phase: "staged",
      expectedBaseSha,
      expectedUpdatedSha: null,
      tempWorktreePath,
      worktreeAuthority: null,
      materializeBase,
      outcome: null,
      updatedAt: new Date().toISOString(),
    });
  }

  static fromStored(expectedIdentity, value) {
    assertExactObjectKeys(
      value,
      [
        "version", "identity", "phase", "expectedBaseSha", "expectedUpdatedSha",
        "tempWorktreePath", "worktreeAuthority", "materializeBase", "outcome", "updatedAt",
      ],
      "auto-rescue cleanup journal",
    );
    if (value.version !== AUTO_RESCUE_CLEANUP_VERSION) throw new Error("auto-rescue cleanup version is invalid");
    const journal = new AutoRescueCleanupJournal(value);
    if (JSON.stringify(journal.identity) !== JSON.stringify(expectedIdentity)) {
      throw new Error("auto-rescue cleanup journal targets a different authority");
    }
    return journal;
  }

  advance(phase, outcome = this.outcome, expectedUpdatedSha = this.expectedUpdatedSha) {
    const advanced = new AutoRescueCleanupJournal({
      identity: this.identity,
      phase,
      expectedBaseSha: this.expectedBaseSha,
      expectedUpdatedSha,
      tempWorktreePath: this.tempWorktreePath,
      worktreeAuthority: this.worktreeAuthority,
      materializeBase: this.materializeBase,
      outcome,
      updatedAt: new Date().toISOString(),
    });
    Object.assign(this, advanced);
  }

  recordWorktreeAuthority(authority) {
    this.worktreeAuthority = authority instanceof AutoRescueWorktreeAuthority
      ? authority
      : AutoRescueWorktreeAuthority.fromStored(authority);
  }

  toJSON() {
    return {
      version: AUTO_RESCUE_CLEANUP_VERSION,
      identity: this.identity,
      phase: this.phase,
      expectedBaseSha: this.expectedBaseSha,
      expectedUpdatedSha: this.expectedUpdatedSha,
      tempWorktreePath: this.tempWorktreePath,
      worktreeAuthority: this.worktreeAuthority?.toJSON() ?? null,
      materializeBase: this.materializeBase,
      outcome: this.outcome?.toJSON() ?? null,
      updatedAt: this.updatedAt,
    };
  }
}

class AutoRescueCleanupStore {
  constructor(identity) {
    this.identity = identity;
    const token = crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    this.directory = path.join(identity.mainRepoPath, ".git", "sennel", "recovery", "auto-rescue");
    ensureRealDirectory(this.directory);
    this.path = path.join(this.directory, `${token}.json`);
    this.file = new AtomicJsonFile(this.path);
  }

  load() {
    let stat;
    try {
      stat = fs.lstatSync(this.path);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(this.path) !== this.path) {
      throw new Error(`auto-rescue cleanup journal must be one real non-hardlinked file: ${this.path}`);
    }
    return AutoRescueCleanupJournal.fromStored(this.identity, this.file.read(null));
  }

  write(journal) {
    this.file.write(journal.toJSON());
  }

  remove() {
    fs.unlinkSync(this.path);
    const descriptor = fs.openSync(this.directory, "r");
    let primaryError = null;
    try {
      fs.fsyncSync(descriptor);
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        fs.closeSync(descriptor);
      } catch (cleanupError) {
        if (primaryError) {
          throw new AggregateError(
            [primaryError, cleanupError],
            "auto-rescue journal removal and descriptor cleanup both failed",
            { cause: primaryError },
          );
        }
        throw cleanupError;
      }
    }
    if (primaryError) throw primaryError;
  }
}

function autoRescueCleanupError(journal, result, { worktreeResidue = null } = {}) {
  const error = new Error(
    `temporary auto-rescue worktree cleanup failed: ${result.stderr || result.stdout || "unknown error"}`,
  );
  error.code = "AUTO_RESCUE_CLEANUP_FAILED";
  error.cleanupAuthority = {
    journalPath: null,
    tempWorktreePath: journal.tempWorktreePath,
    expectedBaseSha: journal.expectedBaseSha,
    expectedUpdatedSha: journal.expectedUpdatedSha,
    phase: journal.phase,
    residue: { worktree: worktreeResidue, journal: true },
  };
  return error;
}

function pathIsAbsent(filePath) {
  try {
    fs.lstatSync(filePath);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

function removeAutoRescueWorktree(runGitFn, journal, worktreeAuthoritySource) {
  const worktrees = runGitFn(["-C", journal.identity.mainRepoPath, "worktree", "list", "--porcelain"]);
  if (!worktrees.ok) return { ok: false, error: autoRescueCleanupError(journal, worktrees) };
  const registered = worktrees.stdout.split("\n").includes(`worktree ${journal.tempWorktreePath}`);
  if (registered) {
    if (journal.worktreeAuthority == null) {
      return {
        ok: false,
        error: autoRescueCleanupError(
          journal,
          { stderr: "registered temporary worktree has no durable generation authority" },
          { worktreeResidue: true },
        ),
      };
    }
    try {
      worktreeAuthoritySource.assertCurrent(journal.tempWorktreePath, journal.worktreeAuthority);
    } catch (error) {
      return {
        ok: false,
        error: autoRescueCleanupError(journal, { stderr: error.message }, { worktreeResidue: true }),
      };
    }
    const cleanupRes = runGitFn([
      "-C", journal.identity.mainRepoPath, "worktree", "remove", "--force", journal.tempWorktreePath,
    ]);
    if (!cleanupRes.ok) {
      return {
        ok: false,
        error: autoRescueCleanupError(journal, cleanupRes, { worktreeResidue: true }),
      };
    }
  } else {
    try {
      fs.lstatSync(journal.tempWorktreePath);
      return {
        ok: false,
        error: autoRescueCleanupError(
          journal,
          { stderr: "unregistered temporary path remains" },
          { worktreeResidue: true },
        ),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const verified = runGitFn(["-C", journal.identity.mainRepoPath, "worktree", "list", "--porcelain"]);
  let generationAbsent = true;
  if (journal.worktreeAuthority != null) {
    try {
      worktreeAuthoritySource.assertAbsent(journal.tempWorktreePath, journal.worktreeAuthority);
    } catch {
      generationAbsent = false;
    }
  }
  if (
    !verified.ok
    || verified.stdout.split("\n").includes(`worktree ${journal.tempWorktreePath}`)
    || !pathIsAbsent(journal.tempWorktreePath)
    || !generationAbsent
  ) {
    return {
      ok: false,
      error: autoRescueCleanupError(journal, verified, {
        worktreeResidue: verified.ok ? true : null,
      }),
    };
  }
  return { ok: true };
}

/**
 * R8/R9 auto-rescue cherry-pick driver. Returns one of:
 *   { ok: true, intoBranch, commits }                            — cherry-pick succeeded.
 *   { ok: false, code: "MAIN_REPO_DIRTY", dirtyFiles }           — preflight dirty.
 *   { ok: false, code: "MAIN_REPO_LOCKED" }                      — checkout & fallback both failed.
 *   { ok: false, code: "CHERRY_PICK_CONFLICT", conflictFiles }   — cherry-pick conflict, restored.
 */
function autoRescueIdentity({
  mainRepoPath,
  baseBranch,
  baseline,
  featureBranch,
  specRoot = DEFAULT_FLOW_SPEC_DIR,
  specId,
  allowedIssueLogId = null,
  allowFinalizeMetadata = false,
}) {
  return {
    mainRepoPath: path.resolve(mainRepoPath),
    baseBranch,
    baseline,
    featureBranch,
    specRoot: FlowSpecRoot.from(specRoot).toString(),
    specId,
    allowedIssueLogId,
    allowFinalizeMetadata,
  };
}

function autoRescueBodyError(outcome) {
  const primaryError = new Error(`auto-rescue body failed: ${outcome.code}`);
  primaryError.code = outcome.code;
  primaryError.conflictFiles = [...outcome.conflictFiles];
  if (!outcome.abortFailure) return primaryError;
  const abortError = outcome.abortFailure.toError();
  const error = new AggregateError(
    [primaryError, abortError],
    "auto-rescue cherry-pick and abort both failed",
    { cause: primaryError },
  );
  error.code = primaryError.code;
  error.conflictFiles = [...primaryError.conflictFiles];
  error.outcome = outcome.toJSON();
  return error;
}

function autoRescueRecoveryAuthority(store, journal, phase = journal.phase) {
  return {
    journalPath: store.path,
    tempWorktreePath: journal.tempWorktreePath,
    expectedBaseSha: journal.expectedBaseSha,
    phase,
    residue: { worktree: true, journal: true },
  };
}

function autoRescueCleanupFailure(store, journal, outcome, cleanupError) {
  journal.advance("cleanup-failed", outcome);
  cleanupError.cleanupAuthority.journalPath = store.path;
  cleanupError.cleanupAuthority.phase = journal.phase;
  try {
    store.write(journal);
  } catch (authorityError) {
    const error = new AggregateError(
      [cleanupError, authorityError],
      "auto-rescue cleanup and durable recovery publication both failed",
      { cause: cleanupError },
    );
    error.code = cleanupError.code;
    error.cleanupAuthority = cleanupError.cleanupAuthority;
    throw error;
  }
  if (outcome?.ok === false) {
    const primaryError = autoRescueBodyError(outcome);
    const error = new AggregateError(
      [primaryError, cleanupError],
      "auto-rescue body and temporary worktree cleanup both failed",
      { cause: primaryError },
    );
    error.code = "AUTO_RESCUE_CLEANUP_FAILED";
    error.cleanupAuthority = cleanupError.cleanupAuthority;
    error.bodyCode = primaryError.code;
    throw error;
  }
  return {
    ok: false,
    code: "AUTO_RESCUE_CLEANUP_FAILED",
    cleanupAuthority: cleanupError.cleanupAuthority,
  };
}

function completeAutoRescueCleanup(store, journal, outcome, runGitFn, worktreeAuthoritySource) {
  const cleanup = removeAutoRescueWorktree(runGitFn, journal, worktreeAuthoritySource);
  if (!cleanup.ok) return autoRescueCleanupFailure(store, journal, outcome, cleanup.error);
  if (outcome != null) {
    journal.advance("completed", outcome, journal.expectedUpdatedSha);
    try {
      store.write(journal);
    } catch (cause) {
      const cleanupError = autoRescueCleanupError(
        journal,
        { stderr: cause.message },
        { worktreeResidue: false },
      );
      cleanupError.cause = cause;
      return autoRescueCleanupFailure(store, journal, outcome, cleanupError);
    }
  } else {
    store.remove();
  }
  return outcome?.toJSON() ?? null;
}

function baseBranchIsCheckedOut(mainRepoPath, baseBranch) {
  try {
    return fs.readFileSync(path.join(mainRepoPath, ".git", "HEAD"), "utf8").trim()
      === `ref: refs/heads/${baseBranch}`;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function autoRescueAuthorityFailure(store, journal, message) {
  const error = new Error(message);
  error.code = "AUTO_RESCUE_CLEANUP_FAILED";
  error.cleanupAuthority = autoRescueRecoveryAuthority(store, journal, journal.phase);
  return error;
}

function assertAutoRescueUpdatedRef(store, journal, runGitFn) {
  const baseRef = `refs/heads/${journal.identity.baseBranch}`;
  const current = runGitFn(["-C", journal.identity.mainRepoPath, "rev-parse", "--verify", baseRef]);
  if (!current.ok || current.stdout.trim() !== journal.expectedUpdatedSha) {
    throw autoRescueAuthorityFailure(store, journal, "auto-rescue updated base ref diverged from journal authority");
  }
}

function materializeAutoRescueBase(store, journal, runGitFn) {
  assertAutoRescueUpdatedRef(store, journal, runGitFn);
  if (!journal.materializeBase) return;
  const baseRef = `refs/heads/${journal.identity.baseBranch}`;
  const headRef = runGitFn(["-C", journal.identity.mainRepoPath, "symbolic-ref", "-q", "HEAD"]);
  if (!headRef.ok || headRef.stdout.trim() !== baseRef) {
    throw autoRescueAuthorityFailure(store, journal, "auto-rescue base checkout authority changed before materialization");
  }
  const oldIndex = runGitFn([
    "-C", journal.identity.mainRepoPath,
    "diff-index", "--cached", "--quiet", journal.expectedBaseSha, "--",
  ]);
  const updatedIndex = runGitFn([
    "-C", journal.identity.mainRepoPath,
    "diff-index", "--cached", "--quiet", journal.expectedUpdatedSha, "--",
  ]);
  if (oldIndex.ok) {
    const materialized = runGitFn([
      "-C", journal.identity.mainRepoPath,
      "read-tree", "-u", "-m", journal.expectedBaseSha, journal.expectedUpdatedSha,
    ]);
    if (!materialized.ok) {
      throw autoRescueAuthorityFailure(store, journal, "auto-rescue base checkout materialization failed");
    }
  } else if (!updatedIndex.ok) {
    throw autoRescueAuthorityFailure(store, journal, "auto-rescue caller index diverged before materialization");
  }
  const verifiedIndex = runGitFn([
    "-C", journal.identity.mainRepoPath,
    "diff-index", "--cached", "--quiet", journal.expectedUpdatedSha, "--",
  ]);
  let dirtyFiles;
  try {
    dirtyFiles = listMainRepoDirtyFiles(
      journal.identity.mainRepoPath,
      journal.identity.specId,
      journal.identity.allowedIssueLogId,
      {
        allowFinalizeMetadata: journal.identity.allowFinalizeMetadata,
        specRoot: journal.identity.specRoot,
      },
    );
  } catch {
    dirtyFiles = null;
  }
  if (!verifiedIndex.ok || dirtyFiles == null || dirtyFiles.length > 0) {
    throw autoRescueAuthorityFailure(store, journal, "auto-rescue base checkout materialization is not clean");
  }
}

function probeAutoRescueRefOid(mainRepoPath, baseRef, runGitFn) {
  const probe = runGitFn(["-C", mainRepoPath, "rev-parse", "--verify", baseRef]);
  return probe.ok ? probe.stdout.trim() : null;
}

export function runDetachedAutoRescue({
  mainRepoPath,
  baseBranch,
  baseline,
  featureBranch,
  specRoot = DEFAULT_FLOW_SPEC_DIR,
  specId,
  allowedIssueLogId = null,
  allowFinalizeMetadata = false,
  range,
  runGitFn = runGit,
  worktreeAuthoritySource = new AutoRescueWorktreeAuthoritySource(mainRepoPath),
  tempWorktreePathFactory = () => path.join(
    os.tmpdir(),
    `${PRODUCT.temporaryPrefix("rescue-tmp")}${process.pid}-${Date.now()}`,
  ),
}) {
  const identity = autoRescueIdentity({
    mainRepoPath,
    baseBranch,
    baseline,
    featureBranch,
    specRoot,
    specId,
    allowedIssueLogId,
    allowFinalizeMetadata,
  });
  const store = new AutoRescueCleanupStore(identity);
  const existing = store.load();
  if (existing) {
    if (existing.phase === "ref-update-prepared") {
      const baseRef = `refs/heads/${baseBranch}`;
      const current = runGitFn(["-C", mainRepoPath, "rev-parse", "--verify", baseRef]);
      const currentOid = current.ok ? current.stdout.trim() : null;
      if (currentOid === existing.expectedBaseSha) {
        const update = runGitFn([
          "-C", mainRepoPath, "update-ref", baseRef,
          existing.expectedUpdatedSha, existing.expectedBaseSha,
        ]);
        if (!update.ok) {
          const observedOid = probeAutoRescueRefOid(mainRepoPath, baseRef, runGitFn);
          if (observedOid === existing.expectedBaseSha) {
            const error = new Error("auto-rescue prepared ref update could not be resumed");
            error.code = "AUTO_RESCUE_CLEANUP_FAILED";
            error.cleanupAuthority = autoRescueRecoveryAuthority(store, existing, existing.phase);
            throw error;
          }
          if (observedOid !== existing.expectedUpdatedSha) {
            throw autoRescueAuthorityFailure(store, existing, "auto-rescue resumed ref update result is ambiguous");
          }
        }
      } else if (currentOid !== existing.expectedUpdatedSha) {
        const error = new Error("auto-rescue base ref diverged from both journaled OIDs");
        error.code = "AUTO_RESCUE_CLEANUP_FAILED";
        error.cleanupAuthority = autoRescueRecoveryAuthority(store, existing, existing.phase);
        throw error;
      }
      existing.advance("base-updated", existing.outcome, existing.expectedUpdatedSha);
      store.write(existing);
    }
    if (existing.phase === "base-updated") {
      materializeAutoRescueBase(store, existing, runGitFn);
      existing.advance("worktree-materialized", existing.outcome, existing.expectedUpdatedSha);
      store.write(existing);
    }
    if (["worktree-materialized", "completed"].includes(existing.phase) && existing.outcome?.ok) {
      assertAutoRescueUpdatedRef(store, existing, runGitFn);
    }
    const recoveredOutcome = existing.outcome;
    const recovered = completeAutoRescueCleanup(
      store,
      existing,
      recoveredOutcome,
      runGitFn,
      worktreeAuthoritySource,
    );
    if (recovered !== null) return recovered;
  }

  const baseRef = `refs/heads/${baseBranch}`;
  const baseProbe = runGitFn(["-C", mainRepoPath, "rev-parse", "--verify", baseRef]);
  if (!baseProbe.ok || !GIT_OBJECT_ID.test(baseProbe.stdout.trim())) {
    return AutoRescueOutcome.failure("MAIN_REPO_LOCKED").toJSON();
  }
  const expectedBaseSha = baseProbe.stdout.trim();
  const tempWorktreePath = tempWorktreePathFactory();
  const journal = AutoRescueCleanupJournal.create(
    identity,
    expectedBaseSha,
    tempWorktreePath,
    baseBranchIsCheckedOut(mainRepoPath, baseBranch),
  );
  store.write(journal);
  const addRes = runGitFn([
    "-C", mainRepoPath, "worktree", "add", "--detach", tempWorktreePath, expectedBaseSha,
  ]);
  if (!addRes.ok) {
    const outcome = AutoRescueOutcome.failure("MAIN_REPO_LOCKED");
    journal.advance("body-failed", outcome);
    store.write(journal);
    return completeAutoRescueCleanup(store, journal, outcome, runGitFn, worktreeAuthoritySource);
  }
  journal.recordWorktreeAuthority(worktreeAuthoritySource.capture(tempWorktreePath, expectedBaseSha));
  journal.advance("worktree-added");
  store.write(journal);

  let outcome;
  try {
    outcome = AutoRescueOutcome.fromResult(cherryPickRange(tempWorktreePath, range, runGitFn));
  } catch (primaryError) {
    if (primaryError.code !== "AUTO_RESCUE_CONFLICT_PROBE_FAILED") throw primaryError;
    const cleanup = completeAutoRescueCleanup(store, journal, null, runGitFn, worktreeAuthoritySource);
    if (cleanup?.ok === false) {
      const cleanupError = Object.assign(new Error("auto-rescue cleanup failed after Git probe failure"), {
        code: cleanup.code,
        cleanupAuthority: cleanup.cleanupAuthority,
      });
      throw new AggregateError(
        [primaryError, cleanupError],
        "auto-rescue Git probe and temporary worktree cleanup both failed",
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  journal.recordWorktreeAuthority(worktreeAuthoritySource.capture(tempWorktreePath));
  if (outcome.abortFailure) {
    journal.advance("abort-failed", outcome);
    try {
      store.write(journal);
    } catch (authorityError) {
      const bodyError = autoRescueBodyError(outcome);
      throw new AggregateError(
        [bodyError, authorityError],
        "auto-rescue abort failure and durable recovery publication both failed",
        { cause: bodyError },
      );
    }
    const error = autoRescueBodyError(outcome);
    error.cleanupAuthority = autoRescueRecoveryAuthority(store, journal);
    throw error;
  }
  if (outcome.ok) {
    const headRes = runGitFn(["-C", tempWorktreePath, "rev-parse", "HEAD"]);
    if (!headRes.ok || !GIT_OBJECT_ID.test(headRes.stdout.trim())) {
      outcome = AutoRescueOutcome.failure("MAIN_REPO_LOCKED");
    } else {
      const updatedSha = headRes.stdout.trim();
      journal.advance("ref-update-prepared", outcome, updatedSha);
      store.write(journal);
      const updateRes = runGitFn([
        "-C",
        mainRepoPath,
        "update-ref",
        baseRef,
        updatedSha,
        expectedBaseSha,
      ]);
      if (!updateRes.ok) {
        const observedOid = probeAutoRescueRefOid(mainRepoPath, baseRef, runGitFn);
        if (observedOid === updatedSha) {
          outcome = AutoRescueOutcome.success();
        } else if (observedOid === expectedBaseSha) {
          outcome = AutoRescueOutcome.failure("MAIN_REPO_LOCKED");
        } else {
          throw autoRescueAuthorityFailure(store, journal, "auto-rescue ref update result is ambiguous");
        }
      }
    }
  }
  journal.advance(outcome.ok ? "base-updated" : "body-failed", outcome);
  store.write(journal);
  if (outcome.ok) {
    materializeAutoRescueBase(store, journal, runGitFn);
    journal.advance("worktree-materialized", outcome, journal.expectedUpdatedSha);
    store.write(journal);
  }
  return completeAutoRescueCleanup(store, journal, outcome, runGitFn, worktreeAuthoritySource);
}

export function runAutoRescue({
  mainRepoPath,
  baseBranch,
  baseline,
  featureBranch,
  specRoot = DEFAULT_FLOW_SPEC_DIR,
  specId,
  allowedIssueLogId = null,
  allowFinalizeMetadata = false,
}) {
  const range = `${baseline}..${featureBranch}`;
  const identity = autoRescueIdentity({
    mainRepoPath,
    baseBranch,
    baseline,
    featureBranch,
    specRoot,
    specId,
    allowedIssueLogId,
    allowFinalizeMetadata,
  });
  const pendingCleanup = new AutoRescueCleanupStore(identity).load();
  if (pendingCleanup) {
    try {
      return runDetachedAutoRescue({
        mainRepoPath,
        baseBranch,
        baseline,
        featureBranch,
        specRoot,
        specId,
        range,
        allowedIssueLogId,
        allowFinalizeMetadata,
      });
    } catch (error) {
      if (error.code !== "AUTO_RESCUE_CLEANUP_FAILED") throw error;
      return {
        ok: false,
        code: error.code,
        bodyCode: error.bodyCode || null,
        cleanupAuthority: error.cleanupAuthority,
      };
    }
  }

  let dirtyFiles;
  try {
    dirtyFiles = listMainRepoDirtyFiles(mainRepoPath, specId, allowedIssueLogId, {
      allowFinalizeMetadata,
      specRoot,
    });
  } catch (error) {
    return { ok: false, code: error.code || "MAIN_REPO_STATUS_FAILED", message: error.message };
  }
  if (dirtyFiles.length > 0) {
    return { ok: false, code: "MAIN_REPO_DIRTY", dirtyFiles };
  }

  try {
    return runDetachedAutoRescue({
      mainRepoPath,
      baseBranch,
      baseline,
      featureBranch,
      specRoot,
      specId,
      range,
      allowedIssueLogId,
      allowFinalizeMetadata,
    });
  } catch (error) {
    if (error.code === "CHERRY_PICK_CONFLICT" && error.outcome?.abortFailure) {
      return { ...error.outcome, cleanupAuthority: error.cleanupAuthority };
    }
    if (error.code !== "AUTO_RESCUE_CLEANUP_FAILED") throw error;
    return {
      ok: false,
      code: error.code,
      bodyCode: error.bodyCode || null,
      cleanupAuthority: error.cleanupAuthority,
    };
  }
}

/**
 * Run `git cherry-pick <range>` with empty-patch tolerance. On the first
 * conflict, abort and return CHERRY_PICK_CONFLICT.
 */
function cherryPickRange(repoPath, range, runGitFn = runGit) {
  // --allow-empty makes `git cherry-pick` skip empty commits silently;
  // duplicate-content commits still need `--skip` recovery below.
  let res = runGitFn(["-C", repoPath, "cherry-pick", range]);
  while (!res.ok) {
    const text = `${res.stdout || ""}\n${res.stderr || ""}`;
    if (/nothing to commit|previous cherry-pick is now empty/i.test(text)) {
      // Duplicate / empty patch — skip and continue with the rest.
      const skip = runGitFn(["-C", repoPath, "cherry-pick", "--skip"]);
      if (!skip.ok) {
        // --skip itself may fail (no in-progress cherry-pick); abort defensively.
        const abort = runGitFn(["-C", repoPath, "cherry-pick", "--abort"]);
        const abortFailure = abort.ok ? null : AutoRescueAbortFailure.fromGitResult(abort);
        return AutoRescueOutcome.failure(
          "CHERRY_PICK_CONFLICT",
          [],
          abortFailure,
        ).toJSON();
      }
      // After --skip, git may have completed the sequence (skip succeeded with
      // nothing more to do) or be ready for the next commit. Probe with the
      // continuation form: another cherry-pick command is not needed — `--skip`
      // continues the in-progress sequence on its own.
      res = skip;
      // Determine whether a cherry-pick is still in progress; if not, we're done.
      const stateProbe = runGitFn(["-C", repoPath, "rev-parse", "--verify", "-q", "CHERRY_PICK_HEAD"]);
      if (!stateProbe.ok) {
        if (stateProbe.status === 1 && !stateProbe.stdout && !stateProbe.stderr) {
          // No in-progress cherry-pick → sequence completed.
          break;
        }
        const error = new Error(`cherry-pick state probe failed: ${stateProbe.stderr || stateProbe.stdout || "unknown Git error"}`);
        error.code = "AUTO_RESCUE_CHERRY_PICK_STATE_FAILED";
        throw error;
      }
      continue;
    }
    // Genuine conflict.
    const statusRes = runGitFn(["-C", repoPath, "diff", "--name-only", "--diff-filter=U"]);
    if (!statusRes.ok) {
      const primaryError = gitFailure(
        "AUTO_RESCUE_CONFLICT_PROBE_FAILED",
        "cherry-pick conflict file probe failed",
        statusRes,
      );
      const abort = runGitFn(["-C", repoPath, "cherry-pick", "--abort"]);
      if (!abort.ok) {
        const abortError = AutoRescueAbortFailure.fromGitResult(abort).toError();
        const error = new AggregateError(
          [primaryError, abortError],
          "auto-rescue conflict probe and abort both failed",
          { cause: primaryError },
        );
        error.code = primaryError.code;
        throw error;
      }
      throw primaryError;
    }
    const conflictFiles = statusRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    const abort = runGitFn(["-C", repoPath, "cherry-pick", "--abort"]);
    const abortFailure = abort.ok ? null : AutoRescueAbortFailure.fromGitResult(abort);
    return AutoRescueOutcome.failure(
      "CHERRY_PICK_CONFLICT",
      conflictFiles,
      abortFailure,
    ).toJSON();
  }
  return { ok: true };
}

function finalizeSyncWarning(state, outboxStore) {
  if (!(outboxStore instanceof FlowOutboxStore)) {
    throw new Error("finalize-sync warning requires the canonical outbox Store");
  }
  const identity = finalizationOutboxIdentity(state, "finalize-sync");
  const entry = outboxStore.status(identity);
  if (entry?.status !== "failed") return null;
  const failure = entry.latestFailure;
  return {
    code: failure?.code || "FINALIZE_SYNC_FAILED",
    message: entry.failure,
    recordedAt: failure?.recordedAt || entry.updatedAt,
    ...(failure?.code === "FINALIZE_SYNC_INTERRUPTED" ? { interrupted: true } : {}),
  };
}

export class RunFinalizeCleanupCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true });
  }

  async execute(ctx) {
    const mainRoot = ctx.mainRoot || ctx.flowManager?._mainRoot || ctx.root;
    const repositoryOperation = new RepositoryFlowOperationLock({
      mainRoot,
      operationOwnerToken: ctx.repositoryOperationOwnerToken || null,
    });
    let token;
    try {
      token = repositoryOperation.acquire();
    } catch (error) {
      if (["REPOSITORY_FLOW_OPERATION_BUSY", "REPOSITORY_MAINTENANCE_BUSY"].includes(error.code)) {
        return Envelope.fail("run", "finalize-cleanup", error.code, error.message, { lockPath: error.lockPath });
      }
      throw error;
    }
    let result;
    let primaryError = null;
    try {
      result = await this.executeOwned({
        ...ctx,
        repositoryOperationOwnerToken: token,
      });
    } catch (error) {
      primaryError = error;
    }
    let releaseError = null;
    try {
      repositoryOperation.release();
    } catch (error) {
      releaseError = error;
    }
    if (primaryError && releaseError) {
      throw new AggregateError(
        [primaryError, releaseError],
        "finalize operation and repository barrier release both failed",
        { cause: primaryError },
      );
    }
    if (primaryError) throw primaryError;
    if (releaseError) throw releaseError;
    return result;
  }

  async executeOwned(ctx) {
    const resolution = FinalizeCleanupStateResolution.resolve(ctx);
    if (resolution instanceof Envelope) return resolution;
    ctx = resolution.stateOwner.bindContext({
      ...ctx,
      flowState: resolution.state,
      finalizeCleanupStateResolution: resolution,
    });
    const { root, autoRescue, force } = ctx;
    const state = resolution.state;
    const { worktreePath, mainRepoPath } = resolution;
    const { baseBranch, featureBranch, worktree } = state;
    const specId = state.specId;
    const reportRoot = mainRepoPath || root;

    // ── Stage (A) — args validation ─────────────────────────────────────────
    if (autoRescue && force) {
      return Envelope.fail("run", "finalize-cleanup", "ARGS_ERROR", [
        "--auto-rescue and --force are mutually exclusive. Pass at most one.",
      ]);
    }

    const pluginContext = canonicalPluginArtifactContext(finalizeCleanupPrePluginLifecycleContext({
      root,
      state,
      worktreePath,
      mainRepoPath,
      specId,
    }), resolution.stateOwner.flowManager, specId);
    const preResult = await runFinalizePreHooks(pluginContext, state);
    if (!preResult.ok) return preResult.env;
    ctx = { ...ctx, finalizePluginContext: pluginContext, finalizePluginPre: preResult.pluginPre };

    if (featureBranch !== baseBranch) {
      const resumed = await runPersistedTeardownIfPresent(ctx, {
        worktreePath,
        mainRepoPath,
        reportRoot,
        specId,
      });
      if (resumed != null) return resumed;
      const targetRoot = (worktree && mainRepoPath) ? mainRepoPath : root;
      assertInitialFinalizeGitAuthority({
        targetRoot,
        state,
        worktreePath: worktree && mainRepoPath ? (worktreePath || root) : null,
      });
    }

    // Spec-only mode has no worktree or feature branch to remove, but shares
    // the same durable final-state and post-command commit boundary.
    if (featureBranch === baseBranch) {
      return runSharedSpecTeardown(ctx, {
        worktreePath: null,
        mainRepoPath: ctx.mainRoot || root,
        reportRoot,
        specId,
      });
    }

    // ── Stage (B) — route routing ───────────────────────────────────────────
    const mergeOutcome = new FlowOutboxStore(resolution.stateOwner.flowManager, { specId })
      .status(finalizationOutboxIdentity(state, "finalize-merge"))?.result ?? null;
    const persistedStrategy = mergeOutcome?.strategy ?? null;
    const baseline = mergeOutcome?.mergedFromSha ?? null;

    if (persistedStrategy === "pr") {
      // PR route — orphan detection is out of scope (Issue #316). Proceed
      // straight into the existing teardown transaction.
      return runTeardown(ctx, { worktreePath, mainRepoPath, reportRoot, specId });
    }

    if (persistedStrategy !== "squash") {
      // The canonical finalize-merge receipt is missing or corrupt. Halt unless
      // the user explicitly waives baseline checking via --force.
      if (!force) {
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          "SQUASH_BASELINE_MISSING",
          [
            "Squash baseline is not recorded in the canonical finalize-merge receipt.",
            "Detection cannot run safely. Recovery: archive the feature branch, inspect commits via patch, cherry-pick post-squash fixes onto baseBranch by hand, then re-run with --force.",
            "Resolve any cherry-pick state via `git cherry-pick --skip` or `git cherry-pick --abort` before retrying.",
          ],
          {
            recordedSha: null,
            baseBranch,
            featureBranch,
            recoveryOptions: RECOVERY_OPTIONS_BASELINE,
          },
        );
      }
      // --force path: skip detection, proceed to forced teardown with audit.
      return runForcedTeardown(ctx, {
        worktreePath,
        mainRepoPath,
        reportRoot,
        specId,
        baseline: null,
        featureBranch,
        baseBranch,
      });
    }

    // ── Stage (C) — orphan guard (squash route only) ────────────────────────
    if (!baseline) {
      if (!force) {
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          "SQUASH_BASELINE_MISSING",
          [
            "Squash baseline SHA is missing for this squash-route flow.",
            "Detection cannot run safely. Recovery: archive the feature branch, inspect commits via patch, cherry-pick post-squash fixes onto baseBranch by hand, then re-run with --force.",
          ],
          {
            recordedSha: null,
            baseBranch,
            featureBranch,
            recoveryOptions: RECOVERY_OPTIONS_BASELINE,
          },
        );
      }
      return runForcedTeardown(ctx, {
        worktreePath,
        mainRepoPath,
        reportRoot,
        specId,
        baseline: null,
        featureBranch,
        baseBranch,
      });
    }

    // R1: resolve the current featureBranch ref explicitly (NOT process HEAD;
    // in branch mode HEAD points at baseBranch by the time cleanup runs).
    const currentRes = runGit([
      "-C",
      mainRepoPath || root,
      "rev-parse",
      featureBranch,
    ]);
    if (!currentRes.ok) {
      return Envelope.fail("run", "finalize-cleanup", "BRANCH_REF_RESOLUTION_FAILED", [
        `Failed to resolve ref for ${featureBranch}: ${currentRes.stderr || currentRes.stdout}`,
      ]);
    }
    const currentSha = currentRes.stdout.trim();

    if (currentSha === baseline) {
      // No-op: feature branch unchanged since squash. Proceed to teardown.
      return runTeardown(ctx, { worktreePath, mainRepoPath, reportRoot, specId });
    }

    const ancestryRes = runGit([
      "-C",
      mainRepoPath || root,
      "merge-base",
      "--is-ancestor",
      baseline,
      featureBranch,
    ]);
    if (!ancestryRes.ok) {
      // Non-zero exit means baseline is NOT an ancestor of featureBranch
      // (history rewrite — rebase / amend / force-update).
      if (!force) {
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          "SQUASH_BASELINE_DIVERGED",
          [
            "Squash baseline is no longer an ancestor of the feature branch.",
            "This indicates a history rewrite (rebase / amend / force-update).",
            "Recovery: archive the current branch, inspect commits via patch, cherry-pick fixes onto baseBranch manually, then re-run with --force.",
          ],
          {
            recordedSha: baseline,
            currentSha,
            baseBranch,
            featureBranch,
            recoveryOptions: RECOVERY_OPTIONS_BASELINE,
          },
        );
      }
      return runForcedTeardown(ctx, {
        worktreePath,
        mainRepoPath,
        reportRoot,
        specId,
        baseline,
        featureBranch,
        baseBranch,
        diverged: true,
      });
    }

    // baseline is an ancestor and SHA differs → orphan commits exist.
    const orphan = readOrphanCommits(mainRepoPath || root, baseline, featureBranch);
    if (!orphan.ok) {
      return Envelope.fail("run", "finalize-cleanup", "ORPHAN_LISTING_FAILED", [
        `Failed to list orphan commits: ${orphan.reason}`,
      ]);
    }
    if (orphan.count === 0) {
      // Baseline differs from current SHA but the range is empty
      // (e.g. a merge commit with no exclusive commits). Treat as no-op.
      return runTeardown(ctx, { worktreePath, mainRepoPath, reportRoot, specId });
    }

    if (autoRescue) {
      const rescue = runAutoRescue({
        mainRepoPath: mainRepoPath || root,
        baseBranch,
        baseline,
        featureBranch,
        specRoot: requiredSpecLocation(state).relativeRoot,
        specId,
        allowedIssueLogId: finalizeAuditId("cherry-pick-conflict", state, { baseline, featureBranch }),
      });
      if (rescue.ok) {
        const teardown = await runTeardown(ctx, {
          worktreePath,
          mainRepoPath,
          reportRoot,
          specId,
        });
        if (teardown && teardown.data) {
          teardown.data.rescued = {
            commits: orphan.commits,
            intoBranch: baseBranch,
          };
        }
        return teardown;
      }
      // Rescue failed — record audit log for CHERRY_PICK_CONFLICT, halt.
      if (rescue.code === "CHERRY_PICK_CONFLICT" && mainRepoPath) {
        try {
          ctx.flowManager.appendIssueLog({
            specId: state.specId,
            idempotencyKey: finalizeAuditId("cherry-pick-conflict", state, { baseline, featureBranch }),
            entry: {
              step: "finalize-cleanup",
              reason: "cherry-pick conflict during auto-rescue (worktree retained for manual recovery)",
              trigger: "sennel flow run finalize-cleanup --auto-rescue",
              resolution: rescue.abortFailure
                ? "cherry-pick abort failed; durable temporary-worktree cleanup authority retained for retry"
                : "cherry-pick aborted; user must resolve manually via archive + individual cherry-pick",
              taskId: null,
              timestamp: new Date().toISOString(),
            },
          });
        } catch (err) {
          return Envelope.fail(
            "run",
            "finalize-cleanup",
            "ISSUE_LOG_AUDIT_FAILED",
            `Required cherry-pick conflict audit append failed: ${err.message}`,
            { originalCode: "CHERRY_PICK_CONFLICT", causeCode: err.code || null },
          );
        }
      }
      const failPayload = {
        recordedSha: baseline,
        currentSha,
        baseBranch,
        featureBranch,
        recoveryOptions: RECOVERY_OPTIONS_RESCUE_FAIL,
      };
      if (rescue.code === "MAIN_REPO_DIRTY") {
        failPayload.dirtyFiles = rescue.dirtyFiles;
        failPayload.recoveryOptions = RECOVERY_OPTIONS_DIRTY;
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          "MAIN_REPO_DIRTY",
          [
            "Main repository has uncommitted changes that block auto-rescue.",
            "Commit or stash them, then retry with --auto-rescue, or retry without rescue and rescue manually.",
          ],
          failPayload,
        );
      }
      if (rescue.code === "MAIN_REPO_LOCKED") {
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          "MAIN_REPO_LOCKED",
          [
            `Failed to acquire baseBranch ${baseBranch} for auto-rescue (locked and detached fallback failed).`,
            "Resolve worktree contention manually and retry, or rescue manually.",
          ],
          failPayload,
        );
      }
      if (rescue.code === "AUTO_RESCUE_CLEANUP_FAILED") {
        failPayload.cleanupAuthority = rescue.cleanupAuthority;
        failPayload.bodyCode = rescue.bodyCode || null;
        failPayload.recoveryOptions = ["retry-auto-rescue-cleanup", "inspect-temporary-worktree"];
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          rescue.code,
          [
            "Auto-rescue stopped because its temporary worktree cleanup was not verified.",
            "Retry with --auto-rescue to resume the durable cleanup authority before teardown.",
          ],
          failPayload,
        );
      }
      // CHERRY_PICK_CONFLICT
      failPayload.conflictFiles = rescue.conflictFiles || [];
      if (rescue.abortFailure) {
        failPayload.abortFailure = rescue.abortFailure;
        failPayload.cleanupAuthority = rescue.cleanupAuthority;
        failPayload.recoveryOptions = ["retry-auto-rescue-cleanup", "inspect-temporary-worktree"];
      }
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "CHERRY_PICK_CONFLICT",
        [
          "Cherry-pick of orphan commits onto baseBranch produced a conflict.",
          "The worktree and feature branch are retained for manual recovery.",
          rescue.abortFailure
            ? "Cherry-pick abort also failed; retry with --auto-rescue to resume the durable temporary-worktree cleanup authority."
            : "Resolve any cherry-pick state via `git cherry-pick --skip` or `git cherry-pick --abort` if your local state is left in an in-progress cherry-pick.",
        ],
        failPayload,
      );
    }

    if (force) {
      return runForcedTeardown(ctx, {
        worktreePath,
        mainRepoPath,
        reportRoot,
        specId,
        baseline,
        featureBranch,
        baseBranch,
        droppedCommits: orphan.commits,
        droppedCount: orphan.count,
        droppedTruncated: orphan.truncated,
      });
    }

    // Default: detect-and-halt with the canonical user-facing recovery menu.
    return Envelope.fail(
      "run",
      "finalize-cleanup",
      "ORPHAN_COMMITS_DETECTED",
      [
        `Orphan commits detected on ${featureBranch} (${orphan.count} commit(s) beyond the recorded squash baseline).`,
        "These commits are not reachable from the recorded squash baseline and would be dropped by branch deletion.",
        "Recovery options:",
        "  - cherry-pick: re-run with `--auto-rescue` to cherry-pick orphan commits onto baseBranch",
        "  - abort: leave the worktree and feature branch as-is and inspect/handle manually",
        "  - force-continue: re-run with `--force` to delete the branch (commits will be lost; recorded to issue-log)",
      ],
      {
        recordedSha: baseline,
        currentSha,
        count: orphan.count,
        truncated: orphan.truncated,
        orphanCommits: orphan.commits,
        baseBranch,
        featureBranch,
        recoveryOptions: RECOVERY_OPTIONS_DETECT,
      },
    );
  }
}

/**
 * Stage (D) — the original transactional teardown.
 * Extracted into a function so route routing and the no-op orphan path can
 * fall through to the same authoritative cleanup transaction.
 */
function createFinalizeCleanupCompletionTransition(stateOwner) {
  return createLifecycleStepTransition({
    flowState: stateOwner.loadReadOnly(),
    stepId: "finalize-cleanup",
    status: "done",
    event: "finalize-cleanup:complete",
    taskId: null,
  });
}

function completeFinalizeCleanupStep(stateOwner, operationOwnerToken) {
  const transition = createFinalizeCleanupCompletionTransition(stateOwner);
  if (!transition) return;
  stateOwner.updateStepStatus(transition, {
    operationOwnerToken,
  });
}

/**
 * `finalize-cleanup` is the last definition-owned leaf.  Completing that
 * Attempt is not itself a lifecycle transition: the Version Store keeps the
 * lifecycle fact as a separate typed Activity so a restart can distinguish a
 * completed cleanup from a finalized Flow.
 */
function finalizeCanonicalFlowIfComplete(stateOwner) {
  const state = stateOwner.loadReadOnly();
  if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION) {
    throw new Error("finalize cleanup requires a Version-1 Flow state");
  }
  if (state.lifecycle === "finalized") return state;
  stateOwner.flowManager.finalizeFlow(state.specId);
  return stateOwner.loadReadOnly();
}

const SHARED_FINALIZE_CLEANUP_PHASES = Object.freeze([
  "prepared",
  "worktree-removed",
  "branch-deleted",
  "validated",
  "pointer-written",
  "completed",
]);

class SharedFinalizeCleanupJournal {
  constructor({ file, value }) {
    this.file = file;
    this.value = value;
  }

  static open(state) {
    const location = requiredSpecLocation(state);
    const journalPath = location.artifact("finalize.cleanup.journal");
    // The journal is a transient Version artifact.  A fresh Version root owns
    // `.runtime`, but not every producer-specific child directory; establish
    // this typed artifact's parent before opening its atomic authority.
    fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o755 });
    const file = new AtomicJsonFile(journalPath);
    const stored = file.read(null);
    if (stored) {
      assertExactObjectKeys(stored, [
        "version",
        "runId",
        "specId",
        "featureBranch",
        "baseBranch",
        "worktreePath",
        "featureSha",
        "phase",
        "updatedAt",
      ], "shared finalize cleanup journal");
      if (
        stored.version !== 1
        || stored.runId !== state.runId
        || stored.specId !== state.specId
        || stored.featureBranch !== state.featureBranch
        || stored.baseBranch !== state.baseBranch
        || !SHARED_FINALIZE_CLEANUP_PHASES.includes(stored.phase)
        || !GIT_OBJECT_ID.test(String(stored.featureSha))
      ) {
        throw new Error("shared finalize cleanup journal does not match the active flow");
      }
    }
    return new SharedFinalizeCleanupJournal({ file, value: stored });
  }

  begin({ state, worktreePath, featureSha }) {
    if (this.value) return this;
    this.value = {
      version: 1,
      runId: state.runId,
      specId: state.specId,
      featureBranch: state.featureBranch,
      baseBranch: state.baseBranch,
      worktreePath: worktreePath || null,
      featureSha,
      phase: "prepared",
      updatedAt: new Date().toISOString(),
    };
    this.file.write(this.value);
    return this;
  }

  atLeast(phase) {
    return SHARED_FINALIZE_CLEANUP_PHASES.indexOf(this.value.phase)
      >= SHARED_FINALIZE_CLEANUP_PHASES.indexOf(phase);
  }

  advance(phase) {
    if (this.atLeast(phase)) return;
    const current = SHARED_FINALIZE_CLEANUP_PHASES.indexOf(this.value.phase);
    const next = SHARED_FINALIZE_CLEANUP_PHASES.indexOf(phase);
    if (next !== current + 1) throw new Error(`invalid shared finalize cleanup transition: ${this.value.phase} -> ${phase}`);
    this.value = { ...this.value, phase, updatedAt: new Date().toISOString() };
    this.file.write(this.value);
  }
}

function resolveFeatureSha(root, featureBranch) {
  const result = runGit(["-C", root, "rev-parse", `refs/heads/${featureBranch}`]);
  if (!result.ok || !GIT_OBJECT_ID.test(result.stdout.trim())) {
    throw new Error(`finalize feature branch could not be resolved: ${featureBranch}`);
  }
  return result.stdout.trim();
}

function sharedFinalizeCompletionData(state, pluginLifecycle, outboxStore) {
  const completion = new FlowCompletion(state);
  const receipt = completion.toJSON();
  const syncWarning = finalizeSyncWarning(state, outboxStore);
  return {
    data: {
      status: "done",
      ...(state.featureBranch === state.baseBranch ? { message: "spec-only mode" } : {}),
      ...(syncWarning ? { outcome: "completed_with_warnings", finalizeWarnings: [syncWarning] } : {}),
      assurance: completion.assurance,
      ...(receipt.advisorySummary && { advisorySummary: receipt.advisorySummary }),
      pluginHooks: pluginLifecycle.data?.pluginHooks || [],
      followUps: pluginLifecycle.data?.followUps || [],
    },
    syncWarning,
  };
}

function sharedFinalizeJournalReality(journal, { state, worktreePath, gitRoot, reportRoot, specId }) {
  if (journal.atLeast("worktree-removed")) {
    const validation = validateTeardown({
      worktreePath,
      mainRepoPath: gitRoot,
      featureBranch: state.featureBranch,
      specId,
      checkBranch: journal.atLeast("branch-deleted") && state.featureBranch !== state.baseBranch,
    });
    if (!validation.ok) {
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "FINALIZE_TEARDOWN_JOURNAL_DIVERGED",
        validation.reasons,
      );
    }
  }
  if (journal.atLeast("pointer-written")) {
    try {
      assertPointerReality(reportRoot, specId);
    } catch (error) {
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "FINALIZE_TEARDOWN_JOURNAL_DIVERGED",
        error.message,
      );
    }
  }
  return null;
}

async function runSharedSpecTeardown(ctx, { worktreePath, mainRepoPath, reportRoot, specId, authorization = null }) {
  const state = ctx.flowState;
  const gitRoot = mainRepoPath || ctx.root;
  const stateOwner = FinalizeFlowStateOwner.forMainContext({ ...ctx, specId });
  const journal = SharedFinalizeCleanupJournal.open(state);
  if (journal.value == null) {
    stateOwner.flowManager.assertFlowStateWritable(specId, {
      operationOwnerToken: ctx.repositoryOperationOwnerToken,
    });
  }
  const featureSha = journal.value?.featureSha || resolveFeatureSha(gitRoot, state.featureBranch);
  journal.begin({ state, worktreePath, featureSha });
  const journalDivergence = sharedFinalizeJournalReality(journal, {
    state,
    worktreePath,
    gitRoot,
    reportRoot,
    specId,
  });
  if (journalDivergence) return journalDivergence;

  if (authorization?.route === "forced" && !journal.atLeast("worktree-removed")) {
    try {
      appendForcedFinalizeAudit(stateOwner.flowManager, state, authorization);
    } catch (error) {
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "ISSUE_LOG_AUDIT_FAILED",
        `Forced finalize audit could not be recorded: ${error.message}`,
        { causeCode: error.code || null },
      );
    }
  }

  if (!journal.atLeast("worktree-removed")) {
    if (state.worktree && worktreePath && pathExistsStrict(worktreePath)) {
      const worktreeHead = runGit(["-C", worktreePath, "rev-parse", "HEAD"]);
      if (!worktreeHead.ok || worktreeHead.stdout.trim() !== journal.value.featureSha) {
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          "FINALIZE_WORKTREE_HEAD_CHANGED",
          `Managed worktree HEAD no longer matches ${state.featureBranch}; cleanup retained it for inspection.`,
          {
            expectedSha: journal.value.featureSha,
            actualSha: worktreeHead.ok ? worktreeHead.stdout.trim() : null,
          },
        );
      }
      const worktreeFlowManager = ctx.flowManager.forRoot(worktreePath, { specId });
      const expectedBinding = worktreeFlowManager.usesWorktreeFlowBinding()
        ? new WorktreeFlowIdentity({
            runId: state.runId,
            issue: state.issue ?? null,
            specId,
            worktreePath,
          })
        : null;
      const removed = removeWorktreeForCleanup({
        mainRepoPath: gitRoot,
        worktreePath,
        featureBranch: state.featureBranch,
        force: ctx.force === true,
        expectedBinding,
      });
      if (!removed.ok) return removed.env;
    } else if (state.worktree && worktreePath) {
      const validation = validateTeardown({
        worktreePath,
        mainRepoPath: gitRoot,
        featureBranch: state.featureBranch,
        specId,
        checkBranch: false,
      });
      if (!validation.ok) {
        return Envelope.fail("run", "finalize-cleanup", "WORKTREE_REMOVAL_RECOVERY_FAILED", validation.reasons);
      }
    }
    journal.advance("worktree-removed");
  }

  if (!journal.atLeast("branch-deleted")) {
    if (state.featureBranch !== state.baseBranch) {
      const branch = runGit(["-C", gitRoot, "rev-parse", "--verify", `refs/heads/${state.featureBranch}`]);
      if (branch.ok) {
        const deleted = deleteFeatureBranchForCleanup({
          mainRepoPath: gitRoot,
          featureBranch: state.featureBranch,
          expectedSha: journal.value.featureSha,
        });
        if (!deleted.ok) return deleted.env;
      }
    }
    journal.advance("branch-deleted");
  }

  if (!journal.atLeast("validated")) {
    const validation = validateTeardown({
      worktreePath,
      mainRepoPath: gitRoot,
      featureBranch: state.featureBranch,
      specId,
      checkBranch: state.featureBranch !== state.baseBranch,
    });
    if (!validation.ok) {
      return Envelope.fail("run", "finalize-cleanup", "TEARDOWN_VALIDATION_FAILED", validation.reasons);
    }
    journal.advance("validated");
  }

  if (!journal.atLeast("pointer-written")) {
    try {
      deleteRepairBaselineForFlow(gitRoot, state);
      writeLastFinalizedPointer(reportRoot, specId);
    } catch (error) {
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "FINALIZE_POINTER_WRITE_FAILED",
        `Finalize metadata cleanup failed: ${error.message}`,
        { causeCode: error.code || null },
      );
    }
    journal.advance("pointer-written");
  }

  let pluginLifecycle = { ok: true, warnings: [], issueLogEntries: [], data: {} };
  if (!journal.atLeast("completed")) {
    const pluginContext = ctx.finalizePluginContext || canonicalPluginArtifactContext(finalizeCleanupPrePluginLifecycleContext({
      root: ctx.root,
      state,
      worktreePath,
      mainRepoPath,
      specId,
    }), stateOwner.flowManager, specId);
    const preResult = ctx.finalizePluginPre
      ? { ok: true, pluginPre: ctx.finalizePluginPre }
      : await runFinalizePreHooks(pluginContext, state);
    if (!preResult.ok) return preResult.env;
    const pluginPre = preResult.pluginPre;
    const postResult = await runFinalizePostHooks(
      canonicalPluginArtifactContext(
        finalizeCleanupPluginLifecycleContext({ root: ctx.root, state, worktreePath, mainRepoPath, specId }),
        stateOwner.flowManager,
        specId,
      ),
      state,
      pluginPre,
      Envelope.ok("run", "finalize-cleanup", { status: "done" }),
    );
    if (!postResult.ok) return postResult.env;
    pluginLifecycle = postResult.pluginLifecycle;
    if (!pluginLifecycle.ok) return finalizeRequiredPluginHookFailure(pluginLifecycle);

    recordFinalizeCleanupPostCommandMetadata({
      flowManager: stateOwner.flowManager,
      specId,
      metrics: Array.isArray(state.metrics) ? state.metrics : [],
      runtimeLog: flattenSteps(state.steps || []).find((step) => step.id === "finalize-cleanup")?.runtimeLog || null,
      notes: Array.isArray(state.notes) ? state.notes : [],
      issueLogEntries: pluginLifecycle.issueLogEntries || [],
      pluginArtifacts: pluginLifecycle.data?.pluginHooks || [],
      operationOwnerToken: ctx.repositoryOperationOwnerToken,
    });
    completeFinalizeCleanupStep(stateOwner, ctx.repositoryOperationOwnerToken);
    const outbox = stateOwner.outbox({ operationOwnerToken: ctx.repositoryOperationOwnerToken });
    const identity = finalizationOutboxIdentity(state, "finalize-cleanup");
    outbox.begin(identity);
    const { data: completionData } = sharedFinalizeCompletionData(
      stateOwner.loadReadOnly(),
      pluginLifecycle,
      outbox,
    );
    outbox.complete(identity, completionData);
    // The last outbox receipt is durable before the Flow lifecycle becomes
    // immutable. This makes a crash in this boundary resumable without
    // reopening a finalized outbox or re-running the external teardown.
    finalizeCanonicalFlowIfComplete(stateOwner);
    journal.advance("completed");
  }

  const completedState = stateOwner.loadReadOnly();
  const { data: completionData, syncWarning } = sharedFinalizeCompletionData(
    completedState,
    pluginLifecycle,
    stateOwner.outbox(),
  );
  const env = attachReport(
    Envelope.ok("run", "finalize-cleanup", completionData),
    reportRoot,
    requiredSpecLocation(completedState).relativeRoot,
  );
  for (const warning of pluginLifecycle.warnings || []) {
    env.addWarning(warning.code || "PLUGIN_HOOK_WARNING", warning.message || JSON.stringify(warning));
  }
  if (syncWarning) {
    env.addWarning(
      "FINALIZE_SYNC_FAILED",
      `Documentation sync did not complete: ${syncWarning.message}. Run 'sennel flow run sync' after inspecting the recorded diagnostics.`,
    );
  }
  if (state.worktree && mainRepoPath) {
    attachOtherFlowMetadataWarning(env, mainRepoPath, requiredSpecLocation(completedState).relativeRoot, specId);
  }
  return env;
}

async function runTeardown(ctx, options) {
  return runSharedSpecTeardown(ctx, options);
}

async function runPersistedTeardownIfPresent(ctx, options) {
  const journalPath = requiredSpecLocation(ctx.flowState).artifact("finalize.cleanup.journal");
  return fs.existsSync(journalPath) ? runSharedSpecTeardown(ctx, options) : null;
}

export function commitFinalizeCleanupPostCommandMetadata({ flowManager, specId, writtenPaths = [] } = {}) {
  if (!flowManager) throw new Error("flowManager is required");
  if (!Array.isArray(writtenPaths)) throw new Error("writtenPaths must be an array");
  const specLocation = flowManager.specLocation(specId);
  const repositoryFlowManager = flowManager.forRoot(specLocation.repositoryRoot, { specId });
  const state = repositoryFlowManager.loadReadOnly(specId);
  if (!state) throw new Error(`flow state not found: ${specId}`);
  const root = specLocation.repositoryRoot;
  const identity = finalizationOutboxIdentity(state, "finalize-cleanup");
  const additionalPaths = writtenPaths.map((filePath) => path
    .relative(root, filePath)
    .split(path.sep)
    .join("/"));
  const operation = new RepositoryFlowOperationLock({ mainRoot: root });
  const operationOwnerToken = operation.acquire();
  try {
    const result = commitFinalizeCompletion({
      root,
      specRoot: specLocation.relativeRoot,
      specId,
      idempotencyKey: identity.idempotencyKey,
      additionalPaths,
    });
    repositoryFlowManager.removeActiveFlow(specId, { operationOwnerToken });
    return result;
  } finally {
    operation.release();
  }
}

/** Validate that teardown removed only the selected managed worktree state. */
export function validateTeardown({
  worktreePath,
  mainRepoPath,
  featureBranch,
  specId,
  checkBranch = true,
  runGit: runGitFn = runGit,
}) {
  const reasons = [];
  let probeFailed = false;

  if (mainRepoPath) {
    const wtListRes = runGitFn(["-C", mainRepoPath, "worktree", "list", "--porcelain"]);
    if (!wtListRes.ok) {
      probeFailed = true;
      reasons.push(`Git worktree validation probe failed: ${wtListRes.stderr || wtListRes.stdout || "unknown"}`);
    } else if (worktreePath) {
      const absPath = path.resolve(worktreePath);
      if (wtListRes.stdout.split("\n").some((line) => line === `worktree ${absPath}`)) {
        reasons.push(`Worktree registration remains for ${absPath}`);
      }
    }

    if (worktreePath && pathExistsStrict(worktreePath)) {
      reasons.push(`Physical worktree directory remains: ${worktreePath}`);
    }

    if (checkBranch) {
      const branchRes = runGitFn(["-C", mainRepoPath, "branch", "--list", featureBranch]);
      if (!branchRes.ok) {
        probeFailed = true;
        reasons.push(`Git branch validation probe failed: ${branchRes.stderr || branchRes.stdout || "unknown"}`);
      } else if (branchRes.stdout.trim()) {
        reasons.push(`Feature branch remains: ${featureBranch}`);
      }
    }
  }

  return { ok: reasons.length === 0, reasons, probeFailed };
}

export { runTeardown };

/**
 * --force teardown variant: persist a FORCED_ORPHAN_DROP audit entry to the
 * main repo issue-log before the existing teardown commits + deletes. The
 * audit entry is staged together with flow.json by runTeardown so the entire
 * destructive action lands in a single commit.
 */
async function runForcedTeardown(ctx, opts) {
  const state = ctx.flowState;
  const { baseline, featureBranch, baseBranch } = opts;
  const droppedCommits = opts.droppedCommits || [];
  const droppedCount = opts.droppedCount ?? droppedCommits.length;
  const droppedTruncated = opts.droppedTruncated ?? false;
  const auditId = finalizeAuditId("forced-orphan-drop", state, {
    baseline,
    featureBranch,
    droppedCommits: droppedCommits.map((commit) => commit.sha),
  });
  const authorization = FinalizeTeardownAuthorization.forced(state, {
    auditId,
    baseline,
    diverged: opts.diverged,
    droppedCommits,
    droppedCount,
    droppedTruncated,
  });
  const teardown = await runSharedSpecTeardown(ctx, { ...opts, authorization });
  if (!teardown.ok) {
    return teardown;
  }

  return teardown;
}

export default RunFinalizeCleanupCommand;
