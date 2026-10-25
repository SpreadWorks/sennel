import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { ProcessExecutionRuntime, ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { runCmd, runCmdAsync } from "../../../src/lib/process.js";
import { AgentTimeoutError } from "../../../src/lib/process-supervisor.js";
import { DEFAULT_REGISTERED_CHILD_GRACE_MS } from "../../../src/lib/agent-timeout.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

async function fixture(t) {
  const root = createTmpDir("registered-execution-");
  const binding = { runId: "registered-run", specId: "registered-spec", nodeId: "task-impl", attemptId: "immutable-origin" };
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root,
    runId: binding.runId, specId: binding.specId, binding, environment: {} });
  t.after(async () => {
    try { await runtime.close(); }
    finally { removeQuiescentRuntimeFixture({ mainRoot: root }); }
  });
  return { root, runtime, binding };
}

test("literal argv survives reservation, actual spawn, stop receipt and reconstructed inventory", async (t) => {
  const { runtime, root, binding } = await fixture(t);
  const args = ["", "two words", "a\"b'c", "a\\b", "日本語", "$name", "%PATH%", "`literal`"];
  const result = await runtime.enter(() => executeManagedProcess(process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args], { timeoutMs: 5000 }));
  assert.deepEqual(JSON.parse(result.stdout), args);
  const receipt = result.processExecutionStopReceipt;
  assert.ok(receipt instanceof ProcessExecutionStopReceipt);
  assert.equal(receipt.scope, "registered-executions");
  assert.equal(receipt.observation.kind, "exited");
  assert.equal(receipt.observation.code, 0);
  assert.equal(receipt.output.completion, "complete");
  assert.deepEqual(receipt.binding.toJSON(), binding);
  assert.equal(receipt.toJSON().pgid, undefined);
  assert.equal(receipt.toJSON().launcherIdentity, undefined);
  await runtime.close();
  const inventory = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root, executionRoot: root }).inventory;
  const call = inventory.executions.flatMap((execution) => execution.calls).find((entry) => entry.callId === receipt.callId);
  assert.deepEqual(new ProcessExecutionStopReceipt(call.receipt).toJSON(), receipt.toJSON());
});

test("nonzero exit remains an ordinary command result with durable termination proof", async (t) => {
  const { runtime } = await fixture(t);
  const result = await runtime.enter(() => runCmdAsync(process.execPath,
    ["-e", "process.stderr.write('expected failure');process.exitCode=7"]));
  assert.equal(result.ok, false);
  assert.equal(result.status, 7);
  assert.equal(result.stderr, "expected failure");
  assert.equal(result.processExecutionStopReceipt.observation.code, 7);
});

test("a failed spawn is recorded separately from a running child exit", async (t) => {
  const { runtime, root } = await fixture(t);
  let failure;
  try { await runtime.enter(() => executeManagedProcess(path.join(root, "missing-executable"), [], { timeoutMs: 5000 })); }
  catch (error) { failure = error; }
  assert.equal(failure.code, "ENOENT");
  assert.equal(failure.providerStarted, false);
  assert.equal(failure.processExecutionStopReceipt.observation.kind, "spawn-failed");
  assert.equal(failure.processExecutionStopReceipt.observation.code, null);
});

test("coordinator timeout waits for the owned child's exit observation before returning proof", async (t) => {
  const { runtime } = await fixture(t);
  let failure;
  try {
    await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"],
      { timeoutMs: 100, graceMs: 200 }));
  } catch (error) { failure = error; }
  assert.ok(failure instanceof AgentTimeoutError);
  assert.equal(failure.processExecutionStopReceipt.observation.kind, "exited");
  assert.equal(failure.stopEvidence.confirmed, true);
  assert.equal(failure.signal, failure.processExecutionStopReceipt.observation.signal);
  assert.equal(failure.killed, true);
  assert.equal(failure.processExecutionStopReceipt.stopOperation.reason, "timeout");
  assert.equal(failure.processExecutionStopReceipt.stopOperation.graceMs, 200);
  assert.equal(runtime.inspect().executions[0].calls[0].graceMs, 200);
});

test("default timeout diagnostics preserve the first committed stop grace through fresh receipt readback", async (t) => {
  const { runtime, root } = await fixture(t);
  let failure;
  try {
    await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"],
      { timeoutMs: 100 }));
  } catch (error) { failure = error; }
  assert.ok(failure instanceof AgentTimeoutError);
  const receipt = failure.processExecutionStopReceipt;
  assert.ok(receipt instanceof ProcessExecutionStopReceipt);
  assert.equal(receipt.observation.kind, "exited");
  assert.equal(receipt.stopOperation.reason, "timeout");
  assert.equal(receipt.stopOperation.graceMs, DEFAULT_REGISTERED_CHILD_GRACE_MS);
  assert.equal(runtime.inspect().executions[0].calls[0].graceMs, DEFAULT_REGISTERED_CHILD_GRACE_MS);
  await runtime.close();
  const saved = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root });
  assert.deepEqual(saved.executions[0].calls[0].receipt, receipt.toJSON());
  assert.equal(failure.graceMs, receipt.stopOperation.graceMs,
    "timeout diagnostics must report the actual first committed stop grace");
});

