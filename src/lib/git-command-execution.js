import { GitRepositoryPolicy } from "./git-repository-environment.js";
import { CommandExecution } from "./process.js";

/** Typed Git execution without application/container initialization. */
export class GitCommandExecution extends CommandExecution {
  constructor(args, opts = {}) {
    const { gitPolicy = new GitRepositoryPolicy({ repositoryRoot: opts.cwd ?? null }), env = process.env, cwd, stdio, ...executionOptions } = opts;
    if (!(gitPolicy instanceof GitRepositoryPolicy)) throw new TypeError("gitPolicy must be a GitRepositoryPolicy");
    super(gitPolicy.invocation(args, { cwd: cwd ?? null, env, stdio: stdio ?? "pipe" }), [],
      { ...executionOptions, readOnly: gitPolicy.readOnly,
        retainedControl: !gitPolicy.readOnly && executionOptions.repositoryRoot == null
          && executionOptions.processExecutionBinding === undefined });
  }
}

export function runGit(args, opts = {}) { return new GitCommandExecution(args, opts).run(); }
export function runGitAsync(args, opts = {}) { return new GitCommandExecution(args, opts).runAsync(); }
