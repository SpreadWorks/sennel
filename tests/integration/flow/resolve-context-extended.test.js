/**
 * tests/integration/flow/resolve-context-extended.test.js
 *
 * Tests for extended resolve-context returning git/gh state.
 */

import { describe, it, afterEach } from "node:test";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { join } from "path";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
const FLOW_CMD = join(process.cwd(), "src/sennel.js");

describe("flow get resolve-context (extended fields)", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  function setupFlowState(dir) {
    const fixture = new CanonicalFlowFixture({
      flowManager: makeFlowManager(dir),
      specId: "001-test",
      runId: "run-001-test",
      request: "Resolve the canonical flow context",
      execution: { mode: "direct", baseBranch: "main", featureBranch: "feature/001-test" },
      issue: 429,
      specRecord: specRecord(),
    }).create().registerActive();
    return fixture.state();
  }

  function runResolveContext(dir, args = []) {
    return execFileSync(
      "node", [FLOW_CMD, "flow", "get", "resolve-context", ...args],
      { encoding: "utf8", env: { ...process.env, SENNEL_WORK_ROOT: dir } },
    );
  }

  function specRecord(overrides = {}) {
    return {
      goal: "JSON goal",
      background: "",
      scope: { in: ["JSON scope"], out: [] },
      constraints: [],
      design_principles: [],
      overview: { modules: [], data_flow: [], decisions: [] },
      requirements: [{ id: "R1", desc: "Do it." }],
      acceptance_criteria: ["Done."],
      clarifications: [],
      alternatives_considered: [],
      open_questions: [],
      ...overrides,
    };
  }

  it("returns dirty, currentBranch, aheadCount, github fields", () => {
    tmp = createTmpDir();
    setupFlowState(tmp);
    const result = runResolveContext(tmp);
    const envelope = JSON.parse(result);
    assert.equal(envelope.ok, true);
    assert.ok("dirty" in envelope.data, "should have dirty field");
    assert.ok("currentBranch" in envelope.data, "should have currentBranch field");
    assert.ok("github" in envelope.data, "should have github field");
    assert.ok("aheadCount" in envelope.data, "should have aheadCount field");
    assert.ok("lastCommit" in envelope.data, "should have lastCommit field");
  });

  it("reads goal and scope from the cataloged spec.record", () => {
    tmp = createTmpDir();
    setupFlowState(tmp);

    const result = runResolveContext(tmp);
    const envelope = JSON.parse(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.goal, "JSON goal");
    assert.deepEqual(envelope.data.scope, { in: ["JSON scope"], out: [] });
  });

  it("accepts matching run ID, Issue, and spec target guards", () => {
    tmp = createTmpDir();
    const state = setupFlowState(tmp);

    const result = runResolveContext(tmp, [
      "--expect-run-id", state.runId,
      "--expect-issue", String(state.issue),
      "--expect-spec", state.specId,
    ]);
    const envelope = JSON.parse(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.activeFlow, "001-test");
    assert.equal(envelope.data.issue, state.issue);
    assert.equal(envelope.data.specId, state.specId);
  });

  it("returns ACTIVE_FLOW_MISMATCH for each mismatching target guard", () => {
    tmp = createTmpDir();
    setupFlowState(tmp);
    const mismatches = [
      ["--expect-run-id", "run-other"],
      ["--expect-issue", "430"],
      ["--expect-spec", "002-other"],
    ];

    for (const args of mismatches) {
      assert.throws(
        () => runResolveContext(tmp, args),
        (error) => {
          const envelope = JSON.parse(error.stdout);
          assert.equal(envelope.ok, false);
          assert.equal(envelope.errors[0].code, "ACTIVE_FLOW_MISMATCH");
          assert.doesNotMatch(`${error.stdout}${error.stderr}`, /unknown option/i);
          return true;
        },
      );
    }
  });
});
