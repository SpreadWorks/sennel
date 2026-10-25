import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { ProcessLock } from "../../../src/lib/process-lock.js";
import { ProcessExecutionBinding, ProcessExecutionControlFailure, ProcessExecutionRuntime, ProcessExecutionStopReceipt,
  ProcessExecutionNonExecutionEvidence, ProcessExecutionRecoveryCall, ProcessExecutionRecoveryEvidence,
  PROCESS_EXECUTION_SCOPE_ENV } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { DirectChildExecutor } from "../../../src/lib/direct-child-executor.js";
import { NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";
import { RuntimeChildExecution } from "../../../src/lib/runtime-package.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const moduleURL = pathToFileURL(path.resolve("src/lib/process-execution-runtime.js")).href;
const ownedRuntimes = new Map();
function fixture(t) {
  const mainRoot = createTmpDir("process-runtime-");
  const owned = [];
  ownedRuntimes.set(mainRoot, owned);
  t.after(async () => {
    try {
      for (const runtime of owned) await runtime.close();
      for (const runtime of owned) {
        if (runtime.store.ownerLock.inspect() !== null) throw new ProcessExecutionControlFailure("ownership-unknown", "Fixture retains an unreleased owner");
      }
    } catch (cause) {
      testTemporaryRoot().retainOnUnconfirmedExecution();
      throw cause;
    } finally { ownedRuntimes.delete(mainRoot); }
    removeTmpDir(mainRoot);
  });
  return { mainRoot, executionRoot: mainRoot, runId: "runtime-run", specId: "runtime-spec" };
}
async function acquire(options) {
  const runtime = await ProcessExecutionRuntime.acquire(options);
  ownedRuntimes.get(options.mainRoot).push(runtime);
  return runtime;
}
function registryPath(mainRoot) {
  const key = crypto.createHash("sha256").update(JSON.stringify(mainRoot)).digest("hex");
  return path.join(mainRoot, ".sennel", "process-runtime", key, "registry.json");
}
async function completeReservedCall(runtime, call) {
  const command = new NativeExecutableInvocation({ executable: process.execPath, args: ["-e", ""], cwd: runtime.executionRoot, env: process.env, stdio: "pipe" });
  const result = await new DirectChildExecutor(runtime, call).run(command.resolvedLaunch(), { timeoutMs: 10000, exitDrainMs: 2000 });
  return result.processExecutionStopReceipt;
}
function failure(code) { return (error) => error instanceof ProcessExecutionControlFailure && error.code === code; }

// Recovery admission traces complete saved inventory -> explicitly released ownership ->
// checkout exclusion -> exact call receipt or durable absence -> synchronous commit.
// Missing inventory, a live owner, or any reserved call without a stop receipt must
// refuse before the consumer can mutate canonical state.
test("unreserved recovery has a stable durable absence proof only within checkout exclusion", async (t) => {
  const options = fixture(t);
  const binding = { runId: options.runId, specId: options.specId, attemptId: "unreserved-attempt", executionContractId: "unreserved-contract" };
  const runtime = await acquire(options);
  await runtime.close();
  let captured;
  const summary = await ProcessExecutionRuntime.withRecoveryEvidence({ ...options, binding }, (evidence) => {
    captured = evidence;
    assert.ok(evidence instanceof ProcessExecutionRecoveryEvidence);
    assert.equal(evidence.assertCurrent().assertBinding(binding), evidence);
    assert.ok(evidence.nonExecution instanceof ProcessExecutionNonExecutionEvidence);
    assert.equal(evidence.nonExecution.reservationBeforeSpawn, true);
    assert.deepEqual(evidence.calls, []);
    assert.deepEqual(evidence.nonExecution.executions.map((execution) => execution.authorityState), ["closed"]);
    assert.throws(() => evidence.assertBinding({ ...binding, attemptId: "different-attempt" }), failure("PROCESS_EXECUTION_RECOVERY_BINDING_MISMATCH"));
    const competing = spawnSync(process.execPath, ["--import", new URL("../../../src/sennel.js", import.meta.url).href, "--input-type=module", "-e", `
      import { ProcessExecutionRuntime } from ${JSON.stringify(moduleURL)};
      try { await ProcessExecutionRuntime.acquire(${JSON.stringify(options)}); process.exitCode = 2; }
      catch (error) { process.stdout.write(error.code); }
    `], { encoding: "utf8", timeout: 10000 });
    assert.equal(competing.status, 0, competing.stderr);
    assert.equal(competing.stdout, "PROCESS_EXECUTION_BUSY");
    return evidence.toJSON();
  });
  assert.equal(summary.id, summary.digest);
  assert.deepEqual(ProcessExecutionNonExecutionEvidence.fromStored(summary.nonExecution).toJSON(), summary.nonExecution);
  assert.throws(() => captured.assertCurrent(), failure("PROCESS_EXECUTION_RECOVERY_AUTHORITY_EXPIRED"));
  const reloaded = await ProcessExecutionRuntime.withRecoveryEvidence({ ...options, binding }, (evidence) => evidence.toJSON());
  assert.deepEqual(reloaded, summary);
  const next = await acquire(options);
  await next.close();
});

test("recovery reads an archived actual child receipt and exact reservation metadata", async (t) => {
  const options = fixture(t); const binding = { executionContractId: "reserved-contract", attemptId: "reserved-attempt" };
  const runtime = await acquire({ ...options, binding });
  const call = await runtime.reserveCall({ invocation: { commandId: "observed-provider" } });
  const receipt = await completeReservedCall(runtime, call);
  await runtime.close();
  const archiver = await acquire(options);
  await archiver.close();
  await ProcessExecutionRuntime.withRecoveryEvidence({ ...options, binding }, (evidence) => {
    assert.equal(evidence.nonExecution, null);
    assert.equal(evidence.calls.length, 1);
    assert.ok(evidence.calls[0] instanceof ProcessExecutionRecoveryCall);
    assert.equal(evidence.calls[0].executionId, runtime.executionId);
    assert.equal(evidence.calls[0].callId, call.callId);
    assert.equal(evidence.calls[0].startPermitted, true);
    assert.deepEqual(evidence.receipts[0].toJSON(), receipt.toJSON());
    assert.deepEqual(evidence.calls[0].receipt.toJSON(), receipt.toJSON());
    assert.equal(evidence.assertCurrent(), evidence);
  });
});

test("dispatch recovery reuses its current exclusive owner and preserves later call admission", async (t) => {
  const options = fixture(t); const binding = { runId: options.runId, attemptId: "dispatch-attempt" };
  const previousInvocation = { providerAttemptId: crypto.randomUUID(), logicalInvocationId: crypto.randomUUID() };
  const previous = await acquire({ ...options, binding });
  const previousCall = await previous.reserveCall({ binding: { ...binding, executionContractId: "old-generation" }, invocation: previousInvocation });
  await completeReservedCall(previous, previousCall);
  await previous.close();
  const current = await acquire({ ...options, binding });
  let scopedEvidence;
  let invocationEvidence;
  await current.enter(async () => {
    const result = await ProcessExecutionRuntime.withRecoveryEvidence({ ...options, binding }, (evidence) => {
      assert.equal(evidence.assertCurrent(), evidence);
      assert.equal(evidence.calls.length, 1);
      assert.equal(evidence.calls[0].callId, previousCall.callId);
      scopedEvidence = evidence.forBinding({ ...binding, executionContractId: "new-generation" });
      assert.ok(scopedEvidence.nonExecution instanceof ProcessExecutionNonExecutionEvidence);
      assert.equal(scopedEvidence.calls.length, 0);
      assert.equal(scopedEvidence.assertCurrent(), scopedEvidence);
      assert.deepEqual(scopedEvidence.nonExecution.binding.toJSON(), { ...binding, executionContractId: "new-generation" });
      assert.equal(scopedEvidence.nonExecution.inventoryDigest, evidence.toJSON().inventoryDigest);
      assert.throws(() => evidence.forBinding({ runId: options.runId }), failure("PROCESS_EXECUTION_RECOVERY_BINDING_MISMATCH"));
      assert.throws(() => evidence.forBinding({ ...binding, attemptId: "different-attempt" }), failure("PROCESS_EXECUTION_RECOVERY_BINDING_MISMATCH"));
      const oldGeneration = evidence.forBinding({ ...binding, executionContractId: "old-generation" });
      const previousAttempt = oldGeneration.forInvocation(previousInvocation);
      assert.equal(previousAttempt.calls.length, 1);
      assert.equal(previousAttempt.calls[0].callId, previousCall.callId);
      assert.equal(previousAttempt.nonExecution, null);
      const nextInvocation = { providerAttemptId: crypto.randomUUID(), logicalInvocationId: previousInvocation.logicalInvocationId };
      invocationEvidence = oldGeneration.forInvocation(nextInvocation);
      assert.equal(invocationEvidence.calls.length, 0);
      assert.deepEqual(invocationEvidence.nonExecution.invocation.toJSON(), nextInvocation);
      assert.equal(invocationEvidence.nonExecution.inventoryDigest, evidence.toJSON().inventoryDigest);
      assert.equal(invocationEvidence.assertCurrent(), invocationEvidence);
      assert.throws(() => invocationEvidence.forInvocation({ logicalInvocationId: previousInvocation.logicalInvocationId }), failure("PROCESS_EXECUTION_RECOVERY_BINDING_MISMATCH"));
      ProcessExecutionRuntime.assertQuiescent(options);
      return evidence.toJSON();
    });
    assert.equal(result.calls[0].binding.executionContractId, "old-generation");
    assert.throws(() => scopedEvidence.assertCurrent(), failure("PROCESS_EXECUTION_RECOVERY_AUTHORITY_EXPIRED"));
    assert.throws(() => invocationEvidence.assertCurrent(), failure("PROCESS_EXECUTION_RECOVERY_AUTHORITY_EXPIRED"));
    const unreserved = { ...binding, executionContractId: "new-generation" };
    await ProcessExecutionRuntime.withRecoveryEvidence({ ...options, binding: unreserved }, (evidence) => {
      assert.deepEqual(evidence.nonExecution.executions.map((execution) => execution.authorityState), ["closed", "exclusive"]);
    });
    const call = await current.reserveCall({ binding: unreserved });
    let consumed = false;
    await assert.rejects(ProcessExecutionRuntime.withRecoveryEvidence({ ...options, binding }, () => { consumed = true; }), failure("PROCESS_EXECUTION_STOP_UNCONFIRMED"));
    assert.equal(consumed, false);
    await completeReservedCall(current, call);
    assert.equal(current.inspect().slot, current.executionId);
  });
  await current.close();
});

test("receipt absence after a physical reservation refuses recovery without invoking canonical consumer", async (t) => {
  const options = fixture(t);
  const runtime = await acquire(options);
  const call = await runtime.reserveCall();
  let consumed = false;
  await assert.rejects(runtime.enter(() => ProcessExecutionRuntime.withRecoveryEvidence({ ...options, binding: { executionContractId: "missing-receipt" } }, () => {
    consumed = true;
  })), failure("PROCESS_EXECUTION_STOP_UNCONFIRMED"));
  assert.equal(consumed, false);
  assert.equal(runtime.inspect().executions[0].calls[0].receipt, null);
  assert.equal(runtime.inspect().slot, runtime.executionId);
  await completeReservedCall(runtime, call);
  await runtime.close();
});

test("missing runtime inventory cannot prove non-execution or create replacement evidence", async (t) => {
  const options = fixture(t); let consumed = false;
  await assert.rejects(ProcessExecutionRuntime.withRecoveryEvidence({ ...options, binding: { executionContractId: "missing-inventory" } }, () => {
    consumed = true;
  }), failure("PROCESS_EXECUTION_ADMISSION_FAILED"));
  assert.equal(consumed, false);
  assert.equal(fs.existsSync(path.join(options.mainRoot, ".sennel")), false);
});

test("unregistered physical artifacts and changed fresh inventory prevent recovery commit", async (t) => {
  const options = fixture(t); const runtime = await acquire(options);
  await runtime.close();
  const rogue = path.join(path.dirname(registryPath(options.mainRoot)), "calls", crypto.randomUUID());
  await ProcessExecutionRuntime.withRecoveryEvidence({ ...options, binding: { executionContractId: "changed-inventory" } }, (evidence) => {
    fs.mkdirSync(rogue);
    assert.throws(() => evidence.assertCurrent(), failure("PROCESS_EXECUTION_RECORD_MISSING"));
  });
  let consumed = false;
  await assert.rejects(ProcessExecutionRuntime.withRecoveryEvidence({ ...options, binding: { executionContractId: "changed-inventory" } }, () => {
    consumed = true;
  }), failure("PROCESS_EXECUTION_RECORD_MISSING"));
  assert.equal(consumed, false);
});

// Outcomes: exact recovery/absence is valid only under held checkout exclusion.
// Real owner loss, missing receipt and exact claim replay are covered by
// execution-coordinator.test.js; production receipt publication/readback faults
// are covered by process-runtime-boundaries.test.js. Retired PID/birth/group
// takeover fixtures confer no authority in the registered-child contract.
test("checkout slot remains busy for a live coordinator and reopens at a new owner epoch", async (t) => {
  const options = fixture(t); const runtime = await acquire(options);
  await assert.rejects(acquire({ ...options, runId: "another-run" }), failure("PROCESS_EXECUTION_BUSY"));
  assert.equal(runtime.inspect().slot, runtime.executionId);
  assert.throws(() => ProcessExecutionRuntime.assertQuiescent(options), failure("PROCESS_EXECUTION_BUSY"));
  runtime.enter(() => {
    ProcessExecutionRuntime.assertQuiescent(options);
    assert.throws(() => ProcessExecutionRuntime.assertQuiescent({ ...options, runId: "another-run" }), failure("PROCESS_EXECUTION_BUSY"));
  });
  await runtime.close();
  ProcessExecutionRuntime.assertQuiescent(options);
  const next = await acquire(options);
  assert.equal(next.ownerEpoch, runtime.ownerEpoch + 1);
  await next.close();
});

test("fresh binding scopes share the owner and persist first run identity before physical calls", async (t) => {
  const options = fixture(t); const runtime = await acquire({ ...options, runId: null, specId: null });
  const binding = new ProcessExecutionBinding({ runId: options.runId, specId: options.specId, attemptId: "attempt-1", executionContractId: "contract-1" });
  await runtime.withBinding(binding, async () => {
    const scope = ProcessExecutionRuntime.current();
    assert.equal(scope.executionId, runtime.executionId);
    const call = await scope.reserveCall({ invocation: { commandId: "observed-child" } });
    assert.deepEqual(call.binding.toJSON(), binding.toJSON());
    await completeReservedCall(scope, call);
  });
  assert.equal(ProcessExecutionRuntime.current(), null);
  const saved = runtime.inspect().executions[0];
  assert.equal(saved.runId, options.runId);
  assert.equal(saved.calls[0].receipt.binding.attemptId, "attempt-1");
  await assert.rejects(runtime.withBinding({ runId: "different-run" }, () => {}), failure("PROCESS_EXECUTION_BINDING_MISMATCH"));
  await runtime.close();
});

test("parallel call reservations use shared admission and individual receipts allow another physical call", async (t) => {
  const options = fixture(t); const runtime = await acquire(options);
  const calls = await Promise.all(Array.from({ length: 3 }, (_, index) => runtime.reserveCall({ invocation: { index } })));
  assert.equal(new Set(calls.map((call) => call.callId)).size, 3);
  await Promise.all(calls.map((call) => completeReservedCall(runtime, call)));
  const retry = await runtime.reserveCall({ invocation: { retry: true } });
  await completeReservedCall(runtime, retry);
  await runtime.close();
  const saved = runtime.inspect().executions[0];
  assert.equal(saved.accepting, false);
  assert.equal(saved.calls.length, 4);
  assert.ok(saved.calls.every((call) => new ProcessExecutionStopReceipt(call.receipt).stopEvidence.status === "confirmed"));
  await assert.rejects(runtime.reserveCall(), failure("PROCESS_EXECUTION_REGISTRATION_CLOSED"));
});

test("open runtime reads durable completed call receipts without publishing unfinished calls or granting quiescence", async (t) => {
  const options = fixture(t);
  const binding = { runId: options.runId, specId: options.specId,
    executionContractId: "open-dispatch-contract", attemptId: "open-dispatch-attempt" };
  const runtime = await acquire({ ...options, binding });
  const pending = await runtime.reserveCall({ invocation: { commandId: "unfinished-provider" } });
  try {
    await runtime.enter(async () => {
      assert.deepEqual(runtime.stopReceipts(binding), []);
      const result = await executeManagedProcess(process.execPath, ["-e", "process.stdout.write('completed-in-open-scope')"], {
        timeoutMs: 10000, graceMs: 100, maxBuffer: 1024,
      });
      assert.equal(result.stdout, "completed-in-open-scope");
      const produced = result.processExecutionStopReceipt;
      assert.ok(produced instanceof ProcessExecutionStopReceipt);
      const saved = ProcessExecutionRuntime.inspect(options).executions.find((entry) => entry.executionId === runtime.executionId);
      assert.equal(saved.status, "active");
      assert.equal(saved.accepting, true);
      assert.equal(saved.closure, null);
      const completed = saved.calls.find((call) => call.callId === produced.callId);
      assert.equal(completed.status, "stopped");
      assert.equal(completed.permit.callId, produced.callId);
      assert.deepEqual(JSON.parse(JSON.stringify(completed.receipt)), JSON.parse(JSON.stringify(produced)));
      assert.equal(saved.calls.find((call) => call.callId === pending.callId).receipt, null);
      assert.throws(() => ProcessExecutionRuntime.assertQuiescent(options), failure("PROCESS_EXECUTION_STOP_UNCONFIRMED"));

      const beforeRead = fs.readFileSync(registryPath(options.mainRoot));
      const receipts = ProcessExecutionRuntime.current().stopReceipts(binding);
      assert.equal(receipts.length, 1,
        "a completed call's saved receipt must be observable before the enclosing dispatch runtime closes");
      assert.ok(receipts[0] instanceof ProcessExecutionStopReceipt);
      assert.deepEqual(receipts[0].toJSON(), produced.toJSON());
      assert.deepEqual(runtime.stopReceipts().map((receipt) => receipt.callId), [produced.callId]);
      assert.deepEqual(runtime.stopReceipts({ ...binding, attemptId: "another-attempt" }), []);
      assert.deepEqual(runtime.stopReceipts(binding).map((receipt) => receipt.toJSON()), [produced.toJSON()]);
      assert.deepEqual(fs.readFileSync(registryPath(options.mainRoot)), beforeRead,
        "reading saved stop receipts must not close or mutate the active runtime");
      assert.throws(() => ProcessExecutionRuntime.assertQuiescent(options), failure("PROCESS_EXECUTION_STOP_UNCONFIRMED"));
    });
  } finally {
    await completeReservedCall(runtime, pending);
    await runtime.close();
  }
});

test("managed provider termination receipt is read back by a new coordinator before checkout reuse", async (t) => {
  const options = fixture(t); const binding = { executionContractId: "managed-reservation", attemptId: "managed-attempt" };
  const runtime = await acquire({ ...options, binding });
  const result = await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "process.stdout.write('completed')"], {
    timeoutMs: 10000, graceMs: 100, maxBuffer: 1024,
  }));
  assert.equal(result.stdout, "completed");
  const call = runtime.inspect().executions[0].calls[0];
  assert.equal(call.status, "stopped");
  assert.equal(call.permit.callId, call.callId);
  assert.equal(call.receipt.callId, call.callId);
  assert.equal(new ProcessExecutionStopReceipt(call.receipt).stopEvidence.status, "confirmed");
  await runtime.close();
  const next = await acquire(options);
  const saved = next.inspect().executions.find((entry) => entry.executionId === runtime.executionId);
  assert.equal(saved.status, "closed");
  assert.deepEqual(saved.calls[0].receipt, call.receipt);
  const receipts = next.stopReceipts();
  assert.equal(receipts.length, 1);
  assert.ok(receipts[0] instanceof ProcessExecutionStopReceipt);
  assert.deepEqual(receipts[0].toJSON().binding, call.binding);
  assert.equal(next.stopReceipts({ attemptId: "another-attempt" }).length, 0);
  await next.close();
  await ProcessExecutionRuntime.withRecoveryEvidence({ ...options, binding }, (evidence) => {
    assert.equal(evidence.nonExecution, null);
    assert.equal(evidence.calls.length, 1);
    assert.equal(evidence.calls[0].startPermitted, true);
    assert.deepEqual(JSON.parse(JSON.stringify(evidence.calls[0].receipt)), call.receipt);
  });
});

