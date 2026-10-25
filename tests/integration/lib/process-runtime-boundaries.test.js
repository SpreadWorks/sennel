import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure, ProcessExecutionCall } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutorIdentity } from "../../../src/lib/process-execution-values.js";
import { executeManagedProcess, readManagedSettlement } from "../../../src/lib/managed-process.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { RuntimeRegistryPublicationFailure } from "../../support/infrastructure/runtime-registry-publication-failure.js";


function archiveAcceptanceMutation(root, archivePath) {
  const witness = path.join(root, "archive-acceptance-mutation.json");
  const source = `import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
    const open = fs.openSync, close = fs.closeSync, fsync = fs.fsyncSync, read = fs.readFileSync;
    const stages = new Map(); let changed = false;
    fs.openSync = function(file, ...args) {
      const descriptor = open.call(this, file, ...args);
      if (path.basename(String(file)).startsWith('.registry.json.') && String(file).endsWith('.tmp')) stages.set(descriptor, String(file));
      return descriptor;
    };
    fs.closeSync = function(descriptor) { stages.delete(descriptor); return close.call(this, descriptor); };
    fs.fsyncSync = function(descriptor) {
      const result = fsync.call(this, descriptor);
      const stage = stages.get(descriptor);
      if (!changed && stage !== undefined) {
        const record = JSON.parse(read(stage));
        const current = record.payload.executions.at(-1), request = current?.requests.at(-1);
        if (current?.calls.length === 0 && request?.operation === 'reserve' && request.response === null) {
          changed = true;
          const archivePath = ${JSON.stringify(archivePath)};
          const before = fs.statSync(archivePath, {bigint:true});
          const archive = JSON.parse(read(archivePath));
          archive.payload.unexpectedAcceptanceField = true;
          archive.digest = crypto.createHash('sha256').update(JSON.stringify(archive.payload)).digest('hex');
          fs.writeFileSync(archivePath, JSON.stringify(archive));
          const after = fs.statSync(archivePath, {bigint:true});
          fs.writeFileSync(${JSON.stringify(witness)}, JSON.stringify({requestId:request.requestId,
            sameIdentity:before.dev===after.dev && before.ino===after.ino}), {flag:'wx'});
        }
      }
      return result;
    };`;
  return { witness, environment: { ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=data:text/javascript;base64,${Buffer.from(source).toString("base64")}`.trim() } };
}

test("archive bytes changed after reserve read are revalidated before acceptance can permit a child effect", { timeout: 60000 }, async (t) => {
  const root = createTmpDir("runtime-archive-acceptance-");
  let original, runtime;
  t.after(async () => {
    try {
      for (const owned of [runtime, original]) {
        if (owned?.control.child.exitCode === null && owned.control.child.signalCode === null) {
          const stopped = once(owned.control.child, "exit");
          owned.control.child.ref(); owned.control.child.kill(); await stopped;
        }
      }
    } finally { removeQuiescentRuntimeFixture({ mainRoot: root }); }
  });
  original = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  await original.close();
  const archivePath = path.join(original.store.archivesAuthority.directory, `${original.executionId}.json`);
  const fault = archiveAcceptanceMutation(root, archivePath);
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: fault.environment });
  // The completed predecessor's eligible history survives into this successor.
  const originalBytes = fs.readFileSync(archivePath);
  const identity = fs.statSync(archivePath, { bigint: true });
  const effect = path.join(root, "forbidden-child-effect");
  await assert.rejects(executeManagedProcess(process.execPath, ["-e",
    `require('node:fs').writeFileSync(${JSON.stringify(effect)},'forbidden')`], { runtime, timeoutMs: 10000 }),
  (error) => error instanceof ProcessExecutionControlFailure
    && error.code === "PROCESS_EXECUTION_REGISTRY_FAILED" && error.processExecutionStopReceipt === undefined);
  const witness = JSON.parse(fs.readFileSync(fault.witness));
  assert.equal(witness.sameIdentity, true);
  const after = fs.statSync(archivePath, { bigint: true });
  assert.equal(after.dev, identity.dev); assert.equal(after.ino, identity.ino);
  assert.equal(fs.readFileSync(archivePath).equals(originalBytes), false);
  const archive = JSON.parse(fs.readFileSync(archivePath));
  assert.equal(archive.payload.unexpectedAcceptanceField, true);
  assert.equal(archive.digest, crypto.createHash("sha256").update(JSON.stringify(archive.payload)).digest("hex"));
  const registry = fs.readFileSync(runtime.store.file.filePath);
  const committed = JSON.parse(registry).payload;
  assert.equal(committed.slot, runtime.executionId);
  const active = committed.executions.find((entry) => entry.executionId === runtime.executionId);
  assert.deepEqual(active.calls, []);
  assert.equal(active.requests.at(-1).requestId, witness.requestId);
  assert.equal(active.requests.at(-1).operation, "reserve");
  assert.equal(active.requests.at(-1).response, null);
  assert.deepEqual(fs.readdirSync(runtime.store.callsAuthority.directory), []);
  assert.equal(fs.existsSync(effect), false);
  assert.equal(fs.existsSync(runtime.store.transition.filePath), true);
  assert.throws(() => ProcessExecutionRuntime.inspect({ mainRoot: root }), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: root }), { code: "PROCESS_EXECUTION_BUSY" });
  assert.equal(fs.readFileSync(runtime.store.file.filePath).equals(registry), true);
  assert.equal(fs.existsSync(effect), false);
});

// Outcome trace: a real provider effect and actual exit precede finishCall; a
// failed registry publication/readback must never become a reusable result.
// These replace launcher/permit IPC crash fixtures. Owner-loss/claim boundaries
// are covered by execution-coordinator.test.js with actual owned control handles.
for (const boundary of ["before-publication", "after-publication"]) {
  test(`receipt ${boundary} failure retains uncertain exclusion and refuses recovery without repeating the child effect`, { timeout: 60000 }, async (t) => {
    const root = createTmpDir(`runtime-receipt-${boundary}-`);
    let runtime;
    let verified = false;
    t.after(async () => {
      if (runtime?.control.child.exitCode === null && runtime.control.child.signalCode === null) {
        const stopped = once(runtime.control.child, "exit");
        runtime.control.child.ref();
        runtime.control.child.kill();
        await stopped;
      }
      // Test teardown stops only the actual owned control handle. It does not
      // convert this unknown registry into a product recovery/exit receipt.
      if (verified) removeTmpDir(root);
      else testTemporaryRoot().retainOnUnconfirmedExecution();
    });
    runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: new RuntimeRegistryPublicationFailure(root, { boundary }).environment });
    const effect = path.join(root, "provider-effects");
    const expected = boundary === "before-publication" ? "PROCESS_EXECUTION_REGISTRY_FAILED" : "PROCESS_EXECUTION_DURABILITY_UNCERTAIN";
    await assert.rejects(executeManagedProcess(process.execPath, ["-e",
      `require('node:fs').appendFileSync(${JSON.stringify(effect)},'effect\\n')`], { runtime, timeoutMs: 10000 }),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === expected && error.processExecutionStopReceipt === undefined);
    assert.equal(fs.readFileSync(effect, "utf8"), "effect\n");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "fault-observed.json"))).boundary, boundary);
    const registry = JSON.parse(fs.readFileSync(runtime.store.file.filePath)).payload;
    const call = registry.executions[0].calls[0];
    assert.equal(registry.slot, runtime.executionId);
    assert.equal(call.observation.kind, "exited");
    assert.equal(call.observation.code, 0);
    assert.equal(call.receipt !== null, boundary === "after-publication");
    assert.equal(fs.existsSync(runtime.store.transition.filePath), true);
    assert.equal(fs.existsSync(runtime.store.ownerLock.lockPath), true);
    assert.throws(() => ProcessExecutionRuntime.inspect({ mainRoot: root }), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
    const physical = JSON.parse(fs.readFileSync(path.join(runtime.store.callsAuthority.directory, call.callId, "outcome.json")));
    assert.equal(physical.receipt.observation.kind, "exited");
    assert.equal(physical.receipt.observation.code, 0);
    assert.throws(() => readManagedSettlement(new ProcessExecutionCall(runtime, call)), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
    const before = fs.readFileSync(runtime.store.file.filePath);
    let consumed = false;
    await assert.rejects(ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: root, binding: { contract: "receipt-failure" } }, () => {
      consumed = true;
    }), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
    assert.equal(consumed, false);
    await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: root }), { code: "PROCESS_EXECUTION_BUSY" });
    await assert.rejects(runtime.close(), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
    assert.deepEqual(fs.readFileSync(runtime.store.file.filePath), before);
    assert.equal(fs.readFileSync(effect, "utf8"), "effect\n");
    verified = true;
  });
}


test("later output chunk publication failure retains exact earlier prefix and never yields a child receipt or repeated effect", { timeout: 60000 }, async (t) => {
  const root = createTmpDir("runtime-output-chunk-failure-");
  let runtime, verified = false;
  t.after(async () => {
    if (runtime?.control.child.exitCode === null && runtime.control.child.signalCode === null) {
      const stopped = once(runtime.control.child, "exit"); runtime.control.child.ref(); runtime.control.child.kill(); await stopped;
    }
    if (verified) removeTmpDir(root); else testTemporaryRoot().retainOnUnconfirmedExecution();
  });
  const source = `import fs from 'node:fs';import path from 'node:path';const rename=fs.renameSync;
    fs.renameSync=function(source,target){
      if(path.basename(String(target))==='stdout.bin'&&fs.statSync(source).size>4*1024*1024)throw Object.assign(new Error('Fixture later output publication unavailable'),{code:'EIO'});
      return rename.call(this,source,target);
    };`;
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: { ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=data:text/javascript;base64,${Buffer.from(source).toString("base64")}`.trim() } });
  const size = 8 * 1024 * 1024, captured = [], effect = path.join(root, "provider-effects");
  await assert.rejects(executeManagedProcess(process.execPath, ["-e",
    `require('node:fs').appendFileSync(${JSON.stringify(effect)},'effect\\n');process.stdout.write(Buffer.alloc(${size},97))`],
  { runtime, timeoutMs: 10000, maxBuffer: size, onStdout(bytes) { captured.push(Buffer.from(bytes)); } }),
  (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_RECORD_SAVE_FAILED"
    && error.processExecutionStopReceipt === undefined);
  const bytes = Buffer.concat(captured);
  assert.equal(bytes.length, size);
  const saved = runtime.inspect().executions[0].calls[0];
  assert.equal(saved.observation.kind, "exited"); assert.equal(saved.observation.code, 0);
  assert.equal(saved.receipt, null); assert.equal(saved.output, null);
  assert.equal(saved.controlFailure.code, "PROCESS_EXECUTION_RECORD_SAVE_FAILED");
  const file = path.join(runtime.store.callsAuthority.directory, saved.callId, "stdout.bin");
  const prefix = fs.readFileSync(file), progress = fs.readFileSync(`${file}.capture`);
  assert.equal(prefix.length, 4 * 1024 * 1024);
  assert.deepEqual(prefix, bytes.subarray(0, prefix.length));
  assert.equal(JSON.parse(progress).prefix.byteLength, prefix.length);
  assert.equal(fs.existsSync(`${file}.transition`), true);
  const call = new ProcessExecutionCall(runtime, saved);
  await assert.rejects(runtime.persistCallOutput(call, { executor: ProcessExecutorIdentity.fromStored(saved.executor),
    stream: "stdout", maximum: size, bytes }), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  assert.deepEqual(fs.readFileSync(file), prefix);
  assert.deepEqual(fs.readFileSync(`${file}.capture`), progress);
  assert.equal(runtime.stopReceipts().length, 0);
  assert.equal(fs.readFileSync(effect, "utf8"), "effect\n");
  verified = true;
});


