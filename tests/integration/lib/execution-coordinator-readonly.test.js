import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ReadOnlyInvocationWorkspace, ReadOnlyProcessRuntimeStorage } from "../../../src/lib/readonly-invocation-workspace.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess, withManagedProcessScope, withReadOnlyManagedProcessScope } from "../../../src/lib/managed-process.js";
import { runCmd, runCmdAsync } from "../../../src/lib/process.js";
import { NodeScriptInvocation } from "../../../src/lib/command-invocation.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("readonly-execution-storage-");
  const workspace = ReadOnlyInvocationWorkspace.create();
  t.after(() => {
    removeTmpDir(root);
    if (fs.existsSync(workspace.path)) fs.rmSync(workspace.path, { recursive: true, force: true });
  });
  return { root, workspace };
}

test("a read-only managed scope closes its real child and removes only its owned scratch", async (t) => {
  const root = createTmpDir("readonly-managed-scope-");
  t.after(() => removeTmpDir(root));
  let runtime;
  let workspacePath;
  const result = await withManagedProcessScope({ executionRoot: root, readOnly: true }, async (scope) => {
    runtime = scope;
    workspacePath = scope.store.storagePolicy.toJSON().workspaceRoot;
    assert.equal(ProcessExecutionRuntime.current(), scope);
    const result = await runCmdAsync(process.execPath, ["-e", "process.stdout.write('literal result')"], { cwd: root });
    assert.equal(result.ok, true);
    const inventory = scope.inspect();
    const calls = inventory.executions.flatMap(execution => execution.calls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].receipt.callId, calls[0].callId);
    assert.deepEqual(fs.readdirSync(root), []);
    return result;
  });
  assert.equal(result.stdout, "literal result");
  assert.equal(runtime.closed, true);
  assert.equal(fs.existsSync(workspacePath), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("a failed read-only callback retains its diagnostics after confirmed runtime closure", async (t) => {
  const root = createTmpDir("readonly-failed-managed-scope-");
  t.after(() => removeTmpDir(root));
  const primary = new Error("retain the original callback failure");
  let runtime;
  let workspace;
  let evidence;
  t.after(() => {
    if (workspace !== undefined && runtime?.closed && workspace.pendingExecutionCount === 0) {
      workspace.complete({ generation: workspace.generation, normalExit: true, resourcesReleased: true });
      workspace.cleanup({ generation: workspace.generation });
    }
  });
  await assert.rejects(withReadOnlyManagedProcessScope({ mainRoot: root }, async (scope, scratch) => {
    runtime = scope;
    workspace = scratch;
    evidence = path.join(scratch.logs(), "callback-failure.txt");
    scratch.writeFile(evidence, "diagnostic before failure");
    const result = await runCmdAsync(process.execPath, ["-e", ""], { cwd: root });
    assert.equal(result.ok, true);
    throw primary;
  }), error => error === primary);
  assert.equal(runtime.closed, true);
  assert.equal(workspace.pendingExecutionCount, 0);
  assert.equal(fs.readFileSync(evidence, "utf8"), "diagnostic before failure");
  assert.deepEqual(fs.readdirSync(root), []);
});

test("read-only storage retains true checkout identity while async and synchronous children write only to owned invocation scratch", async (t) => {
  const { root, workspace } = fixture(t);
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, workspace,
    environment: { ...process.env, SENNEL_PROCESS_EXECUTION_SCOPE: "not an inherited authority" } });
  assert.equal(workspace.pendingExecutionCount, 1);
  try {
    const results = await runtime.enter(async () => {
      const asynchronous = await executeManagedProcess(process.execPath, ["-e", "process.stdout.write('async')"], { runtime, timeoutMs: 10000 });
      const synchronous = runCmd(process.execPath, ["-e", "process.stdout.write('sync')"], { cwd: root });
      assert.equal(synchronous.ok, true, synchronous.stderr);
      const delegated = await executeManagedProcess(new NodeScriptInvocation({
        script: fileURLToPath(new URL("../../../src/sennel.js", import.meta.url)),
        args: ["command", "--", process.execPath, "-e", "process.stdout.write('inherited');process.exitCode=7"], cwd: root,
      }), [], { runtime, timeoutMs: 30000 });
      assert.equal(delegated.code, 7, delegated.stderr);
      assert.equal(delegated.stderr, "");
      return [asynchronous, synchronous, delegated];
    });
    assert.deepEqual(results.map((result) => result.stdout), ["async", "sync", "inherited"]);
    const inventory = runtime.inspect();
    assert.equal(inventory.checkout.mainRoot, root);
    assert.equal(inventory.checkout.executionRoot, root);
    assert.equal(inventory.executions[0].calls.length, 4);
    const delegated = inventory.executions[0].calls.at(-1);
    assert.equal(delegated.parentCallId, inventory.executions[0].calls.at(-2).callId);
    assert.equal(inventory.executions[0].calls.every((call) => call.receipt.checkoutIdentity.executionRoot === root), true);
    assert.equal(runtime.store.authority.directory.startsWith(workspace.path + path.sep), true);
    assert.deepEqual(fs.readdirSync(root), []);
    const policy = workspace.processRuntimeStorage();
    assert.throws(() => new ReadOnlyProcessRuntimeStorage(null, {}), /minted/);
    assert.throws(() => ReadOnlyProcessRuntimeStorage.fromGrant({ ...policy.toJSON(), workspaceGeneration: randomUUID() }), /differs from its minted authority/);
    assert.deepEqual(ReadOnlyProcessRuntimeStorage.fromGrant(policy.toJSON()).toJSON(), policy.toJSON());
  } finally { await runtime.close(); }
  assert.equal(workspace.pendingExecutionCount, 0);
  assert.deepEqual(fs.readdirSync(root), []);
  workspace.complete({ generation: workspace.generation, normalExit: true, resourcesReleased: true });
  workspace.cleanup({ generation: workspace.generation });
  assert.equal(fs.existsSync(workspace.path), false);
});

test("crashed read-only owner retains pending scratch evidence and refuses replacement instead of writing checkout state", async (t) => {
  const { root, workspace } = fixture(t);
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, workspace });
  const exited = once(runtime.control.child, "exit");
  runtime.control.child.ref(); runtime.control.child.kill();
  await exited;
  const before = fs.readFileSync(runtime.store.file.filePath);
  await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: root, workspace }), { code: "PROCESS_EXECUTION_BUSY" });
  assert.deepEqual(fs.readFileSync(runtime.store.file.filePath), before);
  assert.equal(workspace.pendingExecutionCount > 0, true);
  assert.throws(() => workspace.complete({ generation: workspace.generation, normalExit: true, resourcesReleased: true }), /unconfirmed execution evidence/);
  assert.throws(() => workspace.cleanup({ generation: workspace.generation }), /must be confirmed/);
  assert.deepEqual(fs.readdirSync(root), []);
});
