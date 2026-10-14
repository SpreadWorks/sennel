import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { execFileSync, spawnSync } from "node:child_process";
import { CanonicalAutoCheckScenario, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
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

function createTmpProject(agentResponse) {
  const tmp = createTestDirectory("verdict-persist-");
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

function createFlowState(tmp) {
  return new CanonicalAutoCheckScenario({
    flowManager: makeFlowManager(tmp),
    specId: "001-test",
    runId: "run-001-test",
    request: "add a progress bar",
    execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/001-test" },
  }).create();
}

function runCmd(tmp, ...args) {
  const script = path.resolve("src/sennel.js");
  return spawnSync("node", [script, ...args], {
    encoding: "utf8",
    cwd: tmp,
    env: { ...process.env, SENNEL_WORK_ROOT: tmp },
  });
}

describe("spec 232: failed verdict non-persistence (R5)", () => {
  let tmp;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it("does not persist autoCheck when set auto on is rejected (AC6)", () => {
    tmp = createTmpProject(lowResponse());
    createFlowState(tmp);
    runCmd(tmp, "flow", "set", "auto", "on");
    const state = makeFlowManager(tmp).load();
    assert.equal(Object.hasOwn(state, "autoCheck"), false);
  });

  it("does not cache autoCheck when set auto on is accepted", () => {
    tmp = createTmpProject(passResponse());
    createFlowState(tmp);
    runCmd(tmp, "flow", "set", "auto", "on");
    const state = makeFlowManager(tmp).load();
    assert.equal(Object.hasOwn(state, "autoCheck"), false);
  });

  it("does not persist autoCheck when run auto-check returns ineligible (AC6)", () => {
    tmp = createTmpProject(lowResponse());
    createFlowState(tmp);
    runCmd(tmp, "flow", "run", "auto-check");
    const state = makeFlowManager(tmp).load();
    assert.equal(Object.hasOwn(state, "autoCheck"), false);
  });

  it("does not cache autoCheck when run auto-check returns eligible", () => {
    tmp = createTmpProject(passResponse());
    createFlowState(tmp);
    runCmd(tmp, "flow", "run", "auto-check");
    const state = makeFlowManager(tmp).load();
    assert.equal(Object.hasOwn(state, "autoCheck"), false);
  });
});
