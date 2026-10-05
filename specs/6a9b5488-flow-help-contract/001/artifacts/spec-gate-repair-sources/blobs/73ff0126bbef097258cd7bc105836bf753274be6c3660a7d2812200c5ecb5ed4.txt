/**
 * src/flow/lib/run-finalize.js
 *
 * Shared utilities for finalize sub-step commands
 * (run-finalize-commit, run-finalize-merge, run-finalize-sync, run-finalize-cleanup).
 */

import fs from "fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "path";
import { FlowTargetIdentityAuthority } from "../../lib/flow-target-identity-authority.js";
import { PRODUCT } from "../../lib/product.js";
import { runCmd, assertOk } from "../../lib/process.js";
import { findStepById } from "./step-tree.js";
import {
  runGit,
  countCommitsBetween,
  listUncommittedFiles,
} from "../../lib/git-helpers.js";
import { container } from "../../lib/container.js";
import { POINTER_REL_PATH as LAST_FINALIZED_SPEC_POINTER_REL_PATH } from "./run-report-show.js";
import {
  DEFAULT_FLOW_SPEC_DIR,
  FlowWorkspace,
} from "../../lib/flow-workspace.js";
import { FlowSpecId } from "../../lib/flow-spec-id.js";
import { FlowArtifactCatalogStore, FlowVersion } from "../../lib/flow-version.js";
import { FINALIZE_DOCUMENTATION_PATHS, FINALIZE_PRE_MERGE_DEFERRED_PATHS } from "./finalize-commit-paths.js";

const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function isCommittablePath(root, relativePath) {
  const tracked = runGit(["-C", root, "ls-files", "--", relativePath]);
  if (tracked.ok && tracked.stdout.trim() !== "") return true;
  const ignored = runGit(["-C", root, "check-ignore", "-q", "--", relativePath]);
  return !ignored.ok && fs.existsSync(path.join(root, relativePath));
}

export function finalizeOnError(stepName, trigger) {
  return (ctx, err) => {
    try {
      const entry = {
        step: stepName,
        reason: err.message || String(err),
        timestamp: new Date().toISOString(),
      };
      if (trigger) entry.trigger = trigger;
      if (err?.data?.diagnostics) entry.diagnostics = err.data.diagnostics;
      if (err?.data?.runtimeLog) entry.runtimeLog = err.data.runtimeLog;
      if (stepName === "finalize-merge") {
        const state = ctx.flowManager.loadReadOnly(ctx.specId);
        entry.downstream = Object.fromEntries(
          ["finalize-sync", "finalize-cleanup"].map((stepId) => [
            stepId,
            findStepById(state.steps, stepId)?.status ?? null,
          ]),
        );
      }
      const attempt = ctx.flowManager.canonicalState(ctx.specId).attempt?.sequence ?? 0;
      ctx.flowManager.appendIssueLog({
        specId: ctx.specId,
        entry,
        idempotencyKey: ctx.flowOutboxEntry?.idempotencyKey
          ?? `finalize-error-${ctx.flowState.runId}-${stepName}-${attempt}`,
      });
    } catch (e) { console.error("[issue-log hook]", e.message); }
  };
}

