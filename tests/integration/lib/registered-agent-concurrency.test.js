import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { Agent, AGENT_EXTERNAL_EXECUTION_INSTRUCTION } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { ProcessExecutionRuntime, ProcessExecutionStopReceipt, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { NodeScriptInvocation } from "../../../src/lib/command-invocation.js";
import { managedRequest, ManagedProcessMessage } from "../../../src/lib/managed-process-protocol.js";
import { ManagedControlPolicy } from "../../../src/lib/managed-control-policy.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const entry = fileURLToPath(new URL("../../../src/sennel.js", import.meta.url));
const literalArguments = ["", "two words", "$HOME&value", "日本語"];
const prompt = "literal input $HOME&value 日本語\n".repeat(128);
const expectedInput = `${AGENT_EXTERNAL_EXECUTION_INSTRUCTION}\n\n${prompt}`;
const knownAdmissionFailure = "Parent child exit or stop closed nested admission";

function failureSummary(error) {
  const communication = error.communication;
  return { name: error.name, code: error.code ?? null,
    communication: communication === null || communication === undefined ? null : {
      operation: communication.operation, budgetMs: communication.budgetMs, elapsedMs: communication.elapsedMs,
      cutoff: communication.cutoff, attempts: communication.attempts,
    } };
}

function mailboxDiagnostics(runtime) {
  const mailbox = runtime.remoteGrant().endpoint.mailbox;
  return fs.readdirSync(mailbox.requests).filter((name) => name.endsWith(".json")).map((name) => {
    const requestPath = path.join(mailbox.requests, name);
    const request = JSON.parse(fs.readFileSync(requestPath));
    const responsePath = path.join(mailbox.responses, name);
    const response = fs.statSync(responsePath, { throwIfNoEntry: false });
    const error = response !== undefined && response.size < 64 * 1024
      ? JSON.parse(fs.readFileSync(responsePath)).payload?.error : null;
    return { requestId: request.requestId, operation: request.operation,
      callId: request.payload.data?.call?.callId ?? request.callId,
      requestPublishedAt: fs.statSync(requestPath).mtime.toISOString(),
      responsePublishedAt: response?.mtime.toISOString() ?? null, responseBytes: response?.size ?? null,
      responseFailure: error == null ? null : { code: error.code, reason: error.reason,
        message: error.message === knownAdmissionFailure ? knownAdmissionFailure : null } };
  });
}

// Observable outcome: four ordinary provider handles and their twelve public
// command targets all return exact bytes and committed receipts. Shared runtime
// admission, inherited authentication, concurrent control polling, output save,
// parent closure and a fresh historical reader are the production connections.
// The provider is the only fake; no control decision, grant or receipt is faked.
async function runConcurrentAgents(t, { mailboxOnly = false } = {}) {
  const root = createTmpDir("registered-agent-concurrency-");
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
    removeTmpDir(root);
  });
  const readyDirectory = path.join(root, "ready");
  fs.mkdirSync(readyDirectory);
  const denials = path.join(root, "outgoing-network-denials.jsonl");
  let executionEnvironment;
  if (mailboxOnly) {
    const preload = path.join(root, "deny-outgoing-network.mjs");
    fs.writeFileSync(preload, `
      import net from 'node:net';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      net.createConnection=function(...args){
        fs.appendFileSync(${JSON.stringify(denials)},JSON.stringify({at:new Date().toISOString(),code:'EPERM'})+'\\n');
        const socket=new net.Socket();
        queueMicrotask(()=>socket.destroy(Object.assign(new Error('Owned fixture denies outgoing TCP'),{code:'EPERM'})));
        return socket;
      };
      net.connect=net.createConnection;syncBuiltinESMExports();
    `);
    executionEnvironment = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim() };
  }
  const target = path.join(root, "literal-target.mjs");
  fs.writeFileSync(target, `
    const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
    process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:Buffer.concat(chunks).toString('utf8')}));
    process.stderr.write('target-stderr:'+process.argv[2]+':'+process.argv[3]);
  `);
  const provider = path.join(root, "provider.mjs");
  fs.writeFileSync(provider, `
    import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
    const [ordinal,input]=process.argv.slice(2);
    const readyDirectory=${JSON.stringify(readyDirectory)};
    const diagnostic=path.join(${JSON.stringify(root)},'provider-'+ordinal+'-timeline.jsonl');
    const record=(type,step=null)=>fs.appendFileSync(diagnostic,JSON.stringify({type,step,at:new Date().toISOString()})+'\\n');
    for await(const chunk of process.stdin){} // Drain the actual input stream, even when argv transports the prompt.
    await new Promise((resolve,reject)=>{
      const watcher=fs.watch(readyDirectory,()=>check());
      watcher.once('error',error=>{watcher.close();reject(error)});
      const check=()=>{if(fs.readdirSync(readyDirectory).length===4){watcher.close();resolve();}};
      fs.writeFileSync(path.join(readyDirectory,ordinal),'ready');check();
    });
    record('provider-ready');
    const results=[];
    for(let step=0;step<3;step++){
      record('wrapper-start',step);
      const result=await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[${JSON.stringify(entry)},'command','--',process.execPath,
          ${JSON.stringify(target)},ordinal,String(step),...${JSON.stringify(literalArguments)}],
          {cwd:${JSON.stringify(root)},env:process.env,stdio:['pipe','pipe','pipe']});
        const stdout=[],stderr=[];let inputError=null;
        child.stdout.on('data',bytes=>stdout.push(Buffer.from(bytes)));
        child.stderr.on('data',bytes=>stderr.push(Buffer.from(bytes)));
        child.stdin.on('error',error=>{inputError=error.code;});
        child.once('error',reject);
        child.once('close',(code,signal)=>resolve({code,signal,inputError,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')}));
        child.stdin.end(input);
      });
      fs.writeFileSync(path.join(${JSON.stringify(root)},'wrapper-'+ordinal+'-'+step+'-result.json'),JSON.stringify(result));
      record('wrapper-exit',step);results.push(result);
      if(result.code!==0||result.signal!==null||result.inputError!==null){
        process.stderr.write(JSON.stringify({step,code:result.code,signal:result.signal,inputError:result.inputError,stderr:result.stderr}));
        process.exitCode=1;break;
      }
    }
    process.stdout.write(JSON.stringify(results));
  `);
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root, environment: {} });
  const receipts = new Map(), timeline = [];
  const config = { agent: { default: "test/concurrent", timeout: 120, providers: {
    "test/concurrent": { command: process.execPath, args: [provider, "{{PROMPT}}"] },
  } } };
  const outcomes = await runtime.enter(() => Promise.allSettled(Array.from({ length: 4 }, async (_value, ordinal) => {
    const profile = { command: process.execPath, args: [provider, String(ordinal), "{{PROMPT}}"] };
    const agent = new Agent({ config: { agent: { ...config.agent, providers: { "test/concurrent": profile } } },
      paths: { root, agentWorkDir: path.join(root, ".tmp") },
      registry: new ProviderRegistry({ "test/concurrent": profile }), logger: new Logger({ enabled: false }) });
    return agent.call(prompt, { retryCount: 0, cacheMode: "bypass", commandId: "concurrent-provider",
      ...(executionEnvironment === undefined ? {} : { executionEnvironment }),
      onSupervisorEvent(event) { timeline.push({ ordinal, type: event.type, callId: event.callId,
        at: new Date().toISOString(), monotonicMs: performance.now() }); },
      onProcessExecutionStop(receipt) { receipts.set(ordinal, receipt); },
    });
  })));
  const failures = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => failureSummary(outcome.reason));
  if (failures.length > 0) t.diagnostic(JSON.stringify({ failures }));
  let inventory;
  try { inventory = runtime.inspect(); }
  catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
  const physical = inventory.executions.find((execution) => execution.executionId === runtime.executionId);
  const diagnostic = { failures, timeline, mailbox: mailboxDiagnostics(runtime),
    networkDenials: fs.existsSync(denials) ? fs.readFileSync(denials, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
    wrapperResults: fs.readdirSync(root).filter((name) => /^wrapper-\d+-\d+-result\.json$/.test(name)).map((name) => {
      const result = JSON.parse(fs.readFileSync(path.join(root, name)));
      const failure = /^sennel command: ([A-Z][A-Z0-9_]*): ([^\r\n]{0,512})\n?$/.exec(result.stderr);
      return { file: name, code: result.code, signal: result.signal, inputError: result.inputError,
        stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr),
        stdoutDigest: createHash("sha256").update(result.stdout).digest("hex"),
        stderrDigest: createHash("sha256").update(result.stderr).digest("hex"),
        failure: failure === null ? null : { code: failure[1],
          message: failure[2] === knownAdmissionFailure ? knownAdmissionFailure : null } };
    }),
    providerInvocationBytes: physical.calls.filter((call) => call.parentCallId === null)
      .map((call) => Buffer.byteLength(JSON.stringify(call.invocation))) };
  fs.writeFileSync(path.join(root, "concurrency-diagnostics.json"), JSON.stringify(diagnostic));
  t.diagnostic(JSON.stringify(diagnostic));
  if (physical.calls.some((call) => call.receipt === null)) testTemporaryRoot().retainOnUnconfirmedExecution();
  assert.equal(failures.length, 0, JSON.stringify(failures));
  assert.equal(receipts.size, 4);
  if (mailboxOnly) {
    assert.ok(diagnostic.networkDenials.length > 0, "actual provider/wrapper TCP attempts must encounter the fixture EPERM boundary");
    const snapshots = diagnostic.mailbox.filter((frame) => frame.operation === "runtime-snapshot");
    assert.equal(snapshots.length, 12, "every public wrapper must obtain its pinned runtime through the real authenticated mailbox");
    assert.ok(snapshots.every((frame) => frame.responsePublishedAt !== null && frame.responseBytes > 0));
    for (const operation of ["authenticate", "reserve", "claim-launch", "observe", "read-control", "persist-call-output", "finish"]) {
      assert.ok(diagnostic.mailbox.some((frame) => frame.operation === operation), `${operation} must use the same real mailbox fallback`);
    }
  }
  for (let ordinal = 0; ordinal < outcomes.length; ordinal++) {
    const results = JSON.parse(outcomes[ordinal].value);
    assert.equal(results.length, 3);
    for (let step = 0; step < results.length; step++) {
      assert.deepEqual(results[step], { code: 0, signal: null, inputError: null,
        stdout: JSON.stringify({ args: [String(ordinal), String(step), ...literalArguments], input: expectedInput }),
        stderr: `target-stderr:${ordinal}:${step}` });
    }
  }
  assert.equal(physical.calls.length, 16);
  const providers = physical.calls.filter((call) => call.parentCallId === null);
  assert.equal(providers.length, 4);
  for (const parent of providers) {
    const children = physical.calls.filter((call) => call.parentCallId === parent.callId);
    assert.equal(children.length, 3);
    const receipt = [...receipts.values()].find((value) => value.callId === parent.callId);
    assert.ok(receipt instanceof ProcessExecutionStopReceipt);
    assert.deepEqual(receipt.descendants.map((child) => child.callId).sort(), children.map((child) => child.callId).sort());
    assert.ok(children.every((child) => child.invocation.commandId === "command"));
  }
  for (const call of physical.calls) {
    assert.equal(call.receipt.observation.kind, "exited");
    assert.equal(call.receipt.observation.code, 0);
    assert.equal(call.receipt.observation.signal, null);
    assert.equal(call.controlFailure, null);
  }
  await runtime.close();
  const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root });
  assert.equal(historical.executions.length, 1);
  assert.equal(historical.executions[0].status, "closed");
  assert.equal(historical.executions[0].accepting, false);
  assert.equal(historical.executions[0].closure.callClosures.length, 16);
  assert.deepEqual(historical.executions[0].calls.map((call) => new ProcessExecutionStopReceipt(call.receipt).toJSON()),
    physical.calls.map((call) => call.receipt));
}

