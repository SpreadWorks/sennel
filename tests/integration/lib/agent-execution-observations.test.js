import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowAtStepFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { createExecutionQueryScenario } from "../../support/infrastructure/execution-query-scenario.js";
import { capturePromptExecutionReceiversFromView } from "../../../src/flow/lib/canonical-prompt-execution.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionControlFailure } from "../../../src/lib/process-execution-values.js";

// Outcomes traced through the real producers and durable Store:
// retry measurements/cache absence -> Agent.call -> observation catalog -> reload;
// pre-call refusal -> failed filesystem commit -> no provider dispatch;
// post-call refusal -> original response retained -> no retry or false completion;
// nested calls -> captured logical caller -> independent immutable identities.
function fixture(t, outputs, { onSpawn = null, loggerEnabled = false, runId = "observation-run" } = {}) {
  const root = createTmpDir("agent-execution-observation-");
  t.after(() => removeTmpDir(root));
  const specId = "001-observation";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  new FlowAtStepFixture({ flowManager: manager, specId, runId, request: "Observe calls", targetStep: "draft-refine" }).create();
  const config = { agent: { default: "fixture/test", providers: { "fixture/test": {
    command: "claude-fixture", args: ["--model", "requested-model", "--effort", "high", "{{PROMPT}}"], jsonOutputFlag: "--json",
  } } } };
  let starts = 0;
  const agent = new Agent({ config, paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry: new ProviderRegistry(config.agent.providers), flowManager: manager,
    logger: new Logger({ logDir: path.join(root, "logs"), enabled: loggerEnabled, flowManager: manager, cwd: root }),
    supervision: { spawn() {
      const output = outputs[starts++];
      onSpawn?.(starts);
      if (output.error) throw output.error;
      const child = new EventEmitter();
      child.pid = 999999;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify(output.response));
        child.emit("close", output.code ?? 0, null);
      });
      return child;
    } },
  });
  const reload = async () => {
    const restarted = new FlowManager({ root, mainRoot: root, inWorktree: false });
    return (await restarted.readExecutionObservations({ specId })).facts;
  };
  return { root, agent, manager, specId, starts: () => starts, reload };
}

function refuseObservationWrite(t, root, kind) {
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, "renameSync", function (source, target) {
    if (String(target).startsWith(root) && String(target).includes("execution-observations/facts/")) {
      const record = JSON.parse(fs.readFileSync(source, "utf8"));
      if (record.kind === kind) throw Object.assign(new Error("fixture disk unavailable"), { code: "EIO" });
    }
    return rename(source, target);
  });
  return () => mocked.mock.restore();
}

const response = (result, input = null) => ({ result, usage: { input_tokens: input, output_tokens: 0 },
  model: "reported-model", reasoning_effort: "low" });

test("common Agent retries persist exact identity and nullable provider measurements; cache adds no provider", async (t) => {
  const value = fixture(t, [{ response: response("", 2) }, { response: response("ready", 0) }], { loggerEnabled: true });
  assert.equal(await value.agent.call("input", { commandId: "draft-test", retryCount: 1, retryDelayMs: 1 }), "ready");
  assert.equal(await value.agent.call("input", { commandId: "draft-test", retryCount: 1, retryDelayMs: 1 }), "ready");
  assert.equal(value.starts(), 2);
  const facts = await value.reload();
  const starts = facts.filter((entry) => entry.kind === "agent-started");
  const providers = facts.filter((entry) => entry.kind === "provider-settled").sort((left, right) => left.data.attemptIndex - right.data.attemptIndex);
  const ready = facts.filter((entry) => entry.kind === "agent-response-ready");
  assert.equal(starts.length, 2);
  const primary = starts.find((entry) => entry.entityId === providers[0].data.logicalInvocationId);
  assert.deepEqual(primary.data.requested, { provider: "claude", profileKey: "fixture/test", model: "requested-model", effort: "high" });
  assert.equal(starts[0].data.responseMode, "return-to-caller");
  assert.deepEqual(starts[0].data.caller, { kind: "step-attempt", id: starts[0].binding.attemptId, flowVersionId: starts[0].binding.flowVersionId });
  assert.deepEqual(providers.map((entry) => entry.data.status), ["empty", "completed"]);
  assert.equal(new Set(providers.map((entry) => entry.entityId)).size, 2);
  assert.equal(new Set(providers.map((entry) => entry.data.logicalInvocationId)).size, 1);
  assert.deepEqual(providers.map((entry) => entry.data.usage.input_tokens), [2, 0]);
  assert.deepEqual(providers.map((entry) => entry.data.usage.cache_read_tokens), [null, null]);
  assert.ok(providers.every((entry) => entry.data.providerStarted === true && entry.data.maxAttempts === 2 && entry.data.durationMs >= 0));
  assert.deepEqual(providers[1].data.reported, { model: "reported-model", effort: "low" });
  assert.deepEqual(ready.map((entry) => entry.data.cacheOutcome).sort(), ["hit", "miss"]);
  assert.equal(facts.some((entry) => entry.kind === "agent-response-received"), false);
  assert.ok(facts.every((entry) => entry.binding.flowVersionId === starts[0].binding.flowVersionId
    && entry.binding.attemptId === starts[0].binding.attemptId));
  const metrics = value.manager.activityLedger(value.specId).filter((entry) => entry.metric?.executionObservation != null);
  assert.equal(metrics.length, 2);
  const logicalMetric = metrics.find((entry) => entry.metric.kind === "agent").metric;
  assert.equal(logicalMetric.tokens.input, 0);
  assert.equal(logicalMetric.tokens.cacheRead, null);
  assert.equal(logicalMetric.executionObservation.logicalInvocationId, primary.entityId);
  assert.equal(logicalMetric.executionObservation.measurementScope, "final-logical-response");
  assert.equal(logicalMetric.executionObservation.requestId, primary.data.requestId);
  const prompts = path.join(value.root, "logs", "prompts");
  const requestFile = fs.readdirSync(prompts, { recursive: true }).find((file) => file.endsWith(`${primary.data.requestId}.json`));
  const diagnostic = JSON.parse(fs.readFileSync(path.join(prompts, requestFile), "utf8"));
  assert.equal(diagnostic.executionObservation.logicalInvocationId, primary.entityId);
  assert.deepEqual(diagnostic.executionObservation.binding, primary.binding.toJSON());
});

