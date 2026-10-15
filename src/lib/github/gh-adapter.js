import { GhApi } from "./gh-api.js";
import { ProcessExecutionControlFailure } from "../process-execution-values.js";
import { GitHubFailure } from "./failure.js";
import { isGitObjectId } from "../git-snapshot.js";
import { GitHubPreflightRequest } from "./requests.js";
import {
  GitHubRepository, GitHubPreflight, GitHubBranch, GitHubFetchLocator,
  GitHubPullRequest, GitHubIssue, GitHubComment, GitHubCollection, GitHubActor,
} from "./values.js";
import { readPullRequestSources } from "./gh-sources.js";

export function ghActor(actor) {
  if (actor == null) return null;
  return new GitHubActor({ login: actor.login ?? null,
    type: actor.type === "Bot" || actor.__typename === "Bot" ? "bot"
      : actor.type === "Organization" || actor.__typename === "Organization" ? "organization"
        : actor.type === "User" || actor.__typename === "User" ? "user" : "unknown" });
}

function checkUrl(rawUrl, repository, kind, number) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.hostname !== repository.host
    || url.pathname.toLowerCase() !== `/${repository.name}/${kind}/${number}` || url.username || url.password) {
    throw new Error("GitHub resource identity mismatch");
  }
}

function branch(raw, host, deleted = raw.repo == null) {
  return new GitHubBranch({
    repository: raw.repo ? new GitHubRepository({ host, name: raw.repo.full_name }) : null,
    name: raw.ref, deleted,
  });
}

/** Parse only the public domain fields of a REST PR response. */
export function ghPullRequest(raw, repository, headDeleted = raw.head?.repo == null, fetchLocator = null) {
  return new GitHubPullRequest({
    repository, number: raw.number, url: raw.html_url,
    state: raw.merged_at ? "merged" : raw.state,
    title: raw.title, body: raw.body ?? "",
    base: branch(raw.base, repository.host), head: branch(raw.head, repository.host, headDeleted),
    headOid: raw.head.sha, mergeOid: raw.merged_at ? raw.merge_commit_sha : null,
    fetchLocator: fetchLocator ?? new GitHubFetchLocator({ repository, ref: `refs/pull/${raw.number}/head`,
      headOid: raw.head.sha, state: "available", reason: null }),
  });
}

export function ghComment(raw, repository, number) {
  return new GitHubComment({ repository, number, id: raw.id, url: raw.html_url,
    body: raw.body ?? "", at: raw.created_at ?? null, actor: ghActor(raw.user) });
}

/** Built-in adapter. Retry and write reconciliation belong to GitHubProvider. */
export class GhGitHubAdapter {
  constructor(options, { runner } = {}) {
    this.api = new GhApi(options, runner);
  }

  execute(request) {
    try {
      switch (request.operation) {
        case "provider.preflight": return this.preflight(request);
        case "issue.get": return this.issue(request);
        case "pull-request.get": return this.pullRequest(request);
        case "pull-request.search": return this.searchPullRequests(request);
        case "pull-request.create": return this.createPullRequest(request);
        case "pull-request.sources": return readPullRequestSources(this.api, request);
        case "comment.search": return this.searchComments(request);
        case "comment.create": return this.createComment(request);
        default: throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
      }
    } catch (error) {
      if (error instanceof GitHubFailure || error instanceof ProcessExecutionControlFailure) throw error;
      throw new GitHubFailure(request.operation.endsWith(".create") ? "GITHUB_WRITE_OUTCOME_UNKNOWN" : "GITHUB_INVALID_OUTPUT", request.operation);
    }
  }

  preflight(request) {
    let repository = request.context.repository;
    try {
      this.api.command(request, ["--version"], { json: false });
    } catch (error) {
      if (!(error instanceof GitHubFailure)) throw error;
      return new GitHubPreflight({ available: false, authenticated: false, accessible: false,
        repository, failureCode: error.code });
    }
    if (!repository) {
      try {
        const raw = this.api.command(request, ["repo", "view", "--json", "nameWithOwner,url"]);
        const url = new URL(raw.url);
        repository = new GitHubRepository({ host: url.hostname, name: raw.nameWithOwner });
        if (url.protocol !== "https:" || url.pathname.toLowerCase() !== `/${repository.name}` || url.username || url.password) {
          throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
        }
      } catch (error) {
        if (!(error instanceof GitHubFailure)) throw error;
        return new GitHubPreflight({ available: true, authenticated: error.code !== "GITHUB_AUTHENTICATION",
          accessible: false, repository: null, failureCode: error.code === "GITHUB_NOT_FOUND" ? "GITHUB_REPOSITORY_ACCESS" : error.code });
      }
    }
    try {
      // JSON auth status exits zero even for invalid credentials. Use its real exit status.
      this.api.command(request, ["auth", "status", "--active", "--hostname", repository.host], { json: false });
    } catch (error) {
      if (!(error instanceof GitHubFailure)) throw error;
      return new GitHubPreflight({ available: true, authenticated: false, accessible: false,
        repository, failureCode: error.code === "GITHUB_PROCESS_FAILURE" ? "GITHUB_AUTHENTICATION" : error.code });
    }
    try {
      const bound = new GitHubPreflightRequest({ cwd: request.context.cwd, repository });
      const raw = this.api.rest(bound, `repos/${repository.name}`);
      if (raw.full_name.toLowerCase() !== repository.name) throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
      const url = new URL(raw.html_url);
      if (url.hostname !== repository.host || url.protocol !== "https:" || url.pathname.toLowerCase() !== `/${repository.name}`) {
        throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
      }
      return new GitHubPreflight({ available: true, authenticated: true, accessible: true, repository, failureCode: null });
    } catch (error) {
      if (!(error instanceof GitHubFailure)) throw error;
      return new GitHubPreflight({ available: true, authenticated: true, accessible: false, repository,
        failureCode: error.code === "GITHUB_NOT_FOUND" ? "GITHUB_REPOSITORY_ACCESS" : error.code });
    }
  }

