/**
 * A squash merge transaction that never performs a merge in a caller-owned
 * worktree.  Finalization owns only its detached temporary worktree; the base
 * ref is published with compare-and-swap and then materialized into clean
 * worktrees that have that branch checked out.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlowTargetIdentityAuthority } from "../../lib/flow-target-identity-authority.js";
import { RepositoryFlowOperationLock } from "../../lib/repository-maintenance-lock.js";
import { GitStatusPathSet, runGit } from "../../lib/git-helpers.js";
import { RepairArtifactRegistry } from "./repair-state-identity.js";
import { findOutboxCommit } from "./run-finalize.js";
import { PRODUCT } from "../../lib/product.js";

const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const OUTPUT_LIMIT = 4_000;
const FLOW_OPERATION_LOCK_PATH = PRODUCT.managedPath(".repository-flow-operation.lock");

function isFlowRuntimePath(filePath) {
  return filePath === FLOW_OPERATION_LOCK_PATH
    || filePath === PRODUCT.managedPath(".active-flow")
    || FlowTargetIdentityAuthority.managesRepositoryPath(filePath)
    || filePath.startsWith(".tmp/logs/");
}

function gitFailureText(result) {
  return String(result?.stderr || result?.stdout || "unknown git failure")
    .trim()
    .slice(0, OUTPUT_LIMIT);
}

function gitValue(root, args, label) {
  const result = runGit(["-C", root, ...args]);
  if (!result.ok) {
    throw new FinalizeMergeTransactionError({
      code: "MERGE_GIT_PROBE_FAILED",
      message: `${label}: ${gitFailureText(result)}`,
    });
  }
  const value = result.stdout.trim();
  if (!GIT_OBJECT_ID.test(value)) {
    throw new FinalizeMergeTransactionError({
      code: "MERGE_GIT_PROBE_FAILED",
      message: `${label}: Git returned an invalid object ID.`,
    });
  }
  return value;
}

function worktreeStatus(root) {
  const result = runGit([
    "-C", root,
    "status", "--porcelain=v1", "-z", "--untracked-files=all",
  ]);
  if (!result.ok) {
    throw new FinalizeMergeTransactionError({
      code: "MERGE_GIT_PROBE_FAILED",
      message: `Unable to inspect worktree status: ${gitFailureText(result)}`,
    });
  }
  return new GitWorktreeStatus({
    root,
    paths: GitStatusPathSet.fromPorcelainV1Z(result.stdout).toArray(),
  });
}

function configuredWorktrees(mainRoot) {
  const result = runGit(["-C", mainRoot, "worktree", "list", "--porcelain"]);
  if (!result.ok) {
    throw new FinalizeMergeTransactionError({
      code: "MERGE_GIT_PROBE_FAILED",
      message: `Unable to inspect registered worktrees: ${gitFailureText(result)}`,
    });
  }
  const records = [];
  let current = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1);
    if (key === "worktree") current = { path: value, branch: null };
    else if (current && key === "branch") current.branch = value;
  }
  if (current) records.push(current);
  return records;
}

function registeredNestedWorktreePaths(targetRoot, records) {
  const target = path.resolve(targetRoot);
  return records
    .map((entry) => path.resolve(entry.path))
    .filter((entryPath) => entryPath !== target)
    .map((entryPath) => path.relative(target, entryPath).split(path.sep).join("/"))
    .filter((relativePath) => (
      relativePath !== ""
      && relativePath !== ".."
      && !relativePath.startsWith("../")
      && !path.isAbsolute(relativePath)
    ));
}

function operationPath(root, name) {
  const result = runGit(["-C", root, "rev-parse", "--git-path", name]);
  if (!result.ok) {
    throw new FinalizeMergeTransactionError({
      code: "MERGE_GIT_PROBE_FAILED",
      message: `Unable to inspect ${name}: ${gitFailureText(result)}`,
    });
  }
  const resolved = result.stdout.trim();
  return path.isAbsolute(resolved) ? resolved : path.join(root, resolved);
}

function activeOperation(root) {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
    if (fs.existsSync(operationPath(root, name))) return name;
  }
  for (const name of ["rebase-merge", "rebase-apply"]) {
    if (fs.existsSync(operationPath(root, name))) return "REBASE_HEAD";
  }
  return null;
}

function cleanlyMaterialize(worktreePath, beforeSha, afterSha) {
  const result = runGit([
    "-C", worktreePath,
    "read-tree", "-u", "-m", beforeSha, afterSha,
  ]);
  if (!result.ok) {
    throw new FinalizeMergeTransactionError({
      code: "MERGE_TARGET_MATERIALIZATION_FAILED",
      message: `Base ref was updated, but ${worktreePath} could not be materialized: ${gitFailureText(result)}`,
      committed: true,
    });
  }
}

export class FinalizeMergeTransactionError extends Error {
  constructor({ code, message, data = null, committed = false }) {
    super(message);
    this.name = "FinalizeMergeTransactionError";
    this.code = code;
    this.data = data;
    this.committed = committed === true;
  }
}

export class GitWorktreeStatus {
  constructor({ root, paths }) {
    if (typeof root !== "string" || root === "") throw new Error("worktree status root is required");
    if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== "string" || entry === "")) {
      throw new Error("worktree status paths are invalid");
    }
    this.root = path.resolve(root);
    this.paths = Object.freeze([...new Set(paths)]);
    Object.freeze(this);
  }

  get clean() {
    return this.paths.length === 0;
  }

  excluding(paths) {
    const ignored = new Set(paths || []);
    return new GitWorktreeStatus({
      root: this.root,
      paths: this.paths.filter((entry) => !ignored.has(entry)),
    });
  }

  excludingOwnedBy(registry) {
    if (registry == null) return this;
    if (!(registry instanceof RepairArtifactRegistry)) {
      throw new Error("worktree status ownership policy must be a RepairArtifactRegistry");
    }
    return new GitWorktreeStatus({
      root: this.root,
      paths: this.paths.filter((entry) => !registry.owns(entry)),
    });
  }

  withoutFlowRuntimeArtifacts() {
    return new GitWorktreeStatus({
      root: this.root,
      paths: this.paths.filter((entry) => !isFlowRuntimePath(entry)),
    });
  }

  excludingDescendants(paths) {
    const prefixes = (paths || []).map((entry) => entry.replace(/\/+$/, ""));
    return new GitWorktreeStatus({
      root: this.root,
      paths: this.paths.filter((entry) => !prefixes.some((prefix) => (
        entry === prefix || entry.startsWith(`${prefix}/`)
      ))),
    });
  }
}

export class FinalizeMergeReadiness {
  constructor({ baseSha, featureSha, baseWorktrees, featureStatus, targetStatuses }) {
    if (!GIT_OBJECT_ID.test(baseSha) || !GIT_OBJECT_ID.test(featureSha)) {
      throw new Error("merge readiness object IDs are invalid");
    }
    this.baseSha = baseSha;
    this.featureSha = featureSha;
    this.baseWorktrees = Object.freeze([...baseWorktrees]);
    this.featureStatus = featureStatus;
    this.targetStatuses = Object.freeze([...targetStatuses]);
    Object.freeze(this);
  }
}

export class FinalizeMergeTransaction {
  constructor({
    featureRoot,
    mainRoot,
    baseBranch,
    featureBranch,
    commitMessage,
    idempotencyKey = null,
    operationOwnerToken = null,
    allowedFeatureMetadataPaths = [],
    flowArtifactRegistry = null,
    promoteFeatureWorktreeToBase = false,
  }) {
    for (const [name, value] of Object.entries({ featureRoot, mainRoot, baseBranch, featureBranch, commitMessage })) {
      if (typeof value !== "string" || value === "") throw new Error(`finalize merge ${name} is required`);
    }
    this.featureRoot = path.resolve(featureRoot);
    this.mainRoot = path.resolve(mainRoot);
    this.baseBranch = baseBranch;
    this.featureBranch = featureBranch;
    this.commitMessage = commitMessage;
    this.idempotencyKey = idempotencyKey;
    this.operationOwnerToken = operationOwnerToken;
    if (
      !Array.isArray(allowedFeatureMetadataPaths)
      || allowedFeatureMetadataPaths.some((entry) => typeof entry !== "string" || entry === "")
    ) {
      throw new Error("finalize merge allowed feature metadata paths are invalid");
    }
    this.allowedFeatureMetadataPaths = Object.freeze([...new Set(allowedFeatureMetadataPaths)]);
    if (flowArtifactRegistry != null && !(flowArtifactRegistry instanceof RepairArtifactRegistry)) {
      throw new Error("finalize merge Flow artifact registry is invalid");
    }
    this.flowArtifactRegistry = flowArtifactRegistry;
    if (typeof promoteFeatureWorktreeToBase !== "boolean") {
      throw new Error("finalize merge feature worktree promotion flag must be boolean");
    }
    this.promoteFeatureWorktreeToBase = promoteFeatureWorktreeToBase;
    Object.freeze(this);
  }

  get baseRef() {
    return `refs/heads/${this.baseBranch}`;
  }

  get featureRef() {
    return `refs/heads/${this.featureBranch}`;
  }

  inspect({ allowFeatureMetadataPaths = [], flowArtifactRegistry = null } = {}) {
    const baseSha = gitValue(this.mainRoot, ["rev-parse", this.baseRef], `Unable to resolve ${this.baseBranch}`);
    const featureSha = gitValue(this.featureRoot, ["rev-parse", this.featureRef], `Unable to resolve ${this.featureBranch}`);
    const featureHead = gitValue(this.featureRoot, ["rev-parse", "HEAD"], "Unable to resolve feature worktree HEAD");
    if (featureHead !== featureSha) {
      throw new FinalizeMergeTransactionError({
        code: "MERGE_FEATURE_HEAD_MISMATCH",
        message: `Feature worktree HEAD (${featureHead}) does not match ${this.featureBranch} (${featureSha}).`,
      });
    }
    const operation = activeOperation(this.featureRoot);
    if (operation) {
      throw new FinalizeMergeTransactionError({
        code: "MERGE_FEATURE_OPERATION_IN_PROGRESS",
        message: `Feature worktree has ${operation} in progress. Complete or abort it before finalization.`,
      });
    }
    const featureStatus = worktreeStatus(this.featureRoot);
    const relevantFeatureStatus = featureStatus
      .withoutFlowRuntimeArtifacts()
      .excluding(allowFeatureMetadataPaths)
      .excludingOwnedBy(flowArtifactRegistry);
    if (!relevantFeatureStatus.clean) {
      throw new FinalizeMergeTransactionError({
        code: "MERGE_FEATURE_DIRTY",
        message: `Feature worktree has uncommitted changes: ${relevantFeatureStatus.paths.join(", ")}.`,
        data: { paths: relevantFeatureStatus.paths },
      });
    }

    const worktreeRecords = configuredWorktrees(this.mainRoot);
    const baseWorktrees = worktreeRecords
      .filter((entry) => entry.branch === this.baseRef)
      .map((entry) => path.resolve(entry.path));
    const targetStatuses = [];
    for (const targetRoot of baseWorktrees) {
      const targetOperation = activeOperation(targetRoot);
      if (targetOperation) {
        throw new FinalizeMergeTransactionError({
          code: "MERGE_TARGET_OPERATION_IN_PROGRESS",
          message: `Base worktree ${targetRoot} has ${targetOperation} in progress. Complete or abort it before finalization.`,
        });
      }
      const status = worktreeStatus(targetRoot)
        .withoutFlowRuntimeArtifacts()
        .excludingDescendants(registeredNestedWorktreePaths(targetRoot, worktreeRecords))
        .excludingOwnedBy(flowArtifactRegistry);
      if (!status.clean) {
        throw new FinalizeMergeTransactionError({
          code: "MERGE_TARGET_DIRTY",
          message: `Base worktree ${targetRoot} has uncommitted changes: ${status.paths.join(", ")}.`,
          data: { root: targetRoot, paths: status.paths },
        });
      }
      targetStatuses.push(status);
    }

    const mergeBase = gitValue(
      this.mainRoot,
      ["merge-base", baseSha, featureSha],
      "Unable to resolve the merge base",
    );
    const probe = runGit([
      "-C", this.mainRoot,
      "merge-tree", mergeBase, baseSha, featureSha,
    ]);
    if (!probe.ok) {
      throw new FinalizeMergeTransactionError({
        code: "MERGE_GIT_PROBE_FAILED",
        message: `Unable to evaluate merge feasibility: ${gitFailureText(probe)}`,
      });
    }
    if (/(^|\n)(changed in both|<<<<<<< )/m.test(probe.stdout)) {
      throw new FinalizeMergeTransactionError({
        code: "MERGE_CONTENT_CONFLICT",
        message: "The feature and base branches have a content conflict.",
        data: { mergeTree: gitFailureText(probe) },
      });
    }
    return new FinalizeMergeReadiness({
      baseSha,
      featureSha,
      baseWorktrees,
      featureStatus,
      targetStatuses,
    });
  }

  execute() {
    const lock = new RepositoryFlowOperationLock({
      mainRoot: this.mainRoot,
      operationOwnerToken: this.operationOwnerToken,
    });
    lock.acquire();
    try {
      const existing = this.#existingCommit();
      if (existing) return this.#resume(existing);

      const readiness = this.inspect({
        allowFeatureMetadataPaths: this.allowedFeatureMetadataPaths,
        flowArtifactRegistry: this.flowArtifactRegistry,
      });
      const temporaryRoot = path.join(os.tmpdir(), `${PRODUCT.temporaryPrefix("finalize-merge")}${crypto.randomUUID()}`);
      let added = false;
      try {
        const addedResult = runGit([
          "-C", this.mainRoot,
          "worktree", "add", "--detach", temporaryRoot, readiness.baseSha,
        ]);
        if (!addedResult.ok) {
          throw new FinalizeMergeTransactionError({
            code: "MERGE_WORKTREE_CREATE_FAILED",
            message: `Unable to create isolated merge worktree: ${gitFailureText(addedResult)}`,
          });
        }
        added = true;
        const merge = runGit(["-C", temporaryRoot, "merge", "--squash", readiness.featureSha]);
        if (!merge.ok) {
          const paths = this.#unmergedPaths(temporaryRoot);
          runGit(["-C", temporaryRoot, "reset", "--merge"]);
          if (paths.length > 0) {
            throw new FinalizeMergeTransactionError({
              code: "MERGE_CONTENT_CONFLICT",
              message: `The feature and base branches have a content conflict: ${paths.join(", ")}.`,
              data: { paths },
            });
          }
          throw new FinalizeMergeTransactionError({
            code: "MERGE_EXECUTION_FAILED",
            message: `Isolated squash merge failed: ${gitFailureText(merge)}`,
          });
        }
        const commit = runGit(["-C", temporaryRoot, "commit", "-m", this.commitMessage]);
        if (!commit.ok) {
          throw new FinalizeMergeTransactionError({
            code: "MERGE_COMMIT_FAILED",
            message: `Unable to commit isolated squash merge: ${gitFailureText(commit)}`,
          });
        }
        const mergeCommit = gitValue(temporaryRoot, ["rev-parse", "HEAD"], "Unable to read isolated merge commit");
        const update = runGit([
          "-C", this.mainRoot,
          "update-ref", this.baseRef, mergeCommit, readiness.baseSha,
        ]);
        if (!update.ok) {
          throw new FinalizeMergeTransactionError({
            code: "MERGE_BASE_ADVANCED",
            message: `${this.baseBranch} changed while the isolated merge was being prepared: ${gitFailureText(update)}`,
          });
        }
        if (this.promoteFeatureWorktreeToBase) this.#promoteFeatureWorktreeToBase();
        for (const targetRoot of readiness.baseWorktrees) {
          cleanlyMaterialize(targetRoot, readiness.baseSha, mergeCommit);
        }
        return { strategy: "squash", mergedFromSha: readiness.featureSha, mergeCommit };
      } finally {
        if (added) {
          const removed = runGit(["-C", this.mainRoot, "worktree", "remove", "--force", temporaryRoot]);
          if (!removed.ok) {
            process.stderr.write(`[sennel] warning: unable to remove isolated merge worktree ${temporaryRoot}: ${gitFailureText(removed)}\n`);
          }
        }
      }
    } finally {
      lock.release();
    }
  }

  #existingCommit() {
    if (!this.idempotencyKey) return null;
    return findOutboxCommit({
      root: this.mainRoot,
      ref: this.baseRef,
      idempotencyKey: this.idempotencyKey,
    });
  }

  #resume(mergeCommit) {
    const featureSha = gitValue(this.featureRoot, ["rev-parse", this.featureRef], `Unable to resolve ${this.featureBranch}`);
    const currentBase = gitValue(this.mainRoot, ["rev-parse", this.baseRef], `Unable to resolve ${this.baseBranch}`);
    if (this.promoteFeatureWorktreeToBase) this.#promoteFeatureWorktreeToBase();
    const worktreeRecords = configuredWorktrees(this.mainRoot);
    const baseWorktrees = worktreeRecords
      .filter((entry) => entry.branch === this.baseRef)
      .map((entry) => path.resolve(entry.path));
    for (const targetRoot of baseWorktrees) {
      const operation = activeOperation(targetRoot);
      if (operation) {
        throw new FinalizeMergeTransactionError({
          code: "MERGE_TARGET_OPERATION_IN_PROGRESS",
          message: `Base worktree ${targetRoot} has ${operation} in progress. Complete or abort it before finalization.`,
        });
      }
      const status = worktreeStatus(targetRoot)
        .withoutFlowRuntimeArtifacts()
        .excludingDescendants(registeredNestedWorktreePaths(targetRoot, worktreeRecords))
        .excludingOwnedBy(this.flowArtifactRegistry);
      if (!status.clean) {
        throw new FinalizeMergeTransactionError({
          code: "MERGE_TARGET_DIRTY",
          message: `Base worktree ${targetRoot} has uncommitted changes: ${status.paths.join(", ")}.`,
          data: { root: targetRoot, paths: status.paths },
        });
      }
      const head = gitValue(targetRoot, ["rev-parse", "HEAD"], `Unable to read base worktree HEAD at ${targetRoot}`);
      if (head !== currentBase) cleanlyMaterialize(targetRoot, head, currentBase);
    }
    return {
      strategy: "squash",
      mergedFromSha: featureSha,
      mergeCommit,
      resumed: true,
    };
  }

  #promoteFeatureWorktreeToBase() {
    const currentBranch = runGit(["-C", this.featureRoot, "branch", "--show-current"]);
    if (!currentBranch.ok) {
      throw new FinalizeMergeTransactionError({
        code: "MERGE_CALLER_TRANSITION_FAILED",
        message: `Unable to inspect the caller worktree branch: ${gitFailureText(currentBranch)}`,
        committed: true,
      });
    }
    if (currentBranch.stdout.trim() === this.baseBranch) return;
    const status = worktreeStatus(this.featureRoot)
      .withoutFlowRuntimeArtifacts()
      .excluding(this.allowedFeatureMetadataPaths)
      .excludingOwnedBy(this.flowArtifactRegistry);
    if (!status.clean) {
      throw new FinalizeMergeTransactionError({
        code: "MERGE_FEATURE_DIRTY",
        message: `Feature worktree has uncommitted changes: ${status.paths.join(", ")}.`,
        data: { paths: status.paths },
        committed: true,
      });
    }
    // Branch-mode Flow has no separate main worktree. The isolated merge and
    // ref compare-and-swap are already complete; this is only the authority
    // handoff to the published base. The preflight above permits no caller
    // changes except Flow-owned metadata, which the post lifecycle rehydrates.
    const checkout = runGit(["-C", this.featureRoot, "checkout", "--force", this.baseBranch]);
    if (!checkout.ok) {
      throw new FinalizeMergeTransactionError({
        code: "MERGE_CALLER_TRANSITION_FAILED",
        message: `Merge was published, but the caller worktree could not move to ${this.baseBranch}: ${gitFailureText(checkout)}`,
        committed: true,
      });
    }
  }

  #unmergedPaths(root) {
    const result = runGit(["-C", root, "diff", "--name-only", "--diff-filter=U"]);
    if (!result.ok) return [];
    return result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  }
}
