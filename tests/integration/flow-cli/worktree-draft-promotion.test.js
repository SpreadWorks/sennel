import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  WorkerArtifactHandoffCoordinator,
  sealWorkerArtifactHandoff,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { completeDraftWorkerThroughStep } from "../../support/infrastructure/draft-worker-step.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = path.join(repoRoot, "src/sennel.js");
const fixtureRoot = path.join(repoRoot, ".tmp", "issue-497-draft-promotion");
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
    name: "draft-promotion-fixture",
    version: "0.0.0",
    type: "module",
  }, null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/*\n!.sennel/config.json\n");
  const bin = path.join(root, ".fixture-bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh
printf '%s\\n' '{"title":"Offline fixture Issue","body":"Offline fixture immutable Issue snapshot","labels":[],"state":"OPEN"}'
`, { mode: 0o755 });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["add", ".sennel/config.json", ".gitignore", "package.json"]);
  git(root, ["commit", "-m", "fixture"]);
  return root;
}

function runFlow(root, args) {
  const result = spawnSync("node", [cliPath, "flow", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(root, ".fixture-bin")}${path.delimiter}${process.env.PATH}`,
      SENNEL_WORK_ROOT: root,
    },
  });
  const stdout = result.stdout.trim();
  return { ...result, envelope: stdout.startsWith("{") ? JSON.parse(stdout) : null };
}

function expectSuccess(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.envelope?.ok, true, result.stderr || result.stdout);
  return result.envelope.data;
}

function prepareWorktree(root, issue, title) {
  const initialized = expectSuccess(runFlow(root, [
    "set", "init", "--request", `fix Issue #${issue}`, "--issue", String(issue),
  ]));
  const prepared = expectSuccess(runFlow(root, [
    "prepare", "--title", title, "--base", "main", "--worktree", "--run-id", initialized.runId,
  ]));
  return prepared;
}

function canonicalDraft(root, flow) {
  return new FlowManager({ root, mainRoot: root, inWorktree: false, specId: flow.specId })
    .specLocation(flow.specId).artifact("draft");
}

async function publishDraft(root, flow, value) {
  const flowManager = new FlowManager({
    root: flow.worktreePath,
    mainRoot: root,
    inWorktree: true,
    specId: flow.specId,
  });
  if (flowManager.load().currentNodeId === null) {
    flowManager.beginNextAction(flow.specId);
  }
  const state = flowManager.load();
  const invocationId = `draft-promotion-${flow.runId}`;
  const coordinator = new WorkerArtifactHandoffCoordinator();
  const ctx = {
    root: flow.worktreePath,
    executionRoot: flow.worktreePath,
    mainRoot: root,
    specId: flow.specId,
    flowManager,
  };
  const request = coordinator.createRequest({
    ctx,
    state,
    invocation: {
      id: invocationId,
      target: { digest: crypto.createHash("sha256").update(`target:${flow.runId}`).digest("hex") },
      action: {
        digest: crypto.createHash("sha256").update(invocationId).digest("hex"),
        nextAction: { step: "draft" },
      },
    },
  });
  fs.writeFileSync(request.payloadPath("draft.json"), `${JSON.stringify(value, null, 2)}\n`);
  sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId });
  return completeDraftWorkerThroughStep({ coordinator, ctx, request });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("worktree draft promotion", () => {
  it("publishes each active Flow's completed draft to only its canonical artifact", async () => {
    const root = createProject();
    const first = prepareWorktree(root, 497, "first canonical draft");
    const second = prepareWorktree(root, 498, "second canonical draft");
    const firstDraft = canonicalDraftDocument({ goal: "first completed draft" });
    const secondDraft = canonicalDraftDocument({ goal: "second completed draft" });
    assert.equal(fs.existsSync(canonicalDraft(root, first)), false);
    assert.equal(fs.existsSync(canonicalDraft(root, second)), false);

    const firstCompletion = await publishDraft(root, first, firstDraft);
    assert.equal(firstCompletion.completed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(canonicalDraft(root, first), "utf8")), firstDraft);
    assert.equal(fs.existsSync(canonicalDraft(root, second)), false);

    const secondCompletion = await publishDraft(root, second, secondDraft);
    assert.equal(secondCompletion.completed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(canonicalDraft(root, second), "utf8")), secondDraft);

    for (const flow of [first, second]) {
      const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: flow.specId });
      let state = manager.loadReadOnly(flow.specId);
      assert.equal(state.steps[0].children.find((step) => step.id === "draft").status, "done");
      assert.equal(state.steps[0].children.find((step) => step.id === "draft-questions-review").status, "pending");
      manager.beginNextAction(flow.specId);
      state = manager.loadReadOnly(flow.specId);
      assert.equal(state.steps[0].children.find((step) => step.id === "draft-questions-review").status, "in_progress");
      assert.equal(state.draftArtifactPromotion, undefined);
      const descriptor = manager.artifactCatalog(flow.specId).artifacts.find((entry) => entry.logicalKey === "draft");
      assert.match(descriptor.hash, /^[a-f0-9]{64}$/);
    }
  });
});
