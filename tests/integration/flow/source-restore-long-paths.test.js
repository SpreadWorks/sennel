import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { it } from "node:test";
import { GitRepositoryPolicy, GitOwnedStagePolicy } from "../../../src/lib/git-repository-environment.js";
import { GitCommandExecution } from "../../../src/lib/git-command-execution.js";
import { withReadOnlyManagedProcessScope } from "../../../src/lib/managed-process.js";
import { completeManagedOperationSync } from "../../../src/lib/process-execution-completion.js";
import { WorkerArtifactRepositoryMutationSnapshot } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { SourceGitRestoreStage } from "../../../src/flow/lib/source-git-restore-stage.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { testTemporaryRoot } from "../../test-environment.js";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function withRestoreFixture(t, prefix, operation) {
  const root = createTmpDir(prefix);
  t.after(() => removeQuiescentRuntimeFixture({ mainRoot: root }));
  initGitRepo(root);
  try {
    await withReadOnlyManagedProcessScope({ mainRoot: root, executionRoot: root }, () => operation(root));
  } catch (error) {
    testTemporaryRoot().retainOnUnconfirmedExecution(error);
    throw error;
  }
}

it("owned source restoration enables Git long-path support without changing the repository configuration", async (t) => {
  await withRestoreFixture(t, "restore-long-path-policy-", async (root) => {
    git(root, "config", "core.longpaths", "false");
    const configuration = fs.readFileSync(path.join(root, ".git", "config"));
    const attributes = path.join(root, "owned-attributes");
    fs.writeFileSync(attributes, "");
    const restore = new GitOwnedStagePolicy({ repositoryRoot: root, gitDir: path.join(root, ".git"),
      workTree: root, attributesFile: attributes, restore: true });
    const ordinary = new GitRepositoryPolicy({ repositoryRoot: root, readOnly: true, isolateConfiguration: true });
    for (const [gitPolicy, expected] of [[ordinary, "false"], [restore, "true"], [ordinary, "false"]]) {
      const result = await new GitCommandExecution(["config", "--bool", "--get", "core.longpaths"], { cwd: root, gitPolicy }).runAsync();
      assert.equal(result.ok, true, result.stderr);
      assert.equal(result.processExecutionStopReceipt.stopEvidence.confirmed, true);
      assert.equal(result.stdout.trim(), expected, "restore capability must survive configuration isolation without changing ordinary repository policy");
    }
    assert.deepEqual(fs.readFileSync(path.join(root, ".git", "config")), configuration);
  });
});

it("materializes exact raw before-images through an owned Git stage whose file path exceeds 260 characters", async (t) => {
  await withRestoreFixture(t, "restore-long-materialization-", (root) => {
    git(root, "config", "core.longpaths", "true");
    const name = `${"x".repeat(160)}.bin`;
    const raw = Buffer.from([0, 255, 13, 10, 65, 0]);
    fs.writeFileSync(path.join(root, name), raw);
    commitAll(root, "long source restoration");
    const configuration = fs.readFileSync(path.join(root, ".git", "config"));
    const observed = WorkerArtifactRepositoryMutationSnapshot.capture({ root, authorities: ["execution"] });
    const entry = observed.entries.find((value) => value.path === name);
    assert.ok(entry);
    const stage = new SourceGitRestoreStage({ root, gitState: observed.gitState,
      entries: [{ entry, bytes: raw }], maxBytes: 1024 * 1024 });
    completeManagedOperationSync(() => {
      const staged = stage.snapshot(name);
      assert.ok(staged.filePath.length > 260, "the real owned stage must exercise a path longer than the Windows legacy limit");
      assert.deepEqual(staged.bytes, raw);
      assert.deepEqual(fs.readFileSync(path.join(root, name)), raw);
      assert.deepEqual(fs.readFileSync(path.join(root, ".git", "config")), configuration);
    }, () => stage.dispose());
  });
});
