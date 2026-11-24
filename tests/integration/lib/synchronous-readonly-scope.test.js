import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import threads from "node:worker_threads";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionGrant, PROCESS_EXECUTION_SCOPE_ENV } from "../../../src/lib/process-execution-runtime.js";
import { withReadOnlyManagedProcessScope, withReadOnlyManagedProcessScopeSync } from "../../../src/lib/managed-process.js";
import { acquireReadOnlyExecutionGrantSync, releaseReadOnlyExecutionGrantSync, closeSynchronousExecutionBridge } from "../../../src/lib/process-execution-sync.js";
import { WorkerArtifactRepositoryMutationSnapshot } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { runManagedCmdAsync } from "../../../src/lib/process.js";
import { GitRepositoryPolicy } from "../../../src/lib/git-repository-environment.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { testTemporaryRoot } from "../../test-environment.js";

let unexpectedFailure = null;
function quarantine(cause) {
  unexpectedFailure ??= cause;
  // A failed test may not let the product's automatic exit teardown revisit an
  // unconfirmed lease. Explicit mandatory completion already in flight continues.
  process.removeListener("beforeExit", closeSynchronousExecutionBridge);
  testTemporaryRoot().retainOnUnconfirmedExecution();
}

function scopeTest(name, body) {
  test(name, { timeout: 60000 }, async (t) => {
    if (unexpectedFailure !== null) throw new Error("A previous read-only scope failure is retained", { cause: unexpectedFailure });
    const root = createTmpDir("synchronous-readonly-");
    const started = performance.now();
    let active = true; let complete = false;
    const guard = () => {
      if (!active || t.signal.aborted || performance.now() - started > 60000) throw new Error("Read-only scope test is no longer active");
    };
    t.after(() => {
      active = false;
      if (!complete) { quarantine(new Error("Read-only scope body did not complete its assertions")); return; }
      try { closeSynchronousExecutionBridge(); removeTmpDir(root); }
      catch (cause) { quarantine(cause); throw cause; }
    });
    try { await body(t, root, guard); guard(); complete = true; }
    catch (cause) { quarantine(cause); throw cause; }
  });
}

function repository(root) {
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "source.txt"), "source before\n");
  commitAll(root, "scope baseline");
}

function git(root, ...args) {
  return runGit(args, { cwd: root, timeout: 10000,
    gitPolicy: new GitRepositoryPolicy({ repositoryRoot: root, readOnly: true }) });
}

scopeTest("shared read-only lifecycle confirms actual owner exit and current synchronous reuse", async (t, root, guard) => {
  repository(root);
  let child; let workspace; let ownerReleased = false;
  await withReadOnlyManagedProcessScope({ mainRoot: root }, (runtime, owned) => {
    guard(); child = runtime.control.child; workspace = owned;
    const close = runtime.close.bind(runtime);
    t.mock.method(runtime, "close", async () => {
      await close(); guard();
      assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
      assert.equal(runtime.store.ownerLock.inspect(), null);
      ownerReleased = true;
    });
    const result = withReadOnlyManagedProcessScopeSync({ mainRoot: root }, (nested) => {
      assert.equal(nested, runtime); return git(root, "status", "--porcelain=v2");
    });
    assert.equal(result.ok, true, result.stderr);
    assert.throws(() => withReadOnlyManagedProcessScopeSync({ mainRoot: root }, () => Promise.resolve()), TypeError);
    assert.equal(runtime.closed, false);
    assert.equal(git(root, "rev-parse", "--show-toplevel").stdout.trim(), root);
  });
  guard();
  assert.equal(ownerReleased, true);
  assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
  assert.equal(fs.existsSync(workspace.path), false);
});

