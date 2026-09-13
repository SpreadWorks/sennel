import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { FlowManager } from "../../src/lib/flow-manager.js";
import { FlowOutboxStore, finalizationOutboxIdentity } from "../../src/flow/lib/flow-outbox.js";
import { flattenSteps } from "../../src/flow/lib/step-tree.js";
import { confirmCanonicalFixtureStep } from "../support/infrastructure/flow-setup.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "src/sennel.js");
const fixtureRoot = path.join(repoRoot, ".tmp", "flow-concurrent-resume");
const roots = [];

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createProject() {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureRoot, "project-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sennel", "config.json"), JSON.stringify({
    lang: "en",
    type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
  }, null, 2));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "flow-concurrent-resume-fixture",
    version: "0.0.0",
    type: "module",
  }, null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/*\n!.sennel/config.json\n");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["add", ".sennel/config.json", ".gitignore", "package.json"]);
  git(root, ["commit", "-m", "fixture"]);
  const bin = path.join(root, ".fixture-bin");
  fs.mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, "gh");
  fs.writeFileSync(gh, `#!/bin/sh
printf '%s\\n' '{"title":"Offline fixture Issue","body":"Offline fixture immutable Issue snapshot","labels":[],"state":"OPEN"}'
`);
  fs.chmodSync(gh, 0o755);
  return root;
}

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

function targetArgs(flow) {
  return [
    "--expect-run-id", flow.runId,
    "--expect-spec", flow.specId,
    "--expect-issue", String(flow.issue),
  ];
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

function completeManagedWorktreeFlow(root, flow) {
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: flow.specId });
  const mergeState = manager.load(flow.specId);
  const mergeIdentity = finalizationOutboxIdentity(mergeState, "finalize-merge");
  const mergeOutbox = new FlowOutboxStore(manager, { specId: flow.specId });
  mergeOutbox.begin(mergeIdentity);
  mergeOutbox.complete(mergeIdentity, {
    status: "done",
    strategy: "squash",
    mergedFromSha: git(root, ["rev-parse", mergeState.featureBranch]),
  });
  for (const step of flattenSteps(manager.load(flow.specId).steps)) {
    const state = manager.load(flow.specId);
    const currentStep = flattenSteps(state.steps).find((candidate) => candidate.id === step.id);
    if (["done", "skipped"].includes(currentStep.status)) continue;
    if (step.id === "finalize-cleanup") {
      if (currentStep.status === "pending") {
        manager.updateStepStatus({ stepId: step.id, requestedStatus: "in_progress" }, { specId: flow.specId });
      }
      break;
    }
    if (currentStep.status === "pending") {
      manager.updateStepStatus({ stepId: step.id, requestedStatus: "in_progress" }, { specId: flow.specId });
    }
    if (manager.load(flow.specId).currentNodeId === step.id) {
      confirmCanonicalFixtureStep(manager, flow.specId, step.id);
    }
  }

  const completed = runSennel(flow.worktreePath, [
    "flow", "run", "finalize-cleanup", ...targetArgs(flow),
  ]);
  expectSuccess(completed);
}

function activeEntries(root) {
  return JSON.parse(fs.readFileSync(path.join(root, ".sennel", ".active-flow"), "utf8"));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("concurrent managed-worktree flow resume", () => {
  it("keeps an unfinished flow registered and resumable while another managed worktree flow completes", () => {
    const root = createProject();
    const flowA = prepareWorktree(root, 453, "first-active-flow");
    const flowB = prepareWorktree(root, 454, "second-completing-flow");

    assert.deepEqual(activeEntries(root), [
      { specId: flowA.specId, mode: "worktree" },
      { specId: flowB.specId, mode: "worktree" },
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

    completeManagedWorktreeFlow(root, flowB);

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
