import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { ProcessExecutionRuntime, ProcessExecutionStopReceipt, ProcessExecutionBinding } from "../../../src/lib/process-execution-runtime.js";
import { RuntimeChildExecution } from "../../../src/lib/runtime-package.js";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { PromptBatchExecutor, PromptBatchPlan, PromptExecutionBudget, PromptExecutionLimit } from "../../../src/lib/prompt-batching.js";
import { PromptExecutionJournal, PromptExecutionJournalSnapshot, PromptExecutionJournalWriter, PromptExecutionScope } from "../../../src/lib/prompt-execution-journal.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../../test-environment.js";

async function fixture(t) {
  const root = createTmpDir("registered-agent-");
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    catch (error) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw error; }
    removeTmpDir(root);
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root, environment: {} });
  return { root, runtime };
}

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
  assert.notEqual(provider.executor.executorId, execution.calls[0].executor.executorId);
  assert.equal(provider.receipt.scope, "registered-executions");
  assert.deepEqual(provider.receipt, new ProcessExecutionStopReceipt(child.receipt));
});

test("forged inherited delegation rejects an Agent call before admission or provider effects", async (t) => {
  const { root, runtime } = await fixture(t);
  // Runtime delivery owns scratch space before the child starts. Keep setup
  // outside the target so the assertion observes only the rejected Agent.
  const providerRoot = path.join(root, "provider-target");
  fs.mkdirSync(providerRoot);
  const script = path.join(root, "forged-agent-child.mjs");
  const moduleUrl = (name) => JSON.stringify(new URL(`../../../src/lib/${name}.js`, import.meta.url).href);
  fs.writeFileSync(script, `
    import path from 'node:path';
    import {Agent} from ${moduleUrl("agent")};
    import {ProviderRegistry} from ${moduleUrl("provider")};
    import {Logger} from ${moduleUrl("log")};
    const config={agent:{default:'test/exec',providers:{'test/exec':{command:process.execPath,args:['-e','require("fs").writeFileSync("unwanted","yes")']}},timeout:20}};
    const agent=new Agent({config,paths:{root:process.cwd(),agentWorkDir:path.join(process.cwd(),'.tmp')},registry:new ProviderRegistry(config.agent.providers),logger:new Logger({enabled:false})});
    process.env.SENNEL_PROCESS_EXECUTION_SCOPE='invalid-json';
    let admitted=false;
    const {AgentProviderAttemptAdmission}=await import(${moduleUrl("agent-provider-attempt")});
    class Admission extends AgentProviderAttemptAdmission { async beforeProviderAttempt(){admitted=true} }
    try{await agent.call('',{providerAttemptAdmission:new Admission()});throw new Error('Unexpected success')}
    catch(error){console.log(JSON.stringify({name:error.name,code:error.code,admitted}))}
  `);
  const result = await runtime.enter(() => RuntimeChildExecution.runAsync(script, [], {
    cwd: providerRoot, repositoryRoot: root, timeout: 40000,
  }));
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { name: "ProcessExecutionControlFailure", code: "PROCESS_EXECUTION_DELEGATION_REFUSED", admitted: false });
  assert.equal(fs.existsSync(path.join(providerRoot, "unwanted")), false);
  assert.equal(fs.existsSync(path.join(providerRoot, ".tmp")), false);
  const calls = runtime.store.read().executions.at(-1).calls;
  assert.equal(calls.length, 1, "only the registered fixture driver may execute");
  assert.equal(calls[0].invocation.providerAttemptId, null);
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


test("registered Agent persists exact Prompt physical identity before response and reloads the stop receipt", async (t) => {
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
  const completions = await runtime.enter(() => executor.executeCompletions({
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
  assert.deepEqual(completions.map((completion) => completion.response), ["completed"]);
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