scopeTest("synchronous read-only unit shares exact Git receipts and releases its workspace", (_t, root, guard) => {
  repository(root);
  const index = fs.readFileSync(path.join(root, ".git", "index"));
  const config = fs.readFileSync(path.join(root, ".git", "config"));
  const names = fs.readdirSync(root).sort();
  let view; let grant;
  const returned = withReadOnlyManagedProcessScopeSync({ mainRoot: root }, (runtime) => {
    guard(); view = runtime; grant = runtime.remoteGrant();
    assert.equal(withReadOnlyManagedProcessScopeSync({ mainRoot: root }, (nested) => nested), runtime);
    assert.equal(runtime.closed, false);
    const first = git(root, "status", "--porcelain=v2");
    const second = git(root, "rev-parse", "--show-toplevel");
    for (const result of [first, second]) {
      assert.equal(result.ok, true, result.stderr);
      assert.equal(result.processExecutionStopReceipt.executionId, runtime.executionId);
    }
    assert.notEqual(first.processExecutionStopReceipt.callId, second.processExecutionStopReceipt.callId);
    const receipts = runtime.stopReceipts();
    assert.deepEqual(receipts.map((receipt) => receipt.callId).sort(),
      [first.processExecutionStopReceipt.callId, second.processExecutionStopReceipt.callId].sort());
    return second.stdout.trim();
  });
  guard();
  assert.equal(returned, root); assert.equal(view.closed, true);
  assert.equal(ProcessExecutionRuntime.current(), null);
  assert.equal(fs.existsSync(grant.storage.workspaceRoot), false);
  assert.deepEqual(fs.readdirSync(root).sort(), names);
  assert.deepEqual(fs.readFileSync(path.join(root, ".git", "index")), index);
  assert.deepEqual(fs.readFileSync(path.join(root, ".git", "config")), config);
  assert.equal(fs.readFileSync(path.join(root, "source.txt"), "utf8"), "source before\n");
});

scopeTest("synchronous failed bodies and thenables retain diagnostics after mandatory disposal", (_t, root, guard) => {
  for (const thenable of [false, true]) {
    const primary = new Error("body failed before completion");
    let runtime; let grant;
    assert.throws(() => withReadOnlyManagedProcessScopeSync({ mainRoot: root }, (view) => {
      guard(); runtime = view; grant = view.remoteGrant();
      if (thenable) return Promise.resolve("not synchronous");
      throw primary;
    }), thenable ? TypeError : (error) => error === primary);
    guard();
    assert.equal(runtime.closed, true);
    assert.equal(fs.lstatSync(grant.storage.workspaceRoot).isDirectory(), true);
  }
});

scopeTest("inherited synchronous read-only views preserve the existing execution owner", async (_t, root, guard) => {
  const entry = fileURLToPath(new URL("../../../src/sennel.js", import.meta.url));
  const managed = pathToFileURL(fileURLToPath(new URL("../../../src/lib/managed-process.js", import.meta.url))).href;
  const runtimeModule = pathToFileURL(fileURLToPath(new URL("../../../src/lib/process-execution-runtime.js", import.meta.url))).href;
  await withReadOnlyManagedProcessScope({ mainRoot: root }, async (owner) => {
    guard();
    const script = `
      import assert from 'node:assert/strict';
      import { withReadOnlyManagedProcessScopeSync } from ${JSON.stringify(managed)};
      import { ProcessExecutionRuntime, PROCESS_EXECUTION_SCOPE_ENV } from ${JSON.stringify(runtimeModule)};
      const grant = JSON.parse(process.env[PROCESS_EXECUTION_SCOPE_ENV]);
      assert.equal(ProcessExecutionRuntime.current(), null);
      let client;
      const id = withReadOnlyManagedProcessScopeSync({ mainRoot: grant.mainRoot }, (view) => {
        client = view; assert.equal(view.borrowed, true); return view.executionId;
      });
      assert.equal(client.closed, true);
      assert.throws(() => withReadOnlyManagedProcessScopeSync({ mainRoot: grant.mainRoot }, () => Promise.resolve()), TypeError);
      assert.equal(id, grant.executionId);
      process.stdout.write(JSON.stringify({ executionId: id, callId: grant.callId }));
    `;
    const result = await runManagedCmdAsync(process.execPath, ["--import", entry, "--input-type=module", "-e", script],
      { cwd: root, timeout: 30000 });
    guard();
    assert.equal(result.ok, true, result.stderr);
    assert.equal(JSON.parse(result.stdout).executionId, owner.executionId);
    assert.equal(owner.closed, false);
  });
  guard();
});

