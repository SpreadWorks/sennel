import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AtomicFileWriteError } from "../../../src/lib/atomic-file.js";
import { runGitToFile } from "../../../src/lib/git-helpers.js";
import { GitCommandExecution } from "../../../src/lib/git-command-execution.js";
import { TemporaryPaths } from "../../../src/lib/temporary-paths.js";
import { FileIdentity, sameFileIdentity } from "../../../src/lib/real-directory-authority.js";
import { ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-values.js";
import { retainExecutionCompletion } from "../../../src/lib/process-execution-completion.js";
import { finalRegressionWorktreeFingerprint } from "../../../src/flow/lib/test-artifacts.js";
import { buildRepairStateManifest, captureRepairBaseline } from "../../../src/flow/lib/repair-state-identity.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function repository(t, release = () => {}) {
  const root = createTmpDir("git-pending-output-");
  t.after(() => { release(); removeTmpDir(root); });
  fs.writeFileSync(path.join(root, "tracked.txt"), "original\n");
  initGitRepo(root);
  commitAll(root, "Create pending output fixture");
  return root;
}

/** Fake external work remains pending until this fixture explicitly releases it. */
class PendingGitProducer {
  #descriptor = null;
  #identity = null;
  constructor(t) {
    this.failure = new ProcessExecutionControlFailure("bridge-timeout", "Producer completion is still unknown", {
      executionId: randomUUID(), callId: randomUUID(),
    });
    const pending = this;
    const original = GitCommandExecution.prototype.run;
    t.mock.method(GitCommandExecution.prototype, "run", function () {
      if (!Array.isArray(this.invocation.stdio) || !Number.isInteger(this.invocation.stdio[1])) {
        return original.call(this);
      }
      pending.#descriptor = this.invocation.stdio[1];
      pending.#identity = new FileIdentity(fs.fstatSync(pending.#descriptor, { bigint: true }));
      fs.writeSync(pending.#descriptor, "partial output");
      throw pending.failure;
    });
  }
  assertRefused(operation) {
    assert.throws(operation, error => error instanceof ProcessExecutionControlFailure
      && error.code === this.failure.code && error.callId === this.failure.callId);
    assert.notEqual(this.#descriptor, null, "the external producer actually borrowed the descriptor");
  }
  assertRetained(directory) {
    assert.equal(fs.existsSync(directory), true, "an unconfirmed producer still owns its output workspace");
    assert.doesNotThrow(() => fs.fstatSync(this.#descriptor), "the pending producer descriptor must remain open");
    assert.equal(sameFileIdentity(this.#identity,
      new FileIdentity(fs.fstatSync(this.#descriptor, { bigint: true }))), true);
    const stages = fs.readdirSync(directory).filter(name => name.startsWith(".") && name.endsWith(".tmp"));
    assert.equal(stages.length, 1, "retain exactly the pending unpublished stage");
    fs.writeSync(this.#descriptor, " and late output");
    assert.equal(fs.readFileSync(path.join(directory, stages[0]), "utf8"), "partial output and late output");
  }
  release() {
    if (this.#descriptor === null) return;
    let current;
    try { current = new FileIdentity(fs.fstatSync(this.#descriptor, { bigint: true })); }
    catch (error) { assert.equal(error.code, "EBADF"); return; }
    // Never close a recycled descriptor; this fixture releases only its fake
    // pending producer, after all contract assertions have finished.
    if (sameFileIdentity(this.#identity, current)) fs.closeSync(this.#descriptor);
    this.#descriptor = null;
  }
}

function observeWorkspace(t, root, purpose) {
  const original = TemporaryPaths.prototype.create;
  const selected = [];
  t.mock.method(TemporaryPaths.prototype, "create", function (directory, prefix) {
    const result = original.call(this, directory, prefix);
    if (directory === TemporaryPaths.runtimePath(root, purpose)) selected.push(result);
    return result;
  });
  return selected;
}

test("unconfirmed Git output keeps the borrowed descriptor and unpublished stage alive", t => {
  let pending;
  const root = repository(t, () => pending?.release());
  const output = path.join(root, "output"); fs.mkdirSync(output);
  pending = new PendingGitProducer(t);
  const outputPath = path.join(output, "stdout.bin");
  pending.assertRefused(() => runGitToFile(["diff"], { cwd: root, outputPath, log: false }));
  assert.equal(fs.existsSync(outputPath), false);
  pending.assertRetained(output);
});

test("fingerprint refusal retains the unconfirmed Git producer workspace", t => {
  let pending;
  const root = repository(t, () => pending?.release());
  const directories = observeWorkspace(t, root, "final-regression-git");
  pending = new PendingGitProducer(t);
  pending.assertRefused(() => finalRegressionWorktreeFingerprint(root));
  assert.equal(directories.length, 1);
  pending.assertRetained(directories[0]);
});

test("repair manifest refusal retains the unconfirmed Git producer workspace", t => {
  let pending;
  const root = repository(t, () => pending?.release());
  const baseline = captureRepairBaseline({ root, baseRef: "main", runId: "pending-output" });
  const directories = observeWorkspace(t, root, "repair-git");
  pending = new PendingGitProducer(t);
  pending.assertRefused(() => buildRepairStateManifest({ root, specPath: "specs/demo/001/spec.json",
    state: { runId: "pending-output", baseBranch: "main", repairBaseline: baseline.toJSON() } }));
  assert.equal(directories.length, 1);
  pending.assertRetained(directories[0]);
});

test("Git output cleans its stage when a typed reporting failure retains actual confirmed completion", t => {
  const root = repository(t);
  const output = path.join(root, "output"); fs.mkdirSync(output);
  const original = GitCommandExecution.prototype.run;
  let receipt;
  t.mock.method(GitCommandExecution.prototype, "run", function () {
    const result = original.call(this);
    receipt = result.processExecutionStopReceipt;
    assert.ok(receipt instanceof ProcessExecutionStopReceipt);
    assert.equal(receipt.stopEvidence.status, "confirmed");
    const error = new ProcessExecutionControlFailure("receipt-delivery-failed", "Reporting failed after Git completed", {
      executionId: receipt.executionId, callId: receipt.callId,
    });
    retainExecutionCompletion(error, result);
    throw error;
  });
  assert.throws(() => runGitToFile(["diff"], { cwd: root, outputPath: path.join(output, "stdout.bin"), log: false }),
    error => error instanceof ProcessExecutionControlFailure && error.processExecutionStopReceipt === receipt);
  assert.ok(receipt instanceof ProcessExecutionStopReceipt);
  assert.deepEqual(fs.readdirSync(output), []);
});

test("fingerprint refusal retains output whose descriptor release is unconfirmed", t => {
  let descriptor = null;
  let identity = null;
  const close = fs.closeSync;
  const root = repository(t, () => {
    if (descriptor === null) return;
    let current;
    try { current = new FileIdentity(fs.fstatSync(descriptor, { bigint: true })); }
    catch (error) { assert.equal(error.code, "EBADF"); return; }
    if (sameFileIdentity(identity, current)) close(descriptor);
    descriptor = null;
  });
  const directories = observeWorkspace(t, root, "final-regression-git");
  const original = GitCommandExecution.prototype.run;
  t.mock.method(GitCommandExecution.prototype, "run", function () {
    if (!Array.isArray(this.invocation.stdio) || !Number.isInteger(this.invocation.stdio[1])) return original.call(this);
    descriptor = this.invocation.stdio[1];
    identity = new FileIdentity(fs.fstatSync(descriptor, { bigint: true }));
    fs.writeSync(descriptor, "settled output");
    return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
  });
  t.mock.method(fs, "closeSync", function (selected) {
    if (selected === descriptor && sameFileIdentity(identity,
      new FileIdentity(fs.fstatSync(selected, { bigint: true })))) {
      const error = new Error("Output descriptor release is unconfirmed"); error.code = "EIO"; throw error;
    }
    return close(selected);
  });
  assert.throws(() => finalRegressionWorktreeFingerprint(root),
    error => error instanceof AtomicFileWriteError && error.cleanupFailed);
  assert.equal(directories.length, 1);
  assert.equal(fs.existsSync(directories[0]), true, "unreleased output must keep its owned workspace");
  assert.equal(sameFileIdentity(identity, new FileIdentity(fs.fstatSync(descriptor, { bigint: true }))), true);
  const stages = fs.readdirSync(directories[0]).filter(name => name.startsWith(".") && name.endsWith(".tmp"));
  assert.equal(stages.length, 1);
  assert.equal(fs.readFileSync(path.join(directories[0], stages[0]), "utf8"), "settled output");
});
