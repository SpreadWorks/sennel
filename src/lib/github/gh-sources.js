import { GitHubFailure } from "./failure.js";
import {
  GitHubCollection, GitHubTimelineEvent, GitHubReview, GitHubReviewReply,
  GitHubReviewThread, GitHubCommit, GitHubFileDiff, GitHubCommitDiff, GitHubPullRequestSources,
} from "./values.js";
import { ghActor, ghComment, ghPullRequest } from "./gh-adapter.js";

const THREAD_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    reviewThreads(first:100,after:$cursor) { totalCount pageInfo { hasNextPage endCursor }
      nodes { id isResolved isOutdated path line } }
  } }
}`;
const REPLY_QUERY = `query($id:ID!,$cursor:String) {
  node(id:$id) { ... on PullRequestReviewThread {
    comments(first:100,after:$cursor) { totalCount pageInfo { hasNextPage endCursor }
      nodes { id databaseId body createdAt author { login __typename }
        pullRequestReview { databaseId } replyTo { databaseId }
        commit { oid } path line originalLine }
    }
  } }
}`;
const COMMIT_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    commits(first:100,after:$cursor) { totalCount pageInfo { hasNextPage endCursor }
      nodes { commit { oid message committedDate author { user { login __typename } }
        parents(first:100) { totalCount nodes { oid } pageInfo { hasNextPage endCursor } }
      } }
    }
  } }
}`;
const PARENT_QUERY = `query($owner:String!,$name:String!,$oid:String!,$cursor:String) {
  repository(owner:$owner,name:$name) { object(expression:$oid) { ... on Commit {
    parents(first:100,after:$cursor) { totalCount nodes { oid } pageInfo { hasNextPage endCursor } }
  } } }
}`;

// Failures of an optional source remain explicit; malformed evidence is rejected.
const UNAVAILABLE = new Set(["GITHUB_NOT_FOUND", "GITHUB_REPOSITORY_ACCESS", "GITHUB_TRANSPORT",
  "GITHUB_TIMEOUT", "GITHUB_RATE_LIMIT", "GITHUB_OUTPUT_LIMIT"]);

function collection(repository, headOid, entries, reason = null) {
  return new GitHubCollection({ repository, headOid, entries, complete: reason === null, cursor: null, reason });
}

function source(repository, headOid, read) {
  try { return read(); }
  catch (error) {
    if (!(error instanceof GitHubFailure) || !UNAVAILABLE.has(error.code)) throw error;
    return collection(repository, headOid, [], error.code);
  }
}

function fileDiff(raw, commitOid = null) {
  const available = typeof raw.patch === "string";
  return new GitHubFileDiff({ commitOid, path: raw.filename, previousPath: raw.previous_filename ?? null,
    status: raw.status, patch: available ? raw.patch : null,
    state: available ? "available" : "omitted", reason: available ? null : "PATCH_OMITTED" });
}

function timelineEvent(raw, index) {
  const at = raw.created_at ?? raw.submitted_at ?? raw.committer?.date ?? null;
  const dismissed = raw.event === "review_dismissed" ? raw.dismissed_review : null;
  const commitOid = raw.commit_id ?? raw.sha ?? dismissed?.dismissal_commit_id ?? null;
  const id = raw.node_id ?? raw.id ?? `${raw.event}:${commitOid ?? ""}:${at ?? ""}:${index}`;
  return new GitHubTimelineEvent({ id, event: raw.event, at, actor: ghActor(raw.actor ?? raw.user),
    commitOid, reviewId: raw.event === "reviewed" ? raw.id ?? null : dismissed?.review_id ?? null,
    commentId: raw.event === "commented" ? raw.id ?? null : null });
}

