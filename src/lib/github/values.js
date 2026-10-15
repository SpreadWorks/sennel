import { isGitObjectId } from "../git-snapshot.js";
import { GitHubFailure } from "./failure.js";

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("GitHub value must be an object");
  return value;
}
function text(value, name, empty = false) {
  if (typeof value !== "string" || (!empty && value.trim() === "")) throw new TypeError(`Invalid GitHub ${name}`);
  return value;
}
function number(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("GitHub number must be a positive integer");
  return value;
}
function oid(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!isGitObjectId(value)) throw new TypeError("Invalid GitHub object ID");
  return value;
}
function boolean(value) {
  if (typeof value !== "boolean") throw new TypeError("Invalid GitHub boolean");
  return value;
}
function choice(value, choices) {
  if (!choices.includes(value)) throw new TypeError("Invalid GitHub state");
  return value;
}
function optionalText(value, name) { return value === null ? null : text(value, name); }
const UNAVAILABLE_REASON_CODES = new Set([
  "HEAD_CHANGED", "HEAD_LINEAGE_CHANGED", "FILE_LIMIT_REACHED", "PATCH_OMITTED", "COMMITS_UNAVAILABLE", "PAGE_LIMIT",
]);
/** Unavailability is machine-readable evidence, never an external diagnostic. */
function unavailableReason(value) {
  if (value === null) return null;
  text(value, "unavailable reason");
  if (!value.split(",").every((code) => UNAVAILABLE_REASON_CODES.has(code) || GitHubFailure.supports(code))) {
    throw new TypeError("Invalid GitHub unavailable reason code");
  }
  return value;
}
function timestamp(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) throw new TypeError("Invalid GitHub timestamp");
  return value;
}
function url(value) {
  const parsed = new URL(text(value, "URL"));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError("GitHub URL must be a credential-free HTTPS URL");
  return parsed.href;
}
function json(value) {
  if (value instanceof GitHubValue) return value.toJSON();
  if (Array.isArray(value)) return value.map(json);
  return value;
}

/** Wire decoding is strict; callers retain dedicated domain types. */
export class GitHubValue {
  constructor() { if (new.target === GitHubValue) throw new TypeError("GitHub value requires a concrete type"); }
  toJSON() { return Object.fromEntries(Object.entries(this).map(([key, value]) => [key, json(value)])); }
  static fromJSON(value) {
    if (value instanceof this) return value;
    record(value);
    if (Object.keys(value).length !== this.fields.length || this.fields.some((key) => !Object.hasOwn(value, key))) throw new TypeError("Missing or unexpected GitHub value field");
    return new this(value);
  }
}

export class GitHubRepository extends GitHubValue {
  static fields = ["host", "name"];
  constructor({ host, name }) {
    super();
    if (typeof host !== "string" || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) throw new TypeError("Invalid GitHub repository host");
    if (typeof name !== "string" || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(name)) throw new TypeError("Invalid GitHub repository name");
    this.host = host.toLowerCase();
    this.name = name.toLowerCase();
    Object.freeze(this);
  }
  equals(other) { return other instanceof GitHubRepository && this.host === other.host && this.name === other.name; }
  get owner() { return this.name.split("/")[0]; }
  get repo() { return this.name.split("/")[1]; }
}

export class GitHubPreflight extends GitHubValue {
  static fields = ["available", "authenticated", "accessible", "repository", "failureCode"];
  constructor({ available, authenticated, accessible, repository = null, failureCode = null }) {
    super();
    this.available = boolean(available);
    this.authenticated = boolean(authenticated);
    this.accessible = boolean(accessible);
    this.repository = repository === null ? null : GitHubRepository.fromJSON(repository);
    this.failureCode = optionalText(failureCode, "failure code");
    if (failureCode !== null && !GitHubFailure.supports(failureCode)) throw new TypeError("Unknown GitHub preflight failure code");
    if ((!available && authenticated) || (!authenticated && accessible) || (accessible && this.repository === null)
      || (this.ready() ? failureCode !== null : failureCode === null)) throw new TypeError("Inconsistent GitHub preflight");
    Object.freeze(this);
  }
  ready() { return this.available && this.authenticated && this.accessible; }
  assertReady() { if (!this.ready()) throw new GitHubFailure(this.failureCode, "provider.preflight"); return this; }
}

