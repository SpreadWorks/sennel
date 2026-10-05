import { execFileSync } from "child_process";

function git(cwd, args, opts = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

export function initGitRepo(dir) {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

export function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message, "--allow-empty"]);
}

export function checkoutNewBranch(dir, name) {
  git(dir, ["checkout", "-q", "-b", name]);
}
