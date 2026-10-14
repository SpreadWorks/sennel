import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { AgentTimeoutDiagnostic } from "../../../src/lib/agent-timeout.js";
import { ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure, ProcessExecutionStopReceipt, ProcessExecutionBinding } from "../../../src/lib/process-execution-runtime.js";
import { runManagedCmdAsync, runCmdAsync } from "../../../src/lib/process.js";
import { RuntimeChildExecution, currentRuntimePackage } from "../../../src/lib/runtime-package.js";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { PromptBatchExecutor, PromptBatchPlan, PromptExecutionBudget, PromptExecutionLimit } from "../../../src/lib/prompt-batching.js";
import { PromptExecutionJournal, PromptExecutionJournalSnapshot, PromptExecutionJournalWriter, PromptExecutionScope } from "../../../src/lib/prompt-execution-journal.js";
import { ManagedLauncher } from "../../../src/lib/managed-process-launcher.js";
import { executeManagedProcess, readManagedSettlement, verifyManagedProcessStopped } from "../../../src/lib/managed-process.js";
import { managedRequest, readManagedRecord, writeManagedRecord } from "../../../src/lib/managed-process-protocol.js";

async function fixture(t) {
  const root = createTmpDir("managed-process-");
  let runtime;
  t.after(async () => {
    try { if (runtime && !runtime.closed) await runtime.close(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root });
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

test("managed child retains fd 3 snapshot delivery through the anchor's separate descriptor", async (t) => {
  const { root, runtime } = await fixture(t);
  const script = path.join(root, "child.mjs");
  fs.writeFileSync(script, `import {currentRuntimePackage} from ${JSON.stringify(new URL("../../../src/lib/runtime-package.js", import.meta.url).href)};console.log(currentRuntimePackage().revision);`);
  const result = await runtime.enter(() => RuntimeChildExecution.runAsync(script, [], { cwd: root, timeout: 20000 }));
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout.trim(), currentRuntimePackage().revision);
});

test("managed timeout retains provider timeout classification only after confirmed group death", async (t) => {
  const { root, runtime } = await fixture(t);
  const configuredTimeoutMs = 10000;
  const invokedAt = Date.now();
  let providerReadyAt;
  await assert.rejects(runtime.enter(() => executeManagedProcess(process.execPath,
    ["-e", "process.stdout.write('started');setInterval(()=>{},1000)"],
    { cwd: root, timeoutMs: configuredTimeoutMs, graceMs: 200,
      onStdout() { providerReadyAt = Date.now(); } })), (error) => {
    assert.equal(error.name, "AgentTimeoutError", `${error.code}: ${error.message}`);
    assert.equal(error.stopEvidence.confirmed, true);
    assert.equal(error.stdout, "started");
    assert.equal(error.timeoutMs, configuredTimeoutMs);
    const call = runtime.store.read().executions.at(-1).calls[0];
    assert.equal(call.invocation.timeoutMs, configuredTimeoutMs);
    assert.ok(providerReadyAt < call.invocation.deadline, "this case exercises expiration after provider startup");
    assert.ok(call.invocation.deadline >= invokedAt + configuredTimeoutMs);
    assert.ok(call.invocation.deadline < providerReadyAt + configuredTimeoutMs,
      "provider startup must not renew the original deadline");
    assert.ok(Date.now() >= call.invocation.deadline, "timeout cannot settle before its original deadline");
    return true;
  });
});

test("ordinary asynchronous commands preserve extra descriptors with supervised cancellation", async (t) => {
  const root = createTmpDir("process-fd-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "delivery");
  fs.writeFileSync(file, "descriptor-data");
  const descriptor = fs.openSync(file, "r");
  t.after(() => fs.closeSync(descriptor));
  const result = await runCmdAsync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync(3))"], {
    stdio: ["ignore", "pipe", "pipe", descriptor], signal: new AbortController().signal,
  });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout, "descriptor-data");
});

test("normal provider exit waits for a descendant's output and group disappearance", async (t) => {
  const { root, runtime } = await fixture(t);
  const descendant = "setTimeout(()=>{process.stdout.write('descendant');},100)";
  const result = await runtime.enter(() => runManagedCmdAsync(process.execPath, ["-e",
    `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]}).unref();process.exit(0);`],
  { cwd: root, timeout: 20000 }));
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout, "descendant");
  assert.equal(result.stopEvidence.confirmed, true);
});

