import { resolveGitHubConfig } from "./config.js";
import { container } from "../container.js";
import { GhGitHubAdapter } from "./gh-adapter.js";
import { CommandGitHubAdapter } from "./command-adapter.js";
import { GitHubFailure } from "./failure.js";
import { GitHubRepository, GitHubPreflight, GitHubCommentDelivery } from "./values.js";
import { decodeGitHubResult } from "./protocol.js";
import { GitHubExecutionContext, GitHubPreflightRequest, GitHubIssueRequest, GitHubPullRequestRequest,
  GitHubPullRequestSourcesRequest, GitHubPullRequestSearchRequest, GitHubPullRequestCreateRequest,
  GitHubCommentSearchRequest, GitHubCommentCreateRequest, gitHubIdempotencyMarker } from "./requests.js";

export { GitHubFailure } from "./failure.js";
export * from "./values.js";

class GitHubWriteConfirmation {
  constructor(value, recovered) { this.value = value; this.recovered = recovered; Object.freeze(this); }
}

/** GitHub domain execution; canonical Flow decisions and persistence remain outside. */
export class GitHubProvider {
  constructor(adapter, { maxAttempts = 2, repository = null } = {}) {
    this.adapter = adapter;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new TypeError("Invalid GitHub transport retry budget");
    this.maxAttempts = maxAttempts;
    this.repository = repository === null || repository === undefined ? null : GitHubRepository.fromJSON(repository);
  }
  context(input) { return new GitHubExecutionContext({ cwd: input.cwd, repository: input.repository ?? this.repository }); }
  executeRead(request) {
    for (let attempt = 1; ; attempt += 1) {
      try { return decodeGitHubResult(request, this.adapter.execute(request)); }
      catch (error) {
        if (!(error instanceof GitHubFailure) || !error.retryable || attempt >= this.maxAttempts) throw error;
      }
    }
  }
  preflight(input) {
    const request = new GitHubPreflightRequest(this.context(input));
    try { return this.executeRead(request); }
    catch (error) {
      if (!(error instanceof GitHubFailure)) throw error;
      return new GitHubPreflight({ available: error.code !== "GITHUB_UNAVAILABLE", authenticated: false,
        accessible: false, repository: request.context.repository, failureCode: error.code });
    }
  }
  getIssue(input) { return this.executeRead(new GitHubIssueRequest(this.context(input), input)); }
  getPullRequest(input) { return this.executeRead(new GitHubPullRequestRequest(this.context(input), input)); }
  getPullRequestSources(input) { return this.executeRead(new GitHubPullRequestSourcesRequest(this.context(input), input)); }
  findPullRequest(input) {
    const request = new GitHubPullRequestSearchRequest(this.context(input), input);
    const result = this.executeRead(request);
    if (!result.complete) throw new GitHubFailure("GITHUB_WRITE_OUTCOME_UNKNOWN", request.operation);
    const marker = gitHubIdempotencyMarker(request.idempotencyKey);
    if (result.entries.length > 1 || result.entries.some((pr) => !pr.body.includes(marker))) {
      throw new GitHubFailure("GITHUB_CONFLICT", request.operation);
    }
    const found = result.entries[0] ?? null;
    if (found !== null) this.assertSubmittedHead(found, request);
    return found;
  }
  assertSubmittedHead(pr, request) {
    const [headOwner, headName] = request.head.includes(":") ? request.head.split(":") : [request.context.repository.owner, request.head];
    if (pr.headOid !== request.expectedHeadOid || !pr.body.includes(gitHubIdempotencyMarker(request.idempotencyKey))
      || pr.base.name !== request.base || pr.head.name !== headName || pr.head.repository === null
      || pr.head.repository.owner !== headOwner.toLowerCase()
      || (!request.head.includes(":") && !request.context.repository.equals(pr.head.repository))) {
      throw new GitHubFailure("GITHUB_CONFLICT", request.operation);
    }
    return pr;
  }
  /** A failed write never means absence. Readback must prove that before replay. */
  executeWrite(request, readback, validate) {
    for (let attempt = 1; ; attempt += 1) {
      let written;
      try { written = validate(decodeGitHubResult(request, this.adapter.execute(request))); }
      catch (error) {
        if (!(error instanceof GitHubFailure)) throw error;
        // Boundary admission failures are known not to have issued a remote write.
        if (["GITHUB_UNAVAILABLE", "GITHUB_AUTHENTICATION", "GITHUB_REPOSITORY_ACCESS", "GITHUB_INVALID_REQUEST", "GITHUB_CONFLICT"].includes(error.code)) throw error;
        let existing;
        try { existing = readback(); }
        catch (readError) {
          if (!(readError instanceof GitHubFailure)) throw readError;
          if (readError.code === "GITHUB_CONFLICT") throw readError;
          throw new GitHubFailure("GITHUB_WRITE_OUTCOME_UNKNOWN", request.operation);
        }
        if (existing !== null) return new GitHubWriteConfirmation(validate(existing), true);
        if (!error.retryable || attempt >= this.maxAttempts) throw error;
        continue;
      }
      // A success response must agree with independently read remote evidence.
      let remote;
      try { remote = readback(); }
      catch (error) {
        if (!(error instanceof GitHubFailure)) throw error;
        if (error.code === "GITHUB_CONFLICT") throw error;
        throw new GitHubFailure("GITHUB_WRITE_OUTCOME_UNKNOWN", request.operation);
      }
      if (remote === null) throw new GitHubFailure("GITHUB_WRITE_OUTCOME_UNKNOWN", request.operation);
      validate(remote);
      if (!written.samePublication(remote)) throw new GitHubFailure("GITHUB_CONFLICT", request.operation);
      return new GitHubWriteConfirmation(remote, false);
    }
  }
  createPullRequest(input) {
    const admitted = new GitHubPullRequestCreateRequest(this.context(input), input);
    const marker = gitHubIdempotencyMarker(admitted.idempotencyKey);
    const marked = { ...input, body: admitted.body.includes(marker) ? admitted.body : `${admitted.body}\n\n${marker}` };
    const existing = this.findPullRequest(marked);
    if (existing !== null) return existing;
    const request = new GitHubPullRequestCreateRequest(this.context(marked), marked);
    return this.executeWrite(request, () => this.findPullRequest(marked), (pr) => this.assertSubmittedHead(pr, request)).value;
  }
  findComment(input) {
    const request = new GitHubCommentSearchRequest(this.context(input), input);
    const result = this.executeRead(request);
    if (!result.complete) throw new GitHubFailure("GITHUB_WRITE_OUTCOME_UNKNOWN", request.operation);
    const marker = gitHubIdempotencyMarker(request.idempotencyKey);
    const matches = result.entries.filter((comment) => comment.body.includes(marker));
    if (matches.length > 1) throw new GitHubFailure("GITHUB_CONFLICT", request.operation);
    return matches[0] ?? null;
  }
  deliverComment(input) {
    const admitted = new GitHubCommentCreateRequest(this.context(input), input);
    const marker = gitHubIdempotencyMarker(admitted.idempotencyKey);
    const marked = { ...input, body: admitted.body.includes(marker) ? admitted.body : `${admitted.body}\n\n${marker}` };
    const existing = this.findComment(marked);
    if (existing !== null) {
      if (existing.body !== marked.body) throw new GitHubFailure("GITHUB_CONFLICT", "comment.search");
      return new GitHubCommentDelivery({ comment: existing, idempotencyKey: input.idempotencyKey, resumed: true });
    }
    const request = new GitHubCommentCreateRequest(this.context(marked), marked);
    const confirmed = this.executeWrite(request, () => this.findComment(marked), (posted) => {
      if (posted.body !== marked.body) throw new GitHubFailure("GITHUB_CONFLICT", request.operation);
      return posted;
    });
    return new GitHubCommentDelivery({ comment: confirmed.value, idempotencyKey: input.idempotencyKey, resumed: confirmed.recovered });
  }
}

/** CLI assembly boundary; explicit invocation config takes precedence. */
export function resolveGitHubProvider(config, dependencies = {}) {
  const effectiveConfig = config ?? (container.has("config") ? container.get("config") ?? {} : {});
  const settings = resolveGitHubConfig(effectiveConfig);
  const adapter = settings.provider === "gh" ? new GhGitHubAdapter(settings, dependencies) : new CommandGitHubAdapter(settings, dependencies);
  return new GitHubProvider(adapter, settings);
}
