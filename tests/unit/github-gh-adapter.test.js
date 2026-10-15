import assert from "node:assert/strict";
import { test } from "node:test";
import { GhGitHubAdapter } from "../../src/lib/github/gh-adapter.js";
import { GitHubFailure } from "../../src/lib/github/failure.js";
import { resolveGitHubConfig } from "../../src/lib/github/config.js";
import {
  GitHubRepository, GitHubPullRequest, GitHubIssue, GitHubComment, GitHubPullRequestSources,
} from "../../src/lib/github/values.js";
import {
  GitHubExecutionContext, GitHubPreflightRequest, GitHubIssueRequest, GitHubPullRequestRequest,
  GitHubPullRequestSearchRequest, GitHubPullRequestCreateRequest, GitHubPullRequestSourcesRequest,
  GitHubCommentSearchRequest, GitHubCommentCreateRequest,
} from "../../src/lib/github/requests.js";

const repository = new GitHubRepository({ host: "github.example.test", name: "owner/project" });
const context = new GitHubExecutionContext({ cwd: "/tmp/github-adapter-test-worktree", repository });
const firstOid = "a".repeat(40);
const headOid = "b".repeat(40);
const mergeOid = "c".repeat(40);
const at = "2026-01-01T00:00:00Z";
const actor = { login: "reviewer", type: "User" };

function ok(value) { return { ok: true, status: 0, stdout: JSON.stringify(value), stderr: "", signal: null, killed: false }; }
function pr(input = {}) {
  return { number: 42, html_url: "https://github.example.test/owner/project/pull/42", state: "open",
    merged_at: null, merge_commit_sha: null, title: "Feature", body: "Description",
    base: { ref: "main", sha: firstOid, repo: { full_name: "owner/project" } },
    head: { ref: "feature", sha: headOid, repo: { full_name: "fork/project" } }, commits: 2, changed_files: 1,
    ...input };
}
function comment(id, body = "Body", extra = {}) {
  return { id, html_url: `https://github.example.test/owner/project/issues/42#issuecomment-${id}`,
    body, created_at: at, user: actor, ...extra };
}
function fetchRef(extra = {}) {
  return { ref: "refs/pull/42/head", url: "https://github.example.test/api/v3/repos/owner/project/git/refs/pull/42/head",
    object: { type: "commit", sha: headOid }, ...extra };
}
function setup(respond) {
  const calls = [];
  const adapter = new GhGitHubAdapter(resolveGitHubConfig({}), { runner(command, args, options) {
    calls.push({ command, args, options });
    return respond(args, options, calls.length);
  } });
  return { adapter, calls };
}
function failCode(code, operation) {
  return (error) => error instanceof GitHubFailure && error.code === code && error.operation === operation
    && !JSON.stringify(error.toJSON()).includes("private-secret");
}

test("gh preflight fixes host and cwd and separately proves authentication and repository access", () => {
  const { adapter, calls } = setup((args) => args[0] === "api" ? ok({ full_name: repository.name,
    html_url: `https://${repository.host}/${repository.name}` }) : ok(null));
  const result = adapter.execute(new GitHubPreflightRequest(context));
  assert.equal(result.ready(), true);
  assert.deepEqual(result.repository.toJSON(), repository.toJSON());
  assert.deepEqual(calls[1].args, ["auth", "status", "--active", "--hostname", repository.host]);
  assert.equal(calls[2].args[1], "repos/owner/project");
  for (const call of calls) {
    assert.equal(call.command, "gh");
    assert.equal(call.options.cwd, context.cwd);
    assert.equal(call.options.timeout, 30000);
    assert.equal(call.options.maxBuffer, 4194304);
  }
});

