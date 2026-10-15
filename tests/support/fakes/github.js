/** A test-owned offline gh process. Repository, Issue and comment responses
 * follow GitHub REST fields; only the external process is replaced. */
export function offlineGitHubScript({ title = "Offline fixture Issue", body = "Offline fixture immutable Issue snapshot", labels = [], state = "open" } = {}) {
  return `#!${process.execPath}
import("node:fs").then(({ default: fs }) => {
const args = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
if (process.env.SENNEL_TEST_GH_LOG) fs.appendFileSync(process.env.SENNEL_TEST_GH_LOG, JSON.stringify({ args, input }) + "\\n");
const fixture = ${JSON.stringify({ title, body, labels, state })};
const repository = { full_name: "fixture/repository", name: "repository", owner: { login: "fixture" },
  html_url: "https://github.com/fixture/repository", nameWithOwner: "fixture/repository", url: "https://github.com/fixture/repository" };
const emit = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "--version") { process.stdout.write("gh fixture\\n"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") process.exit(0);
if (args[0] === "repo" && args[1] === "view") { emit(repository); process.exit(0); }
if (args[0] === "api") {
  const endpoint = args[1];
  if (endpoint === "user") { emit({ login: "fixture" }); process.exit(0); }
  if (/^repos\\/[^/]+\\/[^/]+$/.test(endpoint)) { emit(repository); process.exit(0); }
  const match = /^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)(\\/comments)?(?:\\?.*)?$/.exec(endpoint);
  if (match) {
    const number = Number(match[1]);
    if (!match[2]) { emit({ ...fixture, number, html_url: repository.html_url + "/issues/" + number,
      url: "https://api.github.com/repos/fixture/repository/issues/" + number,
      labels: fixture.labels.map((label) => typeof label === "string" ? { name: label } : label) }); process.exit(0); }
    const storage = process.argv[1] + ".comments.json";
    const comments = fs.existsSync(storage) ? JSON.parse(fs.readFileSync(storage, "utf8")) : [];
    if (args.includes("POST")) {
      const comment = { id: comments.length + 1, body: JSON.parse(input).body,
        html_url: repository.html_url + "/issues/" + number + "#issuecomment-" + (comments.length + 1),
        user: { login: "fixture" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
      comments.push(comment); fs.writeFileSync(storage, JSON.stringify(comments)); emit(comment);
    } else emit(args.includes("--slurp") ? [comments] : comments);
    process.exit(0);
  }
}
process.stderr.write("Unexpected offline gh operation: " + JSON.stringify(args)); process.exit(19);
});
`;
}

/** Named external provider fixture with durable remote state and optional
 * post-write response loss. Control and remote files stay under the caller's root. */
export function offlineExternalGitHubScript({ repository = { host: "github.com", name: "fixture/repository" },
  title = "Offline Issue", body = "External immutable Issue snapshot", labels = [], controlPath = null } = {}) {
  return `import fs from "node:fs";
import childProcess from "node:child_process";
const request = JSON.parse(fs.readFileSync(0, "utf8"));
const control = ${JSON.stringify(controlPath)};
const controls = control && fs.existsSync(control) ? JSON.parse(fs.readFileSync(control, "utf8")) : {};
const storage = process.argv[1] + ".remote.json";
const remote = fs.existsSync(storage) ? JSON.parse(fs.readFileSync(storage, "utf8")) : { prs: [], comments: [], calls: [] };
remote.calls.push(request); fs.writeFileSync(storage, JSON.stringify(remote));
const repository = ${JSON.stringify(repository)};
const url = "https://" + repository.host + "/" + repository.name;
const payload = request.payload;
const fail = (code) => process.stdout.write(JSON.stringify({ revision: 1, requestId: request.requestId,
  operation: request.operation, ok: false, failure: { code } }));
const reply = (data) => process.stdout.write(JSON.stringify({ revision: 1, requestId: request.requestId,
  operation: request.operation, ok: true, data }));
const collection = (entries) => ({ repository, entries, complete: true, cursor: null, reason: null, headOid: null });
if (request.operation === "provider.preflight") reply({ available: true, authenticated: !controls.authenticationFailure,
  accessible: !controls.authenticationFailure, repository, failureCode: controls.authenticationFailure ? "GITHUB_AUTHENTICATION" : null });
else if (request.operation === "issue.get") reply({ repository, number: payload.number,
  title: ${JSON.stringify(title)}, body: ${JSON.stringify(body)}, labels: ${JSON.stringify(labels)}, state: "open" });
else if (request.operation === "pull-request.search") {
  if (controls.loseResponse && remote.prs.length) fail("GITHUB_TRANSPORT");
  else reply(collection(controls.foreign ? [{ ...controls.foreign, repository }] : remote.prs));
} else if (request.operation === "pull-request.get") reply(remote.prs.find((pr) => pr.number === payload.number));
else if (request.operation === "pull-request.create") {
  const headOid = childProcess.execFileSync("git", ["rev-parse", payload.head], { cwd: request.context.cwd, encoding: "utf8" }).trim();
  const number = 717;
  const pr = { repository, number, url: url + "/pull/" + number, state: "open", title: payload.title, body: payload.body,
    base: { repository, name: payload.base, deleted: false }, head: { repository, name: payload.head, deleted: false },
    headOid, mergeOid: null, fetchLocator: { repository, ref: "refs/pull/" + number + "/head", headOid, state: "available", reason: null } };
  remote.prs.push(pr); fs.writeFileSync(storage, JSON.stringify(remote));
  if (controls.loseResponse) fail("GITHUB_WRITE_OUTCOME_UNKNOWN"); else reply(pr);
} else if (request.operation === "comment.search") {
  if (controls.loseResponse && remote.comments.length) fail("GITHUB_TRANSPORT"); else reply(collection(remote.comments));
} else if (request.operation === "comment.create") {
  const comment = { repository, number: payload.number, id: String(remote.comments.length + 1),
    url: url + "/issues/" + payload.number + "#issuecomment-" + (remote.comments.length + 1), body: payload.body,
    at: "2026-01-01T00:00:00Z", actor: { login: "fixture", type: "user" } };
  remote.comments.push(comment); fs.writeFileSync(storage, JSON.stringify(remote));
  if (controls.loseResponse) fail("GITHUB_WRITE_OUTCOME_UNKNOWN"); else reply(comment);
} else fail("GITHUB_INVALID_REQUEST");
`;
}