test("removing the closed registry cannot authorize replacement execution from missing inventory", async (t) => {
  const options = fixture(t); const runtime = await acquire(options);
  await runtime.close();
  new AtomicFile(registryPath(options.mainRoot)).remove();
  await assert.rejects(acquire(options), failure("PROCESS_EXECUTION_RECORD_MISSING"));
});

test("corrupt and symlink runtime records are rejected without writing replacement inventory", async (t) => {
  for (const kind of ["corrupt", "symlink"]) {
    await t.test(kind, async (t) => {
      const options = fixture(t); const runtime = await acquire(options);
      await runtime.close();
      const file = registryPath(options.mainRoot);
      const old = fs.readFileSync(file);
      if (kind === "corrupt") fs.writeFileSync(file, '{"payload":{},"digest":"wrong"}');
      else {
        const target = path.join(options.mainRoot, "unrelated.json"); fs.writeFileSync(target, old);
        fs.unlinkSync(file); fs.symlinkSync(target, file);
      }
      const before = fs.readFileSync(file);
      await assert.rejects(acquire(options), (error) => error instanceof ProcessExecutionControlFailure);
      assert.deepEqual(fs.readFileSync(file), before);
    });
  }
});

test("different checkouts have independent slots and readonly absence creates no runtime metadata", async (t) => {
  const options = fixture(t); const checkout = path.join(options.mainRoot, "checkout"); fs.mkdirSync(checkout);
  ProcessExecutionRuntime.assertQuiescent(options);
  assert.equal(fs.existsSync(path.join(options.mainRoot, ".sennel")), false);
  const first = await acquire(options);
  const second = await acquire({ ...options, executionRoot: checkout });
  assert.notEqual(first.executionId, second.executionId);
  await first.close(); await second.close();
});