test("gh preflight resolves an absent repository once and binds subsequent API requests", () => {
  const unbound = new GitHubExecutionContext({ cwd: context.cwd });
  const { adapter, calls } = setup((args) => args[0] === "repo" ? ok({ nameWithOwner: "owner/project",
    url: "https://github.example.test/owner/project" }) : args[0] === "api" ? ok({ full_name: repository.name,
      html_url: `https://${repository.host}/${repository.name}` }) : ok(null));
  const result = adapter.execute(new GitHubPreflightRequest(unbound));
  assert.equal(result.ready(), true);
  assert.equal(result.repository.host, repository.host);
  assert.equal(calls[3].args[calls[3].args.indexOf("--hostname") + 1], repository.host);
});

test("gh preflight reports unavailable, authentication and repository access failures distinctly", () => {
  for (const [failedStage, failure, flags, code] of [
    [1, { errorCode: "ENOENT" }, [false, false, false], "GITHUB_UNAVAILABLE"],
    [2, {}, [true, false, false], "GITHUB_AUTHENTICATION"],
    [3, { stderr: "private-secret (HTTP 404)" }, [true, true, false], "GITHUB_REPOSITORY_ACCESS"],
  ]) {
    const { adapter, calls } = setup((args, options, ordinal) => ordinal === failedStage
      ? { ok: false, status: 1, stdout: "", stderr: "private-secret", ...failure } : ok(null));
    const result = adapter.execute(new GitHubPreflightRequest(context));
    assert.deepEqual([result.available, result.authenticated, result.accessible], flags);
    assert.equal(result.failureCode, code);
    assert.equal(calls.length, failedStage);
    assert.equal(JSON.stringify(result).includes("private-secret"), false);
  }
});

test("gh issue retrieval normalizes labels and rejects foreign number or pull request data", () => {
  const raw = { number: 42, html_url: "https://github.example.test/owner/project/issues/42",
    title: "Issue", body: "", labels: [{ name: "bug" }, "ready"], state: "open" };
  const request = new GitHubIssueRequest(context, { number: 42 });
  const { adapter, calls } = setup(() => ok(raw));
  const result = adapter.execute(request);
  assert.ok(result instanceof GitHubIssue);
  assert.deepEqual(result.labels, ["bug", "ready"]);
  assert.equal(result.body, "");
  assert.equal(calls[0].args[1], "repos/owner/project/issues/42");
  for (const changed of [{ number: 43 }, { pull_request: {} }, { html_url: "https://github.example.test/other/project/issues/42" }]) {
    const bad = setup(() => ok({ ...raw, ...changed }));
    assert.throws(() => bad.adapter.execute(request), failCode("GITHUB_INVALID_OUTPUT", request.operation));
  }
});

test("gh PR retrieval returns state, fork branch identity, exact OIDs and a read-only PR fetch locator", () => {
  for (const [raw, state, expectedMerge] of [
    [pr(), "open", null], [pr({ state: "closed" }), "closed", null],
    [pr({ state: "closed", merged_at: at, merge_commit_sha: mergeOid }), "merged", mergeOid],
  ]) {
    const { adapter } = setup((args) => args[1] === "graphql"
      ? ok({ data: { repository: { pullRequest: { headRefName: "feature", headRefOid: headOid, headRef: { name: "feature" } } } } })
      : args[1]?.includes("/git/ref/") ? ok(fetchRef()) : ok(raw));
    const result = adapter.execute(new GitHubPullRequestRequest(context, { number: 42 }));
    assert.ok(result instanceof GitHubPullRequest);
    assert.equal(result.state, state);
    assert.equal(result.mergeOid, expectedMerge);
    assert.equal(result.head.repository.name, "fork/project");
    assert.equal(result.headOid, headOid);
    assert.equal(result.fetchLocator.ref, "refs/pull/42/head");
    assert.equal(result.fetchLocator.remoteUrl, "https://github.example.test/owner/project.git");
  }
  const deleted = setup((args) => args[1] === "graphql"
    ? ok({ data: { repository: { pullRequest: { headRefName: "feature", headRefOid: headOid, headRef: null } } } })
    : args[1]?.includes("/git/ref/") ? ok(fetchRef()) : ok(pr({ head: { ref: "feature", sha: headOid, repo: null } })));
  const result = deleted.adapter.execute(new GitHubPullRequestRequest(context, { number: 42 }));
  assert.equal(result.head.deleted, true);
  assert.equal(result.head.repository, null);
  assert.equal(result.fetchLocator.state, "available");
  const missingBranch = setup((args) => args[1] === "graphql"
    ? ok({ data: { repository: { pullRequest: { headRefName: "feature", headRefOid: headOid, headRef: null } } } })
    : args[1]?.includes("/git/ref/") ? ok(fetchRef()) : ok(pr()));
  const deletedBranch = missingBranch.adapter.execute(new GitHubPullRequestRequest(context, { number: 42 }));
  assert.equal(deletedBranch.head.deleted, true);
  assert.equal(deletedBranch.head.repository.name, "fork/project");
  assert.equal(deletedBranch.fetchLocator.state, "available");
});