test("TERM ignoring provider is killed by its live group anchor before a timeout receipt", async (t) => {
  const { root, runtime } = await fixture(t);
  let expire;
  const activityMonitor = {
    start(callback) { expire = callback; },
    observeOutput() { expire(new AgentTimeoutDiagnostic({ reason: "maximum_lifetime", timeoutMs: 10000 })); },
    stop() {},
  };
  await assert.rejects(runtime.enter(() => executeManagedProcess(process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],
    { cwd: root, timeoutMs: 10000, graceMs: 100, activityMonitor })), (error) => {
    assert.equal(error.name, "AgentTimeoutError", `${error.code}: ${error.message}`);
    assert.equal(error.finalAction, "SIGKILL");
    assert.equal(error.stopEvidence.confirmed, true);
    assert.equal(error.stdout, "ready");
    return true;
  });
});

test("nested managed calls register distinct groups under the same root execution", async (t) => {
  const { root, runtime } = await fixture(t);
  const script = path.join(root, "nested.mjs");
  fs.writeFileSync(script, `
    import {ProcessExecutionRuntime} from ${JSON.stringify(new URL("../../../src/lib/process-execution-runtime.js", import.meta.url).href)};
    import {runManagedCmdAsync} from ${JSON.stringify(new URL("../../../src/lib/process.js", import.meta.url).href)};
    const result=await runManagedCmdAsync(process.execPath,['-e','process.stdout.write("nested-output")'],{timeout:20000});
    console.log(JSON.stringify({id:result.processExecutionStopReceipt.executionId,output:result.stdout}));
    if(ProcessExecutionRuntime.current()!==null)throw new Error('Borrowed scope leaked');
  `);
  const result = await runtime.enter(() => RuntimeChildExecution.runAsync(script, [], { cwd: root, timeout: 40000 }));
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { id: runtime.executionId, output: "nested-output" });
  const calls = runtime.store.read().executions.at(-1).calls;
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].pgid, calls[1].pgid);
  assert.equal(calls[1].parentCallId, calls[0].callId);
  assert.equal(calls.every((call) => call.receipt !== null), true);
});

test("a raw child CLI cannot turn a confirmed nested receipt delivery failure into an ordinary exit result", async (t) => {
  const { root, runtime } = await fixture(t);
  const script = path.join(root, "nested-receipt-failure.mjs");
  fs.writeFileSync(script, `
    import {runManagedCmdAsync} from ${JSON.stringify(new URL("../../../src/lib/process.js", import.meta.url).href)};
    try {
      await runManagedCmdAsync(process.execPath,['-e','process.stdout.write("completed")'],{
        timeout:20000,onProcessExecutionStop(){throw new Error('consumer receipt persistence failed')}
      });
    } catch(error) { console.error(error.stack); process.exitCode=1; }
  `);
  let observed = false;
  await assert.rejects(runtime.enter(() => RuntimeChildExecution.runAsync(script, [], {
    cwd: root, timeout: 40000, onProcessExecutionStop() { observed = true; },
  })), (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_RECEIPT_DELIVERY_FAILED");
  assert.equal(observed, false, "a command result consumer cannot observe a subtree with a control failure");
  const calls = runtime.store.read().executions.at(-1).calls;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].parentCallId, calls[0].callId);
  assert.equal(calls[1].receipt.stopEvidence.confirmed, true);
  assert.equal(calls[1].controlFailure.code, "PROCESS_EXECUTION_RECEIPT_DELIVERY_FAILED");
  assert.equal(calls[0].outcome.code, 1);
  assert.equal(calls[0].receipt.stopEvidence.confirmed, true);
});

test("a child exit cannot publish its outer receipt while a stopped nested call lacks its durable receipt", async (t) => {
  const { root, runtime } = await fixture(t);
  const script = path.join(root, "nested-unreceipted.mjs");
  fs.writeFileSync(script, `
    import {withManagedProcessScope,executeManagedProcess} from ${JSON.stringify(new URL("../../../src/lib/managed-process.js", import.meta.url).href)};
    await withManagedProcessScope({executionRoot:process.cwd()},()=>executeManagedProcess(process.execPath,['-e',''],{
      cwd:process.cwd(),timeoutMs:20000,onSupervisorEvent(event){if(event.type==='provider-settled')process.exit(1)}
    }));
  `);
  let observed = false;
  await assert.rejects(runtime.enter(() => RuntimeChildExecution.runAsync(script, [], {
    cwd: root, timeout: 40000, onProcessExecutionStop() { observed = true; },
  })), (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_STOP_UNCONFIRMED");
  assert.equal(observed, false);
  const calls = runtime.store.read().executions.at(-1).calls;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].parentCallId, calls[0].callId);
  assert.equal(calls[1].receipt, null);
  assert.equal(calls[0].receipt.stopEvidence.confirmed, true);
  await runtime.close();
  const saved = ProcessExecutionRuntime.inspect({ mainRoot: root });
  assert.equal(saved.slot, null);
  assert.equal(saved.executions.at(-1).calls.every((call) => call.receipt !== null), true);
});

