import { GitRepositoryPolicy } from "./git-repository-environment.js";
import { runCmd, runCmdAsync } from "./process.js";

/** Typed Git execution without application/container initialization. */
export class GitCommandExecution {
  constructor(args, opts = {}) {
    const { gitPolicy = new GitRepositoryPolicy({ repositoryRoot: opts.cwd ?? null }), env = process.env, cwd, stdio, ...executionOptions } = opts;
    if (!(gitPolicy instanceof GitRepositoryPolicy)) throw new TypeError("gitPolicy must be a GitRepositoryPolicy");
    this.invocation = gitPolicy.invocation(args, { cwd: cwd ?? null, env, stdio: stdio ?? "pipe" });
    this.options = { ...executionOptions, readOnly: gitPolicy.readOnly };
    Object.freeze(this);
  }
  run() { return runCmd(this.invocation, [], this.options); }
  runAsync() { return runCmdAsync(this.invocation, [], this.options); }
}

export function runGit(args, opts = {}) { return new GitCommandExecution(args, opts).run(); }
export function runGitAsync(args, opts = {}) { return new GitCommandExecution(args, opts).runAsync(); }
