/** Safe failures at the GitHub process / protocol boundary. */
const MESSAGES = Object.freeze({
  GITHUB_UNAVAILABLE: "GitHub provider executable is unavailable",
  GITHUB_AUTHENTICATION: "GitHub provider authentication failed",
  GITHUB_REPOSITORY_ACCESS: "GitHub repository access failed",
  GITHUB_NOT_FOUND: "GitHub resource was not found",
  GITHUB_CONFLICT: "GitHub operation identity conflicts with remote evidence",
  GITHUB_TRANSPORT: "GitHub transport failed",
  GITHUB_RATE_LIMIT: "GitHub rate limit was reached",
  GITHUB_TIMEOUT: "GitHub provider timed out",
  GITHUB_SIGNAL: "GitHub provider was terminated by a signal",
  GITHUB_CANCELLED: "GitHub provider operation was cancelled",
  GITHUB_PROCESS_FAILURE: "GitHub provider process failed",
  GITHUB_INVALID_OUTPUT: "GitHub provider returned invalid output",
  GITHUB_OUTPUT_LIMIT: "GitHub provider output exceeded its limit",
  GITHUB_WRITE_OUTCOME_UNKNOWN: "GitHub remote write outcome could not be confirmed",
  GITHUB_INVALID_REQUEST: "GitHub provider request is invalid",
});
const RETRYABLE = new Set(["GITHUB_TRANSPORT", "GITHUB_RATE_LIMIT", "GITHUB_TIMEOUT"]);

export class GitHubFailure extends Error {
  constructor(code, operation) {
    if (!Object.hasOwn(MESSAGES, code)) throw new TypeError("Unknown GitHub failure code");
    super(MESSAGES[code]);
    this.name = "GitHubFailure";
    this.code = code;
    this.operation = operation;
    this.retryable = RETRYABLE.has(code);
  }
  toJSON() { return { code: this.code, operation: this.operation, retryable: this.retryable, message: this.message }; }
  static supports(code) { return Object.hasOwn(MESSAGES, code); }
}

/** Never copy command output, args, external messages or causes into public errors. */
export function classifyProcessFailure(result, operation) {
  const code = result.errorCode === "ENOENT" ? "GITHUB_UNAVAILABLE"
    : result.errorCode === "ABORT_ERR" ? "GITHUB_CANCELLED"
    : result.errorCode === "ETIMEDOUT" || result.killed ? "GITHUB_TIMEOUT"
    : result.errorCode === "ENOBUFS" || result.errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "GITHUB_OUTPUT_LIMIT"
    : result.signal ? "GITHUB_SIGNAL" : "GITHUB_PROCESS_FAILURE";
  return new GitHubFailure(code, operation);
}
