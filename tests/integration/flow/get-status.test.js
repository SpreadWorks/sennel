/**
 * tests/integration/flow/get-status.test.js
 *
 * Tests for `flow get status` — returns flow state as JSON envelope.
 */

import { describe, it, afterEach } from "node:test";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync, spawnSync } from "child_process";
import { join } from "path";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import GetStatusCommand from "../../../src/flow/lib/get-status.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { WorktreeFlowBindingStore, WorktreeFlowIdentity } from "../../../src/lib/worktree-flow-binding.js";
const FLOW_CMD = join(process.cwd(), "src/sennel.js");
const FLOW_CMD_ARGS_PREFIX = ["flow"];

describe("flow get status", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  function setupFlowState(dir, {
    specId = "001-test",
    runId = "run-001-test",
    issue = 1001,
    autoApprove = true,
    activeStep = null,
    execution = { mode: "branch", baseBranch: "main", featureBranch: "feature/001-test" },
  } = {}) {
    const manager = makeFlowManager(dir);
    const fixture = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId,
      issue,
      request: "request belongs in detailed status",
      execution,
      autoApprove,
      specRecord: {
        goal: "status fixture",
        requirements: [{ id: "R-T-1", desc: "Exercise status rendering.", task_ids: ["T-1"] }],
      },
    }).create().addTask({
      id: "T-1",
      title: "x",
      goal: "x",
      parent: null,
      origin: "plan",
      added_round: 0,
      status: "pending",
    }).registerActive();
    if (activeStep) fixture.activate(activeStep);
    manager.addNote("status note", { specId });
    manager.appendMetric({ phase: "draft", counter: "srcRead", delta: 1 }, { specId });
    return fixture.state();
  }

  function canonicalSnapshot(dir, specId) {
    const manager = makeFlowManager(dir);
    return {
      state: manager.canonicalState(specId).toJSON(),
      activities: manager.activityLedger(specId),
      catalog: manager.artifactCatalog(specId).toJSON(),
    };
  }

  function cliBinding(dir, runId) {
    const result = spawnSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "get", "next-action", "--expect-run-id", runId], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: dir, SENNEL_SOURCE_ROOT: dir },
    });
    assert.equal(result.status, 0, result.stdout || result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(typeof envelope.data.binding, "string", JSON.stringify(envelope));
    return envelope.data.binding;
  }

  for (const mode of ["branch", "worktree"]) {
    it(`reads context-based status from a CLI-issued opaque binding in ${mode} mode after reload without canonical mutation`, () => {
      tmp = createTmpDir();
      const execution = { mode, baseBranch: "main", featureBranch: "feature/001-test" };
      let worktreePath;
      if (mode === "worktree") {
        initGitRepo(tmp);
        commitAll(tmp, "Create isolated status worktree repository");
        worktreePath = join(tmp, ".sennel", "worktree", "feature-001-test");
        execFileSync("git", ["worktree", "add", worktreePath, "-b", execution.featureBranch], {
          cwd: tmp, encoding: "utf8",
        });
      }
      const state = setupFlowState(tmp, { autoApprove: false, activeStep: "draft", execution });
      if (worktreePath) {
        new WorktreeFlowBindingStore({ worktreePath }).save(new WorktreeFlowIdentity({
          runId: state.runId, issue: state.issue, specId: state.specId, worktreePath,
        }));
      }
      const binding = cliBinding(tmp, state.runId);
      const before = canonicalSnapshot(tmp, state.specId);

      for (const options of [[], ["--details"]]) {
        const result = spawnSync("node", [
          FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "get", "status", "--expect-binding", binding, ...options,
        ], { cwd: tmp, encoding: "utf8", env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp } });
        const envelope = JSON.parse(result.stdout);
        assert.equal(result.status, 0, JSON.stringify(envelope));
        assert.equal(envelope.ok, true);
        assert.equal(envelope.type, "get");
        assert.equal(envelope.key, "status");
        assert.equal(envelope.data.active, true);
        assert.equal(envelope.data.runId, state.runId);
        assert.equal(envelope.data.specId, state.specId);
        assert.equal(envelope.data.issue, state.issue);
        assert.equal(envelope.data.autoApprove, false);
        assert.equal(envelope.data.worktree, mode === "worktree");
        if (options.length) assert.equal(envelope.data.request, state.request);
        assert.deepEqual(canonicalSnapshot(tmp, state.specId), before);
      }
    });
  }

  it("refuses a CLI-issued opaque binding from another authority with the same Flow identifiers", () => {
    tmp = createTmpDir();
    const issuer = join(tmp, "issuer");
    const active = join(tmp, "active");
    fs.mkdirSync(issuer);
    fs.mkdirSync(active);
    const expected = setupFlowState(issuer, { activeStep: "draft" });
    setupFlowState(active, { activeStep: "draft" });
    const binding = cliBinding(issuer, expected.runId);
    const before = canonicalSnapshot(active, expected.specId);
    const manager = makeFlowManager(active);

    const envelope = new GetStatusCommand().execute({
      root: active,
      mainRoot: active,
      executionRoot: active,
      flowManager: manager,
      flowState: manager.loadReadOnly(expected.specId),
      expectBinding: binding,
    });

    assert.equal(envelope.ok, false);
    assert.equal(envelope.errors[0].code, "ACTIVE_FLOW_MISMATCH");
    assert.equal(envelope.data.expectedMainRoot, issuer);
    assert.equal(envelope.data.activeMainRoot, active);
    assert.equal(envelope.data.expectedExecutionRoot, issuer);
    assert.equal(envelope.data.activeExecutionRoot, active);
    assert.equal(Object.hasOwn(envelope.data, "expectedRunId"), false);
    assert.deepEqual(canonicalSnapshot(active, expected.specId), before);
  });

  it("returns JSON envelope with ok: true", () => {
    tmp = createTmpDir();
    setupFlowState(tmp);
    const result = execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "get", "status"], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    const envelope = JSON.parse(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.type, "get");
    assert.equal(envelope.key, "status");
    assert.equal(envelope.data.specId, "001-test");
    assert.ok(Array.isArray(envelope.data.steps));
  });

  it("reads Gate prompt stage inputs without counting their calls or time twice", () => {
    tmp = createTmpDir();
    setupFlowState(tmp);
    const manager = makeFlowManager(tmp);
    manager.appendMetric({ phase: "spec", kind: "agent", callCount: 3, durationMs: 14, responseChars: 30 }, { specId: "001-test" });
    manager.appendMetric({ phase: "spec", kind: "gate-prompt-collection", counter: "gatePromptInputChars:collection",
      delta: 240, callCount: 2, durationMs: 10 }, { specId: "001-test" });
    manager.appendMetric({ phase: "spec", kind: "gate-prompt-format-repair", counter: "gatePromptInputChars:format-repair",
      delta: 120, callCount: 1, durationMs: 4 }, { specId: "001-test" });
    const result = execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "get", "status", "--details"], {
      cwd: tmp,
      encoding: "utf8", env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    const status = JSON.parse(result).data;
    assert.equal(status.metricsSummary.total.spec.callCount, 3);
    assert.equal(status.metricsSummary.total.spec.durationMs, 14);
    assert.equal(status.metricsSummary.total.spec["gatePromptInputChars:collection"], 240);
    assert.equal(status.metricsSummary.total.spec["gatePromptInputChars:format-repair"], 120);
    assert.equal(status.metrics.filter((entry) => entry.kind?.startsWith("gate-prompt-")).length, 2);
  });

  it("returns ok: true with active: false when no active flow", () => {
    tmp = createTmpDir();
    const result = execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "get", "status"], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    const envelope = JSON.parse(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.type, "get");
    assert.equal(envelope.key, "status");
    assert.equal(envelope.data.active, false);
  });

  it("returns active: true when a flow exists", () => {
    tmp = createTmpDir();
    setupFlowState(tmp);
    const result = execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "get", "status"], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    const envelope = JSON.parse(result);
    assert.equal(envelope.data.active, true);
  });

  it("selects the expected runId when multiple active flows exist", () => {
    tmp = createTmpDir();
    setupFlowState(tmp);
    const secondSpec = "002-second";
    setupFlowState(tmp, {
      specId: secondSpec,
      runId: "run-002-second",
      issue: 1002,
      execution: { mode: "worktree", baseBranch: "main", featureBranch: `feature/${secondSpec}` },
    });
    fs.writeFileSync(makeFlowManager(tmp).specLocation("001-test").flowStateFile, "{truncated");

    const result = execFileSync("node", [
      FLOW_CMD,
      ...FLOW_CMD_ARGS_PREFIX,
      "get",
      "status",
      "--expect-run-id",
      "run-002-second",
    ], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    const envelope = JSON.parse(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.specId, secondSpec);
    assert.equal(envelope.data.runId, "run-002-second");
  });

  it("fails on a corrupt selected runId before creating a runtime log", () => {
    tmp = createTmpDir();
    const state = setupFlowState(tmp);
    fs.writeFileSync(makeFlowManager(tmp).specLocation(state.specId).flowStateFile, "{truncated");

    const result = spawnSync("node", [
      FLOW_CMD,
      ...FLOW_CMD_ARGS_PREFIX,
      "get",
      "status",
      state.runId,
      "--expect-run-id",
      state.runId,
      "--expect-issue",
      String(state.issue),
      "--expect-spec",
      state.specId,
    ], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });

    const envelope = JSON.parse(result.stdout);
    assert.notEqual(result.status, 0);
    assert.equal(envelope.errors[0].code, "FLOW_TARGET_RECOVERY_REQUIRED");
    assert.deepEqual(
      { runId: envelope.data.runId, issue: envelope.data.issue, specId: envelope.data.specId },
      { runId: state.runId, issue: state.issue, specId: state.specId },
    );
    assert.equal(fs.existsSync(join(tmp, ".tmp", "logs")), false);
  });

  it("omits audit details from default status", () => {
    tmp = createTmpDir();
    setupFlowState(tmp);
    const result = execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "get", "status"], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    const envelope = JSON.parse(result);
    assert.equal(envelope.data.active, true);
    for (const key of ["request", "notes", "metrics", "metricsSummary", "broadModeHistory", "broadModeHistoryTotal", "broadModeHistoryTruncated"]) {
      assert.equal(Object.hasOwn(envelope.data, key), false, `default status must omit ${key}`);
    }
    assert.equal(envelope.data.autoApprove, true);
  });

  it("returns audit details when --details is requested", () => {
    tmp = createTmpDir();
    setupFlowState(tmp);
    const result = execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "get", "status", "--details"], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    });
    const envelope = JSON.parse(result);
    assert.equal(envelope.data.request, "request belongs in detailed status");
    assert.equal(envelope.data.notes.length, 1);
    assert.equal(envelope.data.metrics.length, 1);
    assert.equal(envelope.data.metricsSummary.flow.draft.srcRead, 1);
  });

  it("returns target runId identifiers in mismatch data for runId status", () => {
    tmp = createTmpDir();
    setupFlowState(tmp);
    let result;
    assert.throws(
      () => {
        result = execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "get", "status", "run-001-test", "--expect-issue", "1002"], {
          cwd: tmp,
          encoding: "utf8",
          env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
        });
      },
      (err) => {
        const envelope = JSON.parse(err.stdout);
        assert.equal(envelope.ok, false);
        assert.equal(envelope.errors[0].code, "ACTIVE_FLOW_MISMATCH");
        assert.equal(envelope.data.expectedIssue, 1002);
        assert.equal(envelope.data.activeIssue, 1001);
        assert.equal(envelope.data.expectedRunId, "run-001-test");
        assert.equal(envelope.data.activeRunId, "run-001-test");
        return true;
      },
    );
    assert.equal(result, undefined);
  });
});
