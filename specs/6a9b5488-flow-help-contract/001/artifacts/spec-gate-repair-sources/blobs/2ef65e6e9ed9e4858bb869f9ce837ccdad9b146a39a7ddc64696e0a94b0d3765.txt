import crypto from "crypto";
import { assertOk } from "./process.js";
import { runGit } from "./git-helpers.js";

/** Immutable Git checkout identity including untracked working-tree entries. */
export function computeGitState(root) {
  const head = runGit(["rev-parse", "HEAD"], { cwd: root });
  assertOk(head, "failed to read HEAD sha");
  const diff = runGit(["diff", "HEAD"], { cwd: root });
  assertOk(diff, "failed to read git diff HEAD");
  const status = runGit(["status", "--porcelain=v1", "-z"], { cwd: root });
  assertOk(status, "failed to read git status");
  const worktreeHash = crypto
    .createHash("sha256")
    .update(diff.stdout)
    .update("\x00")
    .update(status.stdout)
    .digest("hex");
  return { headSha: head.stdout.trim(), worktreeHash };
}
