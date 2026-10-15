import test from "node:test";
import assert from "node:assert/strict";
import { GitHubProvider } from "../../src/lib/github/provider.js";
import { CommandGitHubAdapter } from "../../src/lib/github/command-adapter.js";
import { GitHubFailure, classifyProcessFailure } from "../../src/lib/github/failure.js";
import { GitHubPreflightRequest, GitHubIssueRequest, GitHubPullRequestRequest, GitHubPullRequestSourcesRequest,
  GitHubPullRequestSearchRequest, GitHubExecutionContext, gitHubIdempotencyMarker } from "../../src/lib/github/requests.js";
import { GitHubRepository, GitHubIssue, GitHubPreflight, GitHubCollection, GitHubBranch, GitHubFetchLocator,
  GitHubPullRequest, GitHubComment, GitHubPullRequestSources, GitHubCommit, GitHubCommitDiff, GitHubFileDiff } from "../../src/lib/github/values.js";
import { decodeGitHubResponse } from "../../src/lib/github/protocol.js";
import { GhGitHubAdapter } from "../../src/lib/github/gh-adapter.js";
import { ProcessExecutionControlFailure } from "../../src/lib/process-execution-values.js";

const repository = new GitHubRepository({ host: "github.example", name: "Owner/Repo" });
const cwd = "/fixture/worktree";
const headOid = "a".repeat(40);
const identity = "flow-outbox-v1:run:flow:finalize-merge:finalize-merge";
const input = { cwd, repository, base: "main", head: "feature", expectedHeadOid: headOid, idempotencyKey: identity, title: "Change", body: "Description" };
function pr(body = `${input.body}\n\n${gitHubIdempotencyMarker(identity)}`, override = {}) {
  return new GitHubPullRequest({ repository, number: 42, url: "https://github.example/owner/repo/pull/42", state: "open",
    title: input.title, body, base: new GitHubBranch({ repository, name: "main" }), head: new GitHubBranch({ repository, name: "feature" }),
    headOid, mergeOid: null, fetchLocator: new GitHubFetchLocator({ repository, ref: "refs/pull/42/head", headOid }), ...override });
}
function collection(entries, extra = {}) { return new GitHubCollection({ repository, entries, ...extra }); }
function comment(body, id = 91) { return new GitHubComment({ repository, number: 42, id, body, url: `https://github.example/owner/repo/issues/42#issuecomment-${id}` }); }
function envelope(request, data) { return JSON.stringify({ revision: 1, requestId: request.requestId, operation: request.operation, ok: true, data }); }

test("typed repository and PR invariants bind host, number, branches and merge OID", () => {
  assert.equal(repository.name, "owner/repo");
  assert.equal(pr().fetchLocator.remoteUrl, "https://github.example/owner/repo.git");
  assert.throws(() => new GitHubRepository({ host: "user@github.example", name: "owner/repo" }), TypeError);
  assert.throws(() => pr(undefined, { state: "merged" }), TypeError);
  assert.throws(() => pr(undefined, { url: "https://github.example/other/repo/pull/42" }), TypeError);
  assert.throws(() => pr(undefined, { headOid: "b".repeat(40) }), TypeError);
});

test("external response must match revision, request, operation, repository, number and complete schema", () => {
  const request = new GitHubIssueRequest(new GitHubExecutionContext({ cwd, repository }), { number: 42 });
  const issue = new GitHubIssue({ repository, number: 42, title: "Issue", body: "Body", labels: ["bug"], state: "open" });
  assert.ok(decodeGitHubResponse(request, envelope(request, issue.toJSON())) instanceof GitHubIssue);
  for (const response of [
    "not JSON secret-token", `${envelope(request, issue.toJSON())}\n{}`,
    JSON.stringify({ revision: 2, requestId: request.requestId, operation: request.operation, ok: true, data: issue.toJSON() }),
    JSON.stringify({ revision: 1, requestId: "another", operation: request.operation, ok: true, data: issue.toJSON() }),
    envelope(request, { ...issue.toJSON(), number: 43 }), envelope(request, { ...issue.toJSON(), labels: [{ name: "bug" }] }),
    envelope(request, { ...issue.toJSON(), repository: { host: "github.example", name: "another/repo" } }),
    envelope(request, { ...issue.toJSON(), secret: "credential" }),
  ]) assert.throws(() => decodeGitHubResponse(request, response), { code: "GITHUB_INVALID_OUTPUT" });
});

