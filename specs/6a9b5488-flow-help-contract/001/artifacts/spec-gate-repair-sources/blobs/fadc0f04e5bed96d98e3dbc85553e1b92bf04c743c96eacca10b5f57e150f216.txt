/**
 * Resolve the immutable Issue text that is created together with a linked
 * canonical Flow.  A linked Issue is not merely an identity scalar: its
 * snapshot is part of the creation transaction, so callers must resolve both
 * facts before they can create either a preparing or canonical Flow.
 */

import { fetchIssue } from "./fetch-issue.js";
import { normalizeIssueBody } from "./issue-body-cache.js";

function issueNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Issue snapshot number must be a positive integer");
  }
  return value;
}

export class IssueSnapshot {
  constructor({ number, body } = {}) {
    this.number = issueNumber(number);
    if (typeof body !== "string" || body.trim().length === 0) {
      throw new TypeError("Issue snapshot body must be non-empty text");
    }
    this.body = body;
    Object.freeze(this);
  }

  assertIdentity(number) {
    if (this.number !== issueNumber(number)) {
      throw new TypeError("Issue snapshot identity does not match the linked Issue");
    }
    return this;
  }
}

export class IssueSnapshotSource {
  load(_input) {
    return null;
  }
}

/** Production default: fetch and normalize the Issue through the gh boundary. */
export class GitHubIssueSnapshotSource extends IssueSnapshotSource {
  load({ number, root } = {}) {
    const resolvedNumber = issueNumber(number);
    const fetched = fetchIssue(resolvedNumber, root, { strict: false });
    if (fetched === null) return null;
    if (typeof fetched.body !== "string") {
      process.stderr.write(`warn: failed to fetch issue #${resolvedNumber}: Issue body is not text\n`);
      return null;
    }
    const body = normalizeIssueBody(fetched.body);
    if (body === null) {
      process.stderr.write(`warn: failed to fetch issue #${resolvedNumber}: Issue body is empty\n`);
      return null;
    }
    return new IssueSnapshot({
      number: resolvedNumber,
      body,
    });
  }
}