test("a delegated child reports checkout admission refusal before starting another physical call", async (t) => {
  const { root, runtime } = await fixture(t);
  fs.mkdirSync(path.join(root, "other"));
  const script = path.join(root, "nested-checkout-refusal.mjs");
  fs.writeFileSync(script, `
    import {runManagedCmdAsync} from ${JSON.stringify(new URL("../../../src/lib/process.js", import.meta.url).href)};
    process.chdir('other');
    try {await runManagedCmdAsync(process.execPath,['-e','require("fs").writeFileSync("unexpected","started")'],{timeout:20000});}
    catch(error){console.error(error.stack);process.exitCode=1;}
  `);
  let observed = false;
  await assert.rejects(runtime.enter(() => RuntimeChildExecution.runAsync(script, [], {
    cwd: root, timeout: 40000, onProcessExecutionStop() { observed = true; },
  })), (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_DELEGATION_REFUSED");
  assert.equal(observed, false);
  assert.equal(fs.existsSync(path.join(root, "other", "unexpected")), false);
  const calls = runtime.store.read().executions.at(-1).calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].controlFailure.code, "PROCESS_EXECUTION_DELEGATION_REFUSED");
  assert.equal(calls[0].receipt.stopEvidence.confirmed, true);
});

test("a forged child reporting capability cannot poison the owning execution", async (t) => {
  const { root, runtime } = await fixture(t);
  const script = path.join(root, "nested-forged-report.mjs");
  fs.writeFileSync(script, `
    import {ProcessExecutionRuntime,ProcessExecutionControlFailure,PROCESS_EXECUTION_SCOPE_ENV} from ${JSON.stringify(new URL("../../../src/lib/process-execution-runtime.js", import.meta.url).href)};
    const grant=JSON.parse(process.env[PROCESS_EXECUTION_SCOPE_ENV]);
    grant.capability='00000000-0000-4000-8000-000000000000';
    try {
      await ProcessExecutionRuntime.reportDelegatedControlFailure({environment:{...process.env,[PROCESS_EXECUTION_SCOPE_ENV]:JSON.stringify(grant)},
        error:new ProcessExecutionControlFailure('forged-report','forged failure')});
      throw new Error('forged reporting was accepted');
    } catch(error) {
      if(!(error instanceof ProcessExecutionControlFailure)||error.code!=='PROCESS_EXECUTION_DELEGATION_REFUSED')throw error;
      console.log('refused');
    }
  `);
  const result = await runtime.enter(() => RuntimeChildExecution.runAsync(script, [], { cwd: root, timeout: 40000 }));
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout.trim(), "refused");
  const calls = runtime.store.read().executions.at(-1).calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].controlFailure, null);
  assert.equal(calls[0].receipt.stopEvidence.confirmed, true);
});

async function waitForFile(file, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`File barrier did not arrive: ${file}`);
    await delay(10);
  }
}