test("unavailable reason fields reject external diagnostic text without exposing it", () => {
  const context = new GitHubExecutionContext({ cwd, repository });
  const prRequest = new GitHubPullRequestRequest(context, { number: 42 });
  const searchRequest = new GitHubPullRequestSearchRequest(context, input);
  const sourcesRequest = new GitHubPullRequestSourcesRequest(context, { number: 42 });
  const sourceCollection = (entries = [], extra = {}) => collection(entries, { headOid, ...extra });
  const sources = new GitHubPullRequestSources({ repository, number: 42, headOid, observedHeadOid: headOid, consistent: true,
    timeline: sourceCollection(), reviews: sourceCollection(), comments: sourceCollection(), threads: sourceCollection(),
    commits: sourceCollection(), commitDiffs: sourceCollection(),
    diffs: sourceCollection([new GitHubFileDiff({ path: "change.js", status: "modified", patch: null,
      state: "omitted", reason: "PATCH_OMITTED" })], { complete: false, reason: "FILE_LIMIT_REACHED,PATCH_OMITTED" }) });
  const unavailable = pr().toJSON();
  unavailable.fetchLocator = { ...unavailable.fetchLocator, ref: null, state: "unavailable", reason: "HEAD_CHANGED" };
  assert.equal(decodeGitHubResponse(prRequest, envelope(prRequest, unavailable)).fetchLocator.reason, "HEAD_CHANGED");
  assert.equal(decodeGitHubResponse(sourcesRequest, envelope(sourcesRequest, sources.toJSON())).diffs.reason,
    "FILE_LIMIT_REACHED,PATCH_OMITTED");
  const secret = "external-secret-token-value";
  const diagnosticDiff = sources.toJSON();
  diagnosticDiff.diffs.entries[0].reason = secret;
  for (const [request, data] of [
    [prRequest, { ...unavailable, fetchLocator: { ...unavailable.fetchLocator, reason: secret } }],
    [searchRequest, { ...collection([], { complete: false, reason: "PAGE_LIMIT" }).toJSON(), reason: secret }],
    [sourcesRequest, diagnosticDiff],
    [sourcesRequest, { ...sources.toJSON(), diffs: { ...sources.toJSON().diffs, reason: `PATCH_OMITTED,${secret}` } }],
  ]) assert.throws(() => decodeGitHubResponse(request, envelope(request, data)), (error) => {
    assert.equal(error.code, "GITHUB_INVALID_OUTPUT");
    assert.equal(`${error.message}${JSON.stringify(error)}`.includes(secret), false);
    return true;
  });
});

test("finite transport retries retain the same request identity and do not repeat permanent failures", () => {
  let calls = 0;
  const ids = [];
  const provider = new GitHubProvider({ execute(request) {
    calls += 1; ids.push(request.requestId);
    throw new GitHubFailure("GITHUB_TRANSPORT", request.operation);
  } }, { maxAttempts: 2 });
  assert.throws(() => provider.getIssue({ cwd, repository, number: 42 }), { code: "GITHUB_TRANSPORT", retryable: true });
  assert.equal(calls, 2); assert.equal(new Set(ids).size, 1);
  calls = 0;
  const permanent = new GitHubProvider({ execute(request) { calls += 1; throw new GitHubFailure("GITHUB_AUTHENTICATION", request.operation); } });
  assert.throws(() => permanent.getIssue({ cwd, repository, number: 42 }), { code: "GITHUB_AUTHENTICATION", retryable: false });
  assert.equal(calls, 1);
});

test("PR response loss reads back its exact identity without repeating creation", () => {
  const calls = []; let remote = null;
  const provider = new GitHubProvider({ execute(request) {
    calls.push(request.operation);
    if (request.operation === "pull-request.search") return collection(remote === null ? [] : [remote]);
    remote = pr(request.body);
    throw new GitHubFailure("GITHUB_TIMEOUT", request.operation);
  } });
  const created = provider.createPullRequest(input);
  assert.equal(created.number, 42); assert.equal(created.headOid, headOid);
  assert.deepEqual(calls, ["pull-request.search", "pull-request.create", "pull-request.search"]);
});

