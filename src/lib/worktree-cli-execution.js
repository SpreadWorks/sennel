/**
 * Select the CLI source owned by the current worktree before runtime capture.
 *
 * A globally linked development CLI may point at the main checkout even when
 * it is invoked from a worktree. This module makes the worktree source the
 * authority when both locations are checkouts of the same package.
 */

import fs from "fs";
import path from "path";
import { runBootstrapGitProbe } from "./bootstrap-process.js";
import { captureRegularFile } from "./regular-file-snapshot.js";
import { PRODUCT } from "./product.js";

class WorktreeCliTarget {
  constructor({ worktreeRoot, executionPath, localCliPath }) {
    for (const [name, value] of Object.entries({ worktreeRoot, executionPath, localCliPath })) {
      if (typeof value !== "string" || !path.isAbsolute(value)) {
        throw new Error(`worktree CLI ${name} must be an absolute path`);
      }
    }
    this.worktreeRoot = worktreeRoot;
    this.executionPath = executionPath;
    this.localCliPath = localCliPath;
    Object.freeze(this);
  }

  get usesLocalSource() {
    return this.executionPath === this.localCliPath;
  }

  recoveryCommand(argv) {
    return `node ${JSON.stringify(this.localCliPath)} ${argv.map((arg) => JSON.stringify(arg)).join(" ")}`;
  }
}

class WorktreeCliInvocation {
  constructor(argv) {
    if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== "string")) {
      throw new Error("worktree CLI argv must contain only strings");
    }
    this.argv = Object.freeze([...argv]);
    Object.freeze(this);
  }
}

function gitWorktreeRoot(cwd, repositoryRoot, discoveryCeiling) {
  const result = runBootstrapGitProbe("repository-root", { cwd, repositoryRoot, discoveryCeiling });
  if (!result.ok) return null;
  const root = String(result.stdout || "").trim();
  if (root === "") return null;
  const gitFile = path.join(root, ".git");
  try {
    return fs.statSync(gitFile).isFile() ? fs.realpathSync(root) : null;
  } catch (_) {
    return null;
  }
}

function packageName(packagePath) {
  try {
    const parsed = JSON.parse(captureRegularFile(packagePath, { label: "worktree package identity", maxBytes: 16 * 1024 * 1024 }).text());
    return typeof parsed.name === "string" && parsed.name.trim() !== "" ? parsed.name : null;
  } catch (_) {
    return null;
  }
}

function isFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (_) {
    return false;
  }
}

function resolveWorktreeCli(executionPath, cwd, repositoryRoot, discoveryCeiling) {
  const worktreeRoot = gitWorktreeRoot(cwd, repositoryRoot, discoveryCeiling);
  if (worktreeRoot == null) return null;

  const localPackagePath = path.join(worktreeRoot, "package.json");
  const executionPackagePath = path.join(path.dirname(executionPath), "..", "package.json");
  const localPackageName = packageName(localPackagePath);
  const executionPackageName = packageName(executionPackagePath);
  if (localPackageName == null || localPackageName !== executionPackageName) return null;

  return new WorktreeCliTarget({
    worktreeRoot,
    executionPath,
    localCliPath: path.join(worktreeRoot, PRODUCT.entrypoint),
  });
}

/** Resolve only: selected source is captured and evaluated by the existing loader. */
export function resolveWorktreeLocalCli({ executionPath, argv = [], cwd = process.cwd(), repositoryRoot = null, discoveryCeiling = null } = {}) {
  new WorktreeCliInvocation(argv);
  const target = resolveWorktreeCli(executionPath, cwd, repositoryRoot, discoveryCeiling);
  return target === null || target.usesLocalSource ? null : target;
}

export function worktreeCliFailure(target, argv) {
  return "sennel: worktree-local CLI source is unavailable; refusing to execute a different checkout.\n"
    + `Execution target: ${target.executionPath}\n`
    + `Expected worktree source: ${target.localCliPath}\n`
    + `Recovery: restore the worktree source, then run: ${target.recoveryCommand(argv)}\n`;
}

export function worktreeCliSourceAvailable(target) { return isFile(target.localCliPath); }