test("a forged nested grant cannot initialize runtime directories in a fresh checkout", async (t) => {
  const options = fixture(t);
  const environment = { [PROCESS_EXECUTION_SCOPE_ENV]: JSON.stringify({ version: 1,
    mainRoot: options.mainRoot, executionRoot: options.executionRoot, executionId: crypto.randomUUID(),
    callId: crypto.randomUUID(), ownerEpoch: 1, ownerToken: crypto.randomUUID(), capability: crypto.randomUUID(),
    runId: options.runId, specId: options.specId, bindingDigest: "0".repeat(64) }) };
  await assert.rejects(acquire({ ...options, environment }), (error) => error instanceof ProcessExecutionControlFailure);
  assert.equal(fs.existsSync(path.join(options.mainRoot, ".sennel")), false);
});

test("a running managed call refuses synchronous recovery before any protected write", async (t) => {
  const options = fixture(t); const runtime = await acquire(options);
  const abort = new AbortController(); const reason = new Error("controlled-provider-stop");
  let guarded = false; let observedOutput = "";
  const protectedFile = path.join(options.mainRoot, "canonical-publication.json");
  await runtime.enter(async () => {
    await assert.rejects(executeManagedProcess(process.execPath, ["-e", "process.stdout.write('provider-running'); setInterval(() => {}, 1000)"], {
      timeoutMs: 10000, graceMs: 100, maxBuffer: 1024, abortSignal: abort.signal,
      onStdout(output) {
        observedOutput += output;
        if (guarded || !observedOutput.includes("provider-running")) return;
        guarded = true;
        assert.throws(() => {
          ProcessExecutionRuntime.assertQuiescent(options);
          fs.writeFileSync(protectedFile, "unsafe-publication");
        }, failure("PROCESS_EXECUTION_STOP_UNCONFIRMED"));
        assert.equal(fs.existsSync(protectedFile), false);
        abort.abort(reason);
      },
    }), (error) => error === reason && error.code === "ABORT_ERR");
    assert.equal(guarded, true);
    ProcessExecutionRuntime.assertQuiescent(options);
  });
  await runtime.close();
});