export class GitHubBranch extends GitHubValue {
  static fields = ["repository", "name", "deleted"];
  constructor({ repository, name, deleted = false }) {
    super();
    this.repository = repository === null ? null : GitHubRepository.fromJSON(repository);
    this.name = text(name, "branch");
    this.deleted = boolean(deleted);
    if (repository === null && !deleted) throw new TypeError("Missing GitHub branch repository");
    Object.freeze(this);
  }
}

export class GitHubFetchLocator extends GitHubValue {
  static fields = ["repository", "ref", "headOid", "state", "reason"];
  constructor({ repository, ref = null, headOid, state = "available", reason = null }) {
    super();
    this.repository = GitHubRepository.fromJSON(repository);
    this.ref = optionalText(ref, "fetch ref");
    if (ref !== null && !/^refs\/pull\/[1-9]\d*\/head$/.test(ref)) throw new TypeError("Invalid read-only PR fetch ref");
    this.headOid = oid(headOid);
    this.state = choice(state, ["available", "deleted", "unavailable"]);
    this.reason = unavailableReason(reason);
    if (state === "available" ? ref === null || reason !== null : reason === null) throw new TypeError("Inconsistent GitHub fetch locator");
    Object.freeze(this);
  }
  get remoteUrl() { return `https://${this.repository.host}/${this.repository.name}.git`; }
}

export class GitHubPullRequest extends GitHubValue {
  static fields = ["repository", "number", "url", "state", "title", "body", "base", "head", "headOid", "mergeOid", "fetchLocator"];
  constructor(value) {
    super();
    this.repository = GitHubRepository.fromJSON(value.repository);
    this.number = number(value.number);
    this.url = url(value.url);
    this.state = choice(value.state, ["open", "closed", "merged"]);
    this.title = text(value.title, "PR title", true);
    this.body = text(value.body, "PR body", true);
    this.base = GitHubBranch.fromJSON(value.base);
    this.head = GitHubBranch.fromJSON(value.head);
    this.headOid = oid(value.headOid);
    this.mergeOid = oid(value.mergeOid, true);
    this.fetchLocator = GitHubFetchLocator.fromJSON(value.fetchLocator);
    if ((this.state === "merged") !== (this.mergeOid !== null) || !this.repository.equals(this.base.repository)
      || !this.repository.equals(this.fetchLocator.repository) || this.headOid !== this.fetchLocator.headOid) throw new TypeError("Inconsistent GitHub PR identity");
    const expectedUrl = `https://${this.repository.host}/${this.repository.name}/pull/${this.number}`;
    if (this.url.toLowerCase() !== expectedUrl) throw new TypeError("GitHub PR URL does not match its identity");
    if (this.fetchLocator.ref !== null && this.fetchLocator.ref !== `refs/pull/${this.number}/head`) throw new TypeError("GitHub PR fetch ref does not match its number");
    Object.freeze(this);
  }
  samePublication(other) { return other instanceof GitHubPullRequest && this.repository.equals(other.repository)
    && this.number === other.number && this.headOid === other.headOid && this.url === other.url && this.body === other.body; }
}

export class GitHubIssue extends GitHubValue {
  static fields = ["repository", "number", "title", "body", "labels", "state"];
  constructor(value) {
    super();
    this.repository = GitHubRepository.fromJSON(value.repository);
    this.number = number(value.number);
    this.title = text(value.title, "Issue title", true);
    this.body = text(value.body, "Issue body", true);
    if (!Array.isArray(value.labels)) throw new TypeError("Invalid GitHub labels");
    this.labels = Object.freeze(value.labels.map((label) => text(label, "label")));
    this.state = choice(value.state, ["open", "closed"]);
    Object.freeze(this);
  }
}

