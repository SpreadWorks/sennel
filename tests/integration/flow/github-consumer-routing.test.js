import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import GetIssueCommand from "../../../src/flow/lib/get-issue.js";
import SetInitCommand from "../../../src/flow/lib/set-init.js";
import { fetchNormalizedIssueBody } from "../../../src/flow/lib/issue-body-cache.js";
import { container } from "../../../src/lib/container.js";
import { prepareMergeEffect, resolveMergeStrategy } from "../../../src/flow/commands/merge.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { offlineExternalGitHubScript } from "../../support/fakes/github.js";

let root;
afterEach(() => { container.reset(); if (root) removeTmpDir(root); root = null; });

function externalFixture({ authenticationFailure = false } = {}) {
  root = createTmpDir("github-consumer-");
  const script = path.join(root, "github.mjs");
  const control = path.join(root, "github-control.json");
  fs.writeFileSync(control, JSON.stringify({ authenticationFailure }));
  fs.writeFileSync(script, offlineExternalGitHubScript({ controlPath: control }));
  const config = { lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" },
    commands: { gh: "enable" }, github: { provider: "offline",
      repository: { host: "github.com", name: "fixture/repository" },
      providers: { offline: { command: process.execPath, args: [script], maxAttempts: 1 } } } };
  fs.mkdirSync(path.join(root, ".sennel"));
  fs.writeFileSync(path.join(root, ".sennel", "config.json"), JSON.stringify(config));
  return { script, config };
}

function cli(args) {
  return spawnSync(process.execPath, [path.resolve("src/sennel.js"), "flow", ...args], {
    cwd: root, env: { ...process.env, SENNEL_WORK_ROOT: root }, encoding: "utf8",
  });
}

test("github check exposes selected provider readiness and removes the gh target", () => {
  externalFixture();
  const checked = cli(["get", "check", "github"]);
  assert.equal(checked.status, 0, checked.stderr);
  const result = JSON.parse(checked.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.data.pass, true);
  assert.deepEqual(result.data.github, { available: true, authenticated: true, accessible: true,
    repository: { host: "github.com", name: "fixture/repository" }, failureCode: null });
  assert.equal(result.data.checks[0].id, "github");
  const obsolete = cli(["get", "check", "gh"]);
  assert.notEqual(obsolete.status, 0);
  assert.equal(JSON.parse(obsolete.stdout).ok, false);
  assert.match(obsolete.stdout, /unknown target/);
});

test("PR provider authentication rejection preserves Git refs and canonical Flow before effects", () => {
  const { config, script } = externalFixture({ authenticationFailure: true });
  initGitRepo(root);
  commitAll(root, "test: provider refusal fixture");
  runGit(["switch", "-c", "feature/provider"], { cwd: root });
  const flowManager = makeFlowManager(root);
  const flow = new CanonicalFlowFixture({ flowManager, specId: "001-provider-refusal", runId: "run-provider-refusal",
    execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/provider" } }).create();
  const before = flowManager.canonicalState(flow.specId).toJSON();
  const refs = runGit(["show-ref"], { cwd: root }).stdout;
  container.set("config", config);
  assert.throws(() => prepareMergeEffect({ root, executionRoot: root, flowManager, flowState: flow.state() }),
    (error) => error.code === "GITHUB_AUTHENTICATION");
  assert.deepEqual(flowManager.canonicalState(flow.specId).toJSON(), before);
  assert.equal(runGit(["show-ref"], { cwd: root }).stdout, refs);
  const remote = JSON.parse(fs.readFileSync(`${script}.remote.json`, "utf8"));
  assert.deepEqual(remote.prs, []);
  assert.deepEqual(remote.calls.map((request) => request.operation), ["provider.preflight"]);
});

test("merge policy selects PR independently of provider availability and keeps direct and squash routes", () => {
  const state = { execution: { mode: "branch" }, baseBranch: "main", featureBranch: "feature" };
  assert.equal(resolveMergeStrategy(state, {}), "squash");
  assert.equal(resolveMergeStrategy(state, { commands: { gh: "disable" } }), "squash");
  assert.equal(resolveMergeStrategy(state, { commands: { gh: "enable" } }), "pr");
  assert.equal(resolveMergeStrategy({ ...state, execution: { mode: "direct" } }, { commands: { gh: "enable" } }), "skip");
  assert.equal(resolveMergeStrategy({ ...state, featureBranch: "main" }, { commands: { gh: "enable" } }), "skip");
});


test("Issue callers use the invocation provider and persist its immutable snapshot across manager reload", () => {
  const { config } = externalFixture();
  container.set("config", { github: { provider: "missing", providers: { missing: { command: "/missing-github-provider", args: [] } } } });
  const issue = new GetIssueCommand().execute({ root, number: 314, config });
  assert.deepEqual(issue, { number: 314, title: "Offline Issue", body: "External immutable Issue snapshot", labels: [], state: "open" });
  assert.equal(fetchNormalizedIssueBody(314, root, { config }), "External immutable Issue snapshot");
  const manager = makeFlowManager(root);
  const created = new SetInitCommand().execute({ root, flowManager: manager, issue: 314, config });
  const reloaded = makeFlowManager(root).loadPreparingFlow(created.runId);
  assert.equal(reloaded.issue, 314);
  assert.equal(reloaded.issueBody, "External immutable Issue snapshot");
});


test("direct prepare fetches the named provider snapshot and reloads its cataloged Issue artifact", () => {
  externalFixture();
  initGitRepo(root);
  commitAll(root, "test: named direct preparation");
  const prepared = cli(["prepare", "--title", "named-issue", "--no-branch", "--issue", "315", "--request", "Use the Issue snapshot"]);
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const data = JSON.parse(prepared.stdout).data;
  const reloaded = makeFlowManager(root);
  const snapshot = reloaded.readArtifact({ specId: data.specId, logicalKey: "issue.snapshot", consumerNodeId: "draft" });
  assert.equal(snapshot.bytes.toString("utf8"), "External immutable Issue snapshot\n");
  assert.equal(reloaded.loadReadOnly(data.specId).issue, 315);
});
