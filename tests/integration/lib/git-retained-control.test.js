import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { runGit, runGitAsync } from "../../../src/lib/git-helpers.js";
import { OwnedRetainedProcessScope, executeManagedProcess } from "../../../src/lib/managed-process.js";
import { completeManagedOperationSync } from "../../../src/lib/process-execution-completion.js";
import { ProcessExecutionRuntime, PROCESS_EXECUTION_SCOPE_ENV } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionHistoryReference } from "../../../src/lib/process-execution-history-reference.js";
import { ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-values.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo } from "../../support/infrastructure/git-repo.js";
import { testTemporaryRoot } from "../../test-environment.js";

function rawGit(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function fixture(t, body) {
  const root = createTmpDir("retained-git-");
  t.after(() => removeTmpDir(root));
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "visible.txt"), "real user content\n");
  try { await body(root); }
  catch (error) { testTemporaryRoot().retainOnUnconfirmedExecution(error); throw error; }
}

async function assertReadback(result, root) {
  const receipt = result.processExecutionStopReceipt;
  assert.ok(receipt instanceof ProcessExecutionStopReceipt);
  assert.equal(receipt.checkoutIdentity.executionRoot, root);
  const reference = result.processExecutionHistory;
  assert.ok(reference instanceof ProcessExecutionHistoryReference);
  assert.equal(reference.checkoutIdentity.matches(receipt.checkoutIdentity), true);
  const restored = ProcessExecutionHistoryReference.fromStored(JSON.parse(JSON.stringify(reference)));
  const history = await restored.read();
  const execution = history.executions.find(entry => entry.executionId === receipt.executionId);
  assert.equal(execution.status, "closed");
  const call = execution.calls.find(entry => entry.callId === receipt.callId);
  assert.deepEqual(call.receipt, receipt.toJSON());
  assert.equal(call.invocation.launch.cwd, root);
  assert.equal(fs.existsSync(restored.toJSON().storage.workspaceRoot), true);
  return call;
}