export class GitHubActor extends GitHubValue {
  static fields = ["login", "type"];
  constructor({ login = null, type = "unknown" }) {
    super();
    this.login = optionalText(login, "actor login");
    this.type = choice(type, ["user", "bot", "organization", "unknown"]);
    Object.freeze(this);
  }
}

export class GitHubComment extends GitHubValue {
  static fields = ["repository", "number", "id", "url", "body", "at", "actor"];
  constructor({ repository, number: issueNumber, id, url: commentUrl, body, at = null, actor = null }) {
    super();
    this.repository = GitHubRepository.fromJSON(repository);
    this.number = number(issueNumber);
    if (!((typeof id === "string" && /^[1-9]\d*$/.test(id)) || (Number.isSafeInteger(id) && id > 0))) throw new TypeError("Invalid GitHub comment ID");
    this.id = String(id);
    // Comment fragments carry their identity and are allowed, unlike credential/query URLs.
    const parsed = new URL(text(commentUrl, "comment URL"));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search
      || parsed.host.toLowerCase() !== this.repository.host
      || ![`/${this.repository.name}/issues/${this.number}`, `/${this.repository.name}/pull/${this.number}`].includes(parsed.pathname.toLowerCase())
      || parsed.hash !== `#issuecomment-${this.id}`) throw new TypeError("Invalid GitHub comment URL");
    this.url = parsed.href;
    this.body = text(body, "comment body", true);
    this.at = timestamp(at);
    this.actor = actor === null ? null : GitHubActor.fromJSON(actor);
    Object.freeze(this);
  }
  samePublication(other) { return other instanceof GitHubComment && this.repository.equals(other.repository)
    && this.number === other.number && this.id === other.id && this.url === other.url && this.body === other.body; }
}

export class GitHubCollection extends GitHubValue {
  static fields = ["repository", "entries", "complete", "cursor", "reason", "headOid"];
  constructor({ repository, entries, complete = true, cursor = null, reason = null, headOid = null }) {
    super();
    this.repository = GitHubRepository.fromJSON(repository);
    if (!Array.isArray(entries) || entries.some((entry) => !(entry instanceof GitHubValue))) throw new TypeError("GitHub collection requires typed entries");
    this.entries = Object.freeze([...entries]);
    this.complete = boolean(complete);
    this.cursor = optionalText(cursor, "cursor");
    this.reason = unavailableReason(reason);
    this.headOid = oid(headOid, true);
    if (complete ? cursor !== null || reason !== null : cursor === null && reason === null) throw new TypeError("Inconsistent GitHub collection completeness");
    Object.freeze(this);
  }
  static decode(value, Entry) {
    record(value);
    if (Object.keys(value).length !== this.fields.length || this.fields.some((key) => !Object.hasOwn(value, key))
      || !Array.isArray(value.entries)) throw new TypeError("Invalid GitHub collection");
    return new this({ ...value, entries: value.entries.map((entry) => Entry.fromJSON(entry)) });
  }
  assertIdentity({ repository, headOid = this.headOid, number: resourceNumber, Entry }) {
    if (!this.repository.equals(repository) || this.headOid !== headOid
      || this.entries.some((entry) => !(entry instanceof Entry)
        || (entry.repository !== undefined && !repository.equals(entry.repository))
        || (resourceNumber !== undefined && entry.number !== undefined && resourceNumber !== entry.number))) {
      throw new TypeError("GitHub collection binding differs");
    }
    return this;
  }
}

export class GitHubCommentDelivery extends GitHubValue {
  static fields = ["comment", "idempotencyKey", "resumed"];
  constructor({ comment, idempotencyKey, resumed }) {
    super();
    this.comment = GitHubComment.fromJSON(comment);
    this.idempotencyKey = text(idempotencyKey, "idempotency key");
    this.resumed = boolean(resumed);
    Object.freeze(this);
  }
}

