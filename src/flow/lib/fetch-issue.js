/** Shared GitHub Issue boundary. Lenient failures emit one safe warning. */
import { resolveGitHubProvider } from "../../lib/github/provider.js";
import { GitHubFailure } from "../../lib/github/failure.js";
import { ProcessExecutionControlFailure } from "../../lib/process-execution-values.js";

export function fetchIssue(number, root, { strict = false, config } = {}) {
  const num = Number(number);
  try {
    if (!/^\d+$/.test(String(number ?? "")) || !Number.isSafeInteger(num) || num < 1) throw new GitHubFailure("GITHUB_INVALID_REQUEST", "issue.get");
    const provider = resolveGitHubProvider(config);
    const preflight = provider.preflight({ cwd: root }).assertReady();
    return provider.getIssue({ cwd: root, repository: preflight.repository, number: num }).toJSON();
  } catch (error) {
    if (error instanceof ProcessExecutionControlFailure) throw error;
    if (strict) throw error;
    process.stderr.write(`warn: failed to fetch issue #${Number.isSafeInteger(num) ? num : "invalid"}: ${error instanceof GitHubFailure ? error.code : "GITHUB_INVALID_REQUEST"}\n`);
    return null;
  }
}
