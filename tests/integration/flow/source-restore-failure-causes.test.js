import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { GitCommandExecution } from "../../../src/lib/git-command-execution.js";
import { TemporaryPaths } from "../../../src/lib/temporary-paths.js";
import { SourceHandoffFailureFacts } from "../../../src/flow/lib/source-handoff-failure.js";
import { SourceGitRestoreStage } from "../../../src/flow/lib/source-git-restore-stage.js";
import { WorkerArtifactRepositoryMutationSnapshot, WorkerArtifactSourceRollbackCheckpoint } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { completeManagedOperation } from "../../../src/lib/process-execution-completion.js";

function causes(error) {
  const result = new Set(), pending = [error];
  while (pending.length !== 0) {
    const next = pending.pop();
    if (next === undefined || result.has(next)) continue;
    result.add(next);
    if (next?.cause !== undefined) pending.push(next.cause);
    if (next instanceof AggregateError) pending.push(...next.errors);
  }
  return result;
}

it("preserves the exact control failure when Source authority capture cannot complete", async (t) => {
  const root = createTmpDir("source-capture-control-failure-");
  t.after(() => removeQuiescentRuntimeFixture({ mainRoot: root }));
  initGitRepo(root);
  const file = path.join(root, "data.txt"), bytes = Buffer.from("before\r\n");
  fs.writeFileSync(file, bytes);
  commitAll(root, "source capture control failure contract");
  const generation = fs.statSync(file, { bigint: true }).ino;
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  await completeManagedOperation(() => runtime.enter(() => {
    const failure = new ProcessExecutionControlFailure("endpoint-unavailable", "Mailbox response completion is unknown");
    const execution = t.mock.method(GitCommandExecution, "runTogether", () => { throw failure; });
    assert.throws(
      () => WorkerArtifactRepositoryMutationSnapshot.capture({ root, authorities: ["execution"] }),
      (error) => error === failure,
    );
    assert.equal(execution.mock.callCount(), 1);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.statSync(file, { bigint: true }).ino, generation);
  }), () => runtime.close());
});

for (const boundary of ["capability capture", "source restore"]) {
  it(`retains the original ${boundary} failure when its Git stage cleanup also fails`, async (t) => {
    const root = createTmpDir("source-restore-failure-causes-");
    t.after(() => removeQuiescentRuntimeFixture({ mainRoot: root }));
    initGitRepo(root);
    const file = path.join(root, "data.txt"), raw = Buffer.from("before\r\n");
    fs.writeFileSync(file, raw);
    commitAll(root, "source failure cause contract");
    const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
    await completeManagedOperation(() => runtime.enter(() => {
      const snapshot = WorkerArtifactRepositoryMutationSnapshot.capture({ root, authorities: ["execution"] });
      const blob = boundary === "source restore" ? new WorkerArtifactSourceRollbackCheckpoint([snapshot]).blobBytes() : null;
      if (blob !== null) fs.writeFileSync(file, "worker\n");
      const before = fs.readFileSync(file), generation = fs.statSync(file, { bigint: true }).ino;
      const primary = new Error(`injected ${boundary} failure`), cleanup = new Error("injected Git stage cleanup failure");
      const originalRun = GitCommandExecution.prototype.run;
      const originalSnapshot = SourceGitRestoreStage.prototype.snapshot;
      const originalCleanup = TemporaryPaths.prototype.cleanup;
      let cleanupReached = false, observed;
      try {
        if (blob === null) GitCommandExecution.prototype.run = function () { throw primary; };
        else SourceGitRestoreStage.prototype.snapshot = function () { throw primary; };
        TemporaryPaths.prototype.cleanup = function (target, ...args) {
          if (path.resolve(target).includes(`${path.sep}source-restore${path.sep}`)) {
            cleanupReached = true;
            throw cleanup;
          }
          return originalCleanup.call(this, target, ...args);
        };
        try {
          if (blob === null) new WorkerArtifactSourceRollbackCheckpoint([snapshot]);
          else WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore();
        } catch (error) { observed = error; }
      } finally {
        GitCommandExecution.prototype.run = originalRun;
        SourceGitRestoreStage.prototype.snapshot = originalSnapshot;
        TemporaryPaths.prototype.cleanup = originalCleanup;
      }
      assert.equal(cleanupReached, true, "the cleanup fault must be reached after the original operation failure");
      assert.ok(causes(observed).has(primary), "the public failure must retain its original operation cause");
      assert.ok(causes(observed).has(cleanup), "the public failure must also retain the cleanup cause");
      const saved = JSON.stringify(SourceHandoffFailureFacts.fromError(observed).toJSON());
      const restored = new SourceHandoffFailureFacts(JSON.parse(saved));
      assert.ok(restored.message.includes(primary.message), "saved source failure diagnostics retain the original operation message");
      assert.ok(restored.message.includes(cleanup.message), "saved source failure diagnostics also retain the cleanup message");
      assert.deepEqual(fs.readFileSync(file), before, "failed restore publication leaves the source bytes unchanged");
      assert.equal(fs.statSync(file, { bigint: true }).ino, generation, "failed restore publication leaves the source generation unchanged");
    }), () => runtime.close());
  });
}
