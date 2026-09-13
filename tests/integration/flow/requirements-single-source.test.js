/**
 * tests/integration/flow/requirements-single-source.test.js
 *
 * spec 219: requirements の source of truth が spec.json.requirements に統一され、
 * flow.json 側を参照しないことを検証する。
 *
 * Covers the cataloged requirement definition, file-map progress, and context
 * consumers without a worker-controlled requirement completion status.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import GetResolveContextCommand from "../../../src/flow/lib/get-resolve-context.js";
import RunResumeCommand from "../../../src/flow/lib/run-resume.js";

const SENNEL = path.resolve("src/sennel.js");

function createProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "req-source-"));
  fs.mkdirSync(path.join(tmp, ".sennel"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "specs", "001-test"), { recursive: true });
  execFileSync("git", ["init", tmp], { stdio: "ignore" });
  execFileSync("git", ["-C", tmp, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
  fs.writeFileSync(
    path.join(tmp, ".sennel", "config.json"),
    JSON.stringify({
      lang: "ja",
      type: "base",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
    }),
  );
  return tmp;
}

function setupFlow(tmp, specId, specRecord) {
  const requirements = specRecord.requirements.map((requirement, index) => ({
    ...requirement,
    task_ids: requirement.task_ids ?? [`T${index + 1}`],
    testable: false,
  }));
  const fixture = new CanonicalFlowFixture({
    flowManager: makeFlowManager(tmp),
    specId,
    runId: `run-${specId}`,
    request: "Verify canonical requirements authority",
    execution: { mode: "direct" },
    specRecord: { ...specRecord, requirements },
  }).create();
  for (const taskId of new Set(requirements.flatMap((requirement) => requirement.task_ids))) {
    fixture.addTask({ id: taskId, title: `Fixture Task ${taskId}`, goal: `Own ${taskId}.`, origin: "plan", added_round: 0, status: "pending" });
  }
  return fixture.registerActive();
}

function run(tmp, argv) {
  return spawnSync("node", [SENNEL, ...argv], {
    encoding: "utf8",
    cwd: tmp,
    env: { ...process.env, SENNEL_WORK_ROOT: tmp },
  });
}

function parseEnvelope(res) {
  return JSON.parse(res.stdout.trim());
}

function minimalSpec(requirements) {
  return {
    goal: "test",
    background: "",
    scope: { in: [], out: [] },
    constraints: [],
    design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    requirements,
    acceptance_criteria: [],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
  };
}

// ---------------------------------------------------------------------------
// R1: retro source — must not read state.requirements
// ---------------------------------------------------------------------------

describe("spec 219 R1: run-retro.js does not reference flow state requirements", () => {
  it("source does not access state.requirements", () => {
    const src = fs.readFileSync(path.resolve("src/flow/lib/run-retro.js"), "utf8");
    assert.doesNotMatch(
      src,
      /state\.requirements/,
      "run-retro.js must not read requirements from flow state; use spec.json.requirements",
    );
  });

  it("source does not throw 'no requirements found in flow.json'", () => {
    const src = fs.readFileSync(path.resolve("src/flow/lib/run-retro.js"), "utf8");
    assert.doesNotMatch(
      src,
      /no requirements found in flow\.json/,
      "legacy error string must be removed after spec.json becomes the single source",
    );
  });
});

// ---------------------------------------------------------------------------
// R4: flow get status — requirements come from spec.json, progress from file-map
// ---------------------------------------------------------------------------

describe("flow get status reports requirement-file mapping progress", () => {
  let tmp;
  afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

  it("does not expose retired persisted statuses or report progress without a canonical file-map", () => {
    tmp = createProject();
    const specId = "001-test";
    setupFlow(tmp, specId, minimalSpec([
      { id: "R1", desc: "first requirement", priority: "must", status: "done" },
      { id: "R2", desc: "second requirement", priority: "should", status: "pending" },
    ]));

    const res = run(tmp, ["flow", "get", "status"]);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const env = parseEnvelope(res);
    assert.equal(env.data.requirements.length, 2);
    assert.equal(Object.hasOwn(env.data.requirements[0], "status"), false);
    assert.equal(Object.hasOwn(env.data.requirements[1], "status"), false);
    assert.deepEqual(env.data.requirementsProgress, { mapped: 0, total: 2 });
    assert.equal(env.data.requirementsProgress.total, 2);
  });

  it("returns requirement definitions without manufacturing a status", () => {
    tmp = createProject();
    const specId = "001-test";
    setupFlow(tmp, specId, minimalSpec([
      { id: "R1", desc: "no status", priority: "must" },
      { id: "R2", desc: "also no status", priority: "must" },
    ]));

    const res = run(tmp, ["flow", "get", "status"]);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const env = parseEnvelope(res);
    assert.deepEqual(env.data.requirementsProgress, { mapped: 0, total: 2 });
    assert.equal(Object.hasOwn(env.data.requirements[0], "status"), false);
  });

  it("counts only requirement ids recorded in the canonical file-map", () => {
    tmp = createProject();
    const specId = "001-test";
    setupFlow(tmp, specId, minimalSpec([
      { id: "R1", desc: "mapped requirement", priority: "must" },
      { id: "R2", desc: "unmapped requirement", priority: "must" },
    ])).activate("implement");
    makeFlowManager(tmp).updateFileMap({ specId, requirementId: "R1", paths: ["src/result.js"] });

    const res = run(tmp, ["flow", "get", "status"]);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const env = parseEnvelope(res);
    assert.deepEqual(env.data.requirementsProgress, { mapped: 1, total: 2 });
  });
});

describe("flow-status skill reports mapping evidence without completion claims", () => {
  it("uses requirementsProgress.mapped and does not label requirements as done", () => {
    const skill = fs.readFileSync(path.resolve("src/skills/sennel.flow-status/SKILL.md"), "utf8");
    assert.match(skill, /requirementsProgress\.mapped/);
    assert.match(skill, /mapped to files/);
    assert.doesNotMatch(skill, /Requirements \([^\n]+ done\)/);
  });
});

// ---------------------------------------------------------------------------
// R6: resume and resolve-context read the cataloged requirement definitions
// ---------------------------------------------------------------------------

describe("resume and resolve-context do not reference flow state requirements", () => {
  let tmp;
  afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

  for (const file of [
    "src/flow/lib/run-resume.js",
    "src/flow/lib/get-resolve-context.js",
  ]) {
    it(`${file} does not read state.requirements`, () => {
      const src = fs.readFileSync(path.resolve(file), "utf8");
      assert.doesNotMatch(
        src,
        /state\.requirements/,
        `${file} must read requirements from spec.json, not flow state`,
      );
    });
  }

  it("reads implementation and resume context from the cataloged spec.record", () => {
    tmp = createProject();
    const manager = makeFlowManager(tmp);
    const fixture = setupFlow(tmp, "001-test", minimalSpec([
        { id: "R1", desc: "first cataloged requirement", priority: "must", status: "done" },
        { id: "R2", desc: "second cataloged requirement", priority: "must", status: "pending" },
      ]));
    const state = fixture.state();
    const ctx = { root: tmp, mainRoot: tmp, flowManager: manager, flowState: state };

    const resolved = new GetResolveContextCommand().execute(ctx);
    const resumed = new RunResumeCommand().execute(ctx);

    for (const context of [resolved, resumed]) {
      assert.equal(context.goal, "test");
      assert.deepEqual(context.scope, { in: [], out: [] });
      assert.deepEqual(context.requirements, [
        { id: "R1", desc: "first cataloged requirement", priority: "must", task_ids: ["T1"], testable: false },
        { id: "R2", desc: "second cataloged requirement", priority: "must", task_ids: ["T2"], testable: false },
      ]);
    }
  });
});
