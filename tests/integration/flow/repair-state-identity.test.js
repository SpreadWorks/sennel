import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  AcceptanceBudgetError,
  buildAcceptancePrompt,
  parseAcceptanceResponse,
} from "../../../src/flow/lib/run-acceptance-review.js";
import {
  buildRepairStateManifest,
  captureRepairBaseline,
  deleteRepairBaselineForFlow,
} from "../../../src/flow/lib/repair-state-identity.js";
import { ReviewExecutionLease } from "../../../src/flow/lib/review-execution-lease.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const SPEC_PATH = "specs/demo/001/spec.json";
let root = null;
let repairState = null;

afterEach(() => {
  if (root !== null) removeTmpDir(root);
  root = null;
  repairState = null;
});

function write(relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function initializeRepository({ config = {} } = {}) {
  root = createTmpDir("repair-state-identity-");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test User");
  write(".sennel/config.json", JSON.stringify(config));
  write(SPEC_PATH, JSON.stringify({ requirements: [] }));
  write("app/value.js", "export const value = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "baseline");
  const baseline = captureRepairBaseline({ root, baseRef: "main", runId: "run-test" });
  repairState = {
    runId: "run-test",
    baseBranch: "main",
    repairBaseline: baseline.toJSON(),
  };
  return baseline;
}

function fingerprint() {
  return buildRepairStateManifest({ root, specPath: SPEC_PATH, state: repairState });
}

describe("canonical repair state identity", () => {
  it("pins a baseline and produces a stable SHA-256 content identity", () => {
    const baseline = initializeRepository();
    const first = fingerprint();
    const second = fingerprint();

    assert.match(first.hash, /^[a-f0-9]{64}$/);
    assert.equal(second.hash, first.hash);
    assert.equal(git("rev-parse", baseline.ref), baseline.commitOid);
  });

  it("changes with execution input and returns to the original identity after revert", () => {
    initializeRepository();
    const before = fingerprint();
    write("app/value.js", "export const value = 2;\n");
    assert.notEqual(fingerprint().hash, before.hash);
    write("app/value.js", "export const value = 1;\n");
    assert.equal(fingerprint().hash, before.hash);
  });

  it("excludes a live Review execution lease while retaining ordinary source changes", () => {
    initializeRepository();
    const before = fingerprint();
    const lease = new ReviewExecutionLease({
      mainRoot: root,
      runId: "review-run",
      nodeId: "impl-review",
      attemptId: "review-attempt",
    });
    try {
      lease.acquire();
      assert.equal(fs.existsSync(lease.lock.lockPath), true, "the production lease is held");
      assert.equal(fingerprint().hash, before.hash, "a held runtime lease is not execution input");
    } finally {
      lease.release();
    }
    assert.equal(fingerprint().hash, before.hash, "releasing the runtime lease preserves the same identity");
    write("app/value.js", "export const value = 2;\n");
    assert.notEqual(fingerprint().hash, before.hash, "ordinary source changes remain execution input");
  });

  it("excludes transient Review work units while retaining ordinary source changes", () => {
    initializeRepository();
    const before = fingerprint();
    write(
      ".sennel/review-work-units/run/spec/attempt/inputs/task-context.json",
      '{"source":"parent-owned transient review input"}\n',
    );
    write(
      ".sennel/review-work-units/run/spec/attempt/impl-review.json",
      '{"blockingFindings":[]}\n',
    );
    const afterTransient = fingerprint();
    assert.equal(afterTransient.hash, before.hash, "Review work-unit creation is not source drift");
    assert.equal(
      afterTransient.entries.some((entry) => entry.path.startsWith(".sennel/review-work-units/")),
      false,
      "the manifest has no transient Review work-unit entry",
    );
    write("app/value.js", "export const value = 2;\n");
    assert.notEqual(fingerprint().hash, before.hash, "ordinary source changes remain execution input");
  });

  it("excludes Version-owned evidence from the implementation identity", () => {
    initializeRepository();
    const before = fingerprint();
    write("specs/demo/001/steps/impl/review/result.json", JSON.stringify({ verdict: "PASS" }));
    write("specs/demo/001/activities.jsonl", "{}\n");
    const after = fingerprint();

    assert.equal(after.hash, before.hash);
    assert.equal(after.entries.some((entry) => entry.path.includes("activities.jsonl")), false);
    assert.equal(after.entries.some((entry) => entry.path.includes("steps/impl/review/result.json")), false);
  });

  it("keeps commit metadata out of explicit input content identity", () => {
    initializeRepository();
    write("app/new.js", "export const added = true;\n");
    const beforeCommit = fingerprint();
    git("add", "app/new.js");
    git("commit", "-q", "-m", "commit unchanged content");
    const afterCommit = fingerprint();

    assert.notEqual(afterCommit.headOid, beforeCommit.headOid);
    assert.equal(afterCommit.hash, beforeCommit.hash);
  });

  it("fails closed at the configured complete changed-path boundary", () => {
    initializeRepository({
      config: { flow: { repairFingerprint: { maxChangedPaths: 6 } } },
    });
    write("app/a.js", "a\n");
    write("app/b.js", "b\n");
    assert.doesNotThrow(() => fingerprint());
    write("app/c.js", "c\n");
    assert.throws(() => fingerprint(), /changed path count 7 exceeds configured limit 6/);
  });

  it("rejects hidden index flags outside a declared sparse checkout", () => {
    initializeRepository();
    git("update-index", "--skip-worktree", "app/value.js");
    assert.throws(() => fingerprint(), /manual skip-worktree entry/);
  });

  it("deletes only the selected Flow baseline and remains idempotent", () => {
    const baseline = initializeRepository();
    const second = captureRepairBaseline({ root, baseRef: "main", runId: "another-run" });

    assert.equal(deleteRepairBaselineForFlow(root, { runId: "run-test" }), true);
    assert.equal(deleteRepairBaselineForFlow(root, { runId: "run-test" }), false);
    assert.equal(git("rev-parse", second.ref), second.commitOid);
  });
});

describe("bounded acceptance payloads", () => {
  it("keeps the complete request and response within explicit limits", () => {
    const prompt = buildAcceptancePrompt({
      evidence: {
        requirements: [{ id: "R1", desc: "demo" }],
        diff: "diff --git a/app/a.js b/app/a.js\n",
        repairEvidence: { kind: "no-repair", ref: "acceptance:no-repair", artifact: { reason: "none" } },
        testEvidence: {},
      },
    });

    assert.match(prompt.userPrompt, /Acceptance Evidence/);
    assert.throws(() => buildAcceptancePrompt({
      evidence: { payload: "x".repeat(900_000) },
    }), AcceptanceBudgetError);
    assert.throws(() => parseAcceptanceResponse("x".repeat(900_001)), AcceptanceBudgetError);
  });
});
