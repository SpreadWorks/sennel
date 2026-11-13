import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runGit } from "../../../src/lib/git-command-execution.js";
import { GitRepositoryPolicy } from "../../../src/lib/git-repository-environment.js";
import { withReadOnlyManagedProcessScopeSync } from "../../../src/lib/managed-process.js";
import { ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-values.js";
import { initGitRepo } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

test("synchronous readonly scopes use each caller temporary parent after an earlier parent is removed", (t) => {
  const root = createTmpDir("caller-temporary-parent-");
  const original = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    removeTmpDir(root);
  });
  const repository = path.join(root, "repository");
  fs.mkdirSync(repository);
  initGitRepo(repository);
  const parents = ["first", "second", "scoped"].map(name => {
    const directory = path.join(root, name); fs.mkdirSync(directory); return directory;
  });
  const select = directory => {
    // Let Node choose its native variable precedence on every platform.
    for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = directory;
  };
  const invoke = () => runGit(["rev-parse", "--show-toplevel"], { cwd: repository,
    gitPolicy: new GitRepositoryPolicy({ repositoryRoot: repository, readOnly: true }) });
  const assertCompleted = result => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.realpathSync(result.stdout.trim()), fs.realpathSync(repository));
    assert.ok(result.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt);
    assert.equal(result.processExecutionStopReceipt.stopEvidence.status, "confirmed");
  };
  select(parents[0]);
  assertCompleted(invoke());
  // The command and its owning readonly scope completed before this external
  // temporary-parent removal. The persistent bridge remains alive.
  fs.rmSync(parents[0], { recursive: true });
  select(parents[1]);
  const second = invoke();
  assert.equal(second.status, 0, "second readonly command reused a removed caller temporary parent: " + second.stderr);
  assertCompleted(second);
  select(parents[2]);
  withReadOnlyManagedProcessScopeSync({ mainRoot: repository }, runtime => {
    const grant = runtime.remoteGrant();
    assert.equal(path.dirname(grant.storage.workspaceRoot), fs.realpathSync(parents[2]));
    assert.equal(path.dirname(grant.endpoint.storage.workspaceRoot), fs.realpathSync(parents[2]));
    assertCompleted(invoke());
  });
});