test("gh PR search obtains all REST pages and qualifies the branch owner", () => {
  const { adapter, calls } = setup(() => ok([[pr()], [pr({ number: 43,
    html_url: "https://github.example.test/owner/project/pull/43" })]]));
  const result = adapter.execute(new GitHubPullRequestSearchRequest(context,
    { base: "main", head: "feature", expectedHeadOid: headOid, idempotencyKey: "operation" }));
  assert.deepEqual(result.entries.map((entry) => entry.number), [42, 43]);
  assert.equal(result.complete, true);
  assert.ok(calls[0].args.includes("--paginate"));
  assert.ok(calls[0].args.includes("--slurp"));
  assert.equal(new URL(calls[0].args[1], "https://api.example.test").searchParams.get("head"), "owner:feature");
});

test("gh create operations send JSON on stdin and return full typed remote identities", () => {
  const pull = setup(() => ok(pr()));
  const created = pull.adapter.execute(new GitHubPullRequestCreateRequest(context,
    { base: "main", head: "feature", expectedHeadOid: headOid, idempotencyKey: "operation", title: "Title", body: "Body" }));
  assert.ok(created instanceof GitHubPullRequest);
  assert.equal(created.number, 42);
  assert.deepEqual(JSON.parse(pull.calls[0].options.input), { base: "main", head: "feature", title: "Title", body: "Body" });
  assert.ok(pull.calls[0].args.includes("--input"));
  const receipt = setup(() => ok(comment(10)));
  const delivered = receipt.adapter.execute(new GitHubCommentCreateRequest(context,
    { number: 42, idempotencyKey: "delivery", body: "Body" }));
  assert.ok(delivered instanceof GitHubComment);
  assert.equal(delivered.id, "10");
  assert.deepEqual(JSON.parse(receipt.calls[0].options.input), { body: "Body" });
});

test("gh comment search preserves every candidate for common exact marker validation", () => {
  const { adapter } = setup(() => ok([[comment(1, "first")], [comment(2, "second")]]));
  const result = adapter.execute(new GitHubCommentSearchRequest(context,
    { number: 42, idempotencyKey: "delivery", target: "pull-request" }));
  assert.equal(result.complete, true);
  assert.deepEqual(result.entries.map((entry) => entry.id), ["1", "2"]);
});

