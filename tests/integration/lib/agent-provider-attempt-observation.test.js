import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { Agent } from "../../../src/lib/agent.js";
import { AgentProviderAttemptAdmission, AgentProviderAttemptContext, AgentProviderAttemptObserver,
  AgentProviderAttemptRecord } from "../../../src/lib/agent-provider-attempt.js";
import { PromptBatchExecutor, PromptBatchPlan } from "../../../src/lib/prompt-batching.js";
import { Logger } from "../../../src/lib/log.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-values.js";
import { NodeAgentProviderSequence } from "../../support/infrastructure/node-agent-provider-sequence.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

class Observer extends AgentProviderAttemptObserver {
  records = [];
  failures = [];
  observe(record) { this.records.push(record); }
  observationFailed(error, record) { this.failures.push({ error, record }); }
}

function fixture(t, outputs, options = {}) {
  const root = createTestDirectory("agent-attempt-observation-");
  t.after(() => removeQuiescentRuntimeFixture({ mainRoot: root }));
  const provider = new NodeAgentProviderSequence(root, outputs, { profile: options.profile });
  const config = { agent: { default: "fixture/local", providers: { "fixture/local": provider.profile } } };
  const agent = new Agent({ config, paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry: provider.registry("fixture/local"),
    logger: options.logger ?? new Logger({ enabled: false, logDir: root }),
    supervision: options.supervision,
  });
  return { root, agent, starts: () => provider.starts() };
}

function output(text, usage, code = 0) {
  return { stdout: JSON.stringify({ result: text, usage }), code };
}

it("observes each transport retry, empty reply, and failure with provider-normalized usage", async (t) => {
  const { agent, starts } = fixture(t, [
    output("failed reply", { input_tokens: 10, output_tokens: 1 }, 2),
    output("", { input_tokens: 20, output_tokens: 0 }),
    output("complete", { input_tokens: 30, output_tokens: 3, cache_read_input_tokens: 0 }),
  ]);
  const observer = new Observer();
  const text = await agent.call("input", { commandId: "docs-test", flowAttribution: "none",
    providerAttemptObserver: observer, retryCount: 2, retryDelayMs: 1 });
  assert.equal(text, "complete");
  assert.equal(starts(), 3);
  assert.ok(observer.records.every((entry) => entry instanceof AgentProviderAttemptRecord && entry.providerStarted));
  assert.deepEqual(observer.records.map((entry) => entry.status), ["failed", "empty", "completed"]);
  assert.deepEqual(observer.records.map((entry) => entry.attemptIndex), [0, 1, 2]);
  assert.deepEqual(observer.records.map((entry) => entry.usage.input_tokens), [10, 20, 30]);
  assert.deepEqual(observer.records.map((entry) => entry.usage.cache_creation_tokens), [null, null, null]);
  assert.equal(new Set(observer.records.map((entry) => entry.attemptId)).size, 3);
  assert.equal(new Set(observer.records.map((entry) => entry.logicalInvocationId)).size, 1);
  assert.ok(observer.records.every((entry) => entry.commandId === "docs-test" && entry.inputCharacters === agent.projectInvocation("input").promptCharacterCount));
});

it("keeps unavailable failed usage distinct from a provider that never started", async (t) => {
  const { root, agent, starts } = fixture(t, [{ stdout: "truncated JSON", code: 2 }]);
  const executionWorkDir = path.join(root, "provider-cwd");
  fs.mkdirSync(executionWorkDir);
  class RemoveRetryDirectory extends AgentProviderAttemptAdmission {
    beforeProviderAttempt(context) {
      if (context.attemptIndex === 1) fs.rmdirSync(executionWorkDir);
    }
  }
  const observer = new Observer();
  await assert.rejects(agent.call("input", { executionWorkDir, providerAttemptObserver: observer,
    providerAttemptAdmission: new RemoveRetryDirectory(), retryCount: 1, retryDelayMs: 1 }));
  assert.equal(starts(), 1);
  const history = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root, executionRoot: root });
  const calls = history.inventory.executions.flatMap((entry) => entry.calls);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].receipt.observation.kind, "exited");
  assert.equal(calls[1].receipt.observation.kind, "spawn-failed");
  assert.deepEqual(observer.records.map((entry) => [entry.status, entry.providerStarted, entry.usage]),
    [["failed", true, null], ["failed", false, null]]);
});

it("observer rejection cannot retry success or replace the original provider failure", async (t) => {
  const success = fixture(t, [output("complete", { input_tokens: 0 })]);
  const failure = fixture(t, [output("failed", { input_tokens: 4 }, 2)]);
  class RejectingObserver extends Observer {
    async observe(record) { super.observe(record); throw new Error("observation failed"); }
  }
  const observer = new RejectingObserver();
  assert.equal(await success.agent.call("input", { providerAttemptObserver: observer, retryCount: 2, retryDelayMs: 1 }), "complete");
  await assert.rejects(failure.agent.call("input", { providerAttemptObserver: observer, retryCount: 0 }),
    (error) => error.message.includes("exit=2") && !error.message.includes("observation failed"));
  assert.equal(success.starts(), 1);
  assert.equal(failure.starts(), 1);
  assert.equal(observer.failures.length, 2);
  assert.equal(observer.records[0].usage.input_tokens, 0);
});

