import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { execFileSync, spawnSync } from "node:child_process";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import {
  writeStubAgentScript,
  stubAgentConfig,
} from "../../support/fakes/stub-agent.js";

function lowResponse() {
  return JSON.stringify({
    specBuildability: 1,
    ambiguity: 0,
    verifiability: 1,
    scopeBoundedness: 1,
    targetSpecificity: 0,
    precedent: 0,
    goal: "test goal",
    reason: "stub low",
  });
}

function passResponse() {
  return JSON.stringify({
    specBuildability: 2,
    ambiguity: 2,
    verifiability: 2,
    scopeBoundedness: 2,
    targetSpecificity: 1,
    precedent: 1,
    goal: "test goal",
    reason: "stub pass",
  });
}

function createTmpProject(agentResponse = lowResponse()) {
  const tmp = createTestDirectory("auto-desired-");
  fs.mkdirSync(path.join(tmp, ".sennel"), { recursive: true });
  execFileSync("git", ["init", tmp], { stdio: "ignore" });

  const stubPath = writeStubAgentScript(tmp, ".stub-agent.js", agentResponse);
  fs.writeFileSync(
    path.join(tmp, ".sennel", "config.json"),
    JSON.stringify({
      lang: "ja",
      type: "base",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
      agent: stubAgentConfig(stubPath),
    }),
  );
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "fixture" }));
  return tmp;
}

function createFlowState(tmp, { autoApprove = false } = {}) {
  const manager = makeFlowManager(tmp);
  new CanonicalFlowFixture({
    flowManager: manager,
    specId: "001-test",
    runId: "run-001-test",
    request: "add a progress bar",
    autoApprove,
    execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/001-test" },
    specRecord: {
      goal: "auto policy fixture",
      requirements: [{ id: "R-T-1", desc: "Exercise auto policy.", task_ids: ["T-1"] }],
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
}

function runSetAuto(tmp, value) {
  const script = path.resolve("src/sennel.js");
  const args = ["flow", "set", "auto", value];
  return spawnSync("node", [script, ...args], {
    encoding: "utf8",
    cwd: tmp,
    env: { ...process.env, SENNEL_WORK_ROOT: tmp },
  });
}

describe("spec 232: autoDesired persistence (R1)", () => {
  let tmp;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it("does not add retired autoDesired when active auto on is rejected", () => {
    tmp = createTmpProject(lowResponse());
    createFlowState(tmp);
    const res = runSetAuto(tmp, "on");
    assert.notEqual(res.status, 0, "should exit non-zero on reject");
    const state = makeFlowManager(tmp).load();
    assert.equal(Object.hasOwn(state, "autoDesired"), false);
    const raw = JSON.parse(fs.readFileSync(makeFlowManager(tmp).specLocation("001-test").flowStateFile, "utf8"));
    assert.equal(Object.hasOwn(raw, "autoDesired"), false);
  });

  it("sets active policy autoApprove=false without retired autoDesired", () => {
    tmp = createTmpProject(passResponse());
    createFlowState(tmp, { autoApprove: true });
    const res = runSetAuto(tmp, "off");
    assert.equal(res.status, 0, res.stderr);
    const state = makeFlowManager(tmp).load();
    assert.equal(state.autoApprove, false);
    assert.equal(Object.hasOwn(state, "autoDesired"), false);
  });

  it("persists autoDesired=true in preparing mode when rejected (AC8)", () => {
    tmp = createTmpProject(lowResponse());
    const fm = makeFlowManager(tmp);
    const runId = fm.generateRunId();
    fm.createPreparingFlow(runId, { request: "add a progress bar" });

    const script = path.resolve("src/sennel.js");
    const res = spawnSync("node", [script, "flow", "set", "auto", "on", "--run-id", runId], {
      encoding: "utf8",
      cwd: tmp,
      env: { ...process.env, SENNEL_WORK_ROOT: tmp },
    });
    assert.notEqual(res.status, 0, "should exit non-zero on reject");
    const preparing = fm.loadPreparingFlow(runId);
    assert.equal(preparing.autoDesired, true, "autoDesired must be true in preparing state");
  });
});
