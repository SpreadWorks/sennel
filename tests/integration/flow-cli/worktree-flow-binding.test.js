import { offlineGitHubScript } from "../../support/fakes/github.js";
import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = path.join(repoRoot, "src/sennel.js");
const bindingRelativePath = path.join(".sennel", "flow-identity.json");
const roots = [];

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function createProject() {
  const root = createTestDirectory("sennel-worktree-flow-binding.test-");
  roots.push(root);
  fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sennel", "config.json"), JSON.stringify({
    lang: "en",
    type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
  }, null, 2));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "binding-contract-fixture",
    version: "0.0.0",
    type: "module",
  }, null, 2));
  const bin = path.join(root, ".fixture-bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), offlineGitHubScript(), { mode: 0o755 });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["add", ".sennel/config.json", "package.json"]);
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
  assert.equal(result.envelope?.ok, true, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  return result.envelope.data;
}

function prepareWorktree(root, issue) {
  const initArgs = ["set", "init", "--request", issue == null ? "fix issue-less flow" : `fix Issue #${issue}`];
  if (issue != null) initArgs.push("--issue", String(issue));
  const init = expectSuccess(runFlow(root, initArgs));
  return expectSuccess(runFlow(root, [
    "prepare", "--title", "binding-contract", "--base", "main", "--worktree", "--run-id", init.runId,
  ]));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("worktree flow identity binding contract", () => {
  it("persists all canonical identity fields for Issue and no-Issue flows", () => {
    for (const issue of [440, null]) {
      const root = createProject();
      const flow = prepareWorktree(root, issue);
      const bindingPath = path.join(flow.worktreePath, bindingRelativePath);
      assert.deepEqual(JSON.parse(fs.readFileSync(bindingPath, "utf8")), {
        version: 2,
        runId: flow.runId,
        issue,
        specId: flow.specId,
        worktreePath: fs.realpathSync(flow.worktreePath),
      });
    }
  });

  it("rejects malformed or field-invalid bindings without registry fallback", () => {
    const root = createProject();
    const flow = prepareWorktree(root, 440);
    const bindingPath = path.join(flow.worktreePath, bindingRelativePath);
    const valid = {
      version: 2,
      runId: flow.runId,
      issue: 440,
      specId: flow.specId,
      worktreePath: fs.realpathSync(flow.worktreePath),
    };
    const invalid = [
      "{not-json\n",
      JSON.stringify({ version: 2, runId: flow.runId }),
      JSON.stringify({ ...valid, issue: "440" }),
      JSON.stringify({ ...valid, issue: 0 }),
      JSON.stringify({ ...valid, specId: "../binding-contract" }),
      JSON.stringify({ ...valid, worktreePath: root }),
      JSON.stringify({ ...valid, version: 1 }),
    ];

    fs.writeFileSync(path.join(root, ".sennel", ".current-flow"), "999-unrelated\n");
    for (const content of invalid) {
      fs.writeFileSync(bindingPath, content);
      const result = runFlow(flow.worktreePath, [
        "get", "status", flow.runId,
        "--expect-run-id", flow.runId,
        "--expect-issue", "440",
        "--expect-spec", flow.specId,
      ]);
      assert.notEqual(result.status, 0, content);
      assert.match(
        result.envelope?.errors?.[0]?.messages?.join(" ") || result.stderr,
        /binding|identity|run|issue|spec|worktree|path|json/i,
      );
    }
  });

  it("rejects a symlink SENNEL_WORK_ROOT alias outside the managed boundary", () => {
    const root = createProject();
    const flow = prepareWorktree(root, 440);
    const alias = path.join(root, "worktree-alias");
    fs.symlinkSync(flow.worktreePath, alias);
    const bindingPath = path.join(flow.worktreePath, bindingRelativePath);
    const before = fs.readFileSync(bindingPath);

    const result = runFlow(alias, [
      "get", "status", flow.runId,
      "--expect-run-id", flow.runId,
      "--expect-issue", "440",
      "--expect-spec", flow.specId,
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr || result.stdout, /canonical|real path|symlink|managed worktree/i);
    assert.deepEqual(fs.readFileSync(bindingPath), before);
  });
});
