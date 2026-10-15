import { offlineGitHubScript } from "../support/fakes/github.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../support/infrastructure/git-repo.js";
import {
  writeStubAgentScript,
  writeCapturingStubAgentScript,
  stubAgentConfig,
} from "../support/fakes/stub-agent.js";
import { CanonicalFlowFixture, makeFlowManager } from "../support/infrastructure/flow-setup.js";

const CMD = path.join(process.cwd(), "src/sennel.js");

function passingScore() {
  return JSON.stringify({
    specBuildability: 2,
    ambiguity: 2,
    verifiability: 2,
    scopeBoundedness: 2,
    targetSpecificity: 1,
    precedent: 1,
    goal: "test goal",
    reason: "e2e stub pass",
  });
}

function setupProject(tmp, { capturePath } = {}) {
  const stubPath = capturePath
    ? writeCapturingStubAgentScript(tmp, ".stub-agent.js", capturePath, passingScore())
    : writeStubAgentScript(tmp, ".stub-agent.js", passingScore());
  writeJson(tmp, ".sennel/config.json", {
    lang: "ja",
    type: "base",
    docs: { languages: ["ja"], defaultLanguage: "ja" },
    agent: stubAgentConfig(stubPath),
  });
  writeJson(tmp, "package.json", { name: "fixture", version: "0.0.0" });
  const bin = path.join(tmp, ".fixture-bin");
  fs.mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, "gh");
  fs.writeFileSync(gh, offlineGitHubScript(), { mode: 0o755 });
  initGitRepo(tmp);
  commitAll(tmp, "initial");
}

function runCli(tmp, args) {
  return spawnSync("node", [CMD, ...args], {
    encoding: "utf8",
    cwd: tmp,
    env: {
      ...process.env,
      PATH: `${path.join(tmp, ".fixture-bin")}${path.delimiter}${process.env.PATH}`,
      SENNEL_WORK_ROOT: tmp,
    },
  });
}

describe("e2e — phase-aware auto-check flow (spec 220)", () => {
  let tmp;

  beforeEach(() => {
    tmp = createTmpDir("e2e-auto-check-phase-");
  });

  afterEach(() => {
    removeTmpDir(tmp);
  });

  // A8 — preparing phase 1: set init → run auto-check --run-id → set auto on --run-id
  it("preparing phase completes set init → run auto-check → set auto on with stub agent", () => {
    setupProject(tmp);

    const initRes = runCli(tmp, [
      "flow", "set", "init",
      "--issue", "237",
      "--request", "add a progress bar with bounded scope",
    ]);
    assert.equal(initRes.status, 0, initRes.stderr);
    const runId = JSON.parse(initRes.stdout.trim()).data.runId;
    assert.ok(runId);

    const checkRes = runCli(tmp, [
      "flow", "run", "auto-check",
      "--run-id", runId,
    ]);
    assert.equal(checkRes.status, 0, checkRes.stderr);
    const checkData = JSON.parse(checkRes.stdout.trim()).data;
    assert.equal(checkData.eligible, true);

    // set auto on trusts the persisted verdict
    const autoOn = runCli(tmp, [
      "flow", "set", "auto", "on",
      "--run-id", runId,
    ]);
    assert.equal(autoOn.status, 0, autoOn.stderr);
    const autoData = JSON.parse(autoOn.stdout.trim()).data;
    assert.equal(autoData.autoApprove, true);
  });

  // A8 companion — spec-approved phase: skip path short-circuits AI
  it("approval phase short-circuits auto-check (no agent call)", () => {
    const capturePath = path.join(tmp, ".stub-agent-called");
    setupProject(tmp, { capturePath });

    new CanonicalFlowFixture({
      flowManager: makeFlowManager(tmp),
      specId: "050-approved",
      runId: "run-050-approved",
      execution: {
        mode: "branch",
        baseBranch: "main",
        featureBranch: "feature/050-approved",
      },
      issue: 50,
      issueSnapshot: "Offline fixture immutable Issue snapshot",
      request: "implement feature X",
    }).create().settleBefore("approval").settle("approval").registerActive();

    const res = runCli(tmp, ["flow", "run", "auto-check"]);
    assert.equal(res.status, 0, res.stderr);
    const env = JSON.parse(res.stdout.trim());
    assert.equal(env.data.eligible, true);
    assert.equal(env.data.skipped, true);
    assert.equal(env.data.reason, "spec approved");
    assert.equal(fs.existsSync(capturePath), false, "AI must not be invoked");
  });
});
