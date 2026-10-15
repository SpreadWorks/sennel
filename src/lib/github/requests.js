import path from "node:path";
import { randomUUID } from "node:crypto";
import { isGitObjectId } from "../git-snapshot.js";
import { PRODUCT } from "../product.js";
import { GitHubRepository, GitHubValue } from "./values.js";

export const GITHUB_PROTOCOL_REVISION = 1;
function requireText(value, name, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim())) throw new TypeError(`Invalid GitHub request ${name}`);
  return value;
}
function requireNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("GitHub request number must be a positive integer");
  return value;
}
export class GitHubExecutionContext extends GitHubValue {
  static fields = ["cwd", "repository"];
  constructor({ cwd, repository = null }) {
    super();
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new TypeError("GitHub execution cwd must be absolute");
    this.cwd = path.resolve(cwd);
    this.repository = repository === null ? null : GitHubRepository.fromJSON(repository);
    Object.freeze(this);
  }
}
export class GitHubRequest {
  constructor(operation, context, { idempotencyKey = null, requestId = randomUUID() } = {}) {
    if (new.target === GitHubRequest) throw new TypeError("GitHub request requires a concrete operation");
    this.operation = operation;
    this.context = GitHubExecutionContext.fromJSON(context);
    if (operation !== "provider.preflight" && this.context.repository === null) throw new TypeError("GitHub operation requires repository identity");
    this.requestId = requireText(requestId, "request identity");
    this.idempotencyKey = idempotencyKey === null ? null : requireText(idempotencyKey, "idempotency identity");
    if (this.idempotencyKey !== null && /[\r\n<>]/.test(this.idempotencyKey)) throw new TypeError("Invalid GitHub idempotency marker");
  }
  toJSON() {
    return { revision: GITHUB_PROTOCOL_REVISION, requestId: this.requestId, operation: this.operation,
      context: this.context.toJSON(), payload: this.payload(),
      ...(this.idempotencyKey === null ? {} : { idempotencyKey: this.idempotencyKey }) };
  }
}
export class GitHubPreflightRequest extends GitHubRequest {
  constructor(context) { super("provider.preflight", context); Object.freeze(this); }
  payload() { return {}; }
}
export class GitHubIssueRequest extends GitHubRequest {
  constructor(context, { number }) { super("issue.get", context); this.number = requireNumber(number); Object.freeze(this); }
  payload() { return { number: this.number }; }
}
export class GitHubPullRequestRequest extends GitHubRequest {
  constructor(context, { number }, operation = "pull-request.get") {
    super(operation, context); this.number = requireNumber(number); Object.freeze(this);
  }
  payload() { return { number: this.number }; }
}
export class GitHubPullRequestSourcesRequest extends GitHubPullRequestRequest {
  constructor(context, input) { super(context, input, "pull-request.sources"); }
}
export class GitHubPullRequestSearchRequest extends GitHubRequest {
  constructor(context, { base, head, expectedHeadOid, idempotencyKey }, operation = "pull-request.search") {
    super(operation, context, { idempotencyKey });
    this.base = requireText(base, "base branch");
    this.head = requireText(head, "head branch");
    if (!isGitObjectId(expectedHeadOid)) throw new TypeError("GitHub request requires its expected head OID");
    this.expectedHeadOid = expectedHeadOid;
    if (this.idempotencyKey === null) throw new TypeError("GitHub PR operation requires idempotency identity");
    if (new.target === GitHubPullRequestSearchRequest) Object.freeze(this);
  }
  payload() { return { base: this.base, head: this.head, expectedHeadOid: this.expectedHeadOid }; }
}
export class GitHubPullRequestCreateRequest extends GitHubPullRequestSearchRequest {
  constructor(context, input) {
    super(context, input, "pull-request.create");
    this.title = requireText(input.title, "PR title");
    this.body = requireText(input.body, "PR body", true);
    if (this.idempotencyKey === null) throw new TypeError("GitHub PR creation requires idempotency identity");
    Object.freeze(this);
  }
  payload() { return { ...super.payload(), title: this.title, body: this.body }; }
}
export class GitHubCommentSearchRequest extends GitHubRequest {
  constructor(context, { number, target = "issue", idempotencyKey }, operation = "comment.search") {
    super(operation, context, { idempotencyKey });
    this.number = requireNumber(number);
    if (target !== "issue" && target !== "pull-request") throw new TypeError("Invalid GitHub comment target");
    this.target = target;
    if (this.idempotencyKey === null) throw new TypeError("GitHub comment operation requires idempotency identity");
    if (new.target === GitHubCommentSearchRequest) Object.freeze(this);
  }
  payload() { return { number: this.number, target: this.target }; }
}
export class GitHubCommentCreateRequest extends GitHubCommentSearchRequest {
  constructor(context, input) {
    super(context, input, "comment.create");
    this.body = requireText(input.body, "comment body");
    Object.freeze(this);
  }
  payload() { return { ...super.payload(), body: this.body }; }
}

/** The same exact marker is used for PR and comment operations by both adapters. */
export function gitHubIdempotencyMarker(key) {
  requireText(key, "idempotency identity");
  if (/[\r\n<>]/.test(key)) throw new TypeError("Invalid GitHub idempotency marker");
  return `<!-- ${PRODUCT.machineName}:${key} -->`;
}
