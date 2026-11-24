import { execFileSync } from "node:child_process";
import { NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";

function git(cwd, args) {
  const invocation = new NativeExecutableInvocation({ executable: "git", args, cwd,
    stdio: ["ignore", "pipe", "pipe"] });
  return execFileSync(invocation.executable, invocation.args, {
    ...invocation.processOptions(),
    shell: false,
    encoding: "utf8",
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
