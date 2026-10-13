import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent } from "../../../src/lib/agent.js";
import { AgentProviderAttemptAdmission } from "../../../src/lib/agent-provider-attempt.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { UnknownProviderFailure } from "../../../src/lib/agent-failure.js";
import { executeAgentResponseProtocol } from "../../../src/lib/agent-response-protocol.js";
import {
  AtomicPromptElement, PromptBatchExecutor, PromptBatchPlan, PromptExecutionBudget, PromptExecutionLimit,
  PromptInputBuilder, PromptRequestEnvelope, PromptRequestLimit, PromptProtocolRetryLimit, PromptProviderAttemptLimit,
  PromptReductionPlan, PromptReductionLevel,
} from "../../../src/lib/prompt-batching.js";
import {
  PromptExecutionJournal, PromptExecutionJournalSnapshot, PromptExecutionJournalWriter, PromptExecutionScope, isPromptExecutionControlFailure,
} from "../../../src/lib/prompt-execution-journal.js";

class MemoryWriter extends PromptExecutionJournalWriter {
  records = [];
  persisted = null;
  failure = null;
  failEvent = null;
  failAfterSave = false;

  async save(record) {
    if (record.event === this.failEvent && !this.failAfterSave) throw this.failure;
    this.persisted = JSON.parse(JSON.stringify(record.snapshot));
    this.records.push(record.toJSON());
    if (record.event === this.failEvent) throw this.failure;
  }

  journal(stage = "evaluate", round = 0) {
    return new PromptExecutionJournal({ scope: new PromptExecutionScope({ stage, round }), writer: this,
      snapshot: this.persisted ? PromptExecutionJournalSnapshot.fromJSON(this.persisted) : null });
  }
}

function pairPlan() {
  const envelope = new PromptRequestEnvelope({ revision: "paired-v1", build: (elements) => elements.map((entry) => entry.toPromptText()).join(" ") });
  const limit = new PromptRequestLimit({ maxCharacters: 4 });
  const builder = new PromptInputBuilder({ envelope, limit });
  builder.add(new AtomicPromptElement({ id: "one", sourceRevision: "r1", sequence: 0, text: "one" }));
  builder.add(new AtomicPromptElement({ id: "two", sourceRevision: "r1", sequence: 1, text: "two" }));
  return PromptBatchPlan.create({ collection: builder.build(), envelope, limit });
}

function executor(writer, limit = new PromptExecutionLimit()) {
  return new PromptBatchExecutor({ executionBudget: writer.persisted
    ? PromptExecutionBudget.fromSnapshot(limit, writer.persisted.budget) : new PromptExecutionBudget(limit) });
}

function options(writer, starts, plan = PromptBatchPlan.fromRequest({ request: "input" })) {
  return { plan, executionJournal: writer.journal(writer.persisted?.scope.stage, writer.persisted?.scope.round), responseContract: { parse: (raw) => raw },
    callAgent: async (request, _batch, _retry, _context, admission) => {
      admission.claim();
      await admission.beforeProviderAttempt({ attempt: 1, maxAttempts: 1, providerKey: "test", profileKey: "test/exec" });
      starts.push(request.userPrompt);
      return request.userPrompt;
    } };
}

function agentFixture(t, outcomes, { cached = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-prompt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const starts = [];
  const config = { agent: { default: "test/exec", providers: { "test/exec": { command: "worker", args: ["{{PROMPT}}"] } }, timeout: 30 } };
  const agent = new Agent({ config, paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ logDir: root, enabled: false }),
    flowManager: cached ? { resolveCurrentContext() { return { specId: "cached", taskId: null, flowPhase: "spec" }; },
      loadActiveFlows() { return [{ specId: "cached" }]; }, appendMetric() {}, accumulateAgentMetrics() {} } : undefined,
    supervision: { spawn() {
      const outcome = outcomes[starts.length];
      assert.ok(outcome, "provider startup must stay within its durable frontier");
      starts.push(outcome);
      const child = new EventEmitter(); child.pid = null;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit("data", outcome.stdout ?? ""); child.stderr.emit("data", outcome.stderr ?? "");
        child.emit("close", outcome.code ?? 0, null);
      });
      return child;
    } } });
  return { agent, starts };
}

