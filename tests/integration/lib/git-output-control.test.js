import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { runGitToFile } from "../../../src/lib/git-helpers.js";
import { GitCommandExecution } from "../../../src/lib/git-command-execution.js";
import { AtomicFileWriteError } from "../../../src/lib/atomic-file.js";
import { ProcessExecutionControlFailure } from "../../../src/lib/process-execution-values.js";

function outputFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-output-control-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, outputPath: path.join(root, "stdout.bin") };
}

function withExternalGit(produce, operation) {
  const original = GitCommandExecution.prototype.run;
  GitCommandExecution.prototype.run = function () {
    return produce(this.invocation.stdio[1]);
  };
  try { return operation(); }
  finally { GitCommandExecution.prototype.run = original; }
}

for (const reason of ["endpoint-unavailable", "bridge-timeout"]) {
  test("Git output preserves typed " + reason + " provenance through atomic production", (t) => {
    const { root, outputPath } = outputFixture(t);
    const failure = new ProcessExecutionControlFailure(reason, "Managed launcher did not respond", {
      executionId: randomUUID(), callId: randomUUID(),
    });
    let observed;
    withExternalGit((descriptor) => {
      fs.writeSync(descriptor, "partial output");
      throw failure;
    }, () => assert.throws(() => runGitToFile(["diff", "--binary"], {
      cwd: root, outputPath, log: false,
    }), (error) => { observed = error; return error instanceof ProcessExecutionControlFailure; }));
    assert.deepEqual(observed.toJSON(), failure.toJSON());
    assert.deepEqual(ProcessExecutionControlFailure.fromStored(JSON.parse(JSON.stringify(observed))).toJSON(), failure.toJSON());
    assert.ok(observed.cause instanceof AtomicFileWriteError);
    assert.equal(observed.cause.cause, failure);
    assert.equal(observed.cause.committedToVisibleName, false);
    assert.equal(observed.cause.publicationUnknown, false);
    assert.equal(fs.existsSync(outputPath), false);
  });
}

test("ordinary Git producer failure keeps atomic diagnostics and cleans its owned stage", (t) => {
  const { root, outputPath } = outputFixture(t);
  const failure = new Error("external Git producer failed");
  withExternalGit((descriptor) => {
    fs.writeSync(descriptor, "partial output");
    throw failure;
  }, () => assert.throws(() => runGitToFile(["diff"], { cwd: root, outputPath, log: false }),
    (error) => error instanceof AtomicFileWriteError && error.cause === failure
      && error.code === "ATOMIC_FILE_WRITE_FAILED" && !error.committedToVisibleName && !error.cleanupFailed));
  assert.deepEqual(fs.readdirSync(root), []);
});

for (const status of [0, 128]) {
  test("Git output publishes exact bytes and retains the settled status " + status, (t) => {
    const { root, outputPath } = outputFixture(t);
    const bytes = Buffer.from([0, 255, 0x61, 0xc0, 0x80]);
    const expected = { ok: status === 0, status, stdout: "", stderr: status === 0 ? "" : "Git refused", signal: null, killed: false };
    const result = withExternalGit((descriptor) => { fs.writeSync(descriptor, bytes); return expected; },
      () => runGitToFile(["diff"], { cwd: root, outputPath, log: false }));
    assert.equal(result, expected);
    assert.deepEqual(fs.readFileSync(outputPath), bytes);
    assert.deepEqual(fs.readdirSync(root), ["stdout.bin"]);
  });
}
