import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { AgentProcessStopEvidence } from "../../../src/lib/agent-failure.js";
import { ProcessExecutionBinding, ProcessExecutionControlFailure, ProcessExecutionRuntime, ProcessExecutionStopReceipt,
  PROCESS_EXECUTION_SCOPE_ENV } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const moduleURL = pathToFileURL(path.resolve("src/lib/process-execution-runtime.js")).href;
function fixture(t) {
  const mainRoot = createTmpDir("process-runtime-", { parent: path.resolve(".tmp/c2f6/runtime-registry-fixtures") });
  t.after(() => removeTmpDir(mainRoot));
  return { mainRoot, executionRoot: mainRoot, runId: "runtime-run", specId: "runtime-spec" };
}
function registryPath(mainRoot) {
  const key = crypto.createHash("sha256").update(JSON.stringify(mainRoot)).digest("hex");
  return path.join(mainRoot, ".sennel", "process-runtime", key, "registry.json");
}
async function holder(t, options, reserve = false) {
  const bootstrap = new URL("../../../src/sennel.js", import.meta.url).href;
  const managedURL = new URL("../../../src/lib/managed-process.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", bootstrap, "--input-type=module", "-e", `
    import { ProcessExecutionRuntime } from ${JSON.stringify(moduleURL)};
    const runtime = await ProcessExecutionRuntime.acquire(${JSON.stringify(options)});
    if (${reserve === true}) await runtime.reserveCall({ invocation: { commandId: "interrupted-before-launch" } });
    if (${reserve === "managed"}) {
      const { executeManagedProcess } = await import(${JSON.stringify(managedURL)});
      await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "process.stdout.write('durable-before-crash')"], {
        timeoutMs: 10000, graceMs: 100, maxBuffer: 1024,
      }));
    }
    process.send({executionId: runtime.executionId});
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr.on("data", (bytes) => { stderr += bytes; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
  });
  const ready = new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`Holder exited before ready: ${code}/${signal}: ${stderr}`)));
  });
  return { child, ...(await ready) };
}
async function killHolder(child) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
function failure(code) { return (error) => error instanceof ProcessExecutionControlFailure && error.code === code; }

// Outcomes: reusable checkout only after receipts; live BUSY; orphan empty recovery;
// unidentifiable launch refusal; corrupt/deleted/symlink/uncertain records preserve
// the slot. Producers use acquire/reserve/managed launch, persistence is inspected
// through the production readback API and recovery constructs a new coordinator.
test("checkout slot remains busy for a live coordinator and reopens at a new owner epoch", async (t) => {
  const options = fixture(t); const runtime = await ProcessExecutionRuntime.acquire(options);
  await assert.rejects(ProcessExecutionRuntime.acquire({ ...options, runId: "another-run" }), failure("PROCESS_EXECUTION_BUSY"));
  assert.equal(runtime.inspect().slot, runtime.executionId);
  assert.throws(() => ProcessExecutionRuntime.assertQuiescent(options), failure("PROCESS_EXECUTION_BUSY"));
  runtime.enter(() => {
    ProcessExecutionRuntime.assertQuiescent(options);
    assert.throws(() => ProcessExecutionRuntime.assertQuiescent({ ...options, runId: "another-run" }), failure("PROCESS_EXECUTION_BUSY"));
  });
  await runtime.close();
  ProcessExecutionRuntime.assertQuiescent(options);
  const next = await ProcessExecutionRuntime.acquire(options);
  assert.equal(next.ownerEpoch, runtime.ownerEpoch + 1);
  await next.close();
});

test("fresh binding scopes share the owner and persist first run identity before physical calls", async (t) => {
  const options = fixture(t); const runtime = await ProcessExecutionRuntime.acquire({ ...options, runId: null, specId: null });
  const binding = new ProcessExecutionBinding({ runId: options.runId, specId: options.specId, attemptId: "attempt-1", executionContractId: "contract-1" });
  await runtime.withBinding(binding, async () => {
    const scope = ProcessExecutionRuntime.current();
    assert.equal(scope.executionId, runtime.executionId);
    const call = await scope.reserveCall({ invocation: { commandId: "not-spawned" } });
    assert.deepEqual(call.binding.toJSON(), binding.toJSON());
    await scope.finishCall(call, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() });
  });
  assert.equal(ProcessExecutionRuntime.current(), null);
  const saved = runtime.inspect().executions[0];
  assert.equal(saved.runId, options.runId);
  assert.equal(saved.calls[0].receipt.binding.attemptId, "attempt-1");
  await assert.rejects(runtime.withBinding({ runId: "different-run" }, () => {}), failure("PROCESS_EXECUTION_BINDING_MISMATCH"));
  await runtime.close();
});

test("parallel call reservations use shared admission and individual receipts allow another physical call", async (t) => {
  const options = fixture(t); const runtime = await ProcessExecutionRuntime.acquire(options);
  const calls = await Promise.all(Array.from({ length: 3 }, (_, index) => runtime.reserveCall({ invocation: { index } })));
  assert.equal(new Set(calls.map((call) => call.callId)).size, 3);
  await Promise.all(calls.map((call) => runtime.finishCall(call, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() })));
  const retry = await runtime.reserveCall({ invocation: { retry: true } });
  await runtime.finishCall(retry, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() });
  await runtime.close();
  const saved = runtime.inspect().executions[0];
  assert.equal(saved.accepting, false);
  assert.equal(saved.calls.length, 4);
  assert.ok(saved.calls.every((call) => call.receipt.stopEvidence.status === "confirmed"));
  await assert.rejects(runtime.reserveCall(), failure("PROCESS_EXECUTION_REGISTRATION_CLOSED"));
});

test("managed provider termination receipt is read back by a new coordinator before checkout reuse", async (t) => {
  const options = fixture(t); const runtime = await ProcessExecutionRuntime.acquire(options);
  const result = await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "process.stdout.write('completed')"], {
    timeoutMs: 10000, graceMs: 100, maxBuffer: 1024,
  }));
  assert.equal(result.stdout, "completed");
  const call = runtime.inspect().executions[0].calls[0];
  assert.equal(call.status, "stopped");
  assert.equal(call.permit.callId, call.callId);
  assert.equal(call.receipt.callId, call.callId);
  assert.equal(call.receipt.stopEvidence.status, "confirmed");
  await runtime.close();
  const next = await ProcessExecutionRuntime.acquire(options);
  const saved = next.inspect().executions.find((entry) => entry.executionId === runtime.executionId);
  assert.equal(saved.status, "closed");
  assert.deepEqual(saved.calls[0].receipt, call.receipt);
  const receipts = next.stopReceipts();
  assert.equal(receipts.length, 1);
  assert.ok(receipts[0] instanceof ProcessExecutionStopReceipt);
  assert.deepEqual(receipts[0].toJSON().binding, call.binding);
  assert.equal(next.stopReceipts({ attemptId: "another-attempt" }).length, 0);
  await next.close();
});

test("new process reads a killed coordinator inventory and proves empty execution closure before replacement", async (t) => {
  const options = fixture(t); const { child, executionId } = await holder(t, options);
  await assert.rejects(ProcessExecutionRuntime.acquire(options), failure("PROCESS_EXECUTION_BUSY"));
  await killHolder(child);
  const runtime = await ProcessExecutionRuntime.acquire(options);
  const orphan = runtime.inspect().executions.find((entry) => entry.executionId === executionId);
  assert.equal(orphan.status, "closed");
  assert.equal(orphan.closure.recovery, true);
  assert.equal(runtime.ownerEpoch, orphan.ownerEpoch + 1);
  await runtime.close();
});

test("a fresh coordinator reuses the exact durable physical receipt after the producing process dies", async (t) => {
  const options = fixture(t); const { child, executionId } = await holder(t, options, "managed");
  const produced = ProcessExecutionRuntime.inspect(options).executions[0].calls[0].receipt;
  assert.equal(produced.stopEvidence.status, "confirmed");
  await killHolder(child);
  const runtime = await ProcessExecutionRuntime.acquire(options);
  const recovered = runtime.inspect().executions.find((entry) => entry.executionId === executionId);
  assert.equal(recovered.status, "closed");
  assert.equal(recovered.closure.recovery, true);
  assert.deepEqual(recovered.calls[0].receipt, produced);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.stopReceipts()[0])), produced);
  await runtime.close();
});

test("unknown launcher behind persisted intent refuses orphan recovery and keeps the slot", async (t) => {
  const options = fixture(t); const { child, executionId } = await holder(t, options, true);
  await killHolder(child);
  await assert.rejects(ProcessExecutionRuntime.acquire(options), failure("PROCESS_EXECUTION_STOP_UNCONFIRMED"));
  const saved = ProcessExecutionRuntime.inspect(options);
  assert.equal(saved.slot, executionId);
  assert.equal(saved.executions[0].accepting, false);
  assert.equal(saved.executions[0].calls[0].receipt, null);
  assert.throws(() => ProcessExecutionRuntime.assertQuiescent(options), failure("PROCESS_EXECUTION_BUSY"));
});

test("removing the registry cannot clear a killed coordinator slot", async (t) => {
  const options = fixture(t); const { child } = await holder(t, options);
  await killHolder(child);
  new AtomicFile(registryPath(options.mainRoot)).remove();
  await assert.rejects(ProcessExecutionRuntime.acquire(options), failure("PROCESS_EXECUTION_RECORD_MISSING"));
});

test("corrupt and symlink runtime records are rejected without writing replacement inventory", async (t) => {
  for (const kind of ["corrupt", "symlink"]) {
    await t.test(kind, async (t) => {
      const options = fixture(t); const { child } = await holder(t, options);
      await killHolder(child);
      const file = registryPath(options.mainRoot);
      const old = fs.readFileSync(file);
      if (kind === "corrupt") fs.writeFileSync(file, '{"payload":{},"digest":"wrong"}');
      else {
        const target = path.join(options.mainRoot, "unrelated.json"); fs.writeFileSync(target, old);
        fs.unlinkSync(file); fs.symlinkSync(target, file);
      }
      const before = fs.readFileSync(file);
      await assert.rejects(ProcessExecutionRuntime.acquire(options), (error) => error instanceof ProcessExecutionControlFailure);
      assert.deepEqual(fs.readFileSync(file), before);
    });
  }
});

test("uncertain fsync leaves durable transition marker and all later inspection refuses", async (t) => {
  const options = fixture(t); let armed = false;
  const runtime = await ProcessExecutionRuntime.acquire({ ...options, faultInjector({ phase }) {
    if (armed && phase === "before-runtime-directory-fsync") throw new Error("injected runtime fsync failure");
  } });
  armed = true;
  await assert.rejects(runtime.reserveCall(), failure("PROCESS_EXECUTION_DURABILITY_UNCERTAIN"));
  assert.throws(() => ProcessExecutionRuntime.inspect(options), failure("PROCESS_EXECUTION_DURABILITY_UNCERTAIN"));
  await assert.rejects(runtime.close(), failure("PROCESS_EXECUTION_DURABILITY_UNCERTAIN"));
});

test("environment capability alone cannot borrow from outside the registered parent process group", async (t) => {
  const options = fixture(t); const runtime = await ProcessExecutionRuntime.acquire(options);
  const call = await runtime.reserveCall();
  await assert.rejects(ProcessExecutionRuntime.acquire({ ...options, environment: call.executionEnvironment() }), failure("PROCESS_EXECUTION_DELEGATION_REFUSED"));
  await runtime.finishCall(call, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() });
  await runtime.close();
});

test("different checkouts have independent slots and readonly absence creates no runtime metadata", async (t) => {
  const options = fixture(t); const checkout = path.join(options.mainRoot, "checkout"); fs.mkdirSync(checkout);
  ProcessExecutionRuntime.assertQuiescent(options);
  assert.equal(fs.existsSync(path.join(options.mainRoot, ".sennel")), false);
  const first = await ProcessExecutionRuntime.acquire(options);
  const second = await ProcessExecutionRuntime.acquire({ ...options, executionRoot: checkout });
  assert.notEqual(first.executionId, second.executionId);
  await first.close(); await second.close();
});

test("a forged nested grant cannot initialize runtime directories in a fresh checkout", async (t) => {
  const options = fixture(t);
  const environment = { [PROCESS_EXECUTION_SCOPE_ENV]: JSON.stringify({ version: 1,
    mainRoot: options.mainRoot, executionRoot: options.executionRoot, executionId: crypto.randomUUID(),
    callId: crypto.randomUUID(), ownerEpoch: 1, ownerToken: crypto.randomUUID(), capability: crypto.randomUUID(),
    runId: options.runId, specId: options.specId, bindingDigest: "0".repeat(64) }) };
  await assert.rejects(ProcessExecutionRuntime.acquire({ ...options, environment }), (error) => error instanceof ProcessExecutionControlFailure);
  assert.equal(fs.existsSync(path.join(options.mainRoot, ".sennel")), false);
});

test("a running managed call refuses synchronous recovery before any protected write", async (t) => {
  const options = fixture(t); const runtime = await ProcessExecutionRuntime.acquire(options);
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
    }), (error) => error === reason);
    assert.equal(guarded, true);
    ProcessExecutionRuntime.assertQuiescent(options);
  });
  await runtime.close();
});

test("a legitimate nested member cannot reserve a physical call for a different parent binding", async (t) => {
  const options = fixture(t);
  const binding = new ProcessExecutionBinding({ runId: options.runId, specId: options.specId, attemptId: "parent-attempt", executionContractId: "parent-contract" });
  const runtime = await ProcessExecutionRuntime.acquire({ ...options, binding });
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
  const result = await runtime.enter(() => executeManagedProcess(process.execPath, [script], {
    cwd: options.mainRoot, timeoutMs: 10000, graceMs: 100, maxBuffer: 1024,
  }));
  assert.equal(result.stdout, "PROCESS_EXECUTION_DELEGATION_REFUSED");
  assert.equal(runtime.inspect().executions[0].calls.length, 1);
  await runtime.close();
});