test("foreign, multiple, stale-head and incomplete PR readback refuse before write", () => {
  const changedOid = "b".repeat(40);
  const stale = pr(undefined, { headOid: changedOid, fetchLocator: new GitHubFetchLocator({ repository, ref: "refs/pull/42/head", headOid: changedOid }) });
  for (const candidates of [collection([pr("foreign")]), collection([pr(), pr()]), collection([stale]), collection([], { complete: false, reason: "PAGE_LIMIT" })]) {
    const operations = [];
    const provider = new GitHubProvider({ execute(request) { operations.push(request.operation); return candidates; } });
    assert.throws(() => provider.createPullRequest(input), { code: candidates.complete ? "GITHUB_CONFLICT" : "GITHUB_WRITE_OUTCOME_UNKNOWN" });
    assert.deepEqual(operations, ["pull-request.search"]);
  }
});

test("failed write with unavailable readback never retries remote mutation", () => {
  let searches = 0; let writes = 0;
  const provider = new GitHubProvider({ execute(request) {
    if (request.operation === "pull-request.search") {
      if (searches++ === 0) return collection([]);
      throw new GitHubFailure("GITHUB_TRANSPORT", request.operation);
    }
    writes += 1; throw new GitHubFailure("GITHUB_TIMEOUT", request.operation);
  } });
  assert.throws(() => provider.createPullRequest(input), { code: "GITHUB_WRITE_OUTCOME_UNKNOWN" });
  assert.equal(writes, 1); assert.equal(searches, 3);
});

test("comment receipt reuses exact body and rejects conflicting or multiple marker evidence", () => {
  const commentInput = { cwd, repository, number: 42, body: "Report", idempotencyKey: identity };
  const body = `Report\n\n${gitHubIdempotencyMarker(identity)}`;
  const provider = new GitHubProvider({ execute() { return collection([comment(body)]); } });
  const result = provider.deliverComment(commentInput);
  assert.equal(result.resumed, true); assert.equal(result.comment.id, "91");
  for (const entries of [[comment(`other\n\n${gitHubIdempotencyMarker(identity)}`)], [comment(body), comment(body, 92)]]) {
    const conflict = new GitHubProvider({ execute() { return collection(entries); } });
    assert.throws(() => conflict.deliverComment(commentInput), { code: "GITHUB_CONFLICT" });
  }
});

test("successful write responses still require matching unique remote publication evidence", () => {
  const commentInput = { cwd, repository, number: 42, body: "Report", idempotencyKey: identity };
  const body = `Report\n\n${gitHubIdempotencyMarker(identity)}`;
  for (const entries of [[comment(`different\n\n${gitHubIdempotencyMarker(identity)}`)], [comment(body), comment(body, 92)], []]) {
    let reads = 0; const operations = [];
    const provider = new GitHubProvider({ execute(request) {
      operations.push(request.operation);
      if (request.operation === "comment.search") return collection(reads++ === 0 ? [] : entries);
      return comment(request.body);
    } });
    assert.throws(() => provider.deliverComment(commentInput), { code: entries.length ? "GITHUB_CONFLICT" : "GITHUB_WRITE_OUTCOME_UNKNOWN" });
    assert.deepEqual(operations, ["comment.search", "comment.create", "comment.search"]);
  }
  let reads = 0;
  const wrongBranch = new GitHubProvider({ execute(request) {
    if (request.operation === "pull-request.search") return collection(reads++ === 0 ? [] : [pr()]);
    return pr(request.body, { base: new GitHubBranch({ repository, name: "another-base" }) });
  } });
  assert.throws(() => wrongBranch.createPullRequest(input), { code: "GITHUB_CONFLICT" });
});

test("comment URL and source bindings reject foreign nested identities and incomplete commit inventories", () => {
  assert.throws(() => new GitHubComment({ repository, number: 42, id: 91, body: "Report", url: "https://github.example/owner/repo/issues/999#issuecomment-888" }), TypeError);
  const bound = (entries = []) => collection(entries, { headOid });
  const source = { repository, number: 42, headOid, observedHeadOid: headOid, consistent: true,
    timeline: bound(), reviews: bound(), comments: bound(), threads: bound(), commits: bound([new GitHubCommit({ oid: headOid, message: "head" })]),
    diffs: bound(), commitDiffs: bound([new GitHubCommitDiff({ commitOid: headOid, files: bound() })]) };
  assert.equal(new GitHubPullRequestSources(source).complete, true);
  assert.throws(() => new GitHubPullRequestSources({ ...source, commitDiffs: bound() }), TypeError);
  const oldOid = "b".repeat(40);
  assert.throws(() => new GitHubPullRequestSources({ ...source,
    commits: bound([new GitHubCommit({ oid: oldOid, message: "stale" })]),
    commitDiffs: bound([new GitHubCommitDiff({ commitOid: oldOid, files: bound() })]) }), TypeError);
  const foreign = new GitHubRepository({ host: "github.example", name: "another/repo" });
  const foreignComment = new GitHubComment({ repository: foreign, number: 42, id: 91, body: "Body", url: "https://github.example/another/repo/issues/42#issuecomment-91" });
  assert.throws(() => new GitHubPullRequestSources({ ...source, comments: bound([foreignComment]) }), TypeError);
  const foreignFiles = new GitHubCollection({ repository: foreign, headOid, entries: [] });
  assert.throws(() => new GitHubPullRequestSources({ ...source, commitDiffs: bound([new GitHubCommitDiff({ commitOid: headOid, files: foreignFiles })]) }), TypeError);
});