test("gh external process and HTTP failures have safe stable classifications", () => {
  const request = new GitHubIssueRequest(context, { number: 42 });
  for (const [extra, code] of [
    [{ errorCode: "ENOENT" }, "GITHUB_UNAVAILABLE"], [{ status: 4 }, "GITHUB_AUTHENTICATION"],
    [{ status: 2 }, "GITHUB_CANCELLED"], [{ errorCode: "ETIMEDOUT" }, "GITHUB_TIMEOUT"],
    [{ errorCode: "ENOBUFS" }, "GITHUB_OUTPUT_LIMIT"], [{ signal: "SIGTERM" }, "GITHUB_SIGNAL"],
    [{ errorCode: "ABORT_ERR" }, "GITHUB_CANCELLED"], [{}, "GITHUB_PROCESS_FAILURE"],
    [{ stderr: "private-secret (HTTP 401)" }, "GITHUB_AUTHENTICATION"],
    [{ stderr: "private-secret (HTTP 403)" }, "GITHUB_REPOSITORY_ACCESS"],
    [{ stderr: "private-secret (HTTP 404)" }, "GITHUB_NOT_FOUND"],
    [{ stderr: "private-secret (HTTP 409)" }, "GITHUB_CONFLICT"],
    [{ stderr: "private-secret rate limit (HTTP 403)" }, "GITHUB_RATE_LIMIT"],
    [{ stderr: "private-secret (HTTP 503)" }, "GITHUB_TRANSPORT"],
    [{ stderr: "private-secret dial tcp: no such host" }, "GITHUB_TRANSPORT"],
  ]) {
    const { adapter } = setup(() => ({ ok: false, status: 1, stdout: "private-secret", stderr: "private-secret", ...extra }));
    assert.throws(() => adapter.execute(request), failCode(code, request.operation));
  }
});

test("gh rejects malformed, surplus, wrong-shaped and foreign output without exposing it", () => {
  const request = new GitHubPullRequestRequest(context, { number: 42 });
  for (const stdout of ["private-secret", "{}\n{}", "null", JSON.stringify(pr({ number: 43 })),
    JSON.stringify(pr({ base: { ref: "main", repo: { full_name: "foreign/project" } } }))]) {
    const { adapter } = setup(() => ({ ok: true, status: 0, stdout, stderr: "private-secret" }));
    assert.throws(() => adapter.execute(request), failCode("GITHUB_INVALID_OUTPUT", request.operation));
  }
  const write = setup(() => ({ ok: true, status: 0, stdout: "https://private-secret", stderr: "private-secret" }));
  const create = new GitHubCommentCreateRequest(context, { number: 42, idempotencyKey: "delivery", body: "Body" });
  assert.throws(() => write.adapter.execute(create), failCode("GITHUB_WRITE_OUTCOME_UNKNOWN", create.operation));
});