scopeTest("filesystem-only source capture creates no execution bridge worker", (t, root, guard) => {
  fs.writeFileSync(path.join(root, "source.txt"), "filesystem only\n");
  t.mock.method(threads, "Worker", class extends threads.Worker {
    constructor() { throw new Error("Filesystem-only capture must not start an execution worker"); }
  });
  syncBuiltinESMExports();
  try {
    const snapshot = WorkerArtifactRepositoryMutationSnapshot.capture({ root, authorities: ["execution"] });
    guard();
    assert.equal(snapshot.mode, "filesystem");
    assert.deepEqual(snapshot.entries.map((entry) => entry.path), ["source.txt"]);
    assert.deepEqual(fs.readdirSync(root), ["source.txt"]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

scopeTest("read-only lease release refuses another grant before closing the actual owner", (_t, root, guard) => {
  const grant = acquireReadOnlyExecutionGrantSync({ mainRoot: root, executionRoot: root, environment: process.env });
  assert.throws(() => releaseReadOnlyExecutionGrantSync({ ...grant, ownerToken: crypto.randomUUID() }, { successful: true }),
    { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
  guard();
  releaseReadOnlyExecutionGrantSync(grant, { successful: true });
  guard();
  assert.equal(fs.existsSync(grant.storage.workspaceRoot), false);
});

// Observe an actual private port result before hiding it from the caller. The
// test retains that exact minted capability for lawful controlled-fault teardown;
// product code receives no replacement grant and performs no reconstruction.
class ScopeReplyDrop {
  constructor(t, operation) {
    this.dropped = false;
    this.grant = null;
    this.reply = null;
    this.operations = [];
    const requests = new Map();
    const post = threads.MessagePort.prototype.postMessage;
    const receive = threads.receiveMessageOnPort;
    const observer = this;
    t.mock.method(threads.MessagePort.prototype, "postMessage", function (message, ...args) {
      if (message?.operation !== undefined) {
        requests.set(message.requestId, message.operation);
        observer.operations.push(message.operation);
        if (message.operation === "release-read-only-scope") observer.grant = message.data.grant;
      }
      return post.call(this, message, ...args);
    });
    t.mock.method(threads, "receiveMessageOnPort", (port) => {
      const received = receive(port);
      if (!this.dropped && received && requests.get(received.message.requestId) === operation) {
        this.reply = received.message;
        if (operation === "read-only-scope") this.grant = received.message.result;
        this.dropped = true;
        return undefined;
      }
      return received;
    });
    this.restore = () => { t.mock.restoreAll(); syncBuiltinESMExports(); };
    syncBuiltinESMExports();
  }
}

scopeTest("lost acquisition reply refuses the callback without reconstructing a lease", (t, root, guard) => {
  const observer = new ScopeReplyDrop(t, "read-only-scope");
  let called = false;
  try {
    assert.throws(() => withReadOnlyManagedProcessScopeSync({ mainRoot: root }, () => { called = true; }),
      { code: "PROCESS_EXECUTION_BRIDGE_RESPONSE_INVALID" });
    guard();
    assert.equal(observer.dropped, true);
    assert.equal(observer.reply.error, undefined);
    assert.equal(new ProcessExecutionGrant(observer.reply.result).executionId, observer.grant.executionId);
    assert.equal(called, false);
    assert.equal(observer.operations.includes("release-read-only-scope"), false);
  } finally { observer.restore(); }
  // The fixture observed this original grant at the transport boundary. It does
  // not reacquire by root/PID, invent a grant, or turn the caller's refusal into success.
  assert.notEqual(observer.grant, null);
  releaseReadOnlyExecutionGrantSync(observer.grant, { successful: false });
  guard();
  assert.equal(fs.lstatSync(observer.grant.storage.workspaceRoot).isDirectory(), true);
});

scopeTest("lost release reply remains a failure after locally completed owner closure", (t, root, guard) => {
  const observer = new ScopeReplyDrop(t, "release-read-only-scope");
  let view;
  try {
    assert.throws(() => withReadOnlyManagedProcessScopeSync({ mainRoot: root }, (runtime) => { view = runtime; return "body succeeded"; }),
      { code: "PROCESS_EXECUTION_BRIDGE_RESPONSE_INVALID" });
    guard();
    assert.equal(observer.dropped, true);
    assert.equal(observer.reply.error, undefined);
    assert.equal(observer.reply.result, null);
    assert.equal(view.closed, true);
  } finally { observer.restore(); }
  assert.notEqual(observer.grant, null);
  assert.equal(fs.existsSync(observer.grant.storage.workspaceRoot), false);
});

import { CommandExecution } from "../../../src/lib/process.js";
import { GitCommandExecution } from "../../../src/lib/git-command-execution.js";

scopeTest("synchronous command group captures independent inputs and all native receipts before shared scope release", (_t, root, guard) => {
  const source = `const fs=require('node:fs'),path=require('node:path');
    const root=process.argv[1],id=process.argv[2];let input='';
    process.stdin.setEncoding('utf8');process.stdin.on('data',part=>input+=part);
    process.stdin.on('end',()=>{fs.writeFileSync(path.join(root,'ready-'+id),'started');
      let watcher,finished=false;const complete=()=>{
        if(finished||!fs.existsSync(path.join(root,'ready-a'))||!fs.existsSync(path.join(root,'ready-b')))return false;
        finished=true;watcher?.close();process.stdout.write(JSON.stringify({id,input,environment:process.env.SENNEL_GROUP_ENV}));return true;
      };if(!complete()){watcher=fs.watch(root,complete);complete();}
    });`;
  let reloaded, executionId;
  const results = withReadOnlyManagedProcessScopeSync({ mainRoot: root }, (runtime) => {
    guard(); executionId = runtime.executionId;
    const commands = [
      new CommandExecution(process.execPath, ["-e", source, root, "a"], { cwd: root, input: Buffer.from("first € input"), encoding: "buffer", timeout: 10000,
        env: { ...process.env, SENNEL_GROUP_ENV: "explicit-a" } }),
      new CommandExecution(process.execPath, ["-e", source, root, "b"], { cwd: root, input: Buffer.from("second ☃ input"), encoding: "utf8", timeout: 10000,
        env: { ...process.env, SENNEL_GROUP_ENV: "explicit-b" } }),
      new GitCommandExecution(["--version"], { cwd: root, timeout: 10000,
        gitPolicy: new GitRepositoryPolicy({ repositoryRoot: root, readOnly: true }) }),
    ];
    assert.equal(commands[2] instanceof CommandExecution, true);
    const returned = GitCommandExecution.runTogether(commands);
    guard(); reloaded = runtime.inspect();
    return returned;
  });
  guard(); assert.equal(results.length, 3);
  assert.equal(results.every((result) => result.ok && result.processExecutionStopReceipt.stopEvidence.status === "confirmed"), true);
  assert.equal(Buffer.isBuffer(results[0].stdout), true); assert.equal(typeof results[1].stdout, "string");
  assert.deepEqual(JSON.parse(results[0].stdout.toString("utf8")), { id: "a", input: "first € input", environment: "explicit-a" });
  assert.deepEqual(JSON.parse(results[1].stdout), { id: "b", input: "second ☃ input", environment: "explicit-b" });
  assert.match(results[2].stdout, /^git version /);
  const receipts = results.map((result) => result.processExecutionStopReceipt);
  assert.equal(receipts.every((receipt) => receipt.executionId === executionId && receipt.observation.kind === "exited" && receipt.observation.code === 0), true);
  assert.equal(new Set(receipts.map((receipt) => receipt.callId)).size, 3);
  assert.equal(new Set(receipts.map((receipt) => receipt.executor.executorId)).size, 3);
  const stored = reloaded.executions.find((execution) => execution.executionId === executionId);
  assert.equal(stored.calls.length, 3);
  for (const receipt of receipts) assert.deepEqual(stored.calls.find((call) => call.callId === receipt.callId).receipt, receipt.toJSON());
  assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
});

scopeTest("synchronous command group preserves prelaunch refusal, bounded-output failure and nonzero native completion independently", (_t, root, guard) => {
  const abort = new AbortController(); abort.abort();
  const forbidden = path.join(root, "must-not-execute");
  let reloaded;
  const results = withReadOnlyManagedProcessScopeSync({ mainRoot: root }, (runtime) => {
    guard();
    const returned = CommandExecution.runTogether([
      new CommandExecution(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'forbidden')`],
        { cwd: root, signal: abort.signal, timeout: 10000 }),
      new CommandExecution(process.execPath, ["-e", "process.stdout.write('bounded-output')"],
        { cwd: root, encoding: "buffer", maxBuffer: 5, timeout: 10000 }),
      new CommandExecution(process.execPath, ["-e", "process.stdout.write('retained-nonzero');process.exitCode=7"],
        { cwd: root, encoding: "utf8", timeout: 10000 }),
    ]);
    guard(); reloaded = runtime.inspect(); return returned;
  });
  guard(); assert.equal(results.length, 3);
  assert.equal(results[0].ok, false); assert.equal(results[0].errorCode, "ABORT_ERR");
  assert.equal(Object.hasOwn(results[0], "processExecutionStopReceipt"), false);
  assert.equal(fs.existsSync(forbidden), false);
  assert.equal(results[1].ok, false); assert.equal(results[1].errorCode, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  assert.equal(results[1].stdout.toString("utf8"), "bound");
  assert.equal(results[1].processExecutionStopReceipt.stopEvidence.status, "confirmed");
  assert.equal(results[2].ok, false); assert.equal(results[2].status, 7); assert.equal(results[2].stdout, "retained-nonzero");
  assert.equal(results[2].processExecutionStopReceipt.observation.code, 7);
  assert.equal(results[2].processExecutionStopReceipt.stopEvidence.status, "confirmed");
  const stored = reloaded.executions.find((entry) => entry.executionId === results[1].processExecutionStopReceipt.executionId);
  assert.equal(stored.calls.length, 2);
  for (const result of results.slice(1)) assert.deepEqual(stored.calls.find((call) => call.callId === result.processExecutionStopReceipt.callId).receipt,
    result.processExecutionStopReceipt.toJSON());
});

scopeTest("unscoped command group retains each original owning lifetime and its successful or failed result", (_t, root, guard) => {
  guard(); assert.equal(ProcessExecutionRuntime.current(), null);
  const results = CommandExecution.runTogether([
    new CommandExecution(process.execPath, ["-e", "process.stdout.write(process.env.SENNEL_GROUP_ENV);process.exitCode=9"],
      { cwd: root, repositoryRoot: root, readOnly: true, timeout: 10000, env: { ...process.env, SENNEL_GROUP_ENV: "first" } }),
    new CommandExecution(process.execPath, ["-e", "process.stdout.write(process.env.SENNEL_GROUP_ENV)"],
      { cwd: root, repositoryRoot: root, readOnly: true, timeout: 10000, env: { ...process.env, SENNEL_GROUP_ENV: "second" } }),
  ]);
  guard(); assert.equal(results.length, 2);
  assert.equal(results[0].ok, false); assert.equal(results[0].status, 9); assert.equal(results[0].stdout, "first");
  assert.equal(results[1].ok, true); assert.equal(results[1].stdout, "second");
  assert.equal(results.every((result) => result.processExecutionStopReceipt.stopEvidence.status === "confirmed"), true);
  assert.notEqual(results[0].processExecutionStopReceipt.executionId, results[1].processExecutionStopReceipt.executionId);
  assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
});

import { CommandExecutionBatchFailure } from "../../../src/lib/process.js";
import { ProcessExecutionCanonicalAcknowledgement as GroupCanonicalAcknowledgement,
  ProcessExecutionStopReceipt as GroupStopReceipt, ProcessExecutionControlFailure as GroupControlFailure } from "../../../src/lib/process-execution-values.js";

scopeTest("synchronous command group retains every native completion when canonical publication fails and resumes without reexecution", async (_t, root, guard) => {
  const primary = new Error("injected canonical group writer failure");
  const log = path.join(root, "canonical-events.jsonl");
  let refuse = true, failure, stored;
  await withReadOnlyManagedProcessScope({ mainRoot: root }, async (runtime) => {
    await runtime.withBinding({ purpose: "group-publication-failure" }, () => {
      guard(); const scoped = ProcessExecutionRuntime.current();
      const commands = [0, 1].map((index) => new CommandExecution(process.execPath, ["-e",
        `require('node:fs').appendFileSync(${JSON.stringify(path.join(root, `effect-${index}`))},'effect\\n');process.stdout.write('${index}')`],
      { cwd: root, timeout: 10000 }));
      try { CommandExecution.runTogether(commands); }
      catch (error) { failure = error; }
      guard(); assert.equal(failure instanceof CommandExecutionBatchFailure, true);
      assert.equal(failure.errors.length, 1);
      assert.equal(failure.errors[0] instanceof GroupControlFailure, true);
      assert.equal(failure.errors[0].code, "PROCESS_EXECUTION_ACTIVITY_PENDING");
      assert.equal(failure.errors[0].cause, primary);
      assert.equal(Object.hasOwn(failure, "processExecutionStopReceipt"), false);
      assert.equal(failure.outcomes.length, 2); assert.deepEqual(failure.outcomeIndices, [0, 1]);
      const control = failure.controlFailure();
      assert.equal(control instanceof GroupControlFailure, true);
      assert.equal(control.code, failure.errors[0].code);
      assert.equal(control.executionId, failure.errors[0].executionId); assert.equal(control.callId, failure.errors[0].callId);
      assert.deepEqual(control.primaryCause, failure.errors[0].primaryCause);
      assert.equal(control.cause, failure);
      assert.equal(Object.hasOwn(control, "processExecutionStopReceipt"), false);
      const completions = failure.outcomes.map((outcome) => outcome.unwrap());
      const receipts = completions.map((completion) => new GroupStopReceipt(completion.processExecutionStopReceipt));
      assert.deepEqual(completions.map((completion) => Buffer.from(completion.stdout).toString("utf8")), ["0", "1"]);
      assert.equal(receipts.every((receipt) => receipt.observation.code === 0 && receipt.stopEvidence.status === "confirmed"), true);
      stored = runtime.inspect().executions.find((execution) => execution.executionId === runtime.executionId);
      assert.equal(stored.calls.length, 2); assert.equal(stored.eventAcknowledgements.length, 0);
      assert.equal(stored.events.length, 8); assert.equal(fs.existsSync(log), false);
      for (const receipt of receipts) assert.deepEqual(stored.calls.find((call) => call.callId === receipt.callId).receipt, receipt.toJSON());
      refuse = false;
      scoped.drainEventsSync();
      const resumed = runtime.inspect().executions.find((execution) => execution.executionId === runtime.executionId);
      assert.equal(resumed.eventAcknowledgements.length, 8); assert.equal(resumed.calls.length, 2);
      const publications = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(publications.length, 8); assert.equal(new Set(publications.map((event) => event.eventId)).size, 8);
      for (let index = 0; index < 2; index++) assert.equal(fs.readFileSync(path.join(root, `effect-${index}`), "utf8"), "effect\n");
    }, { eventWriter(event) {
      if (refuse) throw primary;
      fs.appendFileSync(log, `${JSON.stringify(event.toJSON())}\n`);
      return GroupCanonicalAcknowledgement.fromEvent(event);
    } });
  });
  guard(); assert.equal(stored.calls.every((call) => call.receipt !== null), true);
});
