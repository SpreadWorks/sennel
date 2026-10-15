import { runCmd } from "../process.js";
import { ProcessExecutionControlFailure } from "../process-execution-values.js";
import { GitHubFailure, classifyProcessFailure } from "./failure.js";

function graphQLErrorCode(value) {
  if (!Array.isArray(value?.errors) || !value.errors.length) return null;
  const type = value.errors[0]?.type ?? value.errors[0]?.extensions?.type;
  return type === "RATE_LIMITED" ? "GITHUB_RATE_LIMIT"
    : type === "FORBIDDEN" ? "GITHUB_REPOSITORY_ACCESS"
      : type === "NOT_FOUND" ? "GITHUB_NOT_FOUND" : "GITHUB_INVALID_OUTPUT";
}

/** The gh process boundary; no command output escapes through an error. */
export class GhApi {
  constructor(options, runner = runCmd) {
    this.options = options;
    this.runner = runner;
  }

  command(request, args, { input, write = false, json = true } = {}) {
    let result;
    try {
      result = this.runner("gh", args, {
        cwd: request.context.cwd,
        timeout: this.options.timeout,
        maxBuffer: this.options.maxBuffer,
        ...(input !== undefined && { input }),
      });
    } catch (error) {
      if (error instanceof ProcessExecutionControlFailure) throw error;
      throw new GitHubFailure(write ? "GITHUB_WRITE_OUTCOME_UNKNOWN" : "GITHUB_PROCESS_FAILURE", request.operation);
    }
    if (!result.ok) {
      if (result.status === 4) throw new GitHubFailure("GITHUB_AUTHENTICATION", request.operation);
      if (result.status === 2) throw new GitHubFailure("GITHUB_CANCELLED", request.operation);
      const failure = classifyProcessFailure(result, request.operation);
      if (["GITHUB_PROCESS_FAILURE", "GITHUB_WRITE_OUTCOME_UNKNOWN"].includes(failure.code)) {
        if (args[1] === "graphql") {
          let value;
          try { value = JSON.parse(String(result.stdout)); } catch { /* Only a typed JSON error is classifiable. */ }
          const code = graphQLErrorCode(value);
          if (code) throw new GitHubFailure(code, request.operation);
        }
        const stderr = String(result.stderr || "");
        const status = /\bHTTP (\d{3})\b/.exec(stderr)?.[1];
        const code = status === "401" ? "GITHUB_AUTHENTICATION"
          : status === "404" ? "GITHUB_NOT_FOUND"
            : status === "409" || status === "422" ? "GITHUB_CONFLICT"
              : status === "429" || (status === "403" && /rate limit/i.test(stderr)) ? "GITHUB_RATE_LIMIT"
                : status === "403" ? "GITHUB_REPOSITORY_ACCESS"
                  : status && Number(status) >= 500 ? "GITHUB_TRANSPORT"
                    : /(?:dial tcp|TLS handshake timeout|connection (?:reset|refused)|no such host|network is unreachable|unexpected EOF)/i.test(stderr) ? "GITHUB_TRANSPORT" : null;
        if (code) throw new GitHubFailure(code, request.operation);
      }
      throw failure;
    }
    if (!json) return;
    try {
      return JSON.parse(String(result.stdout));
    } catch {
      throw new GitHubFailure(write ? "GITHUB_WRITE_OUTCOME_UNKNOWN" : "GITHUB_INVALID_OUTPUT", request.operation);
    }
  }

  rest(request, endpoint, { paginate = false, objectPages = false, input, write = false } = {}) {
    const args = ["api", endpoint, "--hostname", request.context.repository.host,
      "--header", "Accept: application/vnd.github+json"];
    if (paginate) args.push("--paginate", "--slurp");
    if (input !== undefined) args.push("--method", "POST", "--input", "-");
    const value = this.command(request, args, {
      ...(input !== undefined && { input: JSON.stringify(input) }), write,
    });
    if (paginate && (!Array.isArray(value) || value.some((page) => objectPages
      ? page === null || typeof page !== "object" || Array.isArray(page) : !Array.isArray(page)))) {
      throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
    }
    return paginate && !objectPages ? value.flat() : value;
  }

  graphql(request, query, variables) {
    const value = this.command(request, ["api", "graphql", "--hostname", request.context.repository.host,
      "--input", "-"], { input: JSON.stringify({ query, variables }) });
    const code = graphQLErrorCode(value);
    if (code) throw new GitHubFailure(code, request.operation);
    if (!value || typeof value !== "object" || (value.errors && !Array.isArray(value.errors)) || !value.data) {
      throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
    }
    return value.data;
  }

  /** Independently page a connection, including connections nested under a node. */
  connection(request, query, variables, select) {
    const entries = [];
    const cursors = new Set();
    const identities = new Set();
    let cursor = null;
    let total = null;
    do {
      const connection = select(this.graphql(request, query, { ...variables, cursor }));
      if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean"
        || !Number.isInteger(connection.totalCount) || connection.totalCount < 0) {
        throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
      }
      if (total !== null && total !== connection.totalCount) throw new GitHubFailure("GITHUB_CONFLICT", request.operation);
      total = connection.totalCount;
      for (const node of connection.nodes) {
        const identity = node?.id ?? node?.commit?.oid ?? node?.oid;
        if (identity === undefined || identities.has(identity)) throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
        identities.add(identity);
      }
      entries.push(...connection.nodes);
      if (entries.length > total || (connection.pageInfo.hasNextPage && !connection.nodes.length)) {
        throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
      }
      if (!connection.pageInfo.hasNextPage) break;
      cursor = connection.pageInfo.endCursor;
      if (typeof cursor !== "string" || cursor === "" || cursors.has(cursor)) {
        throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
      }
      cursors.add(cursor);
    } while (true);
    if (entries.length !== total) throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
    return entries;
  }
}