function connection(nodes, totalCount = nodes.length, next = null) {
  return { nodes, totalCount, pageInfo: { hasNextPage: next !== null, endCursor: next } };
}
function commit(oid, parents) {
  return { commit: { oid, message: "Pushed commit", committedDate: at,
    author: { user: { login: "author", __typename: "User" } }, parents: connection(parents.map((oid) => ({ oid }))) } };
}
function sourceSetup({ changedHead = false, omitPatch = false, commitDiffFailure = false, replyPages = false, dismissedReview = false } = {}) {
  let prReads = 0;
  return setup((args, options) => {
    const endpoint = args[1];
    if (endpoint === "repos/owner/project/pulls/42") return ok(pr({
      ...(changedHead && prReads++ > 0 ? { head: { ...pr().head, sha: mergeOid } } : {}),
    }));
    if (endpoint.includes("/timeline?")) return ok([[{ id: 1, event: "commented", created_at: at, user: actor }],
      [{ id: 2, event: "reviewed", submitted_at: at, commit_id: firstOid, user: actor },
        ...(dismissedReview ? [{ id: 3, event: "review_dismissed", created_at: at, actor, commit_id: null,
          dismissed_review: { review_id: "2", dismissal_commit_id: headOid, state: "changes_requested" } }] : [])]]);
    if (endpoint.includes("/reviews?")) return ok([[{ id: 2, state: "CHANGES_REQUESTED", body: "Fix this", submitted_at: at,
      commit_id: firstOid, user: actor }]]);
    if (endpoint.includes("/comments?")) return ok([[comment(1)]]);
    if (endpoint === "graphql") {
      const { query, variables } = JSON.parse(options.input);
      if (query.includes("reviewThreads(")) return ok({ data: { repository: { pullRequest: { reviewThreads: connection([
        { id: "thread", isResolved: true, isOutdated: true, path: "file.js", line: null },
      ]) } } } });
      if (query.includes("... on PullRequestReviewThread")) {
        const reply = (id) => ({ id: `reply-${id}`, databaseId: id, body: "Reply", createdAt: at,
          author: { login: "bot", __typename: "Bot" }, pullRequestReview: { databaseId: 2 },
          replyTo: id === 1 ? null : { databaseId: 1 }, commit: { oid: firstOid }, path: "file.js", line: null, originalLine: 7 });
        return ok({ data: { node: { comments: replyPages
          ? variables.cursor === null ? connection(Array.from({ length: 100 }, (_, index) => reply(index + 1)), 101, "reply-next")
            : connection([reply(101)], 101) : connection([reply(1), reply(2)]) } } });
      }
      return ok({ data: { repository: { pullRequest: { commits: variables.cursor === null
        ? connection([commit(firstOid, [])], 2, "commit-next") : connection([commit(headOid, [firstOid])], 2) } } } });
    }
    if (endpoint.includes("/files?")) return ok([[{ filename: "file.js", status: "modified", ...(omitPatch ? {} : { patch: "@@ diff" }) }]]);
    if (endpoint.includes("/commits/")) {
      if (commitDiffFailure) return { ok: false, status: 1, stdout: "", stderr: "private-secret (HTTP 404)" };
      const sha = endpoint.split("/commits/")[1].split("?")[0];
      return ok([{ sha, files: [{ filename: "file.js", status: "modified", patch: "@@ commit diff" }] }]);
    }
    throw new Error(`Unexpected fake endpoint ${endpoint}`);
  });
}

test("gh PR sources preserve page order, thread/reply/review linkage and commit head lineage", () => {
  const { adapter, calls } = sourceSetup({ replyPages: true });
  const result = adapter.execute(new GitHubPullRequestSourcesRequest(context, { number: 42 }));
  assert.ok(result instanceof GitHubPullRequestSources);
  assert.equal(result.complete, true);
  assert.deepEqual(result.timeline.entries.map((event) => event.id), ["1", "2"]);
  assert.equal(result.timeline.entries[0].commentId, "1");
  assert.equal(result.timeline.entries[1].reviewId, "2");
  assert.equal(result.reviews.entries[0].commitOid, firstOid);
  const thread = result.threads.entries[0];
  assert.equal(thread.resolved, true);
  assert.equal(thread.outdated, true);
  assert.equal(thread.comments.entries.length, 101);
  assert.equal(thread.comments.entries[100].replyToId, "1");
  assert.equal(thread.comments.entries[100].reviewId, "2");
  assert.equal(thread.comments.entries[100].actor.type, "bot");
  assert.deepEqual(result.commits.entries.map((entry) => entry.oid), [firstOid, headOid]);
  assert.deepEqual(result.commits.entries[1].parents, [firstOid]);
  assert.deepEqual(result.commitDiffs.entries.map((entry) => entry.commitOid), [firstOid, headOid]);
  assert.equal(result.commitDiffs.entries[1].files.entries[0].commitOid, headOid);
  for (const field of ["timeline", "reviews", "comments", "threads", "commits", "diffs", "commitDiffs"]) assert.equal(result[field].headOid, headOid);
  for (const call of calls) {
    assert.equal(call.options.cwd, context.cwd);
    assert.equal(call.args[call.args.indexOf("--hostname") + 1], repository.host);
  }
});

