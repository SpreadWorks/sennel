import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { ProcessExecutionRuntime, ProcessExecutionStopReceipt, ProcessExecutionCall } from "../../../src/lib/process-execution-runtime.js";
import { RepositoryLockAuthority } from "../../../src/lib/repository-control-lock.js";
import { runManagedCmdAsync, runCmdAsync } from "../../../src/lib/process.js";
import { readManagedSettlement } from "../../../src/lib/managed-process.js";
import { readManagedRecord, writeManagedRecord } from "../../../src/lib/managed-process-protocol.js";

async function fixture(t) {
  const root = createTmpDir("managed-process-");
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root, environment: {} });
  t.after(async () => {
    try { await runtime.close(); }
    catch (error) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw error; }
    removeTmpDir(root);
  });
  return { root, runtime };
}

test("managed command saves a stop receipt after preserving stdin, environment and both output streams", async (t) => {
  const { root, runtime } = await fixture(t);
  let delivered;
  const result = await runtime.enter(() => runManagedCmdAsync(process.execPath, ["-e",
    "process.stdin.on('data', b => process.stdout.write(b));process.stderr.write(process.env.MANAGED_VALUE);"],
  { cwd: root, env: { ...process.env, MANAGED_VALUE: "diagnostic" }, input: "unchanged bytes\n", timeout: 20000, onProcessExecutionStop(receipt) { delivered = receipt; } }));
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout, "unchanged bytes\n");
  assert.equal(result.stderr, "diagnostic");
  assert.equal(result.stopEvidence.confirmed, true);
  assert.equal(delivered instanceof ProcessExecutionStopReceipt, true);
  assert.equal(result.processExecutionStopReceipt, delivered);
  assert.deepEqual(delivered.toJSON(), runtime.store.read().executions.at(-1).calls[0].receipt.toJSON());
  await runtime.close();
  const successor = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root });
  await successor.close();
});

test("ordinary asynchronous commands preserve extra descriptors through registered execution", async (t) => {
  const root = createTmpDir("process-fd-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "delivery");
  fs.writeFileSync(file, "descriptor-data");
  const descriptor = fs.openSync(file, "r");
  t.after(() => fs.closeSync(descriptor));
  const result = await runCmdAsync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync(3))"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe", descriptor], signal: new AbortController().signal,
  });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout, "descriptor-data");
});

test("visible but durability-uncertain execution outcome record is rejected across a fresh reader", (t) => {
  const root = createTmpDir("managed-record-durability-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "outcome.json");
  const lockAuthority = new RepositoryLockAuthority(root);
  const record = { executionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    callId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "finished" };
  assert.throws(() => writeManagedRecord(file, record, { lockAuthority, faultInjector({ phase }) {
    if (phase === "before-file-readback") throw new Error("injected publication readback failure");
  } }), { code: "PROCESS_EXECUTION_RECORD_SAVE_FAILED" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), record);
  assert.throws(() => readManagedRecord(file, { lockAuthority }), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
});

test("large legal output streams stay outside the shared registry across physical calls", async (t) => {
  const { root, runtime } = await fixture(t);
  const empty = await fixture(t);
  const size = 7 * 1024 * 1024;
  // Keep argv/env and cwd byte length fixed; stdin alone selects output size.
  const args = ["-e", "let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const size=Number(input);process.stdout.write(Buffer.alloc(size,97));process.stderr.write(Buffer.alloc(size,98));});"];
  for (let index = 0; index < 2; index += 1) {
    const quiet = await empty.runtime.enter(() => runManagedCmdAsync(process.execPath, args,
      { cwd: empty.root, input: "0", timeout: 40000, maxBuffer: 8 * 1024 * 1024 }));
    assert.equal(quiet.ok, true);
    assert.equal(quiet.stdout, ""); assert.equal(quiet.stderr, "");
    const result = await runtime.enter(() => runManagedCmdAsync(process.execPath, args,
      { cwd: root, input: String(size), timeout: 40000, maxBuffer: 8 * 1024 * 1024 }));
    assert.equal(result.ok, true);
    assert.equal(result.stdout, "a".repeat(size));
    assert.equal(result.stderr, "b".repeat(size));
    const call = runtime.store.read().executions.at(-1).calls.at(-1);
    const quietCall = empty.runtime.store.read().executions.at(-1).calls.at(-1);
    assert.deepEqual(call.invocation.actualCommand.args, quietCall.invocation.actualCommand.args);
    assert.equal(JSON.stringify(call.invocation.launch.env) === JSON.stringify(quietCall.invocation.launch.env), true,
      "The comparison requires identical effective environment metadata");
    assert.equal(Buffer.byteLength(call.invocation.launch.cwd), Buffer.byteLength(quietCall.invocation.launch.cwd));
    assert.equal(call.receipt.outcomeDigest, result.processExecutionStopReceipt.outcomeDigest);
    assert.equal(Object.hasOwn(call.outcome, "stdout"), false);
    assert.equal(Object.hasOwn(call.outcome, "stderr"), false);
    const directory = runtime.store.callDirectory(call.callId);
    assert.ok(fs.statSync(path.join(directory, "outcome.json")).size < 16384);
    assert.equal(fs.statSync(path.join(directory, "stdout.bin")).size, size);
    assert.equal(fs.statSync(path.join(directory, "stderr.bin")).size, size);
    const largeRegistry = fs.readFileSync(runtime.store.file.filePath);
    const emptyRegistry = fs.readFileSync(empty.runtime.store.file.filePath);
    for (const bytes of [largeRegistry, emptyRegistry]) {
      assert.equal(bytes.includes(Buffer.alloc(8192, 97)), false);
      assert.equal(bytes.includes(Buffer.alloc(8192, 98)), false);
    }
    // Required input/receipt/replay metadata varies with the invocation, not
    // output size. Only bounded output references and chunk acknowledgements grow.
    const metadataDelta = Math.abs(largeRegistry.length - emptyRegistry.length);
    t.diagnostic(JSON.stringify({ callCount: index + 1, emptyRegistryBytes: emptyRegistry.length,
      largeRegistryBytes: largeRegistry.length, metadataDelta, bytesPerOutputStream: size }));
    assert.ok(metadataDelta <= 8192, "Output metadata must remain bounded independently of stream size");
  }
  const call = runtime.store.read().executions.at(-1).calls.at(-1);
  const directory = runtime.store.callDirectory(call.callId);
  fs.writeFileSync(path.join(directory, "stdout.bin"), Buffer.alloc(size, 99));
  assert.throws(() => readManagedSettlement(new ProcessExecutionCall(runtime, call)),
  { code: "PROCESS_EXECUTION_OUTPUT_CORRUPT" });
});