test("safe process and external failure classification never retains stderr or external message", () => {
  for (const [result, code] of [[{ errorCode: "ENOENT" }, "GITHUB_UNAVAILABLE"], [{ errorCode: "ETIMEDOUT", signal: "SIGTERM" }, "GITHUB_TIMEOUT"],
    [{ errorCode: "ENOBUFS" }, "GITHUB_OUTPUT_LIMIT"], [{ signal: "SIGKILL" }, "GITHUB_SIGNAL"], [{ errorCode: "ABORT_ERR" }, "GITHUB_CANCELLED"], [{ status: 12 }, "GITHUB_PROCESS_FAILURE"]]) {
    const error = classifyProcessFailure({ ...result, stderr: "secret-value" }, "issue.get");
    assert.equal(error.code, code); assert.equal(JSON.stringify(error.toJSON()).includes("secret-value"), false);
  }
  const request = new GitHubPreflightRequest({ cwd, repository });
  assert.throws(() => decodeGitHubResponse(request, JSON.stringify({ revision: 1, requestId: request.requestId, operation: request.operation,
    ok: false, failure: { code: "GITHUB_AUTHENTICATION", message: "secret-value" } })), { code: "GITHUB_INVALID_OUTPUT" });
  const adapter = new CommandGitHubAdapter({ command: "external", args: ["literal"], timeout: 10, maxBuffer: 1024 }, { runner(command, args, options) {
    assert.equal(command, "external"); assert.deepEqual(args, ["literal"]); assert.equal(options.cwd, cwd);
    const sent = JSON.parse(options.input); assert.equal(sent.operation, "provider.preflight");
    return { ok: true, stdout: envelope(request, new GitHubPreflight({ available: true, authenticated: true, accessible: true, repository }).toJSON()), stderr: "secret-value" };
  } });
  assert.equal(adapter.execute(request).ready(), true);
});

test("process ownership control failures propagate unchanged without transport retry", () => {
  const control = new ProcessExecutionControlFailure("admission-failed", "Process ownership admission was refused");
  let calls = 0;
  const adapter = new GhGitHubAdapter({ timeout: 30000, maxBuffer: 4096 }, { runner() { calls += 1; throw control; } });
  const provider = new GitHubProvider(adapter);
  assert.throws(() => provider.preflight({ cwd, repository }), (error) => error === control);
  assert.equal(calls, 1);
});

test("per-commit missing diffs and observed head changes remain explicit source facts", () => {
  const observedHeadOid = "b".repeat(40);
  const sourceCollection = (entries = []) => collection(entries, { headOid });
  const missing = new GitHubCommitDiff({ commitOid: headOid, files: sourceCollection([]) });
  const unavailable = new GitHubCommitDiff({ commitOid: observedHeadOid, files: collection([], { headOid, complete: false, reason: "GITHUB_NOT_FOUND" }) });
  const sources = new GitHubPullRequestSources({ repository, number: 42, headOid, observedHeadOid, consistent: false,
    timeline: sourceCollection(), reviews: sourceCollection(), comments: sourceCollection(), threads: sourceCollection(),
    commits: sourceCollection([new GitHubCommit({ oid: observedHeadOid, message: "pushed earlier" }), new GitHubCommit({ oid: headOid, message: "pushed" })]), diffs: sourceCollection(), commitDiffs: sourceCollection([missing, unavailable]) });
  assert.equal(sources.complete, false); assert.equal(sources.consistent, false);
  const reloaded = GitHubPullRequestSources.fromJSON(JSON.parse(JSON.stringify(sources.toJSON())));
  assert.equal(reloaded.commitDiffs.entries[1].files.reason, "GITHUB_NOT_FOUND");
  assert.equal(reloaded.commitDiffs.entries[1].commitOid, observedHeadOid);
});
