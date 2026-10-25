// Run this file in its own normal Node test host: no earlier managed command.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getPorcelainV2Status, runGitAsync } from "../../../src/lib/git-helpers.js";
import { GitRepositoryPolicy } from "../../../src/lib/git-repository-environment.js";
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
