// Run this file in its own normal Node test host: no earlier managed command.
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { getPorcelainV2Status, runGit, runGitAsync } from "../../../src/lib/git-helpers.js";
import { FileIdentity } from "../../../src/lib/file-identity.js";
import { GitRepositoryPolicy, GitOwnedStagePolicy } from "../../../src/lib/git-repository-environment.js";
import { ProcessExecutionRuntime, PROCESS_EXECUTION_SCOPE_ENV } from "../../../src/lib/process-execution-runtime.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo } from "../../support/infrastructure/git-repo.js";

test("first-use standalone Git observation keeps real user paths visible without writing checkout control files", async (t) => {
  const root = createTmpDir("readonly-git-first-use-");
  t.after(() => removeTmpDir(root));
  // Existing raw fixture setup runs no managed bridge in this fresh test host.
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "visible.txt"), "user file\n");
  assert.equal(ProcessExecutionRuntime.current(), null);
  assert.equal(process.env[PROCESS_EXECUTION_SCOPE_ENV], undefined);
  const before = fs.readdirSync(root).sort();
  const status = getPorcelainV2Status(root);
  assert.deepEqual(status.pathSet.toArray(), ["visible.txt"]);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  const asynchronous = await runGitAsync(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"], {
    cwd: root, gitPolicy: new GitRepositoryPolicy({ readOnly: true }),
  });
  assert.equal(asynchronous.ok, true, asynchronous.stderr);
  assert.equal(asynchronous.stdout, "? visible.txt\0");
  assert.equal(asynchronous.processExecutionStopReceipt.checkoutIdentity.executionRoot, root);
  assert.equal(asynchronous.processExecutionStopReceipt.binding.value, null);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: root }), null);
});


test("read-only Git queries and worker environments preserve index bytes when stat refresh is enabled", (t) => {
  const root = createTmpDir("readonly-git-diff-");
  t.after(() => removeTmpDir(root));
  initGitRepo(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("config", "diff.autoRefreshIndex", "true");
  const source = path.join(root, "subject.js");
  const bytes = Buffer.from("export const value = 1;\n");
  fs.writeFileSync(source, bytes);
  git("add", "subject.js");
  git("commit", "-qm", "baseline");
  const policy = new GitRepositoryPolicy({ repositoryRoot: root, readOnly: true });
  const configPath = path.join(root, ".git", "config");
  const originalConfig = fs.readFileSync(configPath);
  const index = path.join(root, ".git", "index");
  for (const consumer of ["query", "worker environment"]) {
    const replacement = path.join(root, "replacement.js");
    fs.writeFileSync(replacement, bytes);
    fs.renameSync(replacement, source);
    fs.utimesSync(source, 1_000_000_000, 1_000_000_000);
    const before = fs.readFileSync(index);
    const generation = FileIdentity.capture(fs.statSync(index, { bigint: true }));
    if (consumer === "query") {
      const result = runGit(["diff", "--binary", "HEAD"], { cwd: root, gitPolicy: policy });
      assert.equal(result.ok, true, result.stderr);
      assert.equal(result.stdout, "");
    } else {
      assert.equal(execFileSync("git", ["diff", "--binary", "HEAD"], {
        cwd: root, env: policy.environment(process.env), encoding: "utf8",
      }), "");
    }
    assert.deepEqual(fs.readFileSync(index), before, consumer);
    assert.equal(generation.equals(FileIdentity.capture(fs.statSync(index, { bigint: true }))), true, consumer);
    assert.deepEqual(fs.readFileSync(source), bytes);
    assert.deepEqual(fs.readFileSync(configPath), originalConfig);
  }
  assert.equal(git("config", "--get", "diff.autoRefreshIndex"), "true");
  const inherited = { GIT_CONFIG_PARAMETERS: "'core.worktree=foreign'" };
  assert.equal(new GitRepositoryPolicy({ repositoryRoot: root }).environment(inherited).GIT_CONFIG_PARAMETERS, undefined);
  assert.equal(new GitOwnedStagePolicy({ repositoryRoot: root }).environment(inherited).GIT_CONFIG_PARAMETERS, undefined);
});