test("a legitimate nested member cannot reserve a physical call for a different parent binding", async (t) => {
  const options = fixture(t);
  const binding = new ProcessExecutionBinding({ runId: options.runId, specId: options.specId, attemptId: "parent-attempt", executionContractId: "parent-contract" });
  const runtime = await acquire({ ...options, binding });
  const script = path.join(options.mainRoot, "nested-binding.mjs");
  fs.writeFileSync(script, `
    import {ProcessExecutionRuntime} from ${JSON.stringify(moduleURL)};
    const runtime=await ProcessExecutionRuntime.acquire(${JSON.stringify(options)});
    let code;
    try { await runtime.reserveCall({binding:{...runtime.binding.toJSON(),attemptId:'foreign-attempt'}}); }
    catch(error) { code=error.code; }
    if(code!=='PROCESS_EXECUTION_DELEGATION_REFUSED')throw new Error('Foreign binding was not refused');
    await runtime.close();
    process.stdout.write(code);
  `);
  const result = await runtime.enter(() => RuntimeChildExecution.runAsync(script, [], {
    cwd: options.mainRoot, timeout: 10000, graceMs: 100, maxBuffer: 1024,
  }));
  assert.equal(result.stdout, "PROCESS_EXECUTION_DELEGATION_REFUSED");
  assert.equal(runtime.inspect().executions[0].calls.length, 1);
  await runtime.close();
});


