import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AtomicPromptElement,
  PromptBatchExecutor,
  PromptBatchPlan,
  PromptExecutionBudget,
  PromptExecutionLimit,
  PromptInputBuilder,
  PromptReductionLevel,
  PromptReductionPlan,
  PromptRequestEnvelope,
  PromptRequestLimit,
} from "../../src/lib/prompt-batching.js";

describe("unlimited aggregate accounting boundaries", () => {
  it("rejects null for every independent numeric limit", () => {
    const defaults = new PromptExecutionLimit();
    for (const field of Object.keys(defaults).filter((field) => ![
      "maxResponseCharacters", "maxAggregateCharacters",
    ].includes(field))) {
      assert.throws(() => new PromptExecutionLimit({ [field]: null }), TypeError, field);
    }
    assert.equal(defaults.maxAggregateCharacters, 1_000_000);
  });

  it("refuses unsafe cumulative accounting without mutating spent counts", () => {
    const budget = new PromptExecutionBudget(new PromptExecutionLimit({ maxAggregateCharacters: null }));
    budget.consumeAggregate({ characters: Number.MAX_SAFE_INTEGER, items: 1 });
    const before = budget.snapshot();
    assert.deepEqual(PromptExecutionBudget.fromSnapshot(budget.limit, before).snapshot(), before);
    for (const cost of [{ characters: 1, items: 0 }, { characters: null, items: 0 }]) {
      assert.throws(() => budget.consumeAggregate(cost), TypeError);
      assert.deepEqual(budget.snapshot(), before);
    }
  });

  it("refuses a restored finite ceiling below spent counts without changing the unlimited budget", () => {
    const limit = new PromptExecutionLimit({ maxAggregateCharacters: null });
    const budget = new PromptExecutionBudget(limit);
    budget.consumeAggregate({ characters: 11, items: 1 });
    const before = budget.snapshot();
    assert.throws(() => budget.withLimit(new PromptExecutionLimit({ maxAggregateCharacters: 10 })), RangeError);
    assert.deepEqual(budget.snapshot(), before);
    assert.equal(budget.limit, limit);
  });

  it("continues with tighter independent limits and preserves every spent counter", () => {
    const limit = new PromptExecutionLimit({ maxRequestCharacters: 100, maxResponseCharacters: 100,
      maxBatchCount: 4, maxProviderCallCount: 4, maxProtocolRetryCount: 2,
      maxSynthesisCallCount: 4, maxAggregateItemCount: 4, maxAggregateCharacters: 50,
      maxReductionDepth: 4, concurrency: 4 });
    const budget = new PromptExecutionBudget(limit);
    budget.consumeProviderCall();
    budget.consumeProviderCall();
    budget.consumeSynthesisCalls(2);
    budget.consumeAggregate({ characters: 11, items: 2 });
    const before = budget.snapshot();
    for (const field of Object.keys(limit).filter((field) => field !== "maxAggregateCharacters")) {
      const tighter = new PromptExecutionLimit({ ...limit, [field]: limit[field] - 1,
        maxAggregateCharacters: null });
      assert.equal(limit.canContinueWith(tighter), true, field);
      const continued = budget.withLimit(tighter);
      assert.equal(continued.limit, tighter);
      assert.deepEqual(continued.snapshot(), before);
      assert.deepEqual(PromptExecutionBudget.fromSnapshot(tighter, continued.snapshot()).snapshot(), before);
    }
    assert.deepEqual(budget.snapshot(), before);
    assert.equal(budget.limit, limit);
  });

  it("allows unlimited responses to tighten to finite but refuses response-cap relaxation", () => {
    const unlimited = new PromptExecutionLimit({ maxResponseCharacters: null, maxAggregateCharacters: null });
    const finite = new PromptExecutionLimit({ maxResponseCharacters: 10, maxAggregateCharacters: null });
    const budget = new PromptExecutionBudget(unlimited);
    budget.consumeAggregate({ characters: 20, items: 2 });
    const before = budget.snapshot();
    assert.equal(unlimited.canContinueWith(finite), true);
    assert.deepEqual(budget.withLimit(finite).snapshot(), before);
    assert.equal(finite.canContinueWith(unlimited), false);
    const tightened = budget.withLimit(finite);
    assert.throws(() => tightened.withLimit(unlimited), RangeError);
    assert.deepEqual(tightened.snapshot(), before);
    assert.equal(unlimited.canContinueWith(unlimited), true);
  });

  it("refuses tighter independent ceilings below spent counts atomically", () => {
    const limit = new PromptExecutionLimit({ maxProviderCallCount: 4, maxSynthesisCallCount: 4,
      maxAggregateItemCount: 4, maxAggregateCharacters: null });
    const budget = new PromptExecutionBudget(limit);
    budget.consumeProviderCall();
    budget.consumeProviderCall();
    budget.consumeSynthesisCalls(2);
    budget.consumeAggregate({ characters: 20, items: 2 });
    const before = budget.snapshot();
    for (const field of ["maxProviderCallCount", "maxSynthesisCallCount", "maxAggregateItemCount"]) {
      const tighter = new PromptExecutionLimit({ ...limit, [field]: 1 });
      assert.equal(limit.canContinueWith(tighter), true, field);
      assert.throws(() => budget.withLimit(tighter), RangeError, field);
      assert.deepEqual(budget.snapshot(), before);
      assert.equal(budget.limit, limit);
    }
  });

  it("advances shrinking synthesis with unlimited characters while preserving its call cap", async () => {
    const initial = new AtomicPromptElement({ id: "initial", sequence: 0,
      sourceRevision: "initial-revision", text: "i".repeat(40) });
    const budget = new PromptExecutionBudget(new PromptExecutionLimit({
      maxAggregateCharacters: null, maxSynthesisCallCount: 1,
    }));
    const reduction = new PromptReductionPlan({ initialElements: [initial],
      coverageDigest: "coverage", executionBudget: budget });
    const envelope = new PromptRequestEnvelope({ build: (elements) => elements.map((element) => element.toPromptText()).join("") });
    const limit = new PromptRequestLimit({ maxCharacters: 100 });
    let calls = 0;
    let advances = 0;
    const callbacks = {
      isComplete: (elements) => elements[0].toPromptText().length <= 20,
      buildRound: (elements) => {
        const builder = new PromptInputBuilder({ envelope, limit });
        elements.forEach((element) => builder.add(element));
        return PromptBatchPlan.create({ collection: builder.build(), envelope, limit });
      },
      executeRound: (plan) => new PromptBatchExecutor({ executionBudget: budget }).executeCompletions({
        plan,
        callAgent: async () => { calls += 1; return "r".repeat(20); },
        responseContract: { parse: (raw) => raw },
      }),
      toNextLevel: (completions) => {
        advances += 1;
        return new PromptReductionLevel({ coverageDigest: "coverage", elements: [
          new AtomicPromptElement({ id: "summary", sequence: 0, sourceRevision: "summary-revision",
            text: completions[0].response }),
        ] });
      },
      finalize: (elements) => elements[0].toPromptText(),
    };
    assert.equal(await reduction.execute(callbacks), "r".repeat(20));
    assert.equal(advances, 1);
    assert.deepEqual(budget.snapshot(), { providerCallCount: 1, synthesisCallCount: 1,
      aggregateCharacters: 20, aggregateItemCount: 1 });
    const before = budget.snapshot();
    await assert.rejects(reduction.execute(callbacks), { code: "PROMPT_CALL_LIMIT_EXCEEDED" });
    assert.equal(calls, 1);
    assert.deepEqual(budget.snapshot(), before);
  });
});