describe("durable prompt execution frontier", () => {
  for (const boundary of ["plan", "execution-attempt", "standalone-attempt"]) {
    it(`preserves durable ${boundary} admission refusal without claims, consumption, or protocol repair`, async (t) => {
      const writer = new MemoryWriter();
      const { agent, starts } = agentFixture(t, []);
      const denied = new Error("execution admission refused");
      const budget = new PromptExecutionBudget(new PromptExecutionLimit({ maxProviderCallCount: 2 }));
      const originalBudget = budget.snapshot();
      let admissionCalls = 0;
      let adapterCalls = 0;
      let protocolRepairs = 0;
      let parsed = 0;
      const refuse = () => { admissionCalls += 1; throw denied; };
      class StandaloneAdmission extends AgentProviderAttemptAdmission {
        async beforeProviderAttempt() { refuse(); }
      }
      const selected = new PromptBatchExecutor({ executionBudget: budget, executionAdmission: {
        async admit() { if (boundary === "plan") refuse(); },
        async beforeProviderAttempt() { if (boundary === "execution-attempt") refuse(); },
      } });
      await assert.rejects(selected.executeCompletions({ ...options(writer, starts),
        protocolRetryLimit: new PromptProtocolRetryLimit(1),
        protocolPolicy: { async execute({ call, accounting }) {
          return (await executeAgentResponseProtocol({ groupIdentity: "admission-refusal", accounting,
            callAgent: async (request) => {
              if (request.repair) protocolRepairs += 1;
              return call();
            },
            parseResponse: (raw) => { parsed += 1; return raw; },
          })).value;
        } },
        callAgent: (request, _batch, _index, _context, providerCallAdmission) => {
          adapterCalls += 1;
          return agent.call(request.userPrompt, { providerCallAdmission, retryCount: 1, retryDelayMs: 1,
            ...(boundary === "standalone-attempt" && { providerAttemptAdmission: new StandaloneAdmission() }),
          });
        },
      }), (error) => error === denied);
      assert.equal(isPromptExecutionControlFailure(denied), true);
      assert.equal(admissionCalls, 1);
      assert.equal(adapterCalls, boundary === "plan" ? 0 : 1);
      assert.deepEqual(starts, []);
      assert.equal(protocolRepairs, 0);
      assert.equal(parsed, 0);
      assert.deepEqual(budget.snapshot(), originalBudget);
      assert.deepEqual(writer.records.map((record) => record.event), boundary === "plan" ? [] : ["planned"]);
      if (boundary === "plan") {
        assert.equal(writer.persisted, null);
      } else {
        const restored = writer.journal().snapshot;
        assert.deepEqual(restored.budget, originalBudget);
        assert.equal(restored.batches[0].claim, null);
        assert.equal(restored.batches[0].transportOrdinal, 0);
        assert.deepEqual(restored.batches[0].responses, []);
        assert.deepEqual(restored.batches[0].transportFailures, []);
      }
    });
  }

  it("resumes only the remaining batch under the original two-call cap and preserves plan order", async () => {
    const writer = new MemoryWriter(); const starts = []; const plan = pairPlan();
    const limit = new PromptExecutionLimit({ maxProviderCallCount: 2, concurrency: 4 });
    writer.failEvent = "validated"; writer.failure = new Error("interrupt after completion"); writer.failAfterSave = true;
    await assert.rejects(executor(writer, limit).executeCompletions(options(writer, starts, plan)), (error) => error === writer.failure);
    assert.equal(writer.persisted.budget.providerCallCount, 1);
    assert.equal(writer.persisted.batches[0].completion.response, "one");
    writer.failEvent = null;
    const budget = PromptExecutionBudget.fromSnapshot(limit, writer.persisted.budget); let projections = 0;
    const completions = await new PromptBatchExecutor({ executionBudget: budget }).executeCompletions({ ...options(writer, starts, plan),
      projectInvocation: () => { projections += 1; return { assertWithinLimit() {} }; } });
    assert.deepEqual(starts, ["one", "two"]);
    assert.deepEqual(completions.map((completion) => completion.response), ["one", "two"]);
    assert.equal(projections, 1);
    assert.equal(budget.providerCallCount, 2);
    assert.deepEqual(completions[1].executionAccounting.toJSON(), { responseCallCount: 2, providerAttemptCount: 2 });
  });

  it("replays bounded raw responses through validation after a validation save failure without charging calls again", async () => {
    const writer = new MemoryWriter(); const starts = []; const limit = new PromptExecutionLimit({ maxProviderCallCount: 1 });
    writer.failEvent = "validated"; writer.failure = new Error("validation checkpoint unavailable");
    await assert.rejects(executor(writer, limit).executeCompletions(options(writer, starts)), (error) => error === writer.failure);
    assert.equal(writer.persisted.batches[0].claim, null);
    assert.equal(writer.persisted.batches[0].responses[0].raw, "input");
    writer.failEvent = null;
    const budget = PromptExecutionBudget.fromSnapshot(limit, writer.persisted.budget);
    const completions = await new PromptBatchExecutor({ executionBudget: budget }).executeCompletions(options(writer, starts));
    assert.deepEqual(starts, ["input"]);
    assert.equal(completions[0].response, "input");
    assert.equal(budget.aggregateCharacters, "input".length);
    assert.equal(budget.providerCallCount, 1);
  });

  it("stops a saved unobserved provider claim before projection or a repeated startup", async () => {
    const writer = new MemoryWriter(); const starts = [];
    writer.failEvent = "response"; writer.failure = new Error("response write failed");
    await assert.rejects(executor(writer).executeCompletions(options(writer, starts)), (error) => error === writer.failure);
    assert.equal(writer.persisted.batches[0].claim.transportOrdinal, 1);
    writer.failEvent = null;
    let projections = 0;
    await assert.rejects(executor(writer).executeCompletions({ ...options(writer, starts), projectInvocation() { projections += 1; } }),
      { code: "PROMPT_EXECUTION_UNCERTAIN" });
    assert.equal(projections, 0);
    assert.deepEqual(starts, ["input"]);
  });

  it("rejects substituted saved response bytes before parsing or starting another provider", async () => {
    const writer = new MemoryWriter(); const starts = []; let parsed = 0;
    writer.failEvent = "validated"; writer.failure = new Error("validation checkpoint unavailable");
    await assert.rejects(executor(writer).executeCompletions(options(writer, starts)), (error) => error === writer.failure);
    writer.failEvent = null;
    writer.persisted.batches[0].responses[0].raw = "other";
    await assert.rejects(executor(writer).executeCompletions({ ...options(writer, starts), responseContract: { parse(raw) { parsed += 1; return raw; } } }),
      { code: "PROMPT_EXECUTION_RESPONSE_MISMATCH" });
    assert.deepEqual(starts, ["input"]);
    assert.equal(parsed, 0);
  });

  it("denies changed plan and stage identities without provider effects", async () => {
    const writer = new MemoryWriter(); const starts = [];
    await executor(writer).executeCompletions(options(writer, starts));
    await assert.rejects(executor(writer).executeCompletions(options(writer, starts, PromptBatchPlan.fromRequest({ request: "changed" }))),
      { code: "PROMPT_EXECUTION_IDENTITY_MISMATCH" });
    assert.throws(() => writer.journal("different"), { code: "PROMPT_EXECUTION_IDENTITY_MISMATCH" });
    assert.deepEqual(starts, ["input"]);
  });

  it("preserves the latest episode budget while replaying a completed earlier scope", async () => {
    const writer = new MemoryWriter(); const starts = [];
    const limit = new PromptExecutionLimit({ maxProviderCallCount: 2, maxSynthesisCallCount: 2 });
    await executor(writer, limit).executeCompletions({ ...options(writer, starts), synthesisCallCount: 1 });
    const earlier = JSON.parse(JSON.stringify(writer.persisted));
    const budget = PromptExecutionBudget.fromSnapshot(limit, earlier.budget);
    const laterWriter = new MemoryWriter();
    const laterOptions = options(laterWriter, starts, PromptBatchPlan.fromRequest({ request: "later" }));
    laterOptions.executionJournal = laterWriter.journal("final");
    await new PromptBatchExecutor({ executionBudget: budget }).executeCompletions({ ...laterOptions, synthesisCallCount: 1 });
    const latest = budget.snapshot(); const saves = writer.records.length;
    await new PromptBatchExecutor({ executionBudget: budget }).executeCompletions({ ...options(writer, starts), synthesisCallCount: 1 });
    assert.deepEqual(budget.snapshot(), latest);
    assert.equal(writer.records.length, saves);
    assert.deepEqual(starts, ["input", "later"]);
    assert.equal(latest.providerCallCount, 2);
    assert.equal(latest.synthesisCallCount, 2);
  });

  it("refuses a supplied latest budget that has lost saved provider or aggregate consumption", async () => {
    const writer = new MemoryWriter(); const starts = [];
    await executor(writer).executeCompletions(options(writer, starts));
    const saves = writer.records.length;
    for (const field of ["providerCallCount", "aggregateCharacters", "aggregateItemCount"]) {
      const snapshot = { ...writer.persisted.budget, [field]: 0 };
      const budget = PromptExecutionBudget.fromSnapshot(new PromptExecutionLimit(), snapshot);
      await assert.rejects(new PromptBatchExecutor({ executionBudget: budget }).executeCompletions(options(writer, starts)),
        { code: "PROMPT_EXECUTION_FRONTIER_MISMATCH" });
      assert.deepEqual(budget.snapshot(), snapshot);
    }
    assert.deepEqual(starts, ["input"]);
    assert.equal(writer.records.length, saves);
  });

  it("scopes the same plan and group to each reduction round while sharing the episode budget", async () => {
    const starts = []; const budget = new PromptExecutionBudget(new PromptExecutionLimit({ maxProviderCallCount: 2 }));
    const plan = PromptBatchPlan.fromRequest({ request: "input" });
    const writers = [new MemoryWriter(), new MemoryWriter()];
    for (const [round, writer] of writers.entries()) {
      const completions = await new PromptBatchExecutor({ executionBudget: budget }).executeCompletions({
        ...options(writer, starts, plan), executionJournal: writer.journal("reduction", round), providerAttemptLimit: new PromptProviderAttemptLimit(1),
      });
      assert.equal(completions[0].executionAccounting.providerAttemptCount, 1);
      assert.equal(writer.persisted.scope.round, round);
      assert.equal(writer.persisted.groups[0].groupId, "linear");
      assert.equal(writer.persisted.groups[0].budget.providerCallCount, 1);
    }
    assert.equal(writers[0].persisted.plan.digest, writers[1].persisted.plan.digest);
    assert.equal(budget.providerCallCount, 2);
    const latest = budget.snapshot(); const savedEvents = writers[0].records.length;
    const completed = await new PromptBatchExecutor({ executionBudget: budget }).executeCompletions({
      ...options(writers[0], starts, plan), executionJournal: writers[0].journal("reduction", 0), providerAttemptLimit: new PromptProviderAttemptLimit(1),
    });
    assert.equal(completed[0].response, "input");
    assert.deepEqual(starts, ["input", "input"]);
    assert.deepEqual(budget.snapshot(), latest);
    assert.equal(writers[0].records.length, savedEvents);
  });

  it("reuses the shared reduction loop while durable round planning reserves synthesis exactly once", async () => {
    const writer = new MemoryWriter(); const starts = [];
    const limit = new PromptExecutionLimit({ maxSynthesisCallCount: 1 });
    const initialElements = ["aaaa", "bbbb"].map((text, sequence) => new AtomicPromptElement({
      id: `source-${sequence}`, sourceRevision: "r1", sequence, text,
    }));
    const reduce = (budget) => new PromptReductionPlan({ initialElements, coverageDigest: "original-coverage", executionBudget: budget }).execute({
      reserveSynthesisCalls: false,
      isComplete: (elements) => elements.length === 1,
      buildRound: () => PromptBatchPlan.fromRequest({ request: "input" }),
      executeRound: (plan) => new PromptBatchExecutor({ executionBudget: budget }).executeCompletions({
        ...options(writer, starts, plan), synthesisCallCount: plan.batches.length,
      }),
      toNextLevel: (completions) => new PromptReductionLevel({ coverageDigest: "original-coverage",
        elements: [new AtomicPromptElement({ id: "summary", sourceRevision: "summary-r1", sequence: 0, text: completions[0].response })] }),
      finalize: (elements, coverageDigest) => ({ text: elements[0].toPromptText(), coverageDigest }),
    });
    writer.failEvent = "validated"; writer.failure = new Error("interrupt after reduction completion"); writer.failAfterSave = true;
    await assert.rejects(reduce(new PromptExecutionBudget(limit)), (error) => error === writer.failure);
    assert.equal(writer.persisted.budget.synthesisCallCount, 1);
    writer.failEvent = null;
    const budget = PromptExecutionBudget.fromSnapshot(limit, writer.persisted.budget);
    const result = await reduce(budget);
    assert.deepEqual(result, { text: "input", coverageDigest: "original-coverage" });
    assert.deepEqual(starts, ["input"]);
    assert.equal(budget.synthesisCallCount, 1);
  });

  it("restores protocol call count and group budget after an observed malformed response", async () => {
    const writer = new MemoryWriter(); const starts = []; let interrupt = true;
    const policy = { async execute({ call, accounting }) {
      const raw = await call();
      assert.deepEqual(accounting.snapshot().toJSON(), { responseCallCount: 1, providerAttemptCount: 1 });
      if (interrupt) throw new Error("process interrupted between response calls");
      return call({ userPrompt: `${raw} repaired` });
    } };
    const limit = new PromptExecutionLimit({ maxProviderCallCount: 2 });
    const config = { protocolPolicy: policy, protocolRetryLimit: new PromptProtocolRetryLimit(1), providerAttemptLimit: new PromptProviderAttemptLimit(2) };
    await assert.rejects(executor(writer, limit).executeCompletions({ ...options(writer, starts), ...config }),
      { code: "PROMPT_BATCH_EXECUTION_INCOMPLETE" });
    interrupt = false;
    const completions = await executor(writer, limit).executeCompletions({ ...options(writer, starts), ...config });
    assert.deepEqual(starts, ["input", "input repaired"]);
    assert.equal(completions[0].response, "input repaired");
    assert.deepEqual(completions[0].executionAccounting.toJSON(), { responseCallCount: 2, providerAttemptCount: 2 });
  });

  it("does not revive an exhausted protocol or group allowance on resume", async () => {
    for (const exhausted of ["protocol", "group"]) {
      const writer = new MemoryWriter(); const starts = []; let interrupt = true;
      const protocolPolicy = { async execute({ call }) { await call(); if (interrupt) throw new Error("interrupt"); return call({ userPrompt: "repair" }); } };
      const config = { protocolPolicy, protocolRetryLimit: new PromptProtocolRetryLimit(exhausted === "protocol" ? 0 : 1),
        providerAttemptLimit: new PromptProviderAttemptLimit(exhausted === "group" ? 1 : 2) };
      await assert.rejects(executor(writer).executeCompletions({ ...options(writer, starts), ...config }), { code: "PROMPT_BATCH_EXECUTION_INCOMPLETE" });
      interrupt = false;
      await assert.rejects(executor(writer).executeCompletions({ ...options(writer, starts), ...config }), { code: "PROMPT_CALL_LIMIT_EXCEEDED" });
      assert.deepEqual(starts, ["input"]);
      assert.equal(writer.persisted.budget.providerCallCount, 1);
    }
  });

  it("records an oversized response as a bounded rejection and refuses replay without provider calls", async () => {
    const writer = new MemoryWriter(); const starts = [];
    const limit = new PromptExecutionLimit({ maxResponseCharacters: 3 });
    await assert.rejects(executor(writer, limit).executeCompletions(options(writer, starts)),
      (error) => error.cause.code === "PROMPT_RESPONSE_TOO_LARGE");
    const response = writer.persisted.batches[0].responses[0];
    assert.equal(response.raw, null);
    assert.equal(response.responseCharacters, 5);
    assert.equal(response.rejection, "PROMPT_RESPONSE_TOO_LARGE");
    assert.equal(writer.persisted.batches[0].claim, null);
    await assert.rejects(executor(writer, limit).executeCompletions(options(writer, starts)),
      (error) => error.cause.code === "PROMPT_RESPONSE_TOO_LARGE");
    assert.deepEqual(starts, ["input"]);
  });

  it("refuses a durable adapter that supplies no provider admission ownership", async () => {
    const writer = new MemoryWriter();
    await assert.rejects(executor(writer).executeCompletions({ ...options(writer, []), callAgent: async () => "unclaimed" }),
      { code: "PROMPT_EXECUTION_ADAPTER_INVALID" });
    assert.equal(writer.persisted.budget.providerCallCount, 0);
    assert.deepEqual(writer.persisted.batches[0].responses, []);
  });

  it("awaits claim persistence before Agent startup and propagates the save refusal unchanged", async (t) => {
    const run = agentFixture(t, [{ stdout: "accepted" }]); const writer = new MemoryWriter();
    writer.failEvent = "claimed"; writer.failure = Object.assign(new Error("store admission denied"), { code: "STORE_ADMISSION_DENIED" });
    await assert.rejects(executor(writer).executeCompletions({ ...options(writer, []),
      callAgent: (request, _batch, _retry, _context, admission) => run.agent.call(request.userPrompt,
        { commandId: "test", retryCount: 2, cacheMode: "bypass", providerCallAdmission: admission }) }), (error) => error === writer.failure);
    assert.equal(run.starts.length, 0);
    assert.equal(writer.persisted.budget.providerCallCount, 0);
  });

  it("preserves persistence refusals through the shared response protocol without producing provider-failure evidence", async () => {
    for (const event of ["claimed", "response"]) {
      const writer = new MemoryWriter(); const starts = [];
      writer.failEvent = event; writer.failure = Object.assign(new Error("checkpoint refused"), { code: "STORE_REFUSED" });
      const protocolPolicy = { async execute({ call, accounting }) {
        return (await executeAgentResponseProtocol({ callAgent: () => call(), parseResponse: (raw) => raw,
          groupIdentity: "evaluation", accounting })).value;
      } };
      await assert.rejects(executor(writer).executeCompletions({ ...options(writer, starts), protocolPolicy }), (error) => error === writer.failure);
      assert.equal(starts.length, event === "claimed" ? 0 : 1);
      assert.equal(writer.persisted.batches[0].responses.length, 0);
    }
  });

  it("preserves durable admission denial through shared format-repair handling", async () => {
    const writer = new MemoryWriter(); const starts = [];
    const protocolPolicy = { async execute({ call, accounting }) {
      return (await executeAgentResponseProtocol({ callAgent: () => call(), parseResponse() { throw new Error("malformed response"); },
        groupIdentity: "evaluation", accounting })).value;
    } };
    await assert.rejects(executor(writer).executeCompletions({ ...options(writer, starts), protocolPolicy,
      protocolRetryLimit: new PromptProtocolRetryLimit(1), providerAttemptLimit: new PromptProviderAttemptLimit(1) }),
      { code: "PROMPT_CALL_LIMIT_EXCEEDED" });
    assert.deepEqual(starts, ["input"]);
    assert.equal(writer.persisted.groups[0].budget.providerCallCount, 1);
  });

  it("blocks transport retry on observation-save failure and restores its transport ordinal after readback", async (t) => {
    const run = agentFixture(t, [{ code: 1, stderr: "HTTP 429 rate limited" }, { stdout: "accepted" }]);
    const writer = new MemoryWriter(); writer.failEvent = "transport-failed";
    writer.failure = Object.assign(new Error("interrupted after failure save"), { code: "CHECKPOINT_UNAVAILABLE" }); writer.failAfterSave = true;
    const limit = new PromptExecutionLimit({ maxProviderCallCount: 2 });
    const callAgent = (request, _batch, _retry, _context, admission) => run.agent.call(request.userPrompt,
      { commandId: "test", retryCount: 1, retryDelayMs: 0, cacheMode: "bypass", providerCallAdmission: admission });
    await assert.rejects(executor(writer, limit).executeCompletions({ ...options(writer, []), callAgent }), (error) => error === writer.failure);
    assert.equal(run.starts.length, 1);
    assert.equal(writer.persisted.batches[0].claim, null);
    assert.equal(writer.persisted.batches[0].transportFailures[0].attempt, 1);
    writer.failEvent = null;
    const completions = await executor(writer, limit).executeCompletions({ ...options(writer, []), callAgent });
    assert.equal(run.starts.length, 2);
    assert.equal(writer.persisted.batches[0].transportOrdinal, 2);
    assert.deepEqual(completions[0].executionAccounting.toJSON(), { responseCallCount: 1, providerAttemptCount: 2 });
  });

  it("treats an unsaved transport failure as uncertain instead of admitting a retry", async (t) => {
    const run = agentFixture(t, [{ code: 1, stderr: "HTTP 429 rate limited" }]);
    const writer = new MemoryWriter(); writer.failEvent = "transport-failed";
    writer.failure = new Error("failure observation unavailable");
    const callAgent = (request, _batch, _retry, _context, admission) => run.agent.call(request.userPrompt,
      { commandId: "test", retryCount: 1, retryDelayMs: 0, cacheMode: "bypass", providerCallAdmission: admission });
    await assert.rejects(executor(writer).executeCompletions({ ...options(writer, []), callAgent }), (error) => error === writer.failure);
    assert.equal(run.starts.length, 1);
    assert.equal(writer.persisted.batches[0].claim.attempt, 1);
    writer.failEvent = null;
    await assert.rejects(executor(writer).executeCompletions({ ...options(writer, []), callAgent }), { code: "PROMPT_EXECUTION_UNCERTAIN" });
    assert.equal(run.starts.length, 1);
  });

  it("keeps an unproven Agent transport exception claimed and refuses restart without another physical attempt", async (t) => {
    const run = agentFixture(t, []); const writer = new MemoryWriter(); let attempts = 0;
    const original = run.agent._callOnce;
    t.after(() => { run.agent._callOnce = original; });
    run.agent._callOnce = async () => { attempts += 1; throw new UnknownProviderFailure({ message: "Completion was not observed" }); };
    const callAgent = (request, _batch, _retry, _context, admission) => run.agent.call(request.userPrompt,
      { commandId: "test", retryCount: 2, retryDelayMs: 0, cacheMode: "bypass", providerCallAdmission: admission });
    await assert.rejects(executor(writer).executeCompletions({ ...options(writer, []), callAgent }), { code: "PROMPT_EXECUTION_UNCERTAIN" });
    assert.equal(attempts, 1);
    assert.equal(writer.persisted.budget.providerCallCount, 1);
    assert.equal(writer.persisted.batches[0].claim.attempt, 1);
    assert.deepEqual(writer.persisted.batches[0].transportFailures, []);
    assert.deepEqual(writer.records.map((record) => record.event), ["planned", "claimed"]);
    await assert.rejects(executor(writer).executeCompletions({ ...options(writer, []), callAgent }), { code: "PROMPT_EXECUTION_UNCERTAIN" });
    assert.equal(attempts, 1);
    assert.equal(writer.persisted.budget.providerCallCount, 1);
  });

  it("restores a paid observed transport failure as a matching cache response and rejects foreign cache identities", async (t) => {
    for (const foreign of [false, true]) {
      const run = agentFixture(t, [{ stdout: "cached" }, { code: 1, stderr: "HTTP 429 rate limited" }], { cached: true });
      await run.agent.call("input", { commandId: "test", retryCount: 0 });
      const writer = new MemoryWriter(); writer.failEvent = "transport-failed"; writer.failAfterSave = true;
      writer.failure = new Error("interrupt after confirmed failure");
      const callAgent = (request, _batch, _retry, _context, admission) => run.agent.call(request.userPrompt,
        { commandId: "test", retryCount: 1, retryDelayMs: 0, cacheMode: "bypass", providerCallAdmission: admission });
      const limit = new PromptExecutionLimit({ maxProviderCallCount: 2 });
      await assert.rejects(executor(writer, limit).executeCompletions({ ...options(writer, []), callAgent }), (error) => error === writer.failure);
      writer.failEvent = null;
      const resumed = foreign ? async (_request, _batch, _retry, _context, admission) => {
        admission.claim();
        admission.recordCacheHit({ providerKey: "foreign", profileKey: "foreign/exec" });
        return "cached";
      } : (request, _batch, _retry, _context, admission) => run.agent.call(request.userPrompt,
        { commandId: "test", retryCount: 1, retryDelayMs: 0, cacheMode: "default", providerCallAdmission: admission });
      if (foreign) {
        await assert.rejects(executor(writer, limit).executeCompletions({ ...options(writer, []), callAgent: resumed }),
          { code: "PROMPT_EXECUTION_IDENTITY_MISMATCH" });
        assert.equal(writer.persisted.batches[0].responses.length, 0);
      } else {
        const completions = await executor(writer, limit).executeCompletions({ ...options(writer, []), callAgent: resumed });
        assert.equal(completions[0].response, "cached");
        const batch = writer.persisted.batches[0];
        assert.equal(batch.responses[0].origin, "cache");
        assert.equal(batch.responses[0].providerKey, batch.transportFailures[0].providerKey);
        assert.equal(batch.responses[0].profileKey, batch.transportFailures[0].profileKey);
        assert.equal(batch.responses[0].schemaDigest, batch.transportFailures[0].schemaDigest);
        assert.deepEqual(completions[0].executionAccounting.toJSON(), { responseCallCount: 1, providerAttemptCount: 1 });
      }
      assert.equal(run.starts.length, 2, "resume cannot start a third physical provider process");
      assert.equal(writer.persisted.budget.providerCallCount, 1);
    }
  });

  it("does not restore transport retries after the saved physical attempt cap is exhausted", async (t) => {
    const run = agentFixture(t, [{ code: 1, stderr: "HTTP 429 rate limited" }, { code: 1, stderr: "HTTP 429 rate limited" }]);
    const writer = new MemoryWriter();
    const callAgent = (request, _batch, _retry, _context, admission) => run.agent.call(request.userPrompt,
      { commandId: "test", retryCount: 1, retryDelayMs: 0, cacheMode: "bypass", providerCallAdmission: admission });
    await assert.rejects(executor(writer).executeCompletions({ ...options(writer, []), callAgent }), { code: "PROMPT_BATCH_EXECUTION_INCOMPLETE" });
    assert.equal(writer.persisted.batches[0].transportFailures.at(-1).attempt, 2);
    await assert.rejects(executor(writer).executeCompletions({ ...options(writer, []), callAgent }), { code: "PROMPT_EXECUTION_TRANSPORT_EXHAUSTED" });
    assert.equal(run.starts.length, 2);
  });

  it("persists cache-origin response and released reservations before a fresh call on resume", async (t) => {
    const run = agentFixture(t, [{ stdout: "cached" }, { stdout: "fresh" }], { cached: true });
    await run.agent.call("input", { commandId: "test", retryCount: 0 });
    const writer = new MemoryWriter(); let interrupt = true;
    const protocolPolicy = { async execute({ call, accounting }) {
      assert.equal(await call(undefined, { cacheMode: "default" }), "cached");
      assert.deepEqual(accounting.snapshot().toJSON(), { responseCallCount: 1, providerAttemptCount: 0 });
      if (interrupt) throw new Error("interrupt after cache response");
      return call(undefined, { cacheMode: "refresh" });
    } };
    const limit = new PromptExecutionLimit({ maxProviderCallCount: 1 });
    const config = { protocolPolicy, protocolRetryLimit: new PromptProtocolRetryLimit(1), providerAttemptLimit: new PromptProviderAttemptLimit(1),
      callAgent: (request, _batch, _retry, context, admission) => run.agent.call(request.userPrompt,
        { commandId: "test", retryCount: 0, cacheMode: context.cacheMode, providerCallAdmission: admission }) };
    await assert.rejects(executor(writer, limit).executeCompletions({ ...options(writer, []), ...config }),
      { code: "PROMPT_BATCH_EXECUTION_INCOMPLETE" });
    assert.equal(writer.persisted.budget.providerCallCount, 0);
    assert.equal(writer.persisted.groups[0].budget.providerCallCount, 0);
    assert.equal(writer.persisted.batches[0].responses[0].origin, "cache");
    interrupt = false;
    const completions = await executor(writer, limit).executeCompletions({ ...options(writer, []), ...config });
    assert.equal(completions[0].response, "fresh");
    assert.equal(run.starts.length, 2);
    assert.equal(writer.persisted.budget.providerCallCount, 1);
    assert.deepEqual(completions[0].executionAccounting.toJSON(), { responseCallCount: 2, providerAttemptCount: 1 });
  });
});
