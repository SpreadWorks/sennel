import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { ReviewExecutionLease } from "../../../src/flow/lib/review-execution-lease.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const roots = [];
afterEach(() => {
  while (roots.length > 0) removeTmpDir(roots.pop());
});

describe("ReviewExecutionLease", () => {
  it("admits one provider execution for one run/node/Attempt identity", () => {
    const root = createTmpDir("review-execution-lease-");
    roots.push(root);
    const identity = {
      mainRoot: root,
      runId: "review-lease-run",
      nodeId: "spec-review",
      attemptId: "spec-review-attempt-2",
    };
    const first = new ReviewExecutionLease(identity);
    const duplicate = new ReviewExecutionLease(identity);
    first.acquire();
    assert.throws(() => duplicate.acquire(), (error) => error?.code === "REVIEW_EXECUTION_BUSY");
    first.release();
    duplicate.acquire();
    duplicate.release();
  });

  it("refuses a legacy PID lease without reclaiming its authority", () => {
    const root = createTmpDir("review-execution-lease-stale-");
    roots.push(root);
    const identity = {
      mainRoot: root,
      runId: "review-lease-run",
      nodeId: "spec-review",
      attemptId: "spec-review-attempt-2",
    };
    const lease = new ReviewExecutionLease(identity);
    fs.mkdirSync(path.dirname(lease.lock.lockPath), { recursive: true });
    fs.writeFileSync(lease.lock.lockPath, `${JSON.stringify({
      version: 1,
      kind: "review-execution",
      runId: identity.runId,
      nodeId: identity.nodeId,
      attemptId: identity.attemptId,
      processIdentity: {
        pid: process.pid,
        bootIdentity: "previous-boot",
        startFingerprint: "1",
        ownerToken: "11111111-1111-4111-8111-111111111111",
      },
    })}\n`);
    const before = fs.readFileSync(lease.lock.lockPath);
    assert.throws(() => lease.acquire(), (error) => error.code === "REVIEW_EXECUTION_LOCK_UNKNOWN");
    assert.deepEqual(fs.readFileSync(lease.lock.lockPath), before);
    lease.release();
    assert.deepEqual(fs.readFileSync(lease.lock.lockPath), before);
  });
});
