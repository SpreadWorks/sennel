import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AtomicFileWriteError } from "../../../src/lib/atomic-file.js";
import { GitCommandExecution } from "../../../src/lib/git-command-execution.js";
import { runGitToFile } from "../../../src/lib/git-helpers.js";
import { ProcessExecutionControlFailure, ProcessExecutionStopReceipt, ProcessExecutionCommunicationAttempt,
  ProcessExecutionCommunicationDiagnostic } from "../../../src/lib/process-execution-values.js";
import { retainExecutionCompletion } from "../../../src/lib/process-execution-completion.js";
import { finalRegressionWorktreeFingerprint } from "../../../src/flow/lib/test-artifacts.js";
import { TemporaryPaths } from "../../../src/lib/temporary-paths.js";
import { initGitRepo } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function endpointFailure() {
  return new ProcessExecutionControlFailure("endpoint-unavailable", "Managed launcher did not respond", {
    executionId: "11111111-1111-4111-8111-111111111111", callId: "22222222-2222-4222-8222-222222222222",
    communication: new ProcessExecutionCommunicationDiagnostic({ operation: "bind", budgetMs: 14000,
      elapsedMs: 14000, cutoff: "budget-exhausted", acceptance: "unknown", stopConfirmation: "unknown",
      attempts: [new ProcessExecutionCommunicationAttempt({ ordinal: 1, responseDeadlineMs: 3000,
        elapsedMs: 3000, outcome: "timeout" }),
      new ProcessExecutionCommunicationAttempt({ ordinal: 2, responseDeadlineMs: 8000,
        elapsedMs: 5000, outcome: "timeout" }),
      new ProcessExecutionCommunicationAttempt({ ordinal: 3, responseDeadlineMs: 14000,
        elapsedMs: 6000, outcome: "timeout" })] }),
  });
}

for (const [name, capture] of [
  ["Git output", root => runGitToFile(["diff"], { cwd: root, outputPath: path.join(root, "output.bin"), log: false })],
  ["dispatcher fingerprint input", root => finalRegressionWorktreeFingerprint(root)],
]) {
  test(`${name} retains typed control identity through the actual AtomicFile producer failure`, t => {
    const root = createTmpDir("git-output-control-");
    t.after(() => removeTmpDir(root));
    fs.writeFileSync(path.join(root, "input.txt"), "original bytes\n");
    const primary = endpointFailure();
    let calls = 0;
    t.mock.method(GitCommandExecution.prototype, "run", () => { calls++; throw primary; });
    assert.throws(() => capture(root), error => {
      assert.ok(error instanceof ProcessExecutionControlFailure, `actual failure type: ${error.name}`);
      assert.deepEqual(error.toJSON(), primary.toJSON());
      assert.ok(error.cause instanceof AtomicFileWriteError);
      assert.equal(error.cause.cause, primary);
      assert.equal(error.cause.committedToVisibleName, false);
      assert.equal(error.processExecutionStopReceipt, undefined, "unknown completion must remain unknown");
      return true;
    });
    assert.equal(calls, 1, "output failure cannot retry its command");
    assert.equal(fs.existsSync(path.join(root, "output.bin")), false);
    assert.equal(fs.readFileSync(path.join(root, "input.txt"), "utf8"), "original bytes\n");
  });
}

test("ordinary Git output producer errors retain the AtomicFile failure and original cause", t => {
  const root = createTmpDir("git-output-ordinary-");
  t.after(() => removeTmpDir(root));
  const primary = new Error("ordinary producer failure");
  t.mock.method(GitCommandExecution.prototype, "run", () => { throw primary; });
  assert.throws(() => runGitToFile(["diff"], { cwd: root, outputPath: path.join(root, "output.bin"), log: false }),
    error => error instanceof AtomicFileWriteError && error.cause === primary && !error.committedToVisibleName);
});

test("fingerprint cleanup failure preserves the original typed operation before the cleanup cause", t => {
  const root = createTmpDir("fingerprint-output-cleanup-");
  t.after(() => removeTmpDir(root));
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "input.txt"), "original bytes\n");
  let primary;
  let receipt;
  const cleanup = new Error("injected fingerprint workspace cleanup failure");
  const run = GitCommandExecution.prototype.run;
  t.mock.method(GitCommandExecution.prototype, "run", function () {
    const result = run.call(this);
    receipt = result.processExecutionStopReceipt;
    assert.ok(receipt instanceof ProcessExecutionStopReceipt);
    assert.equal(receipt.stopEvidence.status, "confirmed");
    primary = new ProcessExecutionControlFailure("receipt-delivery-failed", "Reporting failed after Git completed", {
      executionId: receipt.executionId, callId: receipt.callId,
    });
    retainExecutionCompletion(primary, result);
    throw primary;
  });
  const remove = TemporaryPaths.prototype.cleanup;
  const outputParent = TemporaryPaths.runtimePath(root, "final-regression-git");
  const mocked = t.mock.method(TemporaryPaths.prototype, "cleanup", function (directory) {
    if (path.dirname(directory) === outputParent) throw cleanup;
    return remove.call(this, directory);
  });
  try {
    assert.throws(() => finalRegressionWorktreeFingerprint(root), error => {
      assert.ok(error instanceof ProcessExecutionControlFailure, `actual failure type: ${error.name}`);
      assert.deepEqual(error.toJSON(), primary.toJSON());
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors[0].cause.cause, primary);
      assert.equal(error.cause.errors[1], cleanup);
      assert.equal(error.processExecutionStopReceipt, receipt);
      return true;
    });
  } finally { mocked.mock.restore(); }
  assert.equal(fs.readFileSync(path.join(root, "input.txt"), "utf8"), "original bytes\n");
});