test("gh timeline retains the dismissed review and its dismissal commit identities", () => {
  const { adapter } = sourceSetup({ dismissedReview: true });
  const result = adapter.execute(new GitHubPullRequestSourcesRequest(context, { number: 42 }));
  const dismissal = result.timeline.entries[2];
  assert.equal(result.complete, true);
  assert.deepEqual(result.timeline.entries.map((event) => event.id), ["1", "2", "3"]);
  assert.equal(dismissal.event, "review_dismissed");
  assert.equal(dismissal.reviewId, result.reviews.entries[0].id);
  assert.equal(dismissal.reviewId, "2");
  assert.equal(dismissal.commitOid, headOid);
  assert.equal(dismissal.actor.login, actor.login);
});

test("gh PR sources cannot be complete after a head change or missing diff data", () => {
  const changed = sourceSetup({ changedHead: true }).adapter.execute(new GitHubPullRequestSourcesRequest(context, { number: 42 }));
  assert.equal(changed.consistent, false);
  assert.equal(changed.observedHeadOid, mergeOid);
  assert.equal(changed.complete, false);
  const omitted = sourceSetup({ omitPatch: true }).adapter.execute(new GitHubPullRequestSourcesRequest(context, { number: 42 }));
  assert.equal(omitted.diffs.complete, false);
  assert.equal(omitted.diffs.entries[0].state, "omitted");
  assert.equal(omitted.diffs.entries[0].reason, "PATCH_OMITTED");
  const unavailable = sourceSetup({ commitDiffFailure: true }).adapter.execute(new GitHubPullRequestSourcesRequest(context, { number: 42 }));
  assert.equal(unavailable.commits.complete, true);
  assert.equal(unavailable.complete, false);
  assert.equal(unavailable.commitDiffs.entries[0].commitOid, firstOid);
  assert.equal(unavailable.commitDiffs.entries[0].files.complete, false);
  assert.equal(unavailable.commitDiffs.entries[0].files.reason, "GITHUB_NOT_FOUND");
  assert.equal(JSON.stringify(unavailable).includes("private-secret"), false);
});

test("gh pagination rejects an incomplete response shape or repeated GraphQL cursor", () => {
  const incomplete = setup(() => ok([pr()]));
  const search = new GitHubPullRequestSearchRequest(context, { base: "main", head: "feature", expectedHeadOid: headOid, idempotencyKey: "operation" });
  assert.throws(() => incomplete.adapter.execute(search), failCode("GITHUB_INVALID_OUTPUT", search.operation));
  const { adapter } = sourceSetup();
  const original = adapter.api.runner;
  let page = 0;
  adapter.api.runner = (command, args, options) => args[1] === "graphql" && JSON.parse(options.input).query.includes("reviewThreads(")
    ? ok({ data: { repository: { pullRequest: { reviewThreads: connection([{ id: `thread-${++page}` }], 3, "same-cursor") } } } })
    : original(command, args, options);
  const sources = new GitHubPullRequestSourcesRequest(context, { number: 42 });
  assert.throws(() => adapter.execute(sources), failCode("GITHUB_INVALID_OUTPUT", sources.operation));
});

test("gh PR get rejects stale head observations and never translates a GraphQL access failure into deletion", () => {
  const request = new GitHubPullRequestRequest(context, { number: 42 });
  for (const [response, code] of [
    [ok({ data: { repository: { pullRequest: { headRefName: "feature", headRefOid: mergeOid, headRef: { name: "feature" } } } } }), "GITHUB_CONFLICT"],
    [ok({ errors: [{ type: "FORBIDDEN", message: "private-secret" }] }), "GITHUB_REPOSITORY_ACCESS"],
    [{ ok: false, status: 1, stdout: JSON.stringify({ errors: [{ type: "FORBIDDEN", message: "private-secret" }] }),
      stderr: "private-secret" }, "GITHUB_REPOSITORY_ACCESS"],
  ]) {
    const { adapter } = setup((args) => args[1] === "graphql" ? response : ok(pr()));
    assert.throws(() => adapter.execute(request), failCode(code, request.operation));
  }
});