  issue(request) {
    const repository = request.context.repository;
    const raw = this.api.rest(request, `repos/${repository.name}/issues/${request.number}`);
    checkUrl(raw.html_url, repository, "issues", request.number);
    if (raw.number !== request.number || raw.pull_request) throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
    return new GitHubIssue({ repository, number: raw.number, title: raw.title,
      body: raw.body ?? "", labels: raw.labels.map((label) => typeof label === "string" ? label : label.name), state: raw.state });
  }

  pullRequest(request) {
    const repository = request.context.repository;
    const raw = this.api.rest(request, `repos/${repository.name}/pulls/${request.number}`);
    if (raw.number !== request.number) throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
    const parsed = ghPullRequest(raw, repository);
    // Read through the base PR, avoiding inaccessible-fork 404s being mistaken for deletion.
    const data = this.api.graphql(request, `query($owner:String!,$name:String!,$number:Int!) {
      repository(owner:$owner,name:$name) { pullRequest(number:$number) {
        headRefName headRefOid headRef { name }
      } }
    }`, { owner: repository.owner, name: repository.repo, number: request.number });
    const head = data.repository?.pullRequest;
    if (!head || head.headRefName !== parsed.head.name || !isGitObjectId(head.headRefOid)
      || (head.headRef !== null && head.headRef?.name !== parsed.head.name)) {
      throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
    }
    if (head.headRefOid !== parsed.headOid) throw new GitHubFailure("GITHUB_CONFLICT", request.operation);
    const deleted = head.headRef === null;
    const fetchLocator = this.fetchLocator(request, parsed.headOid);
    return ghPullRequest(raw, repository, deleted, fetchLocator);
  }

  fetchLocator(request, headOid) {
    const repository = request.context.repository;
    const ref = `refs/pull/${request.number}/head`;
    let reason = null;
    try {
      const raw = this.api.rest(request, `repos/${repository.name}/git/ref/pull/${request.number}/head`);
      const url = new URL(raw.url);
      const path = `/repos/${repository.name}/git/refs/pull/${request.number}/head`;
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
        || ![repository.host, `api.${repository.host}`].includes(url.hostname)
        || ![path, `/api/v3${path}`].includes(url.pathname.toLowerCase())
        || raw.ref !== ref || raw.object?.type !== "commit" || !isGitObjectId(raw.object.sha)) {
        throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
      }
      if (raw.object.sha !== headOid) reason = "HEAD_CHANGED";
    } catch (error) {
      if (!(error instanceof GitHubFailure) || ["GITHUB_INVALID_OUTPUT", "GITHUB_CANCELLED", "GITHUB_SIGNAL"].includes(error.code)) throw error;
      reason = error.code;
    }
    return new GitHubFetchLocator({ repository, ref: reason === null ? ref : null, headOid,
      state: reason === null ? "available" : "unavailable", reason });
  }

  searchPullRequests(request) {
    const repository = request.context.repository;
    const query = new URLSearchParams({ state: "all", per_page: "100", base: request.base });
    // A plain branch must be qualified by its owner to prevent matches in other forks.
    query.set("head", request.head.includes(":") ? request.head : `${repository.name.split("/")[0]}:${request.head}`);
    const entries = this.api.rest(request, `repos/${repository.name}/pulls?${query}`, { paginate: true });
    return new GitHubCollection({ repository, entries: entries.map((raw) => ghPullRequest(raw, repository)),
      complete: true, cursor: null, reason: null, headOid: null });
  }

  createPullRequest(request) {
    const repository = request.context.repository;
    const raw = this.api.rest(request, `repos/${repository.name}/pulls`, {
      input: { base: request.base, head: request.head, title: request.title, body: request.body }, write: true,
    });
    return ghPullRequest(raw, repository);
  }

  searchComments(request) {
    const repository = request.context.repository;
    const entries = this.api.rest(request, `repos/${repository.name}/issues/${request.number}/comments?per_page=100`, { paginate: true });
    return new GitHubCollection({ repository, entries: entries.map((raw) => ghComment(raw, repository, request.number)),
      complete: true, cursor: null, reason: null, headOid: null });
  }

  createComment(request) {
    const repository = request.context.repository;
    const raw = this.api.rest(request, `repos/${repository.name}/issues/${request.number}/comments`, {
      input: { body: request.body }, write: true,
    });
    return ghComment(raw, repository, request.number);
  }
}
