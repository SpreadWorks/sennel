import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import {
  PromptBatchExecutor,
  PromptBatchPlan,
  PromptExecutionBudget,
  PromptExecutionLimit,
  PromptProtocolRetryLimit,
  PromptProviderAttemptLimit,
} from "../../../src/lib/prompt-batching.js";

function fixture(t, outcomes, { cached = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-attempt-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const startups = [];
  const config = { agent: { default: "test/exec", providers: {
    "test/exec": { command: "worker", args: ["{{PROMPT}}"] },
  }, timeout: 30 } };
  const flowManager = cached ? {
    resolveCurrentContext() { return { specId: "cached-input", taskId: null, flowPhase: "spec" }; },
    loadActiveFlows() { return [{ specId: "cached-input" }]; },
    appendMetric() {},
    accumulateAgentMetrics() {},
  } : undefined;
  const agent = new Agent({
    config,
    paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry: new ProviderRegistry(config.agent.providers),
    logger: new Logger({ logDir: root, enabled: false }),
    flowManager,
    supervision: { spawn(command, args) {
      startups.push({ command, args });
      const outcome = outcomes[startups.length - 1];
      assert.ok(outcome, "the provider must not start after its attempt budget is exhausted");
      if (outcome instanceof Error) throw outcome;
      const child = new EventEmitter();
      child.pid = null;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit("data", outcome.stdout ?? "");
        child.stderr.emit("data", outcome.stderr ?? "");
        child.emit("close", outcome.code ?? 0, null);
      });
      return child;
    } },
  });
  const budget = new PromptExecutionBudget(new PromptExecutionLimit({ maxProviderCallCount: 10 }));
  const plan = PromptBatchPlan.fromRequest({ request: "read the input" });
  const options = {
    plan,
    protocolRetryLimit: new PromptProtocolRetryLimit(4),
    providerAttemptLimit: new PromptProviderAttemptLimit(4),
    callAgent: (request, _batch, _retry, context, admission) => agent.call(request.userPrompt, {
      commandId: "test", retryCount: 2, retryDelayMs: 1,
      cacheMode: context?.cacheMode ?? "bypass", providerCallAdmission: admission,
    }),
    responseContract: { parse: (raw) => raw },
  };
  return { agent, options, budget, startups, executor: new PromptBatchExecutor({ executionBudget: budget }) };
}

