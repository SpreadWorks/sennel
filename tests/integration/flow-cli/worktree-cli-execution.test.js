import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const roots = [];

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createGitWorktree({ packageName, copySource = false }) {
  const root = createTestDirectory("sennel-worktree-cli-execution.test-");
  roots.push(root);
  if (copySource) fs.cpSync(path.join(repoRoot, "src"), path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: packageName,
    version: "0.0.0",
    type: "module",
  }, null, 2));
  fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sennel", "config.json"), JSON.stringify({
    lang: "en",
    type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
  }, null, 2));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  const worktreePath = path.join(root, "worktree");
  git(root, ["worktree", "add", worktreePath, "-b", "feature"]);
  return { root, worktreePath };
}

function createFixture() {
  return createGitWorktree({ packageName: "@fixture/sennel", copySource: true });
}

function invokeGlobalCli(root, worktreePath, argv = ["flow", "get", "status"]) {
  const env = { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root };
  delete env.SENNEL_WORKTREE_CLI_REEXEC;
  return spawnSync(process.execPath, [path.join(root, "src", "sennel.js"), ...argv], {
    cwd: worktreePath,
    encoding: "utf8",
    env,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("global CLI execution from a managed worktree", () => {
  it("uses the worktree CLI source while retaining the base artifact configuration authority", () => {
    const { root, worktreePath } = createFixture();
    const worktreeCli = path.join(worktreePath, "src", "sennel.js");
    const worktreeSource = fs.readFileSync(worktreeCli, "utf8");
    fs.writeFileSync(
      worktreeCli,
      worktreeSource.replace(
        "const rawArgs = process.argv.slice(2);",
        "process.stderr.write('[worktree-cli]\\n');\nconst rawArgs = process.argv.slice(2);",
      ),
    );
    const result = invokeGlobalCli(root, worktreePath);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /\[worktree-cli\]/);
    assert.equal(JSON.parse(result.stdout).ok, true);
  });

  it("fails closed when the worktree-local CLI source is absent", () => {
    const { root, worktreePath } = createFixture();
    const worktreeCli = path.join(worktreePath, "src", "sennel.js");
    fs.rmSync(worktreeCli);

    const result = invokeGlobalCli(root, worktreePath);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Execution target: ${path.join(root, "src", "sennel.js")}`));
    assert.match(result.stderr, new RegExp(`Expected worktree source: ${worktreeCli}`));
    assert.match(result.stderr, /Recovery: restore the worktree source, then run: node /);
  });

  it("preserves global package execution in an unrelated worktree", () => {
    const { worktreePath } = createGitWorktree({ packageName: "consumer-project" });
    const result = spawnSync(process.execPath, [path.join(repoRoot, "src", "sennel.js"), "flow", "get", "status"], {
      cwd: worktreePath,
      encoding: "utf8",
      env: process.env,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).ok, true);
  });
});
