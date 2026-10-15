import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveGitHubProvider, GitHubPullRequest, GitHubCommentDelivery, GitHubPullRequestSources,
  GitHubRepository, GitHubBranch, GitHubFetchLocator, GitHubIssue, GitHubCollection, GitHubCommit,
  GitHubTimelineEvent, GitHubActor, GitHubReview, GitHubComment, GitHubReviewReply, GitHubReviewThread,
  GitHubFileDiff, GitHubCommitDiff } from "../../src/lib/github/provider.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";

const repository = new GitHubRepository({ host: "github.example", name: "owner/repo" });
const headOid = "a".repeat(40);
const at = "2026-10-15T00:00:00.000Z";
const actor = new GitHubActor({ login: "quality-bot", type: "bot" });
function pr() { return new GitHubPullRequest({ repository, number: 42, title: "Change", body: "Description", url: "https://github.example/owner/repo/pull/42",
  state: "open", base: new GitHubBranch({ repository, name: "main" }), head: new GitHubBranch({ repository, name: "feature" }), headOid, mergeOid: null,
  fetchLocator: new GitHubFetchLocator({ repository, ref: "refs/pull/42/head", headOid }) }); }
function collection(entries = []) { return new GitHubCollection({ repository, entries, headOid }); }
function sources() {
  const files = collection([new GitHubFileDiff({ commitOid: headOid, path: "index.js", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new", state: "available" })]);
  return new GitHubPullRequestSources({ repository, number: 42, headOid, observedHeadOid: headOid, consistent: true,
    timeline: collection([new GitHubTimelineEvent({ id: "event-1", event: "reviewed", at, actor, commitOid: headOid, reviewId: "review-1" })]),
    reviews: collection([new GitHubReview({ id: "review-1", state: "changes_requested", body: "Fix a condition", at, actor, commitOid: headOid })]),
    comments: collection([new GitHubComment({ repository, number: 42, id: "1", url: "https://github.example/owner/repo/pull/42#issuecomment-1", body: "Check it", at, actor })]),
    threads: collection([new GitHubReviewThread({ id: "thread-1", resolved: false, outdated: false, path: "index.js", line: 1,
      comments: collection([new GitHubReviewReply({ id: "reply-1", body: "Boundary case", at, actor, reviewId: "review-1", commitOid: headOid, path: "index.js", line: 1 })]) })]),
    commits: collection([new GitHubCommit({ oid: headOid, message: "pushed implementation", at, actor })]), diffs: files,
    commitDiffs: collection([new GitHubCommitDiff({ commitOid: headOid, files })]) });
}

function fixture(t, mode = "normal", settings = {}) {
  const root = createTmpDir("github-command-provider-");
  t.after(() => removeTmpDir(root));
  const script = path.join(root, "bridge.mjs");
  const stateFile = path.join(root, "remote.json");
  fs.writeFileSync(path.join(root, "seed.json"), JSON.stringify({ repository: repository.toJSON(), pr: pr().toJSON(), sources: sources().toJSON(),
    issue: new GitHubIssue({ repository, number: 42, title: "Issue", body: "Linked requirement", labels: ["enhancement"], state: "open" }).toJSON() }));
  fs.writeFileSync(stateFile, JSON.stringify({ prs: [], comments: [], writes: 0, requests: [] }));
  fs.writeFileSync(script, `import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const seed = JSON.parse(fs.readFileSync('seed.json', 'utf8'));
const file = 'remote.json';
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.requests.push(input);
const mode = ${JSON.stringify(mode)};
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const collection = (entries) => ({repository: seed.repository, entries, complete:true, cursor:null, reason:null, headOid:null});
let data;
switch(input.operation) {
case 'provider.preflight': data={available:true,authenticated:true,accessible:true,repository:seed.repository,failureCode:null}; break;
case 'issue.get': data=seed.issue; break;
case 'pull-request.get': data=seed.pr; break;
case 'pull-request.sources': data=seed.sources; break;
case 'pull-request.search': data=collection(state.prs); break;
case 'pull-request.create': data={...seed.pr,title:input.payload.title,body:input.payload.body}; state.prs.push(data); state.writes++; break;
case 'comment.search': data=collection(state.comments); break;
case 'comment.create': data={repository:seed.repository,number:input.payload.number,id:'91',url:'https://github.example/owner/repo/issues/42#issuecomment-91',body:input.payload.body,at:null,actor:null}; state.comments.push(data); state.writes++; break;
default: throw Error('unexpected operation');
}
save();
if(mode==='timeout') { setTimeout(()=>{},10000); }
else if(mode==='signal') { process.kill(process.pid,'SIGTERM'); }
else if(mode==='overflow') { process.stdout.write('x'.repeat(100000)); }
else if(mode==='nonzero') { process.stderr.write('secret-token-value'); process.exitCode=13; }
else if(mode==='nonzero-success') { process.stdout.write(JSON.stringify({revision:1,requestId:input.requestId,operation:input.operation,ok:true,data})); process.exitCode=13; }
else if(mode==='malformed' || (mode==='response-loss' && input.operation.endsWith('.create'))) { process.stdout.write('secret-token-value invalid JSON'); }
else if(mode==='extra') { process.stdout.write('noise'+JSON.stringify(data)); }
else {
 if(mode==='wrong-repository') data.repository={host:'github.example',name:'other/repo'};
 const response={revision:1,requestId:input.requestId,operation:input.operation,ok:true,data};
 if(mode==='wrong-request') response.requestId='other';
 if(mode==='wrong-operation') response.operation='other';
 if(mode==='wrong-revision') response.revision=9;
 if(mode==='authentication') {delete response.data;response.ok=false;response.failure={code:'GITHUB_AUTHENTICATION'};}
 process.stderr.write('secret-token-value');
 process.stdout.write(JSON.stringify(response));
}
`);
  const config = { github: { provider: "bridge", repository: repository.toJSON(), providers: {
    bridge: { command: process.execPath, args: [script], maxAttempts: 1, timeout: 5000, maxBuffer: 4194304, ...settings },
  } } };
  return { root, config, state: () => JSON.parse(fs.readFileSync(stateFile, "utf8")), provider: () => resolveGitHubProvider(config) };
}

test("configured external executable serves typed read, PR source and write operations in its pinned execution root", (t) => {
  const f = fixture(t); const provider = f.provider(); const input = { cwd: f.root, repository };
  assert.equal(provider.preflight(input).assertReady().repository.equals(repository), true);
  assert.deepEqual(provider.getIssue({ ...input, number: 42 }).labels, ["enhancement"]);
  assert.equal(provider.getPullRequest({ ...input, number: 42 }).fetchLocator.ref, "refs/pull/42/head");
  const source = provider.getPullRequestSources({ ...input, number: 42 });
  assert.ok(source instanceof GitHubPullRequestSources); assert.equal(source.complete, true);
  assert.equal(source.reviews.entries[0].state, "changes_requested");
  assert.equal(source.threads.entries[0].comments.entries[0].actor.type, "bot");
  assert.equal(source.commitDiffs.entries[0].files.entries[0].commitOid, headOid);
  const request = { ...input, ...pr().toJSON(), base: "main", head: "feature", expectedHeadOid: headOid, idempotencyKey: "create-42" };
  const created = provider.createPullRequest(request); assert.ok(created instanceof GitHubPullRequest); assert.equal(created.number, 42);
  const posted = provider.deliverComment({ ...input, number: 42, body: "Report", idempotencyKey: "report-42" });
  assert.ok(posted instanceof GitHubCommentDelivery); assert.equal(posted.resumed, false);
  const reloaded = f.provider().deliverComment({ ...input, number: 42, body: "Report", idempotencyKey: "report-42" });
  assert.equal(reloaded.resumed, true); assert.equal(reloaded.comment.id, posted.comment.id);
  assert.equal(f.state().writes, 2);
  assert.equal(f.state().requests.every((r) => r.context.cwd === f.root && r.context.repository.name === "owner/repo"), true);
});

test("remote PR and comment mutations survive invalid lost responses and provider reconstruction without duplicates", (t) => {
  const f = fixture(t, "response-loss"); const input = { cwd: f.root, repository };
  const request = { ...input, base: "main", head: "feature", expectedHeadOid: headOid, idempotencyKey: "create-42", title: "Change", body: "Description" };
  const created = f.provider().createPullRequest(request);
  assert.equal(created.number, 42); assert.equal(f.state().writes, 1);
  assert.equal(f.provider().createPullRequest(request).headOid, headOid); assert.equal(f.state().writes, 1);
  const commentInput = { ...input, number: 42, body: "Report", idempotencyKey: "report-42" };
  const first = f.provider().deliverComment(commentInput); assert.equal(first.resumed, true);
  const second = f.provider().deliverComment(commentInput); assert.equal(second.comment.id, first.comment.id);
  assert.equal(f.state().writes, 2);
});

test("actual process boundary rejects malformed, mismatched, failed, timed out and oversized output with safe codes", (t) => {
  for (const [mode, settings, code] of [["malformed", {}, "GITHUB_INVALID_OUTPUT"], ["extra", {}, "GITHUB_INVALID_OUTPUT"],
    ["wrong-request", {}, "GITHUB_INVALID_OUTPUT"], ["wrong-operation", {}, "GITHUB_INVALID_OUTPUT"], ["wrong-revision", {}, "GITHUB_INVALID_OUTPUT"],
    ["wrong-repository", {}, "GITHUB_INVALID_OUTPUT"], ["nonzero", {}, "GITHUB_PROCESS_FAILURE"], ["nonzero-success", {}, "GITHUB_PROCESS_FAILURE"],
    ["authentication", {}, "GITHUB_AUTHENTICATION"], ["signal", {}, "GITHUB_SIGNAL"], ["timeout", { timeout: 300 }, "GITHUB_TIMEOUT"],
    ["overflow", { maxBuffer: 1024 }, "GITHUB_OUTPUT_LIMIT"]]) {
    const f = fixture(t, mode, settings);
    assert.throws(() => f.provider().getIssue({ cwd: f.root, repository, number: 42 }), (error) => {
      assert.equal(error.code, code, mode); assert.equal(JSON.stringify(error.toJSON()).includes("secret-token-value"), false); return true;
    });
  }
});