test("a legal capture larger than one control frame preserves exact binary output and sealed receipt readback without storing bytes in the registry", { timeout: 90000 }, async (t) => {
  const root = createTmpDir("runtime-output-beyond-frame-");
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
    removeTmpDir(root);
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  const size = 25 * 1024 * 1024, maximum = 26 * 1024 * 1024;
  const expected = Buffer.alloc(size, 97);
  const result = await executeManagedProcess(process.execPath, ["-e", `process.stdout.write(Buffer.alloc(${size},97))`],
    { runtime, timeoutMs: 30000, maxBuffer: maximum, encoding: "buffer" });
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, expected);
  assert.deepEqual(result.stderr, Buffer.alloc(0));
  assert.equal(result.processExecutionStopReceipt.output.stdoutBytes, size);
  assert.equal(result.processExecutionStopReceipt.output.completion, "complete");
  const inventory = runtime.inspect(), saved = inventory.executions[0].calls[0];
  const settlement = readManagedSettlement(new ProcessExecutionCall(runtime, saved));
  assert.deepEqual(settlement.stdout, expected);
  assert.deepEqual(settlement.stderr, Buffer.alloc(0));
  assert.deepEqual(settlement.processExecutionStopReceipt.toJSON(), result.processExecutionStopReceipt.toJSON());
  assert.equal(runtime.stopReceipts().length, 1);
  assert.equal(saved.outcome.output.stdout.byteLength, size);
  assert.equal(saved.outcome.output.maximum, maximum);
  assert.ok(fs.statSync(runtime.store.file.filePath).size < size / 100,
    "the private input metadata and result references must remain small compared with captured bytes");
});
