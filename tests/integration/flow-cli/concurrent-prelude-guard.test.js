import { offlineGitHubScript } from "../../support/fakes/github.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { CanonicalFlowFixture, makeFlowManager, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";

const CMD = path.join(process.cwd(), "src/sennel.js");

function runCli(tmp, args) {
  return spawnSync("node", [CMD, ...args], {
    encoding: "utf8",
    cwd: tmp,
    env: { ...process.env, PATH: `${path.join(tmp, ".fixture-bin")}:${process.env.PATH}`, SENNEL_WORK_ROOT: tmp },
  });
}

function setupProject(tmp) {
  setupFlowConfig(tmp, "ja");
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }, null, 2));
  const bin = path.join(tmp, ".fixture-bin");
  fs.mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, "gh");
  fs.writeFileSync(gh, offlineGitHubScript());
  fs.chmodSync(gh, 0o755);
  initGitRepo(tmp);
  commitAll(tmp, "initial");
}

describe("e2e — concurrent flow prelude isolation", () => {
  let tmp;

  beforeEach(() => {
    tmp = createTmpDir("e2e-concurrent-prelude-");
  });

  afterEach(() => {
    removeTmpDir(tmp);
  });

  it("prepares a second Issue flow from main while another worktree flow is active", () => {
    setupProject(tmp);

    const issue11Init = runCli(tmp, [
      "flow", "set", "init",
      "--issue", "11",
      "--request", "start issue 11",
    ]);
    assert.equal(issue11Init.status, 0, issue11Init.stderr);
    const issue11RunId = JSON.parse(issue11Init.stdout.trim()).data.runId;
    const issue11Prepare = runCli(tmp, [
      "flow", "prepare",
      "--title", "issue-11",
      "--base", "main",
      "--worktree",
      "--run-id", issue11RunId,
    ]);
    assert.equal(
      issue11Prepare.status,
      0,
      `stdout:\n${issue11Prepare.stdout}\nstderr:\n${issue11Prepare.stderr}`,
    );
    const issue11Data = JSON.parse(issue11Prepare.stdout.trim()).data;
    const issue11Worktree = issue11Data.artifacts.worktree;
    assert.ok(issue11Worktree, "first flow should use worktree mode");

    const initRes = runCli(tmp, [
      "flow", "set", "init",
      "--issue", "12",
      "--request", "start issue 12",
    ]);
    assert.equal(initRes.status, 0, initRes.stderr);
    const runId = JSON.parse(initRes.stdout.trim()).data.runId;
    assert.ok(runId);

    const preStatus = runCli(tmp, [
      "flow", "get", "status", runId,
      "--expect-run-id", runId,
      "--expect-issue", "12",
    ]);
    assert.equal(
      preStatus.status,
      0,
      `stdout:\n${preStatus.stdout}\nstderr:\n${preStatus.stderr}`,
    );
    const preStatusData = JSON.parse(preStatus.stdout.trim()).data;
    assert.equal(preStatusData.runId, runId);
    assert.equal(preStatusData.issue, 12);
    assert.equal(preStatusData.specId, null);

    const prepareRes = runCli(tmp, [
      "flow", "prepare",
      "--title", "issue-12",
      "--no-branch",
      "--run-id", runId,
    ]);

    assert.equal(prepareRes.status, 0, prepareRes.stderr);
    const envelope = JSON.parse(prepareRes.stdout.trim());
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.runId, runId);
    assert.equal(envelope.data.issue, 12);
    // Board acceptance #14 defines the canonical no-branch execution mode as
    // `direct`; `spec-only` was a retired pre-Version layout label.
    assert.equal(envelope.data.artifacts.mode, "direct");
    assert.equal(envelope.data.worktreePath, null);
    const specDir = envelope.data.artifacts.specDir;
    assert.equal(
      fs.existsSync(path.join(tmp, specDir, "flow.json")),
      true,
      "second flow must be prepared in the main repo canonical Version",
    );
    assert.equal(
      fs.existsSync(path.join(issue11Worktree, specDir, "flow.json")),
      false,
      "second flow must not be created inside the first flow worktree",
    );

    const postStatus = runCli(tmp, [
      "flow", "get", "status", runId,
      "--expect-run-id", runId,
      "--expect-issue", "12",
      "--expect-spec", envelope.data.specId,
    ]);
    assert.equal(postStatus.status, 0, postStatus.stderr);
    const postStatusData = JSON.parse(postStatus.stdout.trim()).data;
    assert.equal(postStatusData.runId, runId);
    assert.equal(postStatusData.issue, 12);
    assert.equal(postStatusData.specId, envelope.data.specId);

    const targetArgs = [
      "--expect-run-id", runId,
      "--expect-issue", "12",
      "--expect-spec", envelope.data.specId,
    ];
    const nextAction = runCli(tmp, [
      "flow", "get", "next-action",
      ...targetArgs,
    ]);
    assert.equal(
      nextAction.status,
      0,
      `stdout:\n${nextAction.stdout}\nstderr:\n${nextAction.stderr}`,
    );
    const nextActionEnvelope = JSON.parse(nextAction.stdout.trim());
    assert.equal(nextActionEnvelope.ok, true);
    assert.equal(nextActionEnvelope.data.step, "draft");

    const noteRes = runCli(tmp, [
      "flow", "set", "note", "target-bound dispatcher note",
      ...targetArgs,
    ]);
    assert.equal(noteRes.status, 0, noteRes.stderr);
    const noteEnvelope = JSON.parse(noteRes.stdout.trim());
    assert.equal(noteEnvelope.ok, true);
    const issue12Flow = makeFlowManager(tmp).loadReadOnly(envelope.data.specId);
    assert.equal(
      issue12Flow.notes.some((note) => note.text === "target-bound dispatcher note"),
      true,
      "target-bound set command must mutate the second flow",
    );
    // Canonical Version state remains in the main repository; the managed
    // worktree is only its execution binding.
    const issue11Flow = makeFlowManager(tmp).loadReadOnly(issue11Data.specId);
    assert.equal(
      (issue11Flow.notes || []).some((note) => note.text === "target-bound dispatcher note"),
      false,
      "target-bound set command must not mutate the unrelated worktree flow",
    );

    const mismatch = runCli(tmp, [
      "flow", "get", "next-action",
      "--expect-run-id", issue11RunId,
      "--expect-issue", "12",
    ]);
    assert.notEqual(mismatch.status, 0, mismatch.stdout);
    const mismatchEnvelope = JSON.parse(mismatch.stdout.trim());
    assert.equal(mismatchEnvelope.ok, false);
    assert.equal(mismatchEnvelope.errors[0].code, "FLOW_TARGET_NOT_FOUND");
    assert.equal(mismatchEnvelope.data.matchCount, 0);

    const activeFlows = JSON.parse(fs.readFileSync(path.join(tmp, ".sennel", ".active-flow"), "utf8"));
    assert.equal(
      activeFlows.some((entry) => entry.mode === "worktree" && entry.specId === issue11Data.specId),
      true,
      "first worktree flow must remain active",
    );
    assert.equal(
      activeFlows.some((entry) => entry.mode === "direct" && entry.specId === envelope.data.specId),
      true,
      "second direct flow must be registered active",
    );
  });

  it("rejects bare prepare while another flow is active", () => {
    setupProject(tmp);
    new CanonicalFlowFixture({
      flowManager: makeFlowManager(tmp),
      specId: "011-active",
      runId: "issue-11-run",
      issue: 11,
      issueSnapshot: "# Issue #11\n\nActive fixture issue.\n",
      execution: { mode: "branch", baseBranch: "main", featureBranch: "main" },
    }).create().registerActive();

    const prepareRes = runCli(tmp, [
      "flow", "prepare",
      "--title", "issue-12",
      "--no-branch",
    ]);

    assert.notEqual(prepareRes.status, 0, prepareRes.stdout);
    const envelope = JSON.parse(prepareRes.stdout.trim());
    assert.equal(envelope.ok, false);
    assert.equal(envelope.errors[0].code, "TARGET_REQUIRED");
  });
});