export function writeLastFinalizedPointer(targetRoot, specId) {
  if (!targetRoot || !specId) return;
  const literalSpecId = FlowSpecId.from(specId).toString();
  const pointerAbs = path.join(targetRoot, LAST_FINALIZED_SPEC_POINTER_REL_PATH);
  const directory = path.dirname(pointerAbs);
  const tempPath = path.join(directory, `.last-finalized-spec.${crypto.randomUUID()}.tmp`);
  fs.mkdirSync(directory, { recursive: true });
  let descriptor = null;
  let renamed = false;
  try {
    descriptor = fs.openSync(tempPath, "wx", 0o644);
    fs.writeFileSync(descriptor, literalSpecId + "\n");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, pointerAbs);
    renamed = true;
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
  } catch (error) {
    const cleanupErrors = [];
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (!renamed) {
      try { fs.unlinkSync(tempPath); } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `last-finalized pointer publication and cleanup both failed: ${pointerAbs}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export function commitOrSkip(args, opts) {
  const res = runGit(["commit", ...args], opts);
  if (res.ok) return { status: "done" };
  const output = res.stderr || res.stdout || "";
  if (/nothing to commit|no changes added to commit/i.test(output)) {
    return { status: "skipped", message: "nothing to commit" };
  }
  assertOk(res, "commit failed");
}

export function outboxCommitMarker(idempotencyKey) {
  if (typeof idempotencyKey !== "string" || idempotencyKey === "") {
    throw new Error("finalize commit idempotencyKey is required");
  }
  return `${PRODUCT.artifactMarker("outbox")}: ${idempotencyKey}`;
}

export function hasOutboxCommit({ root, ref, idempotencyKey }) {
  return findOutboxCommit({ root, ref, idempotencyKey }) !== null;
}

export function findOutboxCommit({ root, ref, idempotencyKey }) {
  if (!idempotencyKey) return null;
  const marker = outboxCommitMarker(idempotencyKey);
  const result = runGit([
    "-C", root,
    "log", "-1", "--format=%H%x00%B", "--fixed-strings", `--grep=${marker}`, ref,
  ]);
  if (!result.ok || !result.stdout.includes(marker)) return null;
  const commit = result.stdout.split("\0", 1)[0].trim();
  return GIT_OBJECT_ID.test(commit) ? commit : null;
}

function getFinalizeMergeAllowedMetadataPaths(root, specId, specRoot = DEFAULT_FLOW_SPEC_DIR) {
  const location = new FlowWorkspace({
    repositoryRoot: root,
    executionRoot: root,
    specRoot,
  }).canonicalVersion(specId, new FlowVersion(1));
  const specDirectory = location.relativeDirectory;
  const paths = [
    location.relativeFlowStateFile,
    location.relativeActivitiesFile,
    location.relativeCatalogFile,
    location.relativeIssueLogFile,
  ];
  return {
    paths,
    pathSet: new Set(paths),
    deferredPathSet: new Set(FINALIZE_PRE_MERGE_DEFERRED_PATHS),
    specDirectory,
  };
}

function isFinalizeManagedMetadataPath(dirtyPath, allowed) {
  return dirtyPath === PRODUCT.managedPath(".active-flow")
    || FlowTargetIdentityAuthority.managesRepositoryPath(dirtyPath)
    || dirtyPath === PRODUCT.managedPath("worktree")
    || dirtyPath.startsWith(`${PRODUCT.managedPath("worktree")}/`)
    || allowed.deferredPathSet.has(dirtyPath)
    || dirtyPath === allowed.specDirectory
    || dirtyPath.startsWith(`${allowed.specDirectory}/`);
}

function walkPorcelainStatusPaths(output, visit) {
  let index = 0;
  while (index < output.length) {
    const next = output.indexOf("\0", index);
    const end = next === -1 ? output.length : next;
    const record = output.slice(index, end);
    index = end + 1;
    if (!record) continue;

    const status = record.slice(0, 2);
    const relPath = record.slice(3);
    if (relPath && visit(relPath, status) === false) return;

    if (status.includes("R") || status.includes("C")) {
      const originalNext = output.indexOf("\0", index);
      const originalEnd = originalNext === -1 ? output.length : originalNext;
      const originalPath = output.slice(index, originalEnd);
      index = originalEnd + 1;
      if (originalPath && visit(originalPath, status) === false) return;
    }
  }
}

function readFinalizeMergeStatusOutput(root) {
  const res = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root });
  assertOk(res, "finalize-merge metadata preflight failed: git status failed");
  return res.stdout || "";
}

function buildFinalizeMergeMetadataPreflight(root, specId, dirtyPaths, specRoot = DEFAULT_FLOW_SPEC_DIR) {
  const allowed = getFinalizeMergeAllowedMetadataPaths(root, specId, specRoot);
  const metadataDirty = new Set();
  const externalDirtyPaths = [];
  for (const dirtyPath of dirtyPaths) {
    if (isFinalizeManagedMetadataPath(dirtyPath, allowed)) {
      if (allowed.pathSet.has(dirtyPath)) metadataDirty.add(dirtyPath);
    } else {
      externalDirtyPaths.push(dirtyPath);
    }
  }
  return {
    allowedMetadataPaths: allowed.paths,
    metadataDirtyPaths: allowed.paths.filter((relPath) => metadataDirty.has(relPath)),
    externalDirtyPaths,
  };
}

export function readFinalizeMergeMetadataPreflight({ root, specId, specRoot = DEFAULT_FLOW_SPEC_DIR }) {
  const allowed = getFinalizeMergeAllowedMetadataPaths(root, specId, specRoot);
  const metadataDirty = new Set();
  const externalDirtyPaths = [];
  walkPorcelainStatusPaths(readFinalizeMergeStatusOutput(root), (dirtyPath) => {
    if (isFinalizeManagedMetadataPath(dirtyPath, allowed)) {
      if (allowed.pathSet.has(dirtyPath)) metadataDirty.add(dirtyPath);
      return true;
    }
    externalDirtyPaths.push(dirtyPath);
    return false;
  });
  return {
    allowedMetadataPaths: allowed.paths,
    metadataDirtyPaths: allowed.paths.filter((relPath) => metadataDirty.has(relPath)),
    externalDirtyPaths,
  };
}

export function getFinalizeMergeTargetExternalDirtyPaths({ root, specId, specRoot = DEFAULT_FLOW_SPEC_DIR, dirtyPaths, preflight }) {
  if (preflight) return preflight.externalDirtyPaths;
  if (dirtyPaths) return buildFinalizeMergeMetadataPreflight(root, specId, dirtyPaths, specRoot).externalDirtyPaths;
  return readFinalizeMergeMetadataPreflight({ root, specId, specRoot }).externalDirtyPaths;
}

export function hasFinalizeMergeTargetExternalDirty({ root, specId, specRoot = DEFAULT_FLOW_SPEC_DIR, dirtyPaths, preflight }) {
  return getFinalizeMergeTargetExternalDirtyPaths({ root, specId, specRoot, dirtyPaths, preflight }).length > 0;
}

export function assertFinalizeMergeMetadataMutationSafe({ root, specId, specRoot = DEFAULT_FLOW_SPEC_DIR }) {
  const preflight = readFinalizeMergeMetadataPreflight({ root, specId, specRoot });
  if (preflight.externalDirtyPaths.length === 0) return preflight;

  const details = preflight.externalDirtyPaths.map((dirtyPath) => {
    const status = runGit(["status", "--short", "--", dirtyPath], { cwd: root });
    assertOk(status, `finalize-merge metadata preflight failed: git status failed for ${dirtyPath}`);
    return status.stdout.trim() || dirtyPath;
  });
  const error = new Error([
    "finalize-merge cannot mutate Flow metadata while external paths are dirty:",
    ...details,
    "Resolve the listed paths, then retry 'sennel flow run finalize-merge'.",
  ].join("\n"));
  error.code = "FINALIZE_MERGE_EXTERNAL_DIRTY";
  error.preflight = preflight;
  throw error;
}

export function commitFinalizeMergeMetadataIfSafe({
  root,
  specId,
  dirtyPaths,
  preflight,
  specRoot = DEFAULT_FLOW_SPEC_DIR,
  includeFlowJson = false,
  includeIssueLog = false,
  message = "chore: record finalize metadata before merge",
}) {
  const metadataPreflight = preflight
    || (dirtyPaths
      ? buildFinalizeMergeMetadataPreflight(root, specId, dirtyPaths, specRoot)
      : readFinalizeMergeMetadataPreflight({ root, specId, specRoot }));
  if (metadataPreflight.externalDirtyPaths.length > 0) {
    return {
      status: "skipped",
      reason: "target-external-dirty",
      dirtyPaths: metadataPreflight.externalDirtyPaths,
    };
  }

  const dirtySet = new Set(metadataPreflight.metadataDirtyPaths);
  if (includeFlowJson) dirtySet.add(metadataPreflight.allowedMetadataPaths[0]);
  if (includeIssueLog) dirtySet.add(metadataPreflight.allowedMetadataPaths[3]);
  const metadataPaths = metadataPreflight.allowedMetadataPaths
    .filter((relPath) => dirtySet.has(relPath))
    .filter((relPath) => isCommittablePath(root, relPath));
  if (metadataPaths.length === 0) {
    return { status: "skipped", reason: "no-metadata-dirty" };
  }

  const addRes = runGit(["add", "--", ...metadataPaths], { cwd: root });
  assertOk(addRes, "finalize-merge metadata preflight failed: git add failed");
  return {
    ...commitOrSkip(["-m", message], { cwd: root }),
    paths: metadataPaths,
  };
}

/**
 * Persist the complete Flow-owned evidence emitted by a failed normal
 * finalize-merge attempt.  The error lifecycle has already written the
 * failed outbox, issue-log entry, and downstream skip states when this runs;
 * this boundary deliberately stages no path outside the active spec.
 */
export function commitFinalizeMergeConflictMetadata({ root, specId, specRoot = DEFAULT_FLOW_SPEC_DIR, preflight }) {
  return commitFinalizeMergeMetadataIfSafe({
    root,
    specId,
    preflight,
    specRoot,
    includeFlowJson: true,
    includeIssueLog: true,
    message: "chore: record finalize metadata after conflict",
  });
}

class FinalizeCompletionCommit {
  constructor({ root, specRoot, specId, idempotencyKey, additionalPaths = [] }) {
    if (!root || !specId) throw new Error("finalize completion root and specId are required");
    if (!Array.isArray(additionalPaths) || additionalPaths.some((entry) => typeof entry !== "string")) {
      throw new Error("finalize completion additional paths are invalid");
    }
    this.root = root;
    this.location = new FlowWorkspace({
      repositoryRoot: root,
      executionRoot: root,
      specRoot,
    }).canonicalVersion(specId, new FlowVersion(1));
    const catalog = new FlowArtifactCatalogStore({ location: this.location }).require();
    const durableFlowPaths = catalog.artifacts
      .filter((artifact) => artifact.retention === "permanent")
      .map((artifact) => this.location.relativePath(artifact.relativePath));
    const allowedAdditionalPaths = new Set([
      this.location.relativeCatalogFile,
      ...durableFlowPaths,
    ]);
    if (additionalPaths.some((entry) => !allowedAdditionalPaths.has(entry))) {
      throw new Error("finalize completion additional path is not authorized");
    }
    // Catalog retention is the finalize boundary.  Never stage `.runtime`,
    // transaction files, or a parent Spec directory merely because it happens
    // to contain them.
    this.commitPaths = [...new Set([
      ...durableFlowPaths,
      this.location.relativeCatalogFile,
      ...FINALIZE_DOCUMENTATION_PATHS,
    ])];
    this.idempotencyKey = idempotencyKey;
    this.marker = outboxCommitMarker(idempotencyKey);
  }

  execute() {
    this.commitPaths = this.commitPaths.filter((commitPath) => isCommittablePath(this.root, commitPath));
    if (this.commitPaths.length === 0) {
      return { status: "skipped", reason: "ignored-flow-artifacts" };
    }
    const existing = findOutboxCommit({
      root: this.root,
      ref: "HEAD",
      idempotencyKey: this.idempotencyKey,
    });
    if (existing) {
      this.#reconcileCallerIndex(existing);
      return { status: "skipped", message: "finalize completion already committed", resumed: true };
    }

    const parent = this.#gitValue(["rev-parse", "HEAD"], "finalize completion parent");
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), PRODUCT.temporaryPrefix("finalize-index")));
    const temporaryIndex = path.join(temporaryDirectory, "index");
    const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    let primaryError = null;
    let result = null;
    try {
      assertOk(
        runGit(["-C", this.root, "read-tree", parent], { env }),
        "failed to initialize finalize completion index",
      );
      for (const commitPath of this.commitPaths) {
        assertOk(
          runGit(["-C", this.root, "add", "--", commitPath], { env }),
          `failed to stage completed finalize path: ${commitPath}`,
        );
      }
      result = runGit([
        "-C", this.root,
        "commit", "-m", "chore: complete finalize cleanup", "-m", this.marker,
      ], { env });
      if (!result.ok) {
        const durable = findOutboxCommit({
          root: this.root,
          ref: "HEAD",
          idempotencyKey: this.idempotencyKey,
        });
        if (!durable) assertOk(result, "finalize completion commit failed");
      }
    } catch (error) {
      primaryError = error;
    }

    const cleanupErrors = [];
    for (const target of [temporaryIndex, `${temporaryIndex}.lock`]) {
      try { fs.unlinkSync(target); } catch (error) {
        if (error.code !== "ENOENT") cleanupErrors.push(error);
      }
    }
    try { fs.rmdirSync(temporaryDirectory); } catch (error) { cleanupErrors.push(error); }
    if (primaryError && cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "finalize completion commit and temporary index cleanup both failed",
        { cause: primaryError },
      );
    }
    if (primaryError) throw primaryError;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "finalize completion temporary index cleanup failed", {
        cause: cleanupErrors[0],
      });
    }

    const committed = findOutboxCommit({
      root: this.root,
      ref: "HEAD",
      idempotencyKey: this.idempotencyKey,
    });
    if (!committed) throw new Error("finalize completion commit is not durable");
    this.#reconcileCallerIndex(committed);
    return { status: "done", commit: committed };
  }

  #reconcileCallerIndex(commit) {
    const parent = this.#gitValue(["rev-parse", `${commit}^`], "finalize completion commit parent");
    for (const commitPath of this.commitPaths) {
      const callerMatchesParent = runGit([
        "-C", this.root, "diff", "--cached", "--quiet", parent, "--", commitPath,
      ]);
      if (!callerMatchesParent.ok) continue;
      const callerMatchesCommit = runGit([
        "-C", this.root, "diff", "--cached", "--quiet", commit, "--", commitPath,
      ]);
      if (callerMatchesCommit.ok) continue;
      const result = runGit(["-C", this.root, "reset", "--quiet", commit, "--", commitPath]);
      assertOk(result, `failed to reconcile finalize completion index entry: ${commitPath}`);
    }
  }

  #gitValue(args, label) {
    const result = runGit(["-C", this.root, ...args]);
    assertOk(result, `${label} could not be resolved`);
    return result.stdout.trim();
  }
}

export function commitFinalizeCompletion({ root, specRoot, specId, idempotencyKey, additionalPaths = [] }) {
  return new FinalizeCompletionCommit({ root, specRoot, specId, idempotencyKey, additionalPaths }).execute();
}

export function resolveGitCommonDir(root) {
  const res = runGit(["-C", root, "rev-parse", "--git-common-dir"]);
  assertOk(res, "finalize preflight failed: unable to resolve git common dir");
  return path.resolve(root, res.stdout.trim());
}

function buildFinalizePreflightError(err) {
  const msg = [
    `finalize preflight failed: ${err.message}`,
    "Help:",
    "- This environment cannot write under .git (lock file creation failed).",
    "- Run finalize in a writable shell or with elevated permissions.",
    "- Run: sennel flow run finalize-commit --help",
  ].join("\n");
  const e = new Error(msg);
  e.code = "FINALIZE_PREFLIGHT_FAILED";
  return e;
}

export async function assertGitWriteAccess(gitDir) {
  const lockPath = path.join(gitDir, `.finalize-preflight-${process.pid}-${Date.now()}.lock`);
  try {
    await fs.promises.writeFile(lockPath, "preflight");
    await fs.promises.unlink(lockPath);
  } catch (err) {
    throw buildFinalizePreflightError(err);
  }
}

export async function runFinalizePreflight(root) {
  const gitDir = resolveGitCommonDir(root);
  await assertGitWriteAccess(gitDir);
}

export function runPreflightChecks({ root, baseBranch, featureBranch, commitStepActive }) {
  if (featureBranch === baseBranch) {
    return { ok: true, skipped: "spec-only" };
  }

  const uncommittedFiles = listUncommittedFiles({ cwd: root });
  const ahead = countCommitsBetween(baseBranch, featureBranch, { cwd: root });

  if (commitStepActive) {
    if (ahead === 0 && uncommittedFiles.length === 0) {
      return {
        ok: false,
        reason: "no-commits",
        baseBranch,
        featureBranch,
        hasUncommitted: false,
      };
    }
    return { ok: true };
  }

  if (uncommittedFiles.length > 0) {
    return { ok: false, reason: "dirty-worktree", uncommittedFiles };
  }

  if (ahead === 0) {
    return {
      ok: false,
      reason: "no-commits",
      baseBranch,
      featureBranch,
      hasUncommitted: false,
    };
  }

  return { ok: true };
}

/**
 * Run a one-shot migration script bundled under the CURRENT spec's directory.
 */
export function runMigrationHook(root, specRelPath, executionRoot = root) {
  if (!specRelPath) return;
  const specDir = path.dirname(specRelPath);
  const scriptPath = path.join(root, specDir, "scripts", "finalize-migration.js");
  if (!fs.existsSync(scriptPath)) return;
  const res = runCmd("node", [scriptPath], { cwd: executionRoot });
  assertOk(res, `finalize migration script failed: ${scriptPath}`);
}