test("failure to save the logical start refuses dispatch through the control-failure path", async (t) => {
  const value = fixture(t, [{ response: response("must not start") }]);
  const restore = refuseObservationWrite(t, value.root, "agent-started");
  await assert.rejects(value.agent.call("input", { retryCount: 2, retryDelayMs: 1 }),
    { code: "PROCESS_EXECUTION_OBSERVATION_SAVE_FAILED" });
  assert.equal(value.starts(), 0);
  restore();
  assert.equal((await value.reload()).length, 0);
});

test("post-provider save failure retains its actual response and durable reservation without repeating effects", async (t) => {
  const value = fixture(t, [{ response: response("actual response", 7) }]);
  const restore = refuseObservationWrite(t, value.root, "provider-settled");
  await assert.rejects(value.agent.call("input", { retryCount: 2, retryDelayMs: 1 }), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_OBSERVATION_SAVE_FAILED");
    assert.equal(error.providerOutcome.text, "actual response");
    assert.equal(error.providerOutcome.usage.input_tokens, 7);
    assert.equal(error.providerCompletionEvidence.exitCode, 0);
    return true;
  });
  assert.equal(value.starts(), 1);
  restore();
  const facts = await value.reload();
  assert.deepEqual(facts.map((entry) => entry.kind).sort(), ["agent-started", "provider-started"]);
});

test("unknown transport start is retained as unknown and never retried as a normal provider failure", async (t) => {
  const value = fixture(t, [{ error: new ProcessExecutionControlFailure("communication-failed", "fixture connection lost") }]);
  await assert.rejects(value.agent.call("input", { retryCount: 2, retryDelayMs: 1 }), { code: "PROCESS_EXECUTION_COMMUNICATION_FAILED" });
  assert.equal(value.starts(), 1);
  const provider = (await value.reload()).find((entry) => entry.kind === "provider-settled");
  assert.equal(provider.data.providerStarted, null);
  assert.equal(provider.data.usage, null);
  assert.deepEqual(provider.data.reported, { model: null, effort: null });
});

test("nested common Agent calls persist their actual logical caller", async (t) => {
  let inner;
  const value = fixture(t, [{ response: response("outer") }, { response: response("inner") }], {
    onSpawn(index) { if (index === 1) inner = value.agent.call("inner", { commandId: "nested", cacheMode: "bypass" }); },
  });
  assert.equal(await value.agent.call("outer", { commandId: "outer", cacheMode: "bypass" }), "outer");
  assert.equal(await inner, "inner");
  const starts = (await value.reload()).filter((entry) => entry.kind === "agent-started");
  const outer = starts.find((entry) => entry.data.commandId === "outer");
  const nested = starts.find((entry) => entry.data.commandId === "nested");
  assert.deepEqual(nested.data.caller, { kind: "agent-invocation", id: outer.entityId, flowVersionId: outer.binding.flowVersionId });
  assert.notEqual(nested.entityId, outer.entityId);
});