test("a held legacy owner lock refuses closed-root reuse until its actual owner explicitly releases", async (t) => {
  const options = fixture(t);
  const runtime = await acquire(options);
  await runtime.close();
  const legacy = new ProcessLock({ directoryAuthority: runtime.store.authority, fileName: "owner.lock",
    kind: "checkout-process-runtime", authority: runtime.store.checkout.toJSON() });
  legacy.acquire();
  t.after(() => { if (legacy.ownerToken !== null) legacy.release(); });
  const registry = fs.readFileSync(runtime.store.file.filePath), lock = fs.readFileSync(legacy.lockPath);
  assert.equal(JSON.parse(registry).payload.slot, null);
  assert.throws(() => ProcessExecutionRuntime.inspect(options), { code: "PROCESS_EXECUTION_OWNERSHIP_UNKNOWN" });
  await assert.rejects(acquire(options), { code: "PROCESS_EXECUTION_OWNERSHIP_UNKNOWN" });
  assert.deepEqual(fs.readFileSync(runtime.store.file.filePath), registry);
  assert.deepEqual(fs.readFileSync(legacy.lockPath), lock);
  legacy.release();
  const successor = await acquire(options);
  assert.equal(successor.ownerEpoch, runtime.ownerEpoch + 1);
  await successor.close();
});