test("coordinator SIGKILL leaves a draining reconnectable anchor that recovery stops before readmission", async (t) => {
  const root = createTmpDir("managed-orphan-");
  let child;
  let recovery;
  t.after(async () => {
    try {
      if (child?.exitCode === null && child?.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
      if (!recovery) recovery = await ProcessExecutionRuntime.acquire({ mainRoot: root });
      await recovery.close();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const script = path.join(root, "coordinator.mjs");
  const provider = `const fs=require('fs');fs.writeFileSync('ready',String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync('stopped','yes');process.exit(0)});setInterval(()=>{process.stdout.write('ongoing-output');if(fs.existsSync('disconnected'))fs.writeFileSync('drained','yes')},10);`;
  fs.writeFileSync(script, `
    import {ProcessExecutionRuntime} from ${JSON.stringify(new URL("../../../src/lib/process-execution-runtime.js", import.meta.url).href)};
    import {executeManagedProcess} from ${JSON.stringify(new URL("../../../src/lib/managed-process.js", import.meta.url).href)};
    const runtime=await ProcessExecutionRuntime.acquire({mainRoot:process.cwd()});
    await runtime.enter(()=>executeManagedProcess(process.execPath,['-e',${JSON.stringify(provider)}],{timeoutMs:40000,cwd:process.cwd()}));
    await runtime.close();
  `);
  const delivery = new RuntimeChildExecution();
  try { child = spawn(process.execPath, [script], delivery.options({ cwd: root })); }
  finally { delivery.close(); }
  child.stdout.resume(); child.stderr.resume();
  await waitForFile(path.join(root, "ready"));
  const providerIdentity = new ProcessIdentitySource({ pid: Number(fs.readFileSync(path.join(root, "ready"), "utf8")) }).createOwner("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  child.kill("SIGKILL");
  await once(child, "exit");
  fs.writeFileSync(path.join(root, "disconnected"), "yes");
  await waitForFile(path.join(root, "drained"));
  assert.equal(new ProcessIdentitySource().assess(providerIdentity).status, "live");
  recovery = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  assert.equal(fs.readFileSync(path.join(root, "stopped"), "utf8"), "yes");
  assert.equal(new ProcessIdentitySource().assess(providerIdentity).status, "stale");
  const next = await recovery.enter(() => runManagedCmdAsync(process.execPath, ["-e", "process.stdout.write('successor')"], { timeout: 20000 }));
  assert.equal(next.stdout, "successor");
  assert.equal(next.ok, true);
});

test("stop receipt persistence failure stays a control failure and retains the occupied slot", async (t) => {
  const root = createTmpDir("managed-receipt-failure-");
  let runtime;
  t.after(async () => {
    try { if (runtime) await assert.rejects(runtime.close(), ProcessExecutionControlFailure); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, faultInjector(event) {
    if (event.phase !== "before-runtime-rename") return;
    const payload = JSON.parse(fs.readFileSync(event.tempPath, "utf8")).payload;
    if (payload.executions.some((execution) => execution.calls.some((call) => call.receipt !== null))) {
      throw new Error("injected receipt save failure");
    }
  } });
  await assert.rejects(runtime.enter(() => runManagedCmdAsync(process.execPath, ["-e", "process.stdout.write('provider-completed')"], { timeout: 20000 })), (error) => {
    assert.equal(error instanceof ProcessExecutionControlFailure, true);
    assert.equal(error.code, "PROCESS_EXECUTION_REGISTRY_FAILED");
    return true;
  });
  const registry = runtime.store.read();
  assert.equal(registry.slot, runtime.executionId);
  assert.equal(registry.executions.at(-1).calls[0].receipt, null);
});


test("wrong reconnect capability cannot stop a live managed provider", async (t) => {
  const { root, runtime } = await fixture(t);
  const controller = new AbortController();
  const execution = runtime.enter(() => runManagedCmdAsync(process.execPath, ["-e",
    "const fs=require('fs');fs.writeFileSync('ready','yes');setInterval(()=>{if(fs.existsSync('release')){process.stdout.write('kept-running');process.exit(0)}},10)"],
  { cwd: root, timeout: 20000, signal: controller.signal }));
  // Register cleanup before awaiting the provider's readiness barrier.
  t.after(() => controller.abort());
  await waitForFile(path.join(root, "ready"));
  const call = runtime.store.read().executions.at(-1).calls[0];
  await assert.rejects(managedRequest({ ...call, executionId: runtime.executionId, ownerToken: runtime.ownerToken,
    capability: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, "stop"),
  { code: "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE" });
  fs.writeFileSync(path.join(root, "release"), "yes");
  const result = await execution;
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout, "kept-running");
});

test("bounded output overflow remains a control failure after stopping the group", async (t) => {
  const root = createTmpDir("managed-output-failure-");
  let runtime;
  t.after(async () => {
    try { if (runtime) await assert.rejects(runtime.close(), { code: "PROCESS_EXECUTION_OUTPUT_LIMIT" }); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  await assert.rejects(runtime.enter(() => runManagedCmdAsync(process.execPath,
    ["-e", "process.stdout.write('x'.repeat(1024));setInterval(()=>{},1000)"],
    { timeout: 20000, maxBuffer: 64 })), { code: "PROCESS_EXECUTION_OUTPUT_LIMIT" });
  assert.equal(runtime.store.read().slot, runtime.executionId);
});


test("visible but durability-uncertain launcher record is rejected across a fresh reader", (t) => {
  const root = createTmpDir("managed-record-durability-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "outcome.json");
  const record = { executionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    callId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "finished" };
  assert.throws(() => writeManagedRecord(file, record, { faultInjector({ phase }) {
    if (phase === "before-file-directory-fsync") throw new Error("injected directory fsync failure");
  } }), { code: "PROCESS_EXECUTION_RECORD_SAVE_FAILED" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), record);
  assert.throws(() => readManagedRecord(file), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
});


test("nested Agent call authenticates inherited delegation before provider admission and delivers its exact stop receipt", async (t) => {
  const { root, runtime } = await fixture(t);
  const script = path.join(root, "agent-child.mjs");
  const moduleUrl = (name) => JSON.stringify(new URL(`../../../src/lib/${name}.js`, import.meta.url).href);
  fs.writeFileSync(script, `
    import path from 'node:path';
    import {Agent} from ${moduleUrl("agent")};
    import {ProviderRegistry} from ${moduleUrl("provider")};
    import {Logger} from ${moduleUrl("log")};
    import {ProcessExecutionRuntime} from ${moduleUrl("process-execution-runtime")};
    const config={agent:{default:'test/exec',providers:{'test/exec':{command:process.execPath,args:['-e','process.stdout.write("agent-output")']}},timeout:20}};
    const agent=new Agent({config,paths:{root:process.cwd(),agentWorkDir:path.join(process.cwd(),'.tmp')},registry:new ProviderRegistry(config.agent.providers),logger:new Logger({enabled:false})});
    let receipt;
    const output=await agent.call('',{retryCount:0,cacheMode:'bypass',onProcessExecutionStop(value){receipt=value.toJSON()}});
    console.log(JSON.stringify({output,receipt,scopeClosed:ProcessExecutionRuntime.current()===null}));
  `);
  const result = await runtime.enter(() => RuntimeChildExecution.runAsync(script, [], { cwd: root, timeout: 40000 }));
  assert.equal(result.ok, true, result.stderr);
  const child = JSON.parse(result.stdout);
  assert.equal(child.output, "agent-output");
  assert.equal(child.scopeClosed, true);
  const execution = runtime.store.read().executions.at(-1);
  assert.equal(execution.accepting, true);
  assert.equal(execution.calls.length, 2);
  const provider = execution.calls.find((call) => call.callId === child.receipt.callId);
  assert.equal(provider.parentCallId, execution.calls[0].callId);
  assert.notEqual(provider.pgid, execution.calls[0].pgid);
  assert.deepEqual(provider.receipt, new ProcessExecutionStopReceipt(child.receipt));
});

test("forged inherited delegation rejects an Agent call before admission or provider effects", async (t) => {
  const { root, runtime } = await fixture(t);
  const script = path.join(root, "forged-agent-child.mjs");
  const moduleUrl = (name) => JSON.stringify(new URL(`../../../src/lib/${name}.js`, import.meta.url).href);
  fs.writeFileSync(script, `
    import path from 'node:path';
    import {Agent} from ${moduleUrl("agent")};
    import {ProviderRegistry} from ${moduleUrl("provider")};
    import {Logger} from ${moduleUrl("log")};
    const config={agent:{default:'test/exec',providers:{'test/exec':{command:process.execPath,args:['-e','require("fs").writeFileSync("unwanted","yes")']}},timeout:20}};
    const agent=new Agent({config,paths:{root:process.cwd(),agentWorkDir:path.join(process.cwd(),'.tmp')},registry:new ProviderRegistry(config.agent.providers),logger:new Logger({enabled:false})});
    let admitted=false;
    const {AgentProviderAttemptAdmission}=await import(${moduleUrl("agent-provider-attempt")});
    class Admission extends AgentProviderAttemptAdmission { async beforeProviderAttempt(){admitted=true} }
    try{await agent.call('',{providerAttemptAdmission:new Admission()});throw new Error('Unexpected success')}
    catch(error){console.log(JSON.stringify({name:error.name,code:error.code,admitted}))}
  `);
  const result = await RuntimeChildExecution.runAsync(script, [], { cwd: root, timeout: 40000,
    env: { ...process.env, SENNEL_PROCESS_EXECUTION_SCOPE: "invalid-json" } });
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { name: "ProcessExecutionControlFailure", code: "PROCESS_EXECUTION_DELEGATION_REFUSED", admitted: false });
  assert.equal(fs.existsSync(path.join(root, "unwanted")), false);
  assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
  assert.equal(runtime.store.read().executions.at(-1).calls.length, 0);
});


test("stop receipt callback failure remains a control failure and cannot retry a completed Agent provider", async (t) => {
  const { root, runtime } = await fixture(t);
  const config = { agent: { default: "test/exec", providers: { "test/exec": {
    command: process.execPath, args: ["-e", "process.stdout.write('completed')"],
  } }, timeout: 20 } };
  const agent = new Agent({ config, paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ enabled: false }) });
  await assert.rejects(runtime.enter(() => agent.call("", {
    retryCount: 2, retryDelayMs: 1, cacheMode: "bypass",
    onProcessExecutionStop() { throw new Error("caller receipt persistence failed"); },
  })), { code: "PROCESS_EXECUTION_RECEIPT_DELIVERY_FAILED" });
  const calls = runtime.store.read().executions.at(-1).calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receipt.stopEvidence.confirmed, true);
});


test("managed Agent persists exact Prompt physical identity before response and reloads the stop receipt", async (t) => {
  const { root, runtime } = await fixture(t);
  const binding = new ProcessExecutionBinding({ runId: "prompt-run", specId: "prompt-spec", nodeId: "evaluate",
    attemptId: "prompt-attempt", attemptSequence: 1, executionContractId: "prompt-contract", executionGeneration: 0 });
  class FileJournalWriter extends PromptExecutionJournalWriter {
    records = [];
    get processExecutionBinding() { return binding; }
    async save(record) {
      new AtomicFile(path.join(root, "prompt-journal.json")).write(JSON.stringify(record.snapshot));
      this.records.push(record.toJSON());
    }
  }
  const writer = new FileJournalWriter();
  const journal = new PromptExecutionJournal({ scope: new PromptExecutionScope({ stage: "evaluate", round: 0 }), writer });
  const config = { agent: { default: "test/exec", providers: { "test/exec": {
    command: process.execPath, args: ["-e", "process.stdout.write('completed')"],
  } }, timeout: 20 } };
  const agent = new Agent({ config, paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ enabled: false }) });
  const executor = new PromptBatchExecutor({ executionBudget: new PromptExecutionBudget(new PromptExecutionLimit()) });
  let callbacks = 0;
  await runtime.enter(() => executor.executeCompletions({
    plan: PromptBatchPlan.fromRequest({ request: "input" }), executionJournal: journal,
    responseContract: { parse: (raw) => raw },
    callAgent: (request, _batch, _retry, _context, providerCallAdmission) => agent.call(request.userPrompt, {
      providerCallAdmission, cacheMode: "bypass", retryCount: 0,
      onProcessExecutionStop(receipt) {
        callbacks += 1;
        assert.equal(writer.records.at(-1).event, "process-stopped");
        assert.deepEqual(new ProcessExecutionStopReceipt(writer.records.at(-1).snapshot.batches[0].processStops[0].receipt), receipt);
      },
    }),
  }));
  assert.equal(callbacks, 1);
  const claim = writer.records.find((record) => record.event === "claimed").snapshot;
  const stopped = writer.records.find((record) => record.event === "process-stopped").snapshot;
  assert.deepEqual(stopped.budget, claim.budget);
  assert.deepEqual(stopped.batches[0].claim, claim.batches[0].claim);
  const restored = PromptExecutionJournalSnapshot.fromJSON(JSON.parse(fs.readFileSync(path.join(root, "prompt-journal.json"), "utf8")));
  const observation = restored.batches[0].processStops[0];
  const call = runtime.store.read().executions.at(-1).calls[0];
  assert.deepEqual(new ProcessExecutionStopReceipt(observation.receipt), call.receipt);
  assert.deepEqual(observation.identity, call.invocation.promptProcessIdentity);
  assert.equal(observation.identity.providerAttemptId, call.invocation.providerAttemptContext.attemptId);
  assert.equal(observation.identity.logicalInvocationId, call.invocation.providerAttemptContext.logicalInvocationId);
  assert.deepEqual(call.receipt.binding.toJSON(), binding.toJSON());
});


test("large legal output streams stay outside the shared registry across physical calls", async (t) => {
  const { root, runtime } = await fixture(t);
  const size = 7 * 1024 * 1024;
  for (let index = 0; index < 2; index += 1) {
    const result = await runtime.enter(() => runManagedCmdAsync(process.execPath,
      ["-e", `process.stdout.write(Buffer.alloc(${size}, 97));process.stderr.write(Buffer.alloc(${size}, 98));`],
      { cwd: root, timeout: 40000, maxBuffer: 8 * 1024 * 1024 }));
    assert.equal(result.ok, true);
    assert.equal(result.stdout, "a".repeat(size));
    assert.equal(result.stderr, "b".repeat(size));
    const call = runtime.store.read().executions.at(-1).calls.at(-1);
    assert.equal(call.receipt.outcomeDigest, result.processExecutionStopReceipt.outcomeDigest);
    assert.equal(Object.hasOwn(call.outcome, "stdout"), false);
    assert.equal(Object.hasOwn(call.outcome, "stderr"), false);
    const directory = runtime.store.callDirectory(call.callId);
    assert.ok(fs.statSync(path.join(directory, "outcome.json")).size < 16384);
    assert.equal(fs.statSync(path.join(directory, "stdout.bin")).size, size);
    assert.equal(fs.statSync(path.join(directory, "stderr.bin")).size, size);
    assert.ok(fs.statSync(runtime.store.file.filePath).size < 65536);
  }
  const call = runtime.store.read().executions.at(-1).calls.at(-1);
  const directory = runtime.store.callDirectory(call.callId);
  fs.writeFileSync(path.join(directory, "stdout.bin"), Buffer.alloc(size, 99));
  assert.throws(() => readManagedSettlement({ ...call, executionId: runtime.executionId,
    ownerToken: runtime.ownerToken, outcomePath: path.join(directory, "outcome.json") }),
  { code: "PROCESS_EXECUTION_OUTPUT_CORRUPT" });
});

test("unknown membership refuses initial TERM and later KILL without losing control failure", (t) => {
  const root = createTmpDir("managed-membership-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals = [];
  t.mock.method(process, "kill", (pid, signal) => { signals.push({ pid, signal }); return true; });
  for (const failAt of [1, 2]) {
    const launcher = new ManagedLauncher({ call: { ownerToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      outcomePath: path.join(root, `outcome-${failAt}.json`) }, maxBuffer: 64, graceMs: 20 });
    launcher.child = {};
    let observed = 0;
    launcher.capture = () => {
      if (++observed === failAt) throw new ProcessExecutionControlFailure("OBSERVATION_UNKNOWN", "injected unavailable OS membership");
      return [];
    };
    launcher.stop("recovery");
    t.mock.timers.tick(20);
    assert.equal(launcher.state, "control-failed");
    assert.equal(launcher.controlFailure.code, "PROCESS_EXECUTION_OBSERVATION_UNKNOWN");
    assert.equal(readManagedRecord(launcher.call.outcomePath).controlFailure.code, "PROCESS_EXECUTION_OBSERVATION_UNKNOWN");
    launcher.stop("recovery");
    t.mock.timers.tick(100);
  }
  assert.deepEqual(signals, [{ pid: -process.pid, signal: "SIGTERM" }]);
});

test("control failure preserves a live managed group while its coordinator exits and fresh admission refuses", async (t) => {
  const root = createTmpDir("managed-control-exit-");
  const wrapper = path.join(root, "launcher-fixture.mjs");
  const script = path.join(root, "coordinator.mjs");
  const fixtureEndpoint = `\0sennel-fixture-${path.basename(root)}`;
  const moduleUrl = (name) => JSON.stringify(new URL(`../../../src/lib/${name}.js`, import.meta.url).href);
  let child;
  let exited = false;
  let call;
  let exit;
  t.after(async () => {
    try {
      if (fs.existsSync(path.join(root, "fixture-call.json"))) {
        const owned = JSON.parse(fs.readFileSync(path.join(root, "fixture-call.json"), "utf8"));
        const stopping = await managedRequest({ ...owned, endpoint: fixtureEndpoint }, "fixture-cleanup");
        const cleanupDeadline = Date.now() + 5000;
        while (!verifyManagedProcessStopped(stopping) && Date.now() < cleanupDeadline) await delay(20);
        assert.equal(verifyManagedProcessStopped(stopping), true, "the fixture endpoint must stop its entire owned group");
      }
      if (child && !exited) await exit;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  fs.writeFileSync(wrapper, `
    import fs from 'node:fs';
    import net from 'node:net';
    import {ManagedLauncher} from ${moduleUrl("managed-process-launcher")};
    import {ManagedProcessMessage, captureManagedMembers} from ${moduleUrl("managed-process-protocol")};
    let input='';for await(const bytes of process.stdin)input+=bytes;
    const config=JSON.parse(input);
    const readdir=fs.readdirSync;
    fs.readdirSync=function(directory,...args){
      if(directory==='/proc'&&fs.existsSync(${JSON.stringify(path.join(root, "observation-unavailable"))})){
        throw Object.assign(new Error('injected unavailable proc observation'),{code:'EIO'});
      }
      return readdir.call(this,directory,...args);
    };
    // This fixture alone owns a cleanup endpoint, independent of production
    // refusal. It restores the real observation before signaling its own group.
    const cleanup=net.createServer(socket=>{
      let body='';socket.on('error',()=>{});socket.on('data',bytes=>{
        body+=bytes;if(!body.includes('\\n'))return;
        const request=ManagedProcessMessage.from(JSON.parse(body.trim()));
        if(!request.matches(config.call)||request.operation!=='fixture-cleanup')return socket.destroy();
        fs.readdirSync=readdir;
        const members=captureManagedMembers(process.pid,config.call.ownerToken);
        socket.end(JSON.stringify(new ManagedProcessMessage(config.call,'response',{cleaning:true,pgid:process.pid,
          launcherIdentity:members.find(member=>member.pid===process.pid),members}))+'\\n');
        setTimeout(()=>{process.kill(-process.pid,'SIGTERM');setTimeout(()=>process.kill(-process.pid,'SIGKILL'),200)},20);
      });
    });
    await new Promise(resolve=>cleanup.listen(${JSON.stringify(fixtureEndpoint)},resolve));
    fs.writeFileSync(${JSON.stringify(path.join(root, "fixture-call.json"))},JSON.stringify(config.call));
    await new ManagedLauncher(config).run();
  `);
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {ProcessExecutionRuntime} from ${moduleUrl("process-execution-runtime")};
    import {executeManagedProcess} from ${moduleUrl("managed-process")};
    const spawn=childProcess.spawn;
    childProcess.spawn=function(command,args,options){
      if(args[0].endsWith('/managed-process-launcher.js'))args=[${JSON.stringify(wrapper)},...args.slice(1)];
      return spawn.call(this,command,args,options);
    };syncBuiltinESMExports();
    const runtime=await ProcessExecutionRuntime.acquire({mainRoot:process.cwd()});
    let failure,closureFailure;
    try{
      await runtime.enter(()=>executeManagedProcess(process.execPath,['-e',
        "const fs=require('fs');fs.writeFileSync('ready',String(process.pid));setInterval(()=>process.stdout.write('still-draining'),20)"],
        {cwd:process.cwd(),timeoutMs:40000,maxBuffer:1024*1024}));
    }catch(error){failure={name:error.name,code:error.code}}
    try{await runtime.close()}catch(error){closureFailure={name:error.name,code:error.code}}
    fs.writeFileSync('coordinator-result.json',JSON.stringify({failure,closureFailure}));
  `);
  const delivery = new RuntimeChildExecution();
  try { child = spawn(process.execPath, [script], delivery.options({ cwd: root })); }
  finally { delivery.close(); }
  child.stdout.resume();
  let diagnostic = "";
  child.stderr.on("data", (bytes) => { diagnostic += bytes; });
  exit = once(child, "exit").then((result) => { exited = true; return result; });
  await waitForFile(path.join(root, "ready"));
  call = JSON.parse(fs.readFileSync(path.join(root, "fixture-call.json"), "utf8"));
  fs.writeFileSync(path.join(root, "observation-unavailable"), "yes");
  await waitForFile(path.join(root, "coordinator-result.json"));
  const result = JSON.parse(fs.readFileSync(path.join(root, "coordinator-result.json"), "utf8"));
  assert.equal(result.failure.code, "PROCESS_EXECUTION_OBSERVATION_UNKNOWN");
  assert.equal(result.closureFailure.code, "PROCESS_EXECUTION_OBSERVATION_UNKNOWN");
  const live = await managedRequest(call, "status");
  assert.equal(live.state, "control-failed");
  const persisted = readManagedRecord(call.outcomePath);
  assert.equal(persisted.state, "control-failed");
  assert.equal(persisted.controlFailure.code, "PROCESS_EXECUTION_OBSERVATION_UNKNOWN");
  assert.match(persisted.controlFailure.message, /EIO: injected unavailable proc observation/);
  assert.ok(live.outcome.output.stdout.byteLength > 0);
  assert.equal(new ProcessIdentitySource().assess(live.launcherIdentity).status, "live");
  const finished = await Promise.race([exit, delay(2000).then(() => null)]);
  assert.notEqual(finished, null, `typed refusal must let the coordinator exit with its anchor still live: ${diagnostic}`);
  assert.deepEqual(finished, [0, null], diagnostic);
  const before = ProcessExecutionRuntime.inspect({ mainRoot: root });
  assert.equal(before.slot, call.executionId);
  assert.equal(before.executions.at(-1).accepting, false);
  assert.equal(before.executions.at(-1).status, "stopping");
  assert.equal(before.executions.at(-1).calls[0].receipt, null);
  await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: root }), { code: "PROCESS_EXECUTION_OBSERVATION_UNKNOWN" });
  const after = ProcessExecutionRuntime.inspect({ mainRoot: root });
  assert.equal(after.slot, call.executionId);
  assert.equal(after.executions.at(-1).accepting, false);
  assert.equal(after.executions.at(-1).calls[0].receipt, null);
  assert.equal(new ProcessIdentitySource().assess(live.launcherIdentity).status, "live");
});

for (const [reason, currentScope, options] of [
  ["INVALID_DEADLINE", false, "{timeoutMs:0}"],
  ["DELEGATION_REFUSED", true, "{timeoutMs:20000,processExecutionBinding:{nodeId:'different-node'}}"],
]) {
  test(`a delegated pre-call ${reason} refusal survives raw child exit before any provider reservation`, async (t) => {
    const { root, runtime } = await fixture(t);
    const script = path.join(root, "pre-call-refusal.mjs");
    fs.writeFileSync(script, `
      import {withManagedProcessScope,executeManagedProcess} from ${JSON.stringify(new URL("../../../src/lib/managed-process.js", import.meta.url).href)};
      const invoke = () => executeManagedProcess(process.execPath,['-e','throw new Error("must not launch")'],${options});
      try {
        await withManagedProcessScope({executionRoot:process.cwd()},()=>${currentScope
          ? "withManagedProcessScope({executionRoot:process.cwd()},invoke)" : "invoke()"});
      } catch(error) { console.error(error.stack); process.exitCode=1; }
    `);
    let observed = false;
    await assert.rejects(runtime.enter(() => RuntimeChildExecution.runAsync(script, [], {
      cwd: root, timeout: 20000, onProcessExecutionStop() { observed = true; },
    })), (error) => error instanceof ProcessExecutionControlFailure && error.code === `PROCESS_EXECUTION_${reason}`);
    assert.equal(observed, false);
    const calls = runtime.store.read().executions.at(-1).calls;
    assert.equal(calls.length, 1, "the refusal precedes any provider launch intent");
    assert.equal(calls[0].receipt.stopEvidence.confirmed, true, "only the real outer CLI has a physical stop receipt");
    assert.equal(calls[0].controlFailure.code, `PROCESS_EXECUTION_${reason}`);
  });
}