export class GitHubTimelineEvent extends GitHubValue {
  static fields = ["id", "event", "at", "actor", "commitOid", "reviewId", "commentId"];
  constructor({ id, event, at = null, actor = null, commitOid = null, reviewId = null, commentId = null }) {
    super();
    this.id = text(String(id ?? ""), "timeline identity");
    this.event = text(event, "timeline event");
    this.at = timestamp(at);
    this.actor = actor === null ? null : GitHubActor.fromJSON(actor);
    this.commitOid = oid(commitOid, true);
    this.reviewId = reviewId === null ? null : text(String(reviewId), "review ID");
    this.commentId = commentId === null ? null : text(String(commentId), "comment ID");
    Object.freeze(this);
  }
}

export class GitHubReview extends GitHubValue {
  static fields = ["id", "state", "body", "at", "actor", "commitOid"];
  constructor({ id, state, body, at = null, actor = null, commitOid = null }) {
    super();
    this.id = text(String(id ?? ""), "review ID");
    this.state = choice(state, ["approved", "changes_requested", "commented", "dismissed", "pending"]);
    this.body = text(body, "review body", true);
    this.at = timestamp(at);
    this.actor = actor === null ? null : GitHubActor.fromJSON(actor);
    this.commitOid = oid(commitOid, true);
    Object.freeze(this);
  }
}

export class GitHubReviewReply extends GitHubValue {
  static fields = ["id", "body", "at", "actor", "reviewId", "replyToId", "commitOid", "path", "line", "originalLine"];
  constructor({ id, body, at = null, actor = null, reviewId = null, replyToId = null, commitOid = null, path = null, line = null, originalLine = null }) {
    super();
    this.id = text(String(id ?? ""), "reply ID");
    this.body = text(body, "reply body", true);
    this.at = timestamp(at);
    this.actor = actor === null ? null : GitHubActor.fromJSON(actor);
    this.reviewId = reviewId === null ? null : text(String(reviewId), "review ID");
    this.replyToId = replyToId === null ? null : text(String(replyToId), "reply target ID");
    this.commitOid = oid(commitOid, true);
    this.path = optionalText(path, "path");
    this.line = line === null ? null : number(line);
    this.originalLine = originalLine === null ? null : number(originalLine);
    Object.freeze(this);
  }
}

export class GitHubReviewThread extends GitHubValue {
  static fields = ["id", "resolved", "outdated", "path", "line", "comments"];
  constructor({ id, resolved, outdated, path, line = null, comments }) {
    super();
    this.id = text(id, "thread ID");
    this.resolved = boolean(resolved);
    this.outdated = boolean(outdated);
    this.path = text(path, "thread path");
    this.line = line === null ? null : number(line);
    this.comments = comments instanceof GitHubCollection ? comments : GitHubCollection.decode(comments, GitHubReviewReply);
    this.comments.assertIdentity({ repository: this.comments.repository, Entry: GitHubReviewReply });
    Object.freeze(this);
  }
}

export class GitHubCommit extends GitHubValue {
  static fields = ["oid", "message", "at", "actor", "parents"];
  constructor({ oid: commitOid, message, at = null, actor = null, parents = [] }) {
    super();
    this.oid = oid(commitOid);
    this.message = text(message, "commit message", true);
    this.at = timestamp(at);
    this.actor = actor === null ? null : GitHubActor.fromJSON(actor);
    if (!Array.isArray(parents)) throw new TypeError("Invalid GitHub commit parents");
    this.parents = Object.freeze(parents.map((value) => oid(value)));
    Object.freeze(this);
  }
}