it("captures usage before schema cleanup and log failures without another provider attempt", async (t) => {
  const observer = new Observer();
  const originalRm = fs.promises.rm;
  t.after(() => { fs.promises.rm = originalRm; });
  fs.promises.rm = async (target, options) => {
    if (String(target).includes("schema-")) throw new Error("fixture cleanup denied");
    return originalRm(target, options);
  };
  const { agent, starts } = fixture(t, [output("complete", { input_tokens: 9 })], {
    profile: { jsonSchemaFlag: "--schema", jsonSchemaMode: "file" },
    logger: { async agent(event) {
      if (event.phase === "end") {
        assert.equal(observer.records.length, 1);
        throw new Error("fixture log failed");
      }
    } },
  });
  await assert.rejects(agent.call("input", { providerAttemptObserver: observer, retryCount: 2, retryDelayMs: 1,
    jsonSchema: { type: "object", properties: { value: { type: "string" } } } }), /fixture log failed/);
  assert.equal(starts(), 1);
  assert.equal(observer.records.length, 1);
  assert.equal(observer.records[0].usage.input_tokens, 9);
  assert.equal(observer.records[0].status, "completed");
});

it("refused transport retry does not start or observe another attempt and does not consume its budget", async (t) => {
  const { agent, starts } = fixture(t, [output("", { input_tokens: 4 })]);
  const observer = new Observer();
  const contexts = [];
  const denied = new Error("retry requires confirmation");
  const executor = new PromptBatchExecutor({ executionAdmission: {
    async admit(prepared) { assert.equal(prepared.inputCharacters, agent.projectInvocation("input").promptCharacterCount); },
    async beforeProviderAttempt(context) {
      assert.ok(context instanceof AgentProviderAttemptContext);
      contexts.push(context);
      if (context.attemptIndex === 1) throw denied;
    },
  } });
  const plan = PromptBatchPlan.fromRequest({ id: "input", request: { userPrompt: "input" } });
  await assert.rejects(executor.executeCompletions({ plan,
    projectInvocation: (request) => agent.projectInvocation(request.userPrompt),
    callAgent: (request, _batch, _index, _context, providerCallAdmission) => agent.call(request.userPrompt, {
      commandId: "docs-test", providerCallAdmission, providerAttemptObserver: observer, retryCount: 2, retryDelayMs: 1,
    }), responseContract: { parse: (value) => value },
  }), (error) => error.cause === denied);
  assert.equal(starts(), 1);
  assert.equal(observer.records.length, 1);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].logicalInvocationId, contexts[1].logicalInvocationId);
  assert.equal(contexts[0].invocation.initialPlannedAttempt, true);
  assert.equal(executor.executionBudget.providerCallCount, 1);
});

it("explicit admission refusal prevents dispatch and observation", async (t) => {
  const { agent, starts } = fixture(t, []);
  const observer = new Observer();
  const denied = new Error("execution denied");
  class Admission extends AgentProviderAttemptAdmission {
    async beforeProviderAttempt(context) { assert.equal(context.inputCharacters, agent.projectInvocation("input").promptCharacterCount); throw denied; }
  }
  await assert.rejects(agent.call("input", { providerAttemptObserver: observer,
    providerAttemptAdmission: new Admission(), retryCount: 2 }), (error) => error === denied);
  assert.equal(starts(), 0);
  assert.equal(observer.records.length, 0);
});

it("an already aborted call does not start or observe a provider", async (t) => {
  const { agent, starts } = fixture(t, []);
  const observer = new Observer();
  const controller = new AbortController();
  const reason = new Error("run aborted");
  controller.abort(reason);
  await assert.rejects(agent.call("input", { abortSignal: controller.signal, providerAttemptObserver: observer }),
    (error) => error === reason);
  assert.equal(starts(), 0);
  assert.equal(observer.records.length, 0);
});

it("aborts an in-flight provider through registered execution and retains obtained usage without retry", async (t) => {
  const controller = new AbortController();
  const reason = new Error("run interrupted");
  let receipt;
  const observer = new Observer();
  const { root, agent, starts } = fixture(t, [{ ...output("partial", { input_tokens: 7 }), pending: true }], {
    supervision: { graceMs: 1 },
  });
  await assert.rejects(agent.call("input", { abortSignal: controller.signal, providerAttemptObserver: observer,
    onStdout() { controller.abort(reason); }, onProcessExecutionStop(value) { receipt = value; },
    retryCount: 2, retryDelayMs: 1 }), (error) => error === reason);
  assert.ok(receipt instanceof ProcessExecutionStopReceipt);
  const readback = new ProcessExecutionStopReceipt(JSON.parse(JSON.stringify(receipt)));
  const history = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root, executionRoot: root });
  const call = history.inventory.executions.flatMap((entry) => entry.calls).find((entry) => entry.callId === receipt.callId);
  assert.ok(["SIGTERM", "SIGKILL"].includes(call.outcome.finalAction));
  assert.equal(readback.observation.signal, call.outcome.finalAction);
  const saved = new ProcessExecutionStopReceipt(call.receipt);
  assert.deepEqual(saved.toJSON(), readback.toJSON());
  assert.equal(saved.observation.signal, call.outcome.finalAction);
  assert.equal(starts(), 1);
  assert.equal(observer.records.length, 1);
  assert.equal(observer.records[0].status, "failed");
  assert.equal(observer.records[0].providerStarted, true);
  assert.equal(observer.records[0].usage.input_tokens, 7);
  assert.equal(reason.stopEvidence.status, "confirmed");
});