test("abort after output keeps the original reservation and a confirmed registered receipt", async (t) => {
  const { runtime } = await fixture(t);
  const abort = new AbortController();
  let failure;
  try {
    await runtime.enter(() => executeManagedProcess(process.execPath,
      ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
        timeoutMs: 5000, graceMs: 200, abortSignal: abort.signal, onStdout: () => abort.abort(),
      }));
  } catch (error) { failure = error; }
  assert.equal(failure.code, "ABORT_ERR");
  assert.equal(failure.stdout, "ready");
  assert.equal(failure.processExecutionStopReceipt.stopOperation.reason, "abort");
  assert.equal(failure.processExecutionStopReceipt.observation.kind, "exited");
  assert.equal(runtime.inspect().executions[0].calls.length, 1);
});

test("synchronous worker execution preserves exact binary output and shared Flow origin", async (t) => {
  const { runtime, binding } = await fixture(t);
  const result = runtime.enter(() => runCmd(process.execPath,
    ["-e", "process.stdout.write(Buffer.from([0,255,128,10]))"], { encoding: "buffer", timeout: 5000 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.stdout, Buffer.from([0, 255, 128, 10]));
  assert.deepEqual(result.processExecutionStopReceipt.binding.toJSON(), binding);
  const hex = await runtime.enter(() => runCmdAsync(process.execPath,
    ["-e", "process.stdout.write(Buffer.from([0,255,128,10]))"], { encoding: "hex", timeout: 5000 }));
  assert.equal(hex.stdout, "00ff800a");
  assert.equal(hex.processExecutionStopReceipt.output.stdoutBytes, 4);
});

test("retained pipe writers cannot turn registered exit proof into complete output or tree proof", async (t) => {
  const { runtime } = await fixture(t);
  const source = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},800)'],{stdio:['ignore',process.stdout,'ignore']});c.unref();process.stdout.write('parent')";
  const result = await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", source], { timeoutMs: 5000 }));
  assert.equal(result.stdout, "parent");
  assert.equal(result.processExecutionStopReceipt.scope, "registered-executions");
  assert.equal(result.processExecutionStopReceipt.output.completion, "incomplete");
  assert.deepEqual(result.processExecutionStopReceipt.descendants, []);
});

test("stdin bytes are snapshotted before admission and preserve the supplied view bounds", async (t) => {
  const { runtime } = await fixture(t);
  const bytes = Uint8Array.from([17, 0, 255, 128, 10, 18]);
  const input = new DataView(bytes.buffer, 1, 4);
  const result = await runtime.enter(() => executeManagedProcess(process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"], {
      timeoutMs: 5000, encoding: "buffer", stdinContent: input,
      onSupervisorEvent: ({ type }) => { if (type === "intent") bytes.fill(99); },
    }));
  assert.deepEqual(result.stdout, Buffer.from([0, 255, 128, 10]));
  assert.equal(result.processExecutionStopReceipt.observation.code, 0);
  assert.equal(result.processExecutionStopReceipt.output.stdoutBytes, 4);
});

test("invalid execution limits and pre-aborted input refuse before reserving or claiming a child", async (t) => {
  const { runtime, root } = await fixture(t);
  const before = runtime.store.read().toJSON();
  for (const input of [{ maxBuffer: -1 }, { maxBuffer: Infinity }, { maxBuffer: 1.5 },
    { graceMs: 0 }, { graceMs: Infinity }, { abortSignal: "invalid" }, { exitDrainMs: 0 }, { encoding: "unsupported-encoding" },
    { stdinContent: {} }, { stdinContent: 1 }]) {
    await assert.rejects(runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "process.exitCode=1"],
      { cwd: root, timeoutMs: 5000, ...input })), TypeError);
    assert.equal(isDeepStrictEqual(runtime.store.read().toJSON(), before), true,
      "Invalid execution input must leave the complete private registry unchanged");
  }
  const abort = new AbortController();
  abort.abort(new Error("cancelled before admission"));
  await assert.rejects(runtime.enter(() => executeManagedProcess(process.execPath, [],
    { cwd: root, timeoutMs: 5000, abortSignal: abort.signal })), { code: "ABORT_ERR", message: "cancelled before admission" });
  assert.equal(isDeepStrictEqual(runtime.store.read().toJSON(), before), true,
    "Pre-aborted input must leave the complete private registry unchanged");
});
