import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { runGit } from "../../../src/lib/git-helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const roots = [];

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
  initGitRepo(root);
  commitAll(root, "worktree CLI fixture");
  const worktreePath = path.join(root, "worktree");
  const added = runGit(["worktree", "add", worktreePath, "-b", "feature"], { cwd: root });
  assert.equal(added.ok, true, added.stderr);
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

  it("executes captured local entry bytes after that entry deletes itself and replaces its disk loader", () => {
    const { root, worktreePath } = createFixture();
    const localEntry = path.join(worktreePath, "src", "sennel.js");
    const source = fs.readFileSync(localEntry, "utf8");
    fs.writeFileSync(localEntry, source.replace("const rawArgs = process.argv.slice(2);", `
      process.stderr.write('[captured-local-entry]\\n');
      unlinkSync(new URL(import.meta.url));
      writeFileSync(new URL('./lib/runtime-loader.js', import.meta.url), 'throw new Error("mutable local loader executed");');
      const rawArgs = process.argv.slice(2);
    `));
    const result = invokeGlobalCli(root, worktreePath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /\[captured-local-entry\]/);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.equal(fs.existsSync(localEntry), false);
    assert.match(fs.readFileSync(path.join(worktreePath, "src", "lib", "runtime-loader.js"), "utf8"), /mutable local loader executed/);
  });

  it("fails closed when the worktree-local CLI source is absent", () => {
    const { root, worktreePath } = createFixture();
    const worktreeCli = path.join(worktreePath, "src", "sennel.js");
    fs.rmSync(worktreeCli);

    const result = invokeGlobalCli(root, worktreePath);

    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const failure = JSON.parse(result.stdout);
    assert.equal(failure.ok, false);
    assert.deepEqual(failure.errors.map((error) => error.code), ["FLOW_BOOTSTRAP_FAILED"]);
    assert.equal(failure.guidance.cause.kind, "bootstrap");
    assert.equal(failure.guidance.cause.code, "FLOW_RUNTIME_HANDOFF_FAILED");
    assert.equal(failure.guidance.nextAction.kind, "external_work");
    assert.equal(Object.hasOwn(failure, "directive"), false);
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