function fetchLocatorSetup(response) {
  return setup((args) => args[1] === "graphql"
    ? ok({ data: { repository: { pullRequest: { headRefName: "feature", headRefOid: headOid, headRef: { name: "feature" } } } } })
    : args[1]?.includes("/git/ref/") ? response : ok(pr()));
}

test("gh PR fetch locator marks absent, inaccessible or failed ref reads unavailable without changing PR identity", () => {
  for (const [extra, reason] of [
    [{ stderr: "private-secret (HTTP 404)" }, "GITHUB_NOT_FOUND"],
    [{ stderr: "private-secret (HTTP 403)" }, "GITHUB_REPOSITORY_ACCESS"],
    [{ stderr: "private-secret (HTTP 503)" }, "GITHUB_TRANSPORT"],
    [{ errorCode: "ETIMEDOUT" }, "GITHUB_TIMEOUT"],
  ]) {
    const { adapter, calls } = fetchLocatorSetup({ ok: false, status: 1, stdout: "", stderr: "private-secret", ...extra });
    const result = adapter.execute(new GitHubPullRequestRequest(context, { number: 42 }));
    assert.equal(result.state, "open");
    assert.equal(result.number, 42);
    assert.equal(result.headOid, headOid);
    assert.equal(result.head.deleted, false);
    assert.equal(result.fetchLocator.state, "unavailable");
    assert.equal(result.fetchLocator.reason, reason);
    assert.equal(result.fetchLocator.ref, null);
    assert.equal(result.fetchLocator.headOid, headOid);
    assert.ok(result.fetchLocator.repository.equals(repository));
    assert.equal(calls[2].args[1], "repos/owner/project/git/ref/pull/42/head");
    assert.equal(calls[2].args[calls[2].args.indexOf("--hostname") + 1], repository.host);
    assert.equal(calls[2].options.cwd, context.cwd);
    assert.equal(JSON.stringify(result).includes("private-secret"), false);
  }
});

test("gh PR fetch locator reports a changed remote ref without claiming it reaches the observed head", () => {
  const { adapter } = fetchLocatorSetup(ok(fetchRef({ object: { type: "commit", sha: mergeOid } })));
  const result = adapter.execute(new GitHubPullRequestRequest(context, { number: 42 }));
  assert.equal(result.headOid, headOid);
  assert.equal(result.fetchLocator.headOid, headOid);
  assert.equal(result.fetchLocator.state, "unavailable");
  assert.equal(result.fetchLocator.reason, "HEAD_CHANGED");
  assert.equal(result.fetchLocator.ref, null);
});

test("gh PR ref output validates repository, ref and object identity and propagates cancellation or signal", () => {
  const request = new GitHubPullRequestRequest(context, { number: 42 });
  for (const raw of [fetchRef({ ref: "refs/pull/43/head" }),
    fetchRef({ url: "https://github.example.test/api/v3/repos/foreign/project/git/refs/pull/42/head" }),
    fetchRef({ object: { type: "blob", sha: headOid } }), fetchRef({ object: { type: "commit", sha: "invalid" } })]) {
    assert.throws(() => fetchLocatorSetup(ok(raw)).adapter.execute(request), failCode("GITHUB_INVALID_OUTPUT", request.operation));
  }
  for (const [extra, code] of [[{ errorCode: "ABORT_ERR" }, "GITHUB_CANCELLED"], [{ signal: "SIGTERM" }, "GITHUB_SIGNAL"]]) {
    const response = { ok: false, status: 1, stdout: "", stderr: "private-secret", ...extra };
    assert.throws(() => fetchLocatorSetup(response).adapter.execute(request), failCode(code, request.operation));
  }
});

