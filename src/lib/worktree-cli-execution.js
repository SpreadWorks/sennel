/**
 * Resolve and execute the CLI source owned by the current worktree.
 *
 * A globally linked development CLI may point at the main checkout even when
 * it is invoked from a worktree. This module makes the worktree source the
 * authority when both locations are checkouts of the same package.
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
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

function gitWorktreeRoot(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) return null;
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
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return typeof parsed.name === "string" && parsed.name.trim() !== "" ? parsed.name : null;
  } catch (_) {
    return null;
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function resolveWorktreeCli(executionPath, cwd) {
  const worktreeRoot = gitWorktreeRoot(cwd);
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

function failClosed(target, argv) {
  process.stderr.write(
    "sennel: worktree-local CLI source is unavailable; refusing to execute a different checkout.\n"
    + `Execution target: ${target.executionPath}\n`
    + `Expected worktree source: ${target.localCliPath}\n`
    + `Recovery: restore the worktree source, then run: ${target.recoveryCommand(argv)}\n`,
  );
  return 1;
}

/**
 * Re-execute using the current worktree's CLI if this process was launched
 * from a different checkout. Returns null when normal dispatch should proceed.
 */
export function executeWorktreeLocalCli({ argv, cwd = process.cwd() } = {}) {
  new WorktreeCliInvocation(argv || []);
  const executionPath = fs.realpathSync(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
    PRODUCT.entrypoint,
  ));
  const target = resolveWorktreeCli(executionPath, cwd);
  if (
    target == null
    || target.usesLocalSource
  ) return null;
  if (!isFile(target.localCliPath)) return failClosed(target, argv);

  const result = spawnSync(process.execPath, [target.localCliPath, ...argv], {
    cwd,
    env: {
      ...process.env,
      [PRODUCT.env("WORK_ROOT")]: target.worktreeRoot,
      [PRODUCT.env("SOURCE_ROOT")]: target.worktreeRoot,
    },
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(`sennel: failed to execute worktree-local CLI ${target.localCliPath}: ${result.error.message}\n`);
    process.stderr.write(`Recovery: ${target.recoveryCommand(argv)}\n`);
    return 1;
  }
  return result.status ?? 1;
}