test("queued recovery releases a failed consumer before fresh evidence and later child admission", async (t) => {
  const options = fixture(t);
  const binding = { runId: options.runId, specId: options.specId, attemptId: "queued-recovery-attempt" };
  const runtime = await acquire({ ...options, binding });
  const firstCall = await runtime.reserveCall({ invocation: { commandId: "before-queued-recovery" } });
  const firstReceipt = await completeReservedCall(runtime, firstCall);
  assert.equal(firstReceipt.callId, firstCall.callId);
  assert.equal(firstReceipt.stopEvidence.status, "confirmed");
  const bound = await runtime.withBinding(binding, () => ProcessExecutionRuntime.current());
  assert.notEqual(bound, runtime);
  assert.equal(bound.root, runtime);
  const consumerFailure = new Error("The first synchronous recovery consumer refused its canonical input");
  let firstEvidence;
  let secondEvidence;
  const results = await Promise.allSettled([
    runtime.enter(() => ProcessExecutionRuntime.withRecoveryEvidence({ ...options, binding }, (evidence) => {
      firstEvidence = evidence;
      assert.equal(evidence.assertCurrent(), evidence);
      assert.deepEqual(evidence.receipts.map((receipt) => receipt.toJSON()), [firstReceipt.toJSON()]);
      throw consumerFailure;
    })),
    bound.enter(() => ProcessExecutionRuntime.withRecoveryEvidence({ ...options, binding }, (evidence) => {
      secondEvidence = evidence;
      assert.ok(firstEvidence instanceof ProcessExecutionRecoveryEvidence);
      assert.notEqual(evidence, firstEvidence);
      assert.throws(() => firstEvidence.assertCurrent(), failure("PROCESS_EXECUTION_RECOVERY_AUTHORITY_EXPIRED"));
      assert.equal(evidence.assertCurrent().assertBinding(binding), evidence);
      assert.deepEqual(evidence.receipts.map((receipt) => receipt.toJSON()), [firstReceipt.toJSON()]);
      return evidence.calls[0].receipt.toJSON();
    })),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].reason, consumerFailure);
  assert.equal(results[1].status, "fulfilled");
  assert.deepEqual(results[1].value, firstReceipt.toJSON());
  assert.throws(() => firstEvidence.assertCurrent(), failure("PROCESS_EXECUTION_RECOVERY_AUTHORITY_EXPIRED"));
  assert.throws(() => secondEvidence.assertCurrent(), failure("PROCESS_EXECUTION_RECOVERY_AUTHORITY_EXPIRED"));
  const laterCall = await runtime.reserveCall({ binding, invocation: { commandId: "after-queued-recovery" } });
  const laterReceipt = await completeReservedCall(runtime, laterCall);
  assert.equal(laterReceipt.callId, laterCall.callId);
  assert.equal(laterReceipt.stopEvidence.status, "confirmed");
  await runtime.close();
  const saved = ProcessExecutionRuntime.inspect(options);
  assert.equal(saved.slot, null);
  const execution = saved.executions.find((entry) => entry.executionId === runtime.executionId);
  assert.equal(execution.status, "closed");
  assert.equal(execution.recoveryFence, null);
  assert.deepEqual(execution.calls.map((call) => call.receipt), [firstReceipt.toJSON(), laterReceipt.toJSON()]);
});