test("four concurrent public Agent calls preserve twelve inherited command results and all sixteen durable receipts", { timeout: 240000 },
  (t) => runConcurrentAgents(t));

test("four concurrent public Agent calls preserve all sixteen receipts when provider and wrapper TCP is denied", { timeout: 240000 },
  (t) => runConcurrentAgents(t, { mailboxOnly: true }));

async function runStartPublication(t, { expire = false, stop = false } = {}) {
  const root = createTmpDir("registered-start-publication-");
  let runtime, releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  t.after(async () => {
    releaseStart();
    try { await runtime?.close(); }
    catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
    removeTmpDir(root);
  });
  const preload = path.join(root, "deny-network.mjs");
  fs.writeFileSync(preload, `import net from 'node:net';import{syncBuiltinESMExports}from'node:module';
    net.createConnection=()=>{const socket=new net.Socket();queueMicrotask(()=>socket.destroy(Object.assign(new Error('Owned network boundary'),{code:'EPERM'})));return socket;};syncBuiltinESMExports();`);
  const provider = path.join(root, "provider.mjs");
  fs.writeFileSync(provider, `import{spawn}from'node:child_process';
    for await(const chunk of process.stdin){}
    const child=spawn(process.execPath,[${JSON.stringify(entry)},'command','--',process.execPath,'-e',
      'process.stdout.write("literal child output");process.stderr.write("literal child error");'],{env:process.env,stdio:['ignore','pipe','pipe']});
    const stdout=[],stderr=[];child.stdout.on('data',b=>stdout.push(b));child.stderr.on('data',b=>stderr.push(b));
    child.once('close',(code,signal)=>{process.stdout.write(JSON.stringify({code,signal,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()}));process.exitCode=code===0?0:1;});`);
  const earlyTimer = path.join(root, "early-start-deadline.json");
  let coordinatorEnvironment = {};
  if (expire || stop) {
    const timerPreload = path.join(root, "early-deadline.mjs");
    fs.writeFileSync(timerPreload, `import fs from 'node:fs';const original=globalThis.setTimeout;let fired=false;
      globalThis.setTimeout=(callback,delay,...args)=>{
        if(!fired&&delay>13000&&delay<=14000){fired=true;return original(()=>{fs.writeFileSync(${JSON.stringify(earlyTimer)},JSON.stringify({fired:1,delay}));callback(...args);},0);}
        return original(callback,delay,...args);
      };`);
    coordinatorEnvironment = { NODE_OPTIONS: `--import=${pathToFileURL(timerPreload).href}` };
  }
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: coordinatorEnvironment });
  const observe = runtime.observeCall.bind(runtime);
  let parentCall, stopReceipt;
  runtime.observeCall = async (call, event) => {
    if (event.type === "started" && call.parentCallId === null) {
      parentCall = call;
      await startGate;
    }
    return observe(call, event);
  };
  const directory = runtime.remoteGrant().endpoint.mailbox.requests;
  let watcher;
  const authenticating = new Promise((resolve, reject) => {
    const check = () => {
      try {
        for (const name of fs.readdirSync(directory).filter((name) => name.endsWith(".json"))) {
          const message = JSON.parse(fs.readFileSync(path.join(directory, name)));
          if (message.operation === "authenticate") { watcher.close(); resolve(message); return; }
        }
      } catch (cause) { watcher.close(); reject(cause); }
    };
    watcher = fs.watch(directory, check);
    watcher.once("error", reject);
    check();
  });
  t.after(() => watcher.close());
  const executing = runtime.enter(() => executeManagedProcess(new NodeScriptInvocation({ script: provider, cwd: root,
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim() } }), [],
    { runtime, timeoutMs: 120000, onProcessExecutionStop(receipt) { stopReceipt = receipt; } }));
  executing.catch(() => {});
  const request = await authenticating;
  const before = runtime.inspect().executions[0].calls.find((call) => call.callId === request.callId);
  assert.equal(before.status, "claimed");
  assert.equal(before.accepting, true);
  assert.equal(before.observation, null);
  assert.equal(before.stopOperation, null);
  t.diagnostic(JSON.stringify({ requestId: request.requestId, callId: request.callId,
    beforeStartAcknowledgement: { status: before.status, accepting: before.accepting, observation: before.observation, stopOperation: before.stopOperation } }));
  const policy = new ManagedControlPolicy();
  const ledger = runtime.store.requestFile(runtime.executionId, request.requestId);
  if (expire || stop) {
    // The coordinator's early callback runs after the original pending entry
    // exists. File publication alone does not establish request arrival order.
    await new Promise((resolve, reject) => {
      const check = () => { if (fs.existsSync(earlyTimer)) { timerWatcher.close(); resolve(); } };
      const timerWatcher = fs.watch(root, check);
      timerWatcher.once("error", reject);
      t.after(() => timerWatcher.close());
      check();
    });
  }
  if (stop) {
    let executionFailure = null;
    try {
      assert.equal(JSON.parse(fs.readFileSync(earlyTimer)).fired, 1);
      assert.equal(parentCall.callId, request.callId);
      const operation = await runtime.beginCallStop(parentCall, { reason: "abort" });
      assert.equal(operation.reason, "abort");
      await assert.rejects(managedRequest(request.payload.grant, request.operation, request.payload,
        { requestId: request.requestId }), (cause) => cause.code === "PROCESS_EXECUTION_DELEGATION_REFUSED");
      assert.equal(ledger.read(), null);
      const stopped = runtime.inspect().executions[0];
      assert.equal(stopped.calls.length, 1);
      assert.equal(stopped.calls[0].accepting, false);
      assert.equal(stopped.calls[0].stopOperation.reason, "abort");
      assert.equal(stopped.events.some((event) => event.type === "reserved" && event.callId !== request.callId), false);
    } finally {
      releaseStart();
      try { await executing; }
      catch (cause) { executionFailure = cause; }
    }
    if (executionFailure !== null) assert.equal(executionFailure.code, "ABORT_ERR");
    assert.ok(stopReceipt instanceof ProcessExecutionStopReceipt);
    assert.equal(stopReceipt.callId, request.callId);
    assert.equal(stopReceipt.observation.kind, "exited");
    assert.equal(stopReceipt.stopOperation.reason, "abort");
    assert.deepEqual(stopReceipt.descendants, []);
    assert.equal(ledger.read(), null);
    await runtime.close();
    const saved = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root });
    assert.equal(saved.executions[0].status, "closed");
    assert.equal(saved.executions[0].calls.length, 1);
    assert.deepEqual(saved.executions[0].calls[0].receipt, stopReceipt.toJSON());
    return;
  }
  if (expire) {
    await assert.rejects(managedRequest(request.payload.grant, request.operation,
      { ...request.payload, data: { ...request.payload.data, changedRequestBytes: true } }, { requestId: request.requestId }),
    (cause) => cause.code === "PROCESS_EXECUTION_REQUEST_MISMATCH");
    assert.equal(ledger.read(), null);
  }
  let firstSlotDeadline = null, duplicate, result, observedPendingAtFirstSlot = false;
  try {
    const authentication = managedRequest(request.payload.grant, request.operation, request.payload, {
      requestId: request.requestId, policy, onWait(deadline) {
        firstSlotDeadline ??= deadline - policy.budgetMs + policy.responseDeadlineMs(1);
        if (performance.now() >= firstSlotDeadline) {
          if (expire && !observedPendingAtFirstSlot) {
            observedPendingAtFirstSlot = true;
            assert.equal(JSON.parse(fs.readFileSync(earlyTimer)).fired, 1);
            assert.equal(ledger.read(), null);
          }
          if (!expire) releaseStart();
        }
      },
    });
    if (expire) await assert.rejects(authentication, (cause) => {
      assert.equal(cause.code, "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE");
      assert.equal(cause.communication.budgetMs, policy.budgetMs);
      assert.ok(cause.communication.elapsedMs >= policy.responseDeadlineMs(2));
      const response = JSON.parse(fs.readFileSync(path.join(runtime.remoteGrant().endpoint.mailbox.responses, `${request.requestId}.json`)));
      assert.equal(response.payload.error.code, "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE");
      assert.equal(response.payload.error.message, "Parent start publication exceeded its communication budget");
      assert.equal(ledger.read(), null);
      return true;
    });
    else duplicate = await authentication;
  } finally { releaseStart(); result = await executing; }
  if (expire) {
    assert.equal(observedPendingAtFirstSlot, true);
    assert.equal(JSON.parse(fs.readFileSync(earlyTimer)).fired, 1);
    assert.equal(ledger.read(), null);
    const retryStarted = performance.now();
    // managedRequest deliberately consumes its slots on transient failures.
    // Inspect the real server reply directly to distinguish a renewed wait.
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: request.payload.grant.endpoint.host, port: request.payload.grant.endpoint.port });
      t.after(() => socket.destroy());
      let text = "";
      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("error", reject);
      socket.on("data", (bytes) => {
        text += bytes.toString();
        const newline = text.indexOf("\n");
        if (newline < 0) return;
        try { resolve(ManagedProcessMessage.from(JSON.parse(text.slice(0, newline)))); }
        catch (cause) { reject(cause); }
        finally { socket.destroy(); }
      });
    });
    assert.equal(response.respondsTo(ManagedProcessMessage.from(request)), true);
    assert.equal(response.payload.error.code, "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE");
    assert.equal(response.payload.error.message, "Parent start publication exceeded its communication budget");
    assert.ok(performance.now() - retryStarted < policy.responseDeadlineMs(1), "the expired UUID must not receive a new wait budget");
    assert.equal(result.code, 1);
    const physical = runtime.inspect().executions[0];
    assert.equal(physical.calls.length, 1);
    assert.equal(physical.calls[0].receipt.observation.code, 1);
    await runtime.close();
    const saved = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root });
    assert.equal(saved.executions[0].status, "closed");
    assert.equal(saved.executions[0].calls.length, 1);
    assert.equal(saved.executions[0].calls[0].receipt.observation.code, 1);
    return;
  }
  assert.equal(duplicate.ok, true);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { code: 0, signal: null, stdout: "literal child output", stderr: "literal child error" });
  const physical = runtime.inspect().executions[0];
  assert.equal(physical.calls.length, 2);
  assert.ok(physical.calls.every((call) => call.receipt !== null && call.receipt.observation.code === 0));
  const parentStarted = physical.events.find((event) => event.callId === request.callId && event.type === "started");
  const childReserved = physical.events.find((event) => event.callId !== request.callId && event.type === "reserved");
  assert.ok(parentStarted.sequence < childReserved.sequence);
  await runtime.close();
  const saved = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root });
  assert.equal(saved.executions[0].status, "closed");
  assert.equal(saved.executions[0].calls.length, 2);
  assert.ok(saved.executions[0].calls.every((call) => call.receipt !== null));
}