describe("scoped provider attempt admission through Agent", () => {
  it("counts transport recovery, format repair and file rereads under one four-startup cap", async (t) => {
    const run = fixture(t, [
      { code: 1, stderr: "HTTP 429 rate limited" },
      { stdout: "malformed" },
      { stdout: "unavailable" },
      { stdout: "valid" },
    ]);
    const observed = [];
    const completions = await run.executor.executeCompletions({
      ...run.options,
      protocolPolicy: { async execute({ call, accounting }) {
        assert.equal(await call(), "malformed");
        observed.push(accounting.snapshot().toJSON());
        assert.equal(await call(undefined, { retryKind: "format" }), "unavailable");
        observed.push(accounting.snapshot().toJSON());
        return call(undefined, { retryKind: "file_read" });
      } },
    });
    assert.equal(completions[0].response, "valid");
    assert.deepEqual(observed, [
      { responseCallCount: 1, providerAttemptCount: 2 },
      { responseCallCount: 2, providerAttemptCount: 3 },
    ]);
    assert.deepEqual(completions[0].executionAccounting.toJSON(), { responseCallCount: 3, providerAttemptCount: 4 });
    assert.equal(run.startups.length, 4);
    assert.equal(run.budget.providerCallCount, 4);
  });

  it("denies a fifth startup during transport recovery after earlier response retries", async (t) => {
    const run = fixture(t, [
      { stdout: "malformed" },
      { stdout: "unavailable" },
      { code: 1, stderr: "HTTP 429 rate limited" },
      { code: 1, stderr: "HTTP 429 rate limited" },
    ]);
    let failedCallAccounting;
    await assert.rejects(run.executor.executeCompletions({
      ...run.options,
      protocolPolicy: { async execute({ call, accounting }) {
        await call();
        await call(undefined, { retryKind: "format" });
        try { return await call(undefined, { retryKind: "file_read" }); }
        catch (error) { failedCallAccounting = accounting.snapshot().toJSON(); throw error; }
      } },
    }), (error) => {
      assert.equal(error.cause.code, "PROMPT_CALL_LIMIT_EXCEEDED");
      assert.deepEqual(error.details.executionAccounting, { responseCallCount: 3, providerAttemptCount: 4 });
      return error.code === "PROMPT_BATCH_EXECUTION_INCOMPLETE";
    });
    assert.deepEqual(failedCallAccounting, { responseCallCount: 3, providerAttemptCount: 4 });
    assert.equal(run.startups.length, 4);
    assert.equal(run.budget.providerCallCount, 4);
  });

  it("denies the next response call before Agent runs when the group has spent four attempts", async (t) => {
    const run = fixture(t, Array.from({ length: 4 }, () => ({ stdout: "unavailable" })));
    await assert.rejects(run.executor.executeCompletions({
      ...run.options,
      protocolPolicy: { async execute({ call }) {
        for (let attempt = 0; attempt < 4; attempt += 1) await call();
        return call();
      } },
    }), (error) => {
      assert.equal(error.cause.code, "PROMPT_CALL_LIMIT_EXCEEDED");
      assert.deepEqual(error.details.executionAccounting, { responseCallCount: 4, providerAttemptCount: 4 });
      return error.code === "PROMPT_BATCH_EXECUTION_INCOMPLETE";
    });
    assert.equal(run.startups.length, 4);
    assert.equal(run.budget.providerCallCount, 4);
  });

  it("charges a failed startup while retaining Agent call-local attempt metadata", async (t) => {
    const startup = Object.assign(new Error("spawn worker ENOENT"), { code: "ENOENT" });
    const run = fixture(t, [startup]);
    await assert.rejects(run.executor.executeCompletions(run.options), (error) => {
      assert.equal(error.cause.code, "AGENT_PERMISSION_CONFIGURATION_FAILED");
      assert.equal(error.cause.attemptCount, 1);
      assert.equal(error.cause.maxAttempts, 3);
      assert.deepEqual(error.details.executionAccounting, { responseCallCount: 1, providerAttemptCount: 1 });
      return error.code === "PROMPT_BATCH_EXECUTION_INCOMPLETE";
    });
    assert.equal(run.startups.length, 1);
    assert.equal(run.budget.providerCallCount, 1);
  });

  it("refunds an Agent cache hit in both scopes before a fresh call uses the one available attempt", async (t) => {
    const run = fixture(t, [{ stdout: "cached" }, { stdout: "fresh" }], { cached: true });
    await run.agent.call("read the input", { commandId: "test", retryCount: 0 });
    let cachedAccounting;
    const completions = await run.executor.executeCompletions({
      ...run.options,
      providerAttemptLimit: new PromptProviderAttemptLimit(1),
      protocolPolicy: { async execute({ call, accounting }) {
        assert.equal(await call(undefined, { cacheMode: "default" }), "cached");
        cachedAccounting = accounting.snapshot().toJSON();
        return call(undefined, { cacheMode: "refresh" });
      } },
    });
    assert.equal(completions[0].response, "fresh");
    assert.deepEqual(cachedAccounting, { responseCallCount: 1, providerAttemptCount: 0 });
    assert.deepEqual(completions[0].executionAccounting.toJSON(), { responseCallCount: 2, providerAttemptCount: 1 });
    assert.equal(run.startups.length, 2);
    assert.equal(run.budget.providerCallCount, 1);
  });

  it("evicts a cached unavailable evaluation and never caches a newly unavailable response", async (t) => {
    const unavailable = JSON.stringify({ observations: null,
      evaluationUnavailable: { kind: "file-read-failed", reason: "The referenced file could not be opened." } });
    const accepted = JSON.stringify({ observations: [], evaluationUnavailable: null });
    const run = fixture(t, [{ stdout: unavailable }, { stdout: unavailable }, { stdout: accepted }], { cached: true });
    const callOptions = { commandId: "test", retryCount: 0 };
    assert.equal(await run.agent.call("read the input", callOptions), unavailable);
    const decisions = [];
    assert.equal(await run.agent.call("read the input", {
      ...callOptions,
      validateResponseForCache: (raw) => {
        const response = JSON.parse(raw);
        return Array.isArray(response.observations) && response.evaluationUnavailable === null;
      },
      onCacheDecision: (decision) => decisions.push(decision),
    }), unavailable);
    assert.equal(run.startups.length, 2, "an unavailable cached value must cause a fresh provider execution");
    assert.equal(decisions.at(-1).cacheOutcome, "invalid_hit");
    assert.equal(decisions.at(-1).fresh, true);
    assert.equal(await run.agent.call("read the input", callOptions), accepted,
      "the removed cached failure and newly rejected failure must both be absent");
    assert.equal(run.startups.length, 3);
    assert.equal(await run.agent.call("read the input", callOptions), accepted);
    assert.equal(run.startups.length, 3, "accepted evaluations remain cacheable");
  });
});
