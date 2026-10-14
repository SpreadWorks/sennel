import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
/**
 * tests/integration/flow/set-approval.test.js
 *
 * spec 221 R5, R7: `sennel flow set approval` の挙動を検証する。
 * - --approved を渡すと spec.json.user_approval が更新される
 * - --confirmed-at 省略時は ISO 8601 が自動付与される
 * - --notes は任意
 * - active flow がない場合は非ゼロ終了
 * - --approved を省略した場合は usage error で非ゼロ終了
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { FlowAtStepFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { loadSpecJson } from "../../../src/lib/spec-json.js";

const SENNEL = path.resolve("src/sennel.js");

function createProject() {
  const tmp = createTestDirectory("set-approval-");
  fs.mkdirSync(path.join(tmp, ".sennel"), { recursive: true });
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

function setupSpec(tmp, specId, extras = {}) {
  const specJson = {
    goal: "test",
    background: "",
    scope: { in: [], out: [] },
    constraints: [],
    design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    requirements: [],
    acceptance_criteria: [],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
    ...extras,
  };
  const fixture = new FlowAtStepFixture({
    flowManager: makeFlowManager(tmp),
    specId,
    runId: `run-${specId}`,
    execution: { mode: "direct" },
    targetStep: "approval",
    specRecord: specJson,
  }).create();
  return fixture.location().directory;
}

function run(tmp, argv) {
  return spawnSync("node", [SENNEL, ...argv], {
    encoding: "utf8",
    cwd: tmp,
    env: { ...process.env, SENNEL_WORK_ROOT: tmp },
  });
}

describe("flow set approval (spec 221 R5, R7)", () => {
  let tmp;
  afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

  it("R5: --approved sets user_approval.approved=true and auto-fills confirmed_at", () => {
    tmp = createProject();
    const specDir = setupSpec(tmp, "001-test");
    const res = run(tmp, ["flow", "set", "approval", "--approved"]);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const updated = loadSpecJson(path.join(specDir, "spec.json"));
    assert.equal(updated.user_approval?.approved, true);
    assert.match(
      updated.user_approval?.confirmed_at ?? "",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      "confirmed_at must be ISO 8601",
    );
    assert.equal(
      fs.existsSync(path.join(specDir, ".runtime", "spec-render", "spec.md")),
      false,
      "approval must not regenerate a persistent Markdown view",
    );
  });

  it("R5: --notes value is persisted", () => {
    tmp = createProject();
    const specDir = setupSpec(tmp, "001-test");
    const res = run(tmp, ["flow", "set", "approval", "--approved", "--notes", "looks good"]);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const updated = loadSpecJson(path.join(specDir, "spec.json"));
    assert.equal(updated.user_approval?.notes, "looks good");
  });

  it("R5: --confirmed-at overrides the auto timestamp", () => {
    tmp = createProject();
    const specDir = setupSpec(tmp, "001-test");
    const ts = "2025-12-31T23:59:59.000Z";
    const res = run(tmp, ["flow", "set", "approval", "--approved", "--confirmed-at", ts]);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const updated = loadSpecJson(path.join(specDir, "spec.json"));
    assert.equal(updated.user_approval?.confirmed_at, ts);
  });

  it("R5: written spec.json passes schema validation", () => {
    tmp = createProject();
    const specDir = setupSpec(tmp, "001-test");
    const res = run(tmp, ["flow", "set", "approval", "--approved", "--notes", "ok"]);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    // loadSpecJson validates by default
    const updated = loadSpecJson(path.join(specDir, "spec.json"));
    assert.ok(updated.user_approval);
  });

  it("R5: invalid approval input leaves cataloged Spec and Flow bytes unchanged", () => {
    tmp = createProject();
    const specDir = setupSpec(tmp, "invalid-approval");
    const flowPath = path.join(specDir, "flow.json");
    const specPath = path.join(specDir, "spec.json");
    const before = { flow: fs.readFileSync(flowPath), spec: fs.readFileSync(specPath) };

    const result = run(tmp, ["flow", "set", "approval", "--approved", "--confirmed-at", "not-a-date"]);

    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readFileSync(flowPath), before.flow);
    assert.deepEqual(fs.readFileSync(specPath), before.spec);
  });

  it("R5: exits non-zero when no active flow exists", () => {
    tmp = createProject();
    const res = run(tmp, ["flow", "set", "approval", "--approved"]);
    assert.notEqual(res.status, 0, "expected non-zero exit when no active flow");
  });

  it("R7: exits non-zero when --approved is omitted", () => {
    tmp = createProject();
    setupSpec(tmp, "001-test");
    const res = run(tmp, ["flow", "set", "approval"]);
    assert.notEqual(res.status, 0, "expected non-zero exit when --approved is omitted");
    assert.match(res.stderr + res.stdout, /approved|usage/i);
  });
});
