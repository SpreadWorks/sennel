import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { FinalizationWorktreeScenario } from "../support/infrastructure/finalization-worktree-scenario.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "src/sennel.js");

function runSennel(root, args) {
  const result = spawnSync("node", [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(root, ".fixture-bin")}:${process.env.PATH}`,
      SENNEL_WORK_ROOT: root,
    },
  });
  assert.equal(result.error, undefined, result.error?.stack || result.error?.message);
  return {
    ...result,
    envelope: result.stdout.trim().startsWith("{") ? JSON.parse(result.stdout.trim()) : null,
  };
}

function expectSuccess(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.envelope?.ok, true, result.stderr || result.stdout);
  return result.envelope.data;
}

function prepareWorktree(root, issue, title) {
  const initialized = expectSuccess(runSennel(root, [
    "flow", "set", "init", "--issue", String(issue), "--request", `recover ${title}`,
  ]));
  const prepared = expectSuccess(runSennel(root, [
    "flow", "prepare", "--title", title, "--base", "main", "--worktree",
    "--run-id", initialized.runId,
  ]));
  return {
    root,
    issue,
    runId: prepared.runId,
    specId: prepared.specId,
    worktreePath: prepared.worktreePath,
  };
}

function activeEntries(root) {
  return JSON.parse(fs.readFileSync(path.join(root, ".sennel", ".active-flow"), "utf8"));
}

describe("concurrent managed-worktree flow resume", () => {
  it("keeps an unfinished flow registered and resumable while another managed worktree flow completes", async (t) => {
    const flowB = await FinalizationWorktreeScenario.prepare(t);
    const root = flowB.mainRoot;
    const flowA = prepareWorktree(root, 453, "first-active-flow");

    assert.deepEqual(activeEntries(root), [
      { specId: flowB.specId, mode: "worktree" },
      { specId: flowA.specId, mode: "worktree" },
    ]);

    const bareResume = runSennel(root, ["flow", "resume"]);
    assert.notEqual(bareResume.status, 0, bareResume.stdout);
    assert.match(`${bareResume.stdout}\n${bareResume.stderr}`, /multiple active flows/i);
    assert.match(`${bareResume.stdout}\n${bareResume.stderr}`, /--spec <specId>/);

    const selectedBeforeCompletion = expectSuccess(runSennel(root, [
      "flow", "resume", "--spec", flowA.specId,
    ]));
    assert.equal(selectedBeforeCompletion.runId, flowA.runId);
    assert.equal(selectedBeforeCompletion.specId, flowA.specId);
    assert.equal(selectedBeforeCompletion.worktreePath, flowA.worktreePath);

    const completed = await flowB.dispatch(16);
    assert.notEqual(completed.ok, false, JSON.stringify(completed));

    assert.deepEqual(activeEntries(root), [
      { specId: flowA.specId, mode: "worktree" },
    ]);
    assert.equal(fs.existsSync(flowB.worktreePath), false, "completed flow worktree must be cleaned up");

    const resumed = expectSuccess(runSennel(root, [
      "flow", "resume", "--spec", flowA.specId,
    ]));
    assert.equal(resumed.runId, flowA.runId);
    assert.equal(resumed.specId, flowA.specId);
    assert.equal(resumed.worktreePath, flowA.worktreePath);
    assert.equal(fs.existsSync(flowA.worktreePath), true, "unfinished flow worktree remains authoritative");
  });
});