test("gh sources retrieve more than the REST PR commit limit and retain every commit diff", () => {
  const { adapter, calls } = sourceSetup();
  const original = adapter.api.runner;
  const oids = Array.from({ length: 250 }, (_, index) => (index + 1).toString(16).padStart(40, "0"));
  oids.push(headOid);
  adapter.api.runner = (command, args, options) => {
    if (args[1] === "repos/owner/project/pulls/42") return ok(pr({ commits: 251 }));
    if (args[1] === "graphql") {
      const { query, variables } = JSON.parse(options.input);
      if (query.includes("commits(first:")) {
        const start = variables.cursor === null ? 0 : Number(variables.cursor);
        const nodes = oids.slice(start, start + 100).map((oid, index) => commit(oid, start + index === 0 ? [] : [oids[start + index - 1]]));
        return ok({ data: { repository: { pullRequest: { commits: connection(nodes, 251,
          start + 100 < 251 ? String(start + 100) : null) } } } });
      }
    }
    return original(command, args, options);
  };
  const result = adapter.execute(new GitHubPullRequestSourcesRequest(context, { number: 42 }));
  assert.equal(result.complete, true);
  assert.deepEqual(result.commits.entries.map((entry) => entry.oid), oids);
  assert.deepEqual(result.commitDiffs.entries.map((entry) => entry.commitOid), oids);
  assert.equal(calls.filter((call) => call.args[1]?.includes("/pulls/42/commits")).length, 0);
});

test("gh file caps remain incomplete even when gh has fetched every exposed page", () => {
  const { adapter } = sourceSetup();
  const original = adapter.api.runner;
  const files = Array.from({ length: 3000 }, (_, index) => ({ filename: `file-${index}.js`, status: "modified", patch: "@@ diff" }));
  adapter.api.runner = (command, args, options) => {
    if (args[1] === "repos/owner/project/pulls/42") return ok(pr({ changed_files: 3001 }));
    if (args[1]?.includes("/files?")) return ok([files.slice(0, 1500), files.slice(1500)]);
    if (args[1]?.includes(`/commits/${firstOid}?`)) return ok([{ sha: firstOid, files: files.slice(0, 1500) }, { sha: firstOid, files: files.slice(1500) }]);
    return original(command, args, options);
  };
  const result = adapter.execute(new GitHubPullRequestSourcesRequest(context, { number: 42 }));
  assert.equal(result.complete, false);
  assert.equal(result.diffs.complete, false);
  assert.equal(result.diffs.entries.length, 3000);
  assert.equal(result.diffs.reason, "FILE_LIMIT_REACHED");
  assert.equal(result.commitDiffs.entries[0].files.entries.length, 3000);
  assert.equal(result.commitDiffs.entries[0].files.reason, "FILE_LIMIT_REACHED");
});

test("gh source outages remain typed incomplete data and truncated GraphQL pages are rejected", () => {
  const { adapter } = sourceSetup();
  const original = adapter.api.runner;
  adapter.api.runner = (command, args, options) => args[1]?.includes("/reviews?")
    ? { ok: false, status: 1, stderr: "private-secret (HTTP 503)" } : original(command, args, options);
  const result = adapter.execute(new GitHubPullRequestSourcesRequest(context, { number: 42 }));
  assert.equal(result.complete, false);
  assert.equal(result.reviews.complete, false);
  assert.equal(result.reviews.reason, "GITHUB_TRANSPORT");
  assert.equal(JSON.stringify(result).includes("private-secret"), false);
  const truncated = sourceSetup();
  const run = truncated.adapter.api.runner;
  truncated.adapter.api.runner = (command, args, options) => args[1] === "graphql" && JSON.parse(options.input).query.includes("reviewThreads(")
    ? ok({ data: { repository: { pullRequest: { reviewThreads: connection([], 1) } } } }) : run(command, args, options);
  const request = new GitHubPullRequestSourcesRequest(context, { number: 42 });
  assert.throws(() => truncated.adapter.execute(request), failCode("GITHUB_INVALID_OUTPUT", request.operation));
});