test("standalone sync and async writers keep a same-cwd checkout clean with retained receipt readback", { timeout: 120000 }, async t => {
  await fixture(t, async root => {
    const cwd = process.cwd();
    const names = ["TMPDIR", "TMP", "TEMP"];
    const environment = new Map(names.map(name => [name, process.env[name]]));
    try {
      process.chdir(root);
      for (const name of names) process.env[name] = root;
      const first = runGit(["config", "fixture.value", "persisted"], { cwd: root, timeout: 20000 });
      const second = await runGitAsync(["status", "--porcelain=v1", "-z"], { cwd: root, timeout: 20000 });
      assert.equal(first.ok, true, first.stderr);
      assert.equal(second.ok, true, second.stderr);
      assert.equal(second.stdout, "?? visible.txt\0");
      assert.equal(rawGit(root, ["config", "--get", "fixture.value"]).trim(), "persisted");
      assert.equal(rawGit(root, ["status", "--short"]), "?? visible.txt\n");
      for (const result of [first, second]) await assertReadback(result, root);
      const inherited = process.env[PROCESS_EXECUTION_SCOPE_ENV];
      try {
        process.env[PROCESS_EXECUTION_SCOPE_ENV] = JSON.stringify(first.processExecutionHistory);
        assert.throws(() => runGit(["status", "--short"], { cwd: root }), ProcessExecutionControlFailure);
      } finally {
        if (inherited === undefined) delete process.env[PROCESS_EXECUTION_SCOPE_ENV]; else process.env[PROCESS_EXECUTION_SCOPE_ENV] = inherited;
      }
      assert.notEqual(first.processExecutionStopReceipt.callId, second.processExecutionStopReceipt.callId);
      assert.deepEqual(fs.readdirSync(root).sort(), [".git", "visible.txt"]);
    } finally {
      process.chdir(cwd);
      for (const [name, value] of environment) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});

test("standalone writers preserve a different cwd, native nonzero result and closed history", { timeout: 120000 }, async t => {
  await fixture(t, async root => {
    assert.notEqual(process.cwd(), root);
    const failed = runGit(["checkout", "missing-retained-branch"], { cwd: root, timeout: 20000 });
    const written = await runGitAsync(["config", "fixture.async", "written"], { cwd: root, timeout: 20000 });
    assert.equal(failed.ok, false);
    assert.notEqual(failed.status, 0);
    assert.equal(failed.processExecutionStopReceipt.observation.code, failed.status);
    assert.equal(written.ok, true, written.stderr);
    assert.equal(rawGit(root, ["config", "--get", "fixture.async"]).trim(), "written");
    await assertReadback(failed, root);
    await assertReadback(written, root);
    assert.deepEqual(fs.readdirSync(root).sort(), [".git", "visible.txt"]);
  });
});

test("a real output-limit control failure keeps its actual receipt and retained inventory", { timeout: 120000 }, async t => {
  await fixture(t, async root => {
    const result = runGit(["status", "--porcelain=v1", "-z"], { cwd: root, timeout: 20000, maxBuffer: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    assert.equal(result.processExecutionStopReceipt.output.completion, "truncated");
    await assertReadback(result, root);
    assert.equal(rawGit(root, ["status", "--short"]), "?? visible.txt\n");
  });
});

test("a refused execute transport retains the acquired locator without inventing a native call", { timeout: 120000 }, async t => {
  await fixture(t, async root => {
    const postMessage = Worker.prototype.postMessage;
    const failure = new Error("owned test transport refused before native request delivery");
    let refused = false;
    t.mock.method(Worker.prototype, "postMessage", function (message, ...args) {
      if (!refused && message.operation === "execute" && message.data.grant?.storage != null) {
        refused = true;
        throw failure;
      }
      return Reflect.apply(postMessage, this, [message, ...args]);
    });
    const result = runGit(["config", "fixture.notrun", "forbidden"], { cwd: root, timeout: 20000 });
    t.mock.restoreAll();
    assert.equal(refused, true);
    assert.equal(result.ok, false);
    assert.equal(result.stderr, failure.message);
    assert.equal(result.processExecutionStopReceipt, undefined);
    assert.ok(result.processExecutionHistory instanceof ProcessExecutionHistoryReference);
    const history = await result.processExecutionHistory.read();
    assert.equal(history.executions.length, 1);
    assert.equal(history.executions[0].status, "closed");
    assert.deepEqual(history.executions[0].calls, []);
    assert.equal(fs.readFileSync(path.join(root, ".git", "config"), "utf8").includes("notrun"), false);
    assert.deepEqual(fs.readdirSync(root).sort(), [".git", "visible.txt"]);
  });
});

test("a post-close retention failure preserves the original native success and readback", { timeout: 120000 }, async t => {
  await fixture(t, async root => {
    const failure = new Error("owned test refused retention completion after actual coordinator close");
    t.mock.method(OwnedRetainedProcessScope.prototype, "completeWorkspace", function () { throw failure; });
    const result = await runGitAsync(["config", "fixture.finished", "kept"], { cwd: root, timeout: 20000 });
    t.mock.restoreAll();
    assert.equal(result.ok, false);
    assert.equal(result.stderr, failure.message);
    assert.equal(result.processExecutionStopReceipt.observation.code, 0);
    assert.equal(rawGit(root, ["config", "--get", "fixture.finished"]).trim(), "kept");
    await assertReadback(result, root);
  });
});

test("explicit, current and inherited owners retain their original authority and malformed delegation still refuses", { timeout: 120000 }, async t => {
  await fixture(t, async root => {
    const control = createTmpDir("retained-explicit-owner-");
    let runtime;
    t.after(() => removeTmpDir(control));
    try {
      const explicit = runGit(["config", "fixture.explicit", "kept"], { cwd: root, repositoryRoot: control, timeout: 20000 });
      assert.equal(explicit.ok, true, explicit.stderr);
      assert.equal(explicit.processExecutionHistory, undefined);
      assert.equal(explicit.processExecutionStopReceipt.checkoutIdentity.executionRoot, control);
      const explicitHistory = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: control });
      assert.deepEqual(explicitHistory.executions.flatMap(entry => entry.calls).find(call => call.callId === explicit.processExecutionStopReceipt.callId).receipt,
        explicit.processExecutionStopReceipt.toJSON());
      runtime = await ProcessExecutionRuntime.acquire({ mainRoot: control, executionRoot: root, environment: {} });
      const current = runtime.enter(() => runGit(["config", "fixture.current", "kept"], { cwd: root, timeout: 20000 }));
      const previous = process.env[PROCESS_EXECUTION_SCOPE_ENV];
      try {
        process.env[PROCESS_EXECUTION_SCOPE_ENV] = JSON.stringify(runtime.remoteGrant());
        const inherited = runGit(["config", "fixture.inherited", "kept"], { cwd: root, timeout: 20000 });
        for (const result of [current, inherited]) {
          assert.equal(result.ok, true, result.stderr);
          assert.equal(result.processExecutionHistory, undefined);
          assert.equal(result.processExecutionStopReceipt.executionId, runtime.executionId);
        }
        const config = fs.readFileSync(path.join(root, ".git", "config"));
        process.env[PROCESS_EXECUTION_SCOPE_ENV] = "not a grant";
        assert.throws(() => runGit(["config", "fixture.malformed", "forbidden"], { cwd: root }), ProcessExecutionControlFailure);
        assert.deepEqual(fs.readFileSync(path.join(root, ".git", "config")), config);
      } finally {
        if (previous === undefined) delete process.env[PROCESS_EXECUTION_SCOPE_ENV]; else process.env[PROCESS_EXECUTION_SCOPE_ENV] = previous;
      }
    } finally {
      try { await runtime?.close(); }
      catch (error) { testTemporaryRoot().retainOnUnconfirmedExecution(error); throw error; }
    }
    assert.deepEqual(fs.readdirSync(root).sort(), [".git", "visible.txt"]);
  });
});

test("generic body and closure failures retain the real stopped child receipt and ordered causes", { timeout: 120000 }, async t => {
  await fixture(t, async root => {
    const controller = new AbortController();
    const reason = new Error("caller aborted after the actual spawn");
    const closure = new Error("retention completion failed after actual coordinator close");
    let child;
    let failure;
    t.mock.method(OwnedRetainedProcessScope.prototype, "completeWorkspace", function () { throw closure; });
    try {
      await executeManagedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        cwd: root, retainedControl: true, timeoutMs: 20000, graceMs: 50, abortSignal: controller.signal,
        onSpawn(value) { child = value; controller.abort(reason); },
      });
      assert.fail("actual abort and retention failure must reject");
    } catch (error) { failure = error; }
    finally { t.mock.restoreAll(); }
    assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors, [reason, closure]);
    assert.equal(failure.cause, reason);
    assert.ok(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.ok(reason.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt);
    assert.equal(reason.processExecutionStopReceipt.stopOperation.reason, "abort");
    assert.equal(failure.processExecutionStopReceipt, reason.processExecutionStopReceipt);
    const call = await assertReadback(failure, root);
    assert.equal(call.outcome.aborted, true);
    assert.equal(call.outcome.timedOut, false);
    assert.throws(() => completeManagedOperationSync(() => { throw reason; }, () => { throw closure; }), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [reason, closure]);
      assert.equal(error.processExecutionStopReceipt, reason.processExecutionStopReceipt);
      return true;
    });
  });
});