export class GitHubFileDiff extends GitHubValue {
  static fields = ["commitOid", "path", "previousPath", "status", "patch", "state", "reason"];
  constructor({ commitOid = null, path, previousPath = null, status, patch = null, state, reason = null }) {
    super();
    this.commitOid = oid(commitOid, true);
    this.path = text(path, "diff path");
    this.previousPath = optionalText(previousPath, "previous path");
    this.status = text(status, "diff status");
    this.patch = patch === null ? null : text(patch, "diff patch", true);
    this.state = choice(state, ["available", "unavailable", "omitted"]);
    this.reason = unavailableReason(reason);
    if (state === "available" ? patch === null || reason !== null : patch !== null || reason === null) throw new TypeError("Inconsistent GitHub diff availability");
    Object.freeze(this);
  }
}

/** Per-commit availability remains explicit even when no file paths can be read. */
export class GitHubCommitDiff extends GitHubValue {
  static fields = ["commitOid", "files"];
  constructor({ commitOid, files }) {
    super();
    this.commitOid = oid(commitOid);
    this.files = files instanceof GitHubCollection ? files : GitHubCollection.decode(files, GitHubFileDiff);
    if (this.files.entries.some((file) => !(file instanceof GitHubFileDiff) || file.commitOid !== this.commitOid)) throw new TypeError("Commit diff files belong to another commit");
    Object.freeze(this);
  }
  get complete() { return this.files.complete && this.files.entries.every((file) => file.state === "available"); }
}

const SOURCE_TYPES = Object.freeze({ timeline: GitHubTimelineEvent, reviews: GitHubReview, comments: GitHubComment,
  threads: GitHubReviewThread, commits: GitHubCommit, diffs: GitHubFileDiff, commitDiffs: GitHubCommitDiff });
export class GitHubPullRequestSources extends GitHubValue {
  static fields = ["repository", "number", "headOid", "observedHeadOid", "consistent", ...Object.keys(SOURCE_TYPES)];
  constructor(value) {
    super();
    this.repository = GitHubRepository.fromJSON(value.repository);
    this.number = number(value.number);
    this.headOid = oid(value.headOid);
    this.observedHeadOid = oid(value.observedHeadOid);
    this.consistent = boolean(value.consistent);
    if (this.consistent !== (this.headOid === this.observedHeadOid)) throw new TypeError("Inconsistent GitHub source observation");
    for (const [field, Entry] of Object.entries(SOURCE_TYPES)) {
      const collection = value[field] instanceof GitHubCollection ? value[field] : GitHubCollection.decode(value[field], Entry);
      collection.assertIdentity({ repository: this.repository, headOid: this.headOid, number: this.number, Entry });
      this[field] = collection;
    }
    for (const thread of this.threads.entries) thread.comments.assertIdentity({ repository: this.repository, headOid: this.headOid, Entry: GitHubReviewReply });
    for (const diff of this.commitDiffs.entries) diff.files.assertIdentity({ repository: this.repository, headOid: this.headOid, Entry: GitHubFileDiff });
    const commitIds = new Set(this.commits.entries.map((commit) => commit.oid));
    const diffIds = new Set(this.commitDiffs.entries.map((diff) => diff.commitOid));
    if (commitIds.size !== this.commits.entries.length || diffIds.size !== this.commitDiffs.entries.length
      || [...diffIds].some((id) => !commitIds.has(id))
      || (this.commitDiffs.complete && [...commitIds].some((id) => !diffIds.has(id)))) throw new TypeError("GitHub commit diff inventory differs from its source commits");
    if (this.commits.complete && this.commits.entries.length > 0 && this.commits.entries.at(-1).oid !== this.headOid) throw new TypeError("GitHub commit inventory does not reach its observed head");
    Object.freeze(this);
  }
  get complete() { return this.consistent && Object.keys(SOURCE_TYPES).every((field) => this[field].complete)
    && this.threads.entries.every((thread) => thread.comments.complete)
    && this.diffs.entries.every((file) => file.state === "available")
    && this.commitDiffs.entries.every((diff) => diff.complete); }
}