test("the durable prompt receiver saves exact common Agent identity and replays after reload without another call", async (t) => {
  const value = await createExecutionQueryScenario(t);
  await value.runPrompt();
  const restarted = value.reload();
  const saved = restarted.readPromptExecutionProgress({ executionContract: value.contract, scope: value.scope, checkoutIdentity: value.runtime.checkoutIdentity });
  const received = saved.batches[0].responses[0].executionObservation;
  assert.equal(received.binding.executionContractId, value.contract.id);
  assert.equal(received.planDigest, value.plan.digest);
  assert.equal(received.responseCallIndex, 0);
  assert.equal(received.providerKey, "claude");
  const facts = (await restarted.readExecutionObservations({ specId: value.specId })).facts;
  const ready = facts.find((entry) => entry.kind === "agent-response-ready");
  assert.equal(received.logicalInvocationId, ready.entityId);
  assert.equal(received.requestId, ready.data.requestId);
  const historical = restarted._store.runtime.readCanonicalTransitionView(value.specId, capturePromptExecutionReceiversFromView);
  assert.equal(historical.length, 1);
  assert.deepEqual(historical[0].toJSON(), received);
  const completions = await value.runPrompt(restarted);
  assert.equal(completions[0].response, "received");
  assert.equal(completions[0].receivedResponses.length, 1);
  assert.deepEqual(completions[0].receivedResponses[0].toJSON(), received);
  assert.equal((await restarted.readExecutionObservations({ specId: value.specId })).facts.length, facts.length);
});


test("failed provider observation retains the real managed receipt and never reruns the external effect", async (t) => {
  const value = await createExecutionQueryScenario(t);
  const restore = refuseObservationWrite(t, value.root, "provider-settled");
  await assert.rejects(value.run({ cacheMode: "bypass", retryCount: 2, retryDelayMs: 1 }), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_OBSERVATION_SAVE_FAILED");
    assert.equal(error.providerOutcome.text, "received");
    assert.equal(error.processExecutionStopReceipt.executionId, value.runtime.executionId);
    assert.equal(error.executionId, value.runtime.executionId);
    assert.equal(error.callId, error.processExecutionStopReceipt.callId);
    assert.equal(error.stopEvidence.status, "confirmed");
    return true;
  });
  restore();
  const history = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: value.root, executionRoot: value.root,
    runId: value.runId, specId: value.specId });
  assert.equal(history.executions[0].calls.length, 1);
  assert.equal(history.executions[0].calls[0].status, "stopped");
  assert.deepEqual((await value.reload().readExecutionObservations({ specId: value.specId })).facts.map((entry) => entry.kind).sort(),
    ["agent-started", "provider-started"]);
});

test("a nested call into another Flow Version retains the original caller namespace", async (t) => {
  const nested = fixture(t, [{ response: response("inner") }], { runId: "nested-observation-run" });
  let inner;
  const outer = fixture(t, [{ response: response("outer") }], {
    onSpawn() { inner = nested.agent.call("inner", { commandId: "nested", cacheMode: "bypass" }); },
  });
  assert.equal(await outer.agent.call("outer", { commandId: "outer", cacheMode: "bypass" }), "outer");
  assert.equal(await inner, "inner");
  const parent = (await outer.reload()).find((entry) => entry.kind === "agent-started");
  const child = (await nested.reload()).find((entry) => entry.kind === "agent-started");
  assert.notEqual(parent.binding.flowVersionId, child.binding.flowVersionId);
  assert.deepEqual(child.data.caller, { kind: "agent-invocation", id: parent.entityId, flowVersionId: parent.binding.flowVersionId });
});

test("an unbound managed runtime captures the exact Agent session binding before launching", async (t) => {
  const value = await createExecutionQueryScenario(t);
  assert.equal(value.runtime.binding.value, null);
  assert.equal(await value.run({ processExecutionBinding: null, cacheMode: "bypass" }), "received");
  const facts = (await value.reload().readExecutionObservations({ specId: value.specId })).facts;
  const start = facts.find((entry) => entry.kind === "agent-started");
  const history = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: value.root, executionRoot: value.root,
    runId: value.runId, specId: value.specId });
  assert.equal(history.executions[0].calls.length, 1);
  const call = history.executions[0].calls[0];
  assert.deepEqual(call.binding, start.binding.toJSON());
  assert.deepEqual(call.invocation.observationBinding, start.binding.toJSON());
  assert.equal(call.invocation.logicalInvocationId, start.entityId);
});


test("a legacy managed prompt without observation refs remains readable without a new source manifest", async (t) => {
  const value = await createExecutionQueryScenario(t);
  await value.runPrompt(value.manager, { flowAttribution: "none" });
  const saved = value.manager.readPromptExecutionProgress({ executionContract: value.contract, scope: value.scope,
    checkoutIdentity: value.runtime.checkoutIdentity });
  assert.equal(saved.batches[0].processStops.length, 1);
  assert.equal(saved.batches[0].responses[0].executionObservation, undefined);
  const observation = await value.manager.readExecutionObservations({ specId: value.specId });
  assert.equal(observation.manifests.length, 0);
  assert.equal(observation.facts.length, 0);
  assert.deepEqual(value.manager._store.runtime.readCanonicalTransitionView(value.specId, capturePromptExecutionReceiversFromView), []);
});