/** Sources are observed at a PR head and never silently represented as complete. */
export function readPullRequestSources(api, request) {
  const repository = request.context.repository;
  const prefix = `repos/${repository.name}`;
  const beforeRaw = api.rest(request, `${prefix}/pulls/${request.number}`);
  if (beforeRaw.number !== request.number) throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
  if (!Number.isSafeInteger(beforeRaw.commits) || beforeRaw.commits < 0
    || !Number.isSafeInteger(beforeRaw.changed_files) || beforeRaw.changed_files < 0) {
    throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
  }
  const before = ghPullRequest(beforeRaw, repository);
  const headOid = before.headOid;
  const variables = { owner: repository.owner, name: repository.repo, number: request.number };
  const timeline = source(repository, headOid, () => collection(repository, headOid,
    api.rest(request, `${prefix}/issues/${request.number}/timeline?per_page=100`, { paginate: true }).map(timelineEvent)));
  const reviews = source(repository, headOid, () => collection(repository, headOid,
    api.rest(request, `${prefix}/pulls/${request.number}/reviews?per_page=100`, { paginate: true }).map((raw) => new GitHubReview({
      id: raw.id, state: raw.state.toLowerCase(), body: raw.body ?? "", at: raw.submitted_at ?? null,
      actor: ghActor(raw.user), commitOid: raw.commit_id ?? null,
    }))));
  const comments = source(repository, headOid, () => collection(repository, headOid,
    api.rest(request, `${prefix}/issues/${request.number}/comments?per_page=100`, { paginate: true })
      .map((raw) => ghComment(raw, repository, request.number))));
  const threads = source(repository, headOid, () => collection(repository, headOid,
    api.connection(request, THREAD_QUERY, variables, (data) => data.repository?.pullRequest?.reviewThreads).map((raw) => {
      const replies = source(repository, headOid, () => collection(repository, headOid,
        api.connection(request, REPLY_QUERY, { id: raw.id }, (data) => data.node?.comments)
          .map((reply) => new GitHubReviewReply({ id: reply.databaseId ?? reply.id, body: reply.body,
            at: reply.createdAt, actor: ghActor(reply.author), reviewId: reply.pullRequestReview?.databaseId ?? null,
            replyToId: reply.replyTo?.databaseId ?? null, commitOid: reply.commit?.oid ?? null,
            path: reply.path ?? null, line: reply.line ?? null, originalLine: reply.originalLine ?? null }))));
      return new GitHubReviewThread({ id: raw.id, resolved: raw.isResolved, outdated: raw.isOutdated,
        path: raw.path, line: raw.line ?? null, comments: replies });
    })));

  const commits = source(repository, headOid, () => {
    const nodes = api.connection(request, COMMIT_QUERY, variables, (data) => data.repository?.pullRequest?.commits);
    const entries = nodes.map(({ commit }) => {
      if (!Array.isArray(commit.parents?.nodes) || !Number.isInteger(commit.parents.totalCount)
        || typeof commit.parents.pageInfo?.hasNextPage !== "boolean") throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
      const parentNodes = commit.parents.pageInfo.hasNextPage
        ? api.connection(request, PARENT_QUERY, { owner: repository.owner, name: repository.repo, oid: commit.oid },
          (data) => data.repository?.object?.parents) : commit.parents.nodes;
      if (parentNodes.length !== commit.parents.totalCount) throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
      return new GitHubCommit({ oid: commit.oid, message: commit.message, at: commit.committedDate,
        actor: ghActor(commit.author?.user), parents: parentNodes.map((parent) => parent.oid) });
    });
    // GitHub reports the actual count, and the last pushed commit must be the observed head.
    const lineageChanged = beforeRaw.commits !== entries.length
      || (entries.length > 0 && entries.at(-1).oid !== headOid);
    return collection(repository, headOid, entries, lineageChanged ? "HEAD_LINEAGE_CHANGED" : null);
  });

  const diffs = source(repository, headOid, () => {
    const rawFiles = api.rest(request, `${prefix}/pulls/${request.number}/files?per_page=100`, { paginate: true });
    const entries = rawFiles.map((raw) => fileDiff(raw));
    const reasons = [];
    if (beforeRaw.changed_files !== rawFiles.length || rawFiles.length >= 3000) {
      reasons.push("FILE_LIMIT_REACHED");
    }
    if (entries.some((entry) => entry.state !== "available")) reasons.push("PATCH_OMITTED");
    return collection(repository, headOid, entries, reasons.length ? [...new Set(reasons)].join(",") : null);
  });
  const commitDiffs = collection(repository, headOid, commits.entries.map((commit) => {
      const files = source(repository, headOid, () => {
        const pages = api.rest(request, `${prefix}/commits/${commit.oid}?per_page=100`, { paginate: true, objectPages: true });
        if (!pages.length || pages.some((page) => page.sha !== commit.oid || !Array.isArray(page.files))) {
          throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
        }
        const files = pages.flatMap((page) => page.files);
        const entries = files.map((raw) => fileDiff(raw, commit.oid));
        return collection(repository, headOid, entries, files.length >= 3000 ? "FILE_LIMIT_REACHED"
          : entries.some((entry) => entry.state !== "available") ? "PATCH_OMITTED" : null);
      });
      return new GitHubCommitDiff({ commitOid: commit.oid, files });
  }), commits.complete ? null : "COMMITS_UNAVAILABLE");
  const afterRaw = api.rest(request, `${prefix}/pulls/${request.number}`);
  if (afterRaw.number !== request.number) throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
  const after = ghPullRequest(afterRaw, repository);
  return new GitHubPullRequestSources({ repository, number: request.number, headOid,
    observedHeadOid: after.headOid, consistent: headOid === after.headOid,
    timeline, reviews, comments, threads, commits, diffs, commitDiffs });
}