test("an inherited wrapper waits for its actual parent's started publication before authenticating and reserving", { timeout: 60000 },
  (t) => runStartPublication(t));

test("pending authentication expires at its original deadline after an early timer and cannot reset through a duplicate UUID", { timeout: 60000 },
  (t) => runStartPublication(t, { expire: true }));

test("stopping the actual claimed parent wakes pending authentication without accepting it or reserving a descendant", { timeout: 60000 },
  (t) => runStartPublication(t, { stop: true }));

test("a queued runtime admission uses its original communication deadline and exact failure without entering the body", { timeout: 60000 }, async (t) => {
  const root = createTmpDir("registered-admission-deadline-");
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: {} });
  let release, holding;
  t.after(async () => {
    release?.();
    await holding;
    try { await runtime.close(); }
    catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
    removeTmpDir(root);
  });
  const client = await ProcessExecutionRuntime.fromRemoteGrant(runtime.remoteGrant());
  await client.close();
  let entered;
  const enteredQueue = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  holding = runtime.store.exclusive(async () => { entered(); await gate; });
  await enteredQueue;
  const policy = new ManagedControlPolicy();
  const deadline = performance.now() + policy.budgetMs;
  const failure = new ProcessExecutionControlFailure("endpoint-unavailable", "Owned admission deadline boundary");
  let bodyEntered = false;
  await assert.rejects(runtime.store.exclusive(() => { bodyEntered = true; }, {
    deadline, deadlineFailure: () => failure,
  }), (cause) => {
    assert.equal(cause, failure);
    assert.ok(performance.now() >= deadline);
    return true;
  });
  assert.equal(bodyEntered, false);
  release();
  await holding;
  await runtime.close();
  const saved = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root });
  assert.equal(saved.executions[0].status, "closed");
  assert.deepEqual(saved.executions[0].calls, []);
});
