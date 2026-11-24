import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionControlFailure, executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { managedRequest } from "../../../src/lib/managed-process-protocol.js";
import { ManagedControlPolicy } from "../../../src/lib/managed-control-policy.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../../test-environment.js";

async function stopOwned(child) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  child.ref();
  const exited = once(child, "exit", { signal: AbortSignal.timeout(new ManagedControlPolicy().budgetMs) });
  child.kill("SIGKILL");
  await exited;
}

// Fault only external socket/filesystem delivery. Registry admission, the actual
// ChildProcess, output, deadlines, and receipt publication stay in production.
async function fixture(t, mode) {
  const root = createTmpDir("managed-control-execution-");
  const observed = path.join(root, "output-observed");
  const audit = path.join(root, "reply-audit.jsonl");
  const preload = `
    import net from 'node:net'; import fs from 'node:fs'; import path from 'node:path';
    const mode=${JSON.stringify(mode)}, observed=${JSON.stringify(observed)}, audit=${JSON.stringify(audit)};
    const originalEnd=net.Socket.prototype.end;
    let delayed=false;
    net.Socket.prototype.end=function(bytes,...args){
      let message;try{message=JSON.parse(String(bytes).trim())}catch{return originalEnd.call(this,bytes,...args)}
      const operation=message.operation;
      if((mode==='lost-claim'&&operation==='reserve-and-claim')||(mode==='lost-stop'&&operation==='begin-stop')||(mode==='lost-control'&&operation==='read-control')){
        fs.appendFileSync(audit,JSON.stringify({operation,requestId:message.requestId,payloadDigest:message.payloadDigest,launchCallId:message.payload?.value?.callId??null,permitCallId:message.payload?.value?.permit?.callId??null})+'\\n');
        this.destroy();return this;
      }
      if(mode==='delayed-control'&&operation==='read-control'&&!delayed){
        delayed=true;const socket=this;
        fs.appendFileSync(audit,JSON.stringify({operation,containsOutput:[message.payload?.value,message.payload?.value?.control].some(value=>value&&typeof value==='object'&&('stdout'in value||'stderr'in value))})+'\\n');
        const deliver=()=>{if(!fs.existsSync(observed))return;watcher.close();originalEnd.call(socket,bytes,...args)};
        const watcher=fs.watch(path.dirname(observed),deliver);socket.once('close',()=>watcher.close());deliver();return this;
      }
      return originalEnd.call(this,bytes,...args);
    };
    if(mode==='lost-control'){
      const read=fs.readdirSync;
      fs.readdirSync=function(directory,options){
        const entries=read.call(this,directory,options);
        if(path.basename(String(directory))!=='requests')return entries;
        return entries.filter(entry=>{try{return JSON.parse(fs.readFileSync(path.join(String(directory),typeof entry==='string'?entry:entry.name),'utf8')).operation!=='read-control'}catch{return true}});
      };
    }
  `;
  let runtime = null, child = null, unknown = false;
  t.after(async () => {
    if (!unknown) {
      try { await runtime?.close(); }
      catch (error) { unknown = true; testTemporaryRoot().retainOnUnconfirmedExecution(); await stopOwned(child); await stopOwned(runtime?.control?.child ?? null); throw error; }
      removeTmpDir(root);
      return;
    }
    testTemporaryRoot().retainOnUnconfirmedExecution();
    await stopOwned(child);
    await stopOwned(runtime?.control?.child ?? null);
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: {
    ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`.trim(),
  } });
  return { root, runtime, observed,
    onSpawn(value) { child = value; },
    retain() { unknown = true; testTemporaryRoot().retainOnUnconfirmedExecution(); },
    audit() { return fs.existsSync(audit) ? fs.readFileSync(audit, "utf8").trim().split("\n").map(JSON.parse) : []; },
  };
}

test("lost launch reply replays one permit and never duplicates a real provider effect", async (t) => {
  const scope = await fixture(t, "lost-claim");
  const result = await scope.runtime.enter(() => executeManagedProcess(process.execPath, ["-e",
    "require('node:fs').appendFileSync('effects','one\\n');process.stdout.write('worker-output')"],
  { cwd: scope.root, timeoutMs: 20000, onSpawn: scope.onSpawn }));
  assert.equal(result.stdout, "worker-output");
  assert.equal(fs.readFileSync(path.join(scope.root, "effects"), "utf8"), "one\n");
  const root = scope.runtime.store.read().executions.at(-1);
  assert.equal(root.calls.length, 1);
  const request = root.requests.filter((entry) => entry.operation === "reserve-and-claim");
  assert.equal(request.length, 1);
  const original = root.calls[0];
  const grant = scope.runtime.remoteGrant();
  const payload = { grant, data: { binding: original.binding.toJSON(), invocation: original.invocation,
    timeoutMs: original.timeoutMs, graceMs: original.graceMs, executor: original.executor.toJSON() } };
  assert.equal(executionValueDigest(payload), request[0].payloadDigest, "replay must use the exact original captured reservation, not reconstructed launch authority");
  const replay = await managedRequest(grant, "reserve-and-claim", payload, { requestId: request[0].requestId });
  assert.deepEqual(replay, request[0].response);
  assert.equal(scope.runtime.inspect().executions.at(-1).calls.length, 1);
  assert.equal(result.processExecutionStopReceipt.observation.kind, "exited");
  const replies = scope.audit();
  assert.ok(replies.length > 0, "the fault must actually drop a launch response");
  assert.ok(replies.every((entry) => entry.requestId === request[0].requestId));
  assert.ok(replies.every((entry) => entry.launchCallId === original.callId && entry.permitCallId === original.callId));
});

test("exhausted control delivery preserves all response slots and explicit unknown without a replacement spawn", async (t) => {
  const scope = await fixture(t, "lost-control");
  scope.retain();
  let original;
  await assert.rejects(scope.runtime.enter(() => executeManagedProcess(process.execPath, ["-e",
    "require('node:fs').appendFileSync('effects','one\\n');process.stdout.write('worker-output');setInterval(()=>{},1000)"],
  { cwd: scope.root, timeoutMs: 30000, onSpawn: scope.onSpawn })), (error) => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.equal(error.code, "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE");
    assert.equal(error.communication.operation, "read-control");
    assert.equal(error.communication.cutoff, "budget-exhausted");
    assert.deepEqual(error.communication.attempts.map((attempt) => attempt.responseDeadlineMs), [2000, 6000, 14000]);
    assert.equal(error.communication.stopConfirmation, "unknown");
    original = error;
    return true;
  });
  const inventory = ProcessExecutionRuntime.inspect({ mainRoot: scope.root });
  const call = inventory.executions.at(-1).calls[0];
  assert.equal(inventory.slot, scope.runtime.executionId);
  assert.equal(call.receipt, null);
  assert.deepEqual(call.controlFailure, original.toJSON());
  assert.equal(fs.readFileSync(path.join(scope.root, "effects"), "utf8"), "one\n");
  await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: scope.root, environment: {} }), { code: "PROCESS_EXECUTION_BUSY" });
});

test("lost stop reply keeps the original abort and durable first stop decision", async (t) => {
  const scope = await fixture(t, "lost-stop");
  const abort = new AbortController();
  await assert.rejects(scope.runtime.enter(() => executeManagedProcess(process.execPath, ["-e",
    "require('node:fs').appendFileSync('effects','one\\n');process.stdout.write('ready');setInterval(()=>{},1000)"],
  { cwd: scope.root, timeoutMs: 20000, graceMs: 100, onSpawn: scope.onSpawn,
    abortSignal: abort.signal, onStdout() { abort.abort(new Error("requested abort")); } })), (error) => {
    assert.equal(error.code, "ABORT_ERR");
    assert.equal(error.message, "requested abort");
    assert.equal(error.stopEvidence.confirmed, true);
    assert.equal(error.processExecutionStopReceipt.stopOperation.reason, "abort");
    return true;
  });
  const root = scope.runtime.store.read().executions.at(-1);
  assert.equal(root.calls.length, 1);
  assert.equal(root.calls[0].controlFailure, null);
  assert.equal(root.requests.filter((entry) => entry.operation === "begin-stop").length, 1);
  assert.equal(fs.readFileSync(path.join(scope.root, "effects"), "utf8"), "one\n");
});

test("a delayed older control reply cannot repeat directly observed stdout stderr or activity", async (t) => {
  const scope = await fixture(t, "delayed-control");
  const stdout = [], stderr = [];
  let observations = 0;
  const result = await scope.runtime.enter(() => executeManagedProcess(process.execPath, ["-e",
    "process.stdout.write('worker-output');process.stderr.write('worker-error')"], {
    cwd: scope.root, timeoutMs: 20000, onSpawn: scope.onSpawn,
    activityMonitor: { start() {}, stop() {}, observeOutput() { observations++; } },
    onStdout(text) { stdout.push(text); fs.writeFileSync(scope.observed, "observed"); },
    onStderr(text) { stderr.push(text); },
  }));
  assert.equal(result.stdout, "worker-output");
  assert.equal(result.stderr, "worker-error");
  assert.deepEqual(stdout, ["worker-output"]);
  assert.deepEqual(stderr, ["worker-error"]);
  assert.equal(observations, 2);
  assert.deepEqual(scope.audit(), [{ operation: "read-control", containsOutput: false }]);
  assert.equal(result.processExecutionStopReceipt.observation.kind, "exited");
});
