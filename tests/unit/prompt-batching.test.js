import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AtomicPromptElement,
  GLOBAL_PROMPT_ELEMENT_HARD_MAX,
  GroupedPromptBatchTopology,
  LinearPromptBatchTopology,
  PromptBatchExecutionIncompleteFailure,
  PromptBatchExecutor,
  PromptBatchGroup,
  PromptBatchPlan,
  PromptBatchReducer,
  PromptCallFootprint,
  PromptCallPlanFootprint,
  PromptCoverageInvalidFailure,
  PromptElementPartition,
  PromptElementTooLargeFailure,
  PromptExecutionLimit,
  PromptExecutionBudget,
  PromptFixedContextTooLargeFailure,
  PromptInputBuilder,
  PromptInputCollection,
  PromptLogicalFootprint,
  PromptPartitionNoProgressFailure,
  PromptProviderCallAdmission,
  PromptProtocolRetryLimit,
  PromptProviderAttemptLimit,
  PromptReductionDidNotConvergeFailure,
  PromptReductionLevel,
  PromptReductionPlan,
  PromptRequestEnvelope,
  PromptRequestLimit,
  PromptResponseTooLargeFailure,
  PromptResponseAllowance,
  PromptScopedBinding,
  RangedTextPromptElement,
  RepeatedPromptContextElement,
  ScopedCartesianPromptBatchTopology,
} from "../../src/lib/prompt-batching.js";

class TextEnvelope extends PromptRequestEnvelope {
  constructor({ fixed = "", schema = null, fallback = null, metadata = true } = {}) {
    super({ revision: "test-v1" });
    this.fixed = fixed;
    this.schema = schema;
    this.fallback = fallback;
    this.metadata = metadata;
  }

  build(elements, context) {
    const metadata = this.metadata ? `[${context.index + 1}/${context.count}]` : "";
    return {
      systemPrompt: this.fixed || null,
      userPrompt: `${metadata}${elements.map((element) => element.toPromptText()).join("|")}`,
      jsonSchema: this.schema,
      fmtFallback: this.fallback,
    };
  }
}

class ResultReducer extends PromptBatchReducer {
  reduce(completions) {
    return Object.freeze(completions.map((completion) => completion.response));
  }
}

function element(id, sequence, text) {
  return new RangedTextPromptElement({ id, sourceRevision: `${id}-revision`, sequence, text });
}

function buildPlan({ elements, envelope = new TextEnvelope(), maxCharacters = 80, executionLimit } = {}) {
  const limit = new PromptRequestLimit({ maxCharacters });
  const builder = new PromptInputBuilder({ envelope, limit });
  elements.forEach((entry) => builder.add(entry));
  const collection = builder.build();
  return PromptBatchPlan.create({ collection, envelope, limit, executionLimit });
}

describe("prompt batching values", () => {
  it("keeps a finite default and accepts only null as an explicit unlimited response limit", () => {
    assert.equal(new PromptExecutionLimit().maxResponseCharacters, GLOBAL_PROMPT_ELEMENT_HARD_MAX);
    assert.equal(new PromptExecutionLimit({ maxResponseCharacters: 12 }).maxResponseCharacters, 12);
    assert.equal(new PromptExecutionLimit({ maxResponseCharacters: null }).maxResponseCharacters, null);
    for (const invalid of [0, -1, 1.5, Number.NaN, Infinity, "unlimited", false]) {
      assert.throws(() => new PromptExecutionLimit({ maxResponseCharacters: invalid }), TypeError);
    }
    assert.throws(() => new PromptExecutionLimit({ maxResponseCharacters: null, maxRequestCharacters: null }), TypeError);
  });

  it("accounts for every logical request component using actual JSON serialization", () => {
    const request = {
      systemPrompt: "system",
      userPrompt: "user",
      jsonSchema: { type: "object", required: ["answer"] },
      fmtFallback: "json only",
    };
    const footprint = PromptLogicalFootprint.measure(request);

    assert.deepEqual(footprint.toJSON(), {
      systemPrompt: 6,
      userPrompt: 4,
      jsonSchema: JSON.stringify(request.jsonSchema).length,
      fmtFallback: 9,
      separators: 4,
      total: 6 + 4 + JSON.stringify(request.jsonSchema).length + 9 + 4,
    });
    assert.equal(footprint.fits(new PromptRequestLimit({ maxCharacters: footprint.total })), true);
    assert.equal(footprint.fits(new PromptRequestLimit({ maxCharacters: footprint.total - 1 })), false);
  });

  it("enforces the global request maximum and strict leaf maximum", () => {
    assert.equal(new PromptRequestLimit().maxCharacters, GLOBAL_PROMPT_ELEMENT_HARD_MAX);
    assert.throws(
      () => new PromptRequestLimit({ maxCharacters: GLOBAL_PROMPT_ELEMENT_HARD_MAX + 1 }),
      RangeError,
    );
    const envelope = new TextEnvelope({ metadata: false });
    const allowed = new PromptInputBuilder({ envelope })
      .add(element("allowed", 0, "x".repeat(GLOBAL_PROMPT_ELEMENT_HARD_MAX - 1)))
      .build();
    assert.equal(allowed.elements[0].toPromptText().length, GLOBAL_PROMPT_ELEMENT_HARD_MAX - 1);

    assert.throws(
      () => new PromptInputBuilder({ envelope })
        .add(new AtomicPromptElement({
          id: "atomic", sourceRevision: "revision", sequence: 0,
          text: "x".repeat(GLOBAL_PROMPT_ELEMENT_HARD_MAX),
        })).build(),
      (error) => error instanceof PromptElementTooLargeFailure && error.code === "PROMPT_ELEMENT_TOO_LARGE",
    );
  });

  it("keeps original and leaf collection arrays immutable", () => {
    const plan = buildPlan({ elements: [element("one", 0, "one")] });
    assert.ok(plan.collection instanceof PromptInputCollection);
    assert.equal(Object.isFrozen(plan.collection), true);
    assert.equal(Object.isFrozen(plan.collection.elements), true);
    assert.throws(() => plan.collection.elements.push(element("two", 1, "two")), TypeError);
  });
});

describe("prompt element partitioning and coverage", () => {
  it("splits a large range without bisecting UTF-16 surrogate pairs and reconstructs it exactly", () => {
    const text = `prefix\n${"😀".repeat(90)}\nsuffix`;
    const plan = buildPlan({ elements: [element("unicode", 0, text)], maxCharacters: 48 });
    const leaves = plan.batches.flatMap((batch) => batch.payloadElements);

    assert.ok(leaves.length > 1);
    assert.equal(leaves.map((leaf) => leaf.text).join(""), text);
    assert.equal(leaves[0].start, 0);
    assert.equal(leaves.at(-1).end, text.length);
    assert.ok(leaves.every((leaf) => !/^[\uDC00-\uDFFF]/.test(leaf.text)));
    assert.ok(leaves.every((leaf) => !/[\uD800-\uDBFF]$/.test(leaf.text)));
    assert.ok(plan.batches.every((batch) => batch.footprint.total <= 48));
  });

  it("preserves present-empty and deleted zero-width elements exactly once", () => {
    const empty = new RangedTextPromptElement({ id: "empty", sourceRevision: "e", sequence: 0, text: "", status: "empty" });
    const deleted = new RangedTextPromptElement({ id: "deleted", sourceRevision: "d", sequence: 1, text: "", status: "deleted" });
    const plan = buildPlan({ elements: [empty, deleted], maxCharacters: 32 });
    const leaves = plan.batches.flatMap((batch) => batch.payloadElements);

    assert.deepEqual(leaves.map((leaf) => [leaf.id, leaf.status, leaf.start, leaf.end]), [
      ["empty", "empty", 0, 0],
      ["deleted", "deleted", 0, 0],
    ]);
  });

  it("rejects gap, overlap, foreign, and no-progress partitions", () => {
    const parent = element("source", 0, "abcdef");
    const first = parent.createRange({ start: 0, end: 2 });
    const gap = parent.createRange({ start: 3, end: 6 });
    assert.throws(
      () => new PromptElementPartition({ parent, children: [first, gap] }),
      (error) => error instanceof PromptCoverageInvalidFailure && error.code === "PROMPT_COVERAGE_INVALID",
    );

    const overlap = parent.createRange({ start: 1, end: 6 });
    assert.throws(() => new PromptElementPartition({ parent, children: [first, overlap] }), PromptCoverageInvalidFailure);
    const foreign = element("other", 0, "abcdef").createRange({ start: 0, end: 6 });
    assert.throws(() => new PromptElementPartition({ parent, children: [foreign] }), PromptCoverageInvalidFailure);

    const sameRange = new RangedTextPromptElement({
      id: "different-leaf-id", originId: parent.originId, sourceRevision: parent.sourceRevision,
      sequence: parent.sequence, text: parent.text, start: parent.start, end: parent.end,
      sourceLength: parent.sourceLength,
    });
    assert.throws(
      () => new PromptElementPartition({ parent, children: [sameRange] }),
      (error) => error instanceof PromptPartitionNoProgressFailure && error.code === "PROMPT_PARTITION_NO_PROGRESS",
    );
  });

  it("rejects duplicate original identity and sequence before planning", () => {
    const envelope = new TextEnvelope();
    const builder = new PromptInputBuilder({ envelope });
    builder.add(element("same", 0, "one"));
    assert.throws(() => builder.add(element("same", 1, "two")), PromptCoverageInvalidFailure);
    assert.throws(() => builder.add(element("other", 0, "two")), PromptCoverageInvalidFailure);
  });
});

describe("prompt batch planning", () => {
  it("preserves the one-shot request and packs multiple elements by exact envelope footprint", () => {
    const envelope = new TextEnvelope({ fixed: "rules", metadata: false });
    const single = buildPlan({ elements: [element("one", 0, "payload")], envelope, maxCharacters: 20 });
    assert.equal(single.batches.length, 1);
    assert.deepEqual(single.batches[0].request, envelope.build(single.batches[0].elements, {
      index: 0, count: 1,
    }));

    const packed = buildPlan({
      elements: [element("a", 0, "a".repeat(20)), element("b", 1, "b".repeat(20)), element("c", 2, "c".repeat(20))],
      maxCharacters: 49,
    });
    assert.equal(packed.batches.length, 2);
    assert.deepEqual(packed.batches.map((batch) => batch.payloadElements.map((entry) => entry.originId)), [["a", "b"], ["c"]]);
  });

  it("plans an already-built atomic request without changing its bytes", () => {
    const request = { systemPrompt: "rules", userPrompt: "exact\nbytes", jsonSchema: { type: "object" }, fmtFallback: "json" };
    const plan = PromptBatchPlan.fromRequest({ request, limit: new PromptRequestLimit({ maxCharacters: 80 }) });
    assert.equal(plan.batches.length, 1);
    assert.deepEqual(plan.batches[0].request, request);
  });

  it("rebuilds count-sensitive metadata to a fixed point before exposing batches", () => {
    const plan = buildPlan({
      elements: Array.from({ length: 12 }, (_, index) => element(`e${index}`, index, "x".repeat(10))),
      maxCharacters: 22,
    });
    assert.ok(plan.batches.length >= 10);
    assert.ok(plan.batches.every((batch) => batch.request.userPrompt.startsWith(`[${batch.index + 1}/${plan.batches.length}]`)));
    assert.ok(plan.batches.every((batch) => batch.footprint.total <= 22));
  });

  it("counts repeated context in every singleton fit and rejects oversized fixed context", () => {
    const envelope = new TextEnvelope();
    const repeated = new RepeatedPromptContextElement({ id: "rules", sourceRevision: "r", sequence: 0, text: "r".repeat(30) });
    const payload = element("payload", 1, "p".repeat(30));
    const plan = buildPlan({ elements: [repeated, payload], envelope, maxCharacters: 48 });
    assert.ok(plan.batches.length > 1);
    assert.ok(plan.batches.every((batch) => batch.contextElements[0] === repeated));

    assert.throws(
      () => buildPlan({ elements: [repeated], envelope, maxCharacters: 30 }),
      (error) => error instanceof PromptFixedContextTooLargeFailure && error.code === "PROMPT_FIXED_CONTEXT_TOO_LARGE",
    );
  });

  it("validates grouped and scoped binding coverage without constructing an unconditional Cartesian product", () => {
    const envelope = new TextEnvelope({ metadata: false });
    const limit = new PromptRequestLimit({ maxCharacters: 60 });
    const first = element("first", 0, "first");
    const second = element("second", 1, "second");
    const builder = new PromptInputBuilder({ envelope, limit }).add(first).add(second);
    const collection = builder.build();
    const grouped = new GroupedPromptBatchTopology({ groups: [
      new PromptBatchGroup({ id: "g1", payloadElements: [collection.elements[0]] }),
      new PromptBatchGroup({ id: "g2", payloadElements: [collection.elements[1]] }),
    ] });
    const groupedPlan = PromptBatchPlan.create({ collection, envelope, limit, topology: grouped });
    assert.deepEqual(groupedPlan.batches.map((batch) => batch.groupId), ["g1", "g2"]);

    const scoped = new ScopedCartesianPromptBatchTopology({ bindings: [
      new PromptScopedBinding({ id: "scope-a:first", payloadElements: [collection.elements[0]] }),
      new PromptScopedBinding({ id: "scope-b:first", payloadElements: [collection.elements[0]] }),
      new PromptScopedBinding({ id: "scope-b:second", payloadElements: [collection.elements[1]] }),
    ] });
    const scopedPlan = PromptBatchPlan.create({ collection, envelope, limit, topology: scoped });
    assert.deepEqual(scopedPlan.batches.map((batch) => batch.groupId), ["scope-a:first", "scope-b:first", "scope-b:second"]);

    const groupedContext = new GroupedPromptBatchTopology({ groups: [
      new PromptBatchGroup({ id: "directive", contextElements: [collection.elements[0]], payloadElements: [collection.elements[1]] }),
    ] });
    const contextPlan = PromptBatchPlan.create({ collection, envelope, limit, topology: groupedContext });
    assert.equal(contextPlan.batches[0].contextElements[0].id, "first");
  });
});

describe("prompt batch execution", () => {
  it("accepts a complete 145k-character JSON response only with an unlimited response limit", async () => {
    const plan = buildPlan({ elements: [element("one", 0, "payload")], maxCharacters: 40 });
    const response = JSON.stringify({ observations: Array.from({ length: 40 }, (_, index) => ({
      rule: `rule-${index}`,
      reason: `Evidence for rule ${index}: ${"x".repeat(3600)}`,
    })) });
    assert.ok(response.length > GLOBAL_PROMPT_ELEMENT_HARD_MAX);
    assert.ok(response.length < 150_000);
    const responseContract = { parse: (raw) => JSON.parse(raw) };
    const reducer = new ResultReducer();
    await assert.rejects(
      () => new PromptBatchExecutor().execute({ plan, callAgent: async () => response, responseContract, reducer }),
      (error) => error instanceof PromptBatchExecutionIncompleteFailure
        && error.cause instanceof PromptResponseTooLargeFailure
        && error.cause.details.maxResponseCharacters === GLOBAL_PROMPT_ELEMENT_HARD_MAX,
    );
    const budget = new PromptExecutionBudget(new PromptExecutionLimit({ maxResponseCharacters: null }));
    const result = await new PromptBatchExecutor({
      executionLimit: new PromptExecutionLimit({ maxResponseCharacters: 3 }),
      executionBudget: budget,
    }).execute({ plan, callAgent: async () => response, responseContract, reducer });
    assert.equal(result[0].observations.length, 40);
    assert.equal(result[0].observations[39].rule, "rule-39");
    assert.equal(budget.snapshot().aggregateCharacters, JSON.stringify(result[0]).length);
    assert.equal(budget.snapshot().providerCallCount, 1);
  });

  it("preserves finite shared limits, aggregate limits, and input limits with unlimited responses", async () => {
    const plan = buildPlan({ elements: [element("one", 0, "payload")], maxCharacters: 40 });
    const responseContract = { parse: (raw) => raw };
    const reducer = new ResultReducer();
    await assert.rejects(
      () => new PromptBatchExecutor({
        executionLimit: new PromptExecutionLimit({ maxResponseCharacters: null }),
        executionBudget: new PromptExecutionBudget(new PromptExecutionLimit({ maxResponseCharacters: 3 })),
      }).execute({ plan, callAgent: async () => "four", responseContract, reducer }),
      (error) => error instanceof PromptBatchExecutionIncompleteFailure
        && error.cause instanceof PromptResponseTooLargeFailure,
    );
    await assert.rejects(
      () => new PromptBatchExecutor({ executionLimit: new PromptExecutionLimit({
        maxResponseCharacters: null, maxAggregateCharacters: 3,
      }) }).execute({ plan, callAgent: async () => "four", responseContract, reducer }),
      (error) => error instanceof PromptBatchExecutionIncompleteFailure
        && error.cause instanceof PromptResponseTooLargeFailure,
    );
    let calls = 0;
    await assert.rejects(
      () => new PromptBatchExecutor({ executionLimit: new PromptExecutionLimit({ maxResponseCharacters: null }) }).execute({
        plan,
        callAgent: async () => { calls += 1; return "ok"; },
        protocolPolicy: { execute: ({ call }) => call({ userPrompt: "x".repeat(41) }) },
        responseContract,
        reducer,
      }),
      (error) => error instanceof PromptBatchExecutionIncompleteFailure && error.cause.code === "PROMPT_BATCH_OVERFLOW",
    );
    assert.equal(calls, 0);
  });

  it("checks each protocol retry and its final response under the active response limit", async () => {
    const plan = buildPlan({ elements: [element("one", 0, "payload")], maxCharacters: 40 });
    const largeResponse = "result:" + "x".repeat(GLOBAL_PROMPT_ELEMENT_HARD_MAX);
    const responseContract = { parse: (raw) => raw };
    const reducer = new ResultReducer();
    let calls = 0;
    const protocolPolicy = { async execute({ call }) {
      await call();
      return call();
    } };
    const result = await new PromptBatchExecutor({ executionLimit: new PromptExecutionLimit({
      maxResponseCharacters: null, maxProtocolRetryCount: 1,
    }) }).execute({
      plan,
      callAgent: async () => { calls += 1; return calls === 1 ? "invalid" : largeResponse; },
      protocolPolicy,
      responseContract,
      reducer,
    });
    assert.deepEqual(result, [largeResponse]);
    assert.equal(calls, 2);

    await assert.rejects(
      () => new PromptBatchExecutor({ executionLimit: new PromptExecutionLimit({ maxResponseCharacters: 3 }) }).execute({
        plan,
        callAgent: async () => "ok",
        protocolPolicy: { async execute({ call }) { await call(); return "four"; } },
        responseContract,
        reducer,
      }),
      (error) => error instanceof PromptBatchExecutionIncompleteFailure
        && error.cause instanceof PromptResponseTooLargeFailure
        && error.cause.message === "Prompt response exceeds its character limit",
    );
  });

  it("preflights every projection before the first provider call", async () => {
    const plan = buildPlan({ elements: [element("one", 0, "x".repeat(30)), element("two", 1, "y".repeat(30))], maxCharacters: 45 });
    let calls = 0;
    await assert.rejects(
      () => new PromptBatchExecutor().execute({
        plan,
        callAgent: async () => { calls += 1; return "ok"; },
        projectInvocation: (_request, batch) => ({
          assertWithinLimit() {
            if (batch.index === 1) throw Object.assign(new Error("overflow"), { code: "PROMPT_INVOCATION_PROJECTION_OVERFLOW" });
          },
        }),
        responseContract: { parse: (raw) => raw },
        reducer: new ResultReducer(),
      }),
      (error) => error.code === "PROMPT_INVOCATION_PROJECTION_OVERFLOW",
    );
    assert.equal(calls, 0);
  });

  it("parses every response immediately and reduces only after exact completion", async () => {
    const plan = buildPlan({ elements: [element("one", 0, "x".repeat(30)), element("two", 1, "y".repeat(30))], maxCharacters: 45 });
    const events = [];
    const result = await new PromptBatchExecutor().execute({
      plan,
      callAgent: async (_request, batch) => { events.push(`call:${batch.index}`); return JSON.stringify({ index: batch.index }); },
      responseContract: { parse: (raw, batch) => { events.push(`parse:${batch.index}`); return JSON.parse(raw); } },
      reducer: new class extends PromptBatchReducer {
        reduce(completions) {
          events.push("reduce");
          return completions.map((completion) => completion.response.index);
        }
      }(),
    });

    assert.deepEqual(result, plan.batches.map((batch) => batch.index));
    assert.deepEqual(events, plan.batches.flatMap((batch) => [`call:${batch.index}`, `parse:${batch.index}`]).concat("reduce"));
  });

  it("returns no reduced result when a later batch fails", async () => {
    const plan = buildPlan({ elements: [element("one", 0, "x".repeat(30)), element("two", 1, "y".repeat(30))], maxCharacters: 45 });
    let reductions = 0;
    await assert.rejects(
      () => new PromptBatchExecutor().execute({
        plan,
        callAgent: async (_request, batch) => {
          if (batch.index === plan.batches.length - 1) throw new Error("transport failed");
          return "ok";
        },
        responseContract: { parse: (raw) => raw },
        reducer: new class extends PromptBatchReducer { reduce() { reductions += 1; return "published"; } }(),
      }),
      (error) => error instanceof PromptBatchExecutionIncompleteFailure
        && error.code === "PROMPT_BATCH_EXECUTION_INCOMPLETE"
        && error.cause.message === "transport failed",
    );
    assert.equal(reductions, 0);
  });

  it("bounds response size and every actual protocol-policy provider call", async () => {
    const plan = buildPlan({ elements: [element("one", 0, "payload")], maxCharacters: 40 });
    await assert.rejects(
      () => new PromptBatchExecutor({ executionLimit: new PromptExecutionLimit({ maxResponseCharacters: 3 }) }).execute({
        plan,
        callAgent: async () => "large",
        responseContract: { parse: (raw) => raw },
        reducer: new ResultReducer(),
      }),
      (error) => error instanceof PromptBatchExecutionIncompleteFailure
        && error.cause instanceof PromptResponseTooLargeFailure,
    );

    let calls = 0;
    await assert.rejects(
      () => new PromptBatchExecutor({ executionLimit: new PromptExecutionLimit({ maxProviderCallCount: 2, maxProtocolRetryCount: 1 }) }).execute({
        plan,
        callAgent: async () => { calls += 1; return "invalid"; },
        protocolPolicy: { async execute({ call }) { await call(); await call(); return call(); } },
        responseContract: { parse: (raw) => raw },
        reducer: new ResultReducer(),
      }),
      (error) => error instanceof PromptBatchExecutionIncompleteFailure && error.cause.code === "PROMPT_CALL_LIMIT_EXCEEDED",
    );
    assert.equal(calls, 2);
  });

  it("rechecks overridden protocol requests and their provider projections before a call", async () => {
    const plan = buildPlan({ elements: [element("one", 0, "payload")], maxCharacters: 40 });
    let calls = 0;
    let projections = 0;
    await assert.rejects(
      () => new PromptBatchExecutor({ executionLimit: new PromptExecutionLimit({ maxProtocolRetryCount: 1 }) }).execute({
        plan,
        callAgent: async () => { calls += 1; return "ok"; },
        projectInvocation: () => ({ assertWithinLimit() { projections += 1; } }),
        protocolPolicy: {
          execute: ({ call }) => call({ userPrompt: "x".repeat(41) }),
        },
        responseContract: { parse: (raw) => raw },
        reducer: new ResultReducer(),
      }),
      (error) => error instanceof PromptBatchExecutionIncompleteFailure
        && error.cause.code === "PROMPT_BATCH_OVERFLOW",
    );
    assert.equal(projections, 1);
    assert.equal(calls, 0);
  });

  it("charges parsed aggregates immediately and stops before retaining a later batch", async () => {
    const plan = buildPlan({
      elements: [element("one", 0, "x".repeat(25)), element("two", 1, "y".repeat(25)), element("three", 2, "z".repeat(25))],
      maxCharacters: 35,
    });
    let calls = 0;
    await assert.rejects(
      () => new PromptBatchExecutor({ executionLimit: new PromptExecutionLimit({ maxAggregateCharacters: 10 }) }).execute({
        plan,
        callAgent: async () => { calls += 1; return "123456"; },
        responseContract: { parse: (raw) => raw },
        reducer: new ResultReducer(),
      }),
      (error) => error instanceof PromptBatchExecutionIncompleteFailure
        && error.cause.code === "PROMPT_RESPONSE_TOO_LARGE",
    );
    assert.equal(plan.batches.length, 3);
    assert.equal(calls, 2);
  });

  it("counts Agent transport attempts through the injected provider-attempt admission", async () => {
    const plan = buildPlan({ elements: [element("one", 0, "payload")], maxCharacters: 40 });
    let providerAttempts = 0;
    await assert.rejects(
      () => new PromptBatchExecutor({ executionLimit: new PromptExecutionLimit({ maxProviderCallCount: 1 }) }).execute({
        plan,
        callAgent: async (_request, _batch, _retry, _context, admission) => {
          admission.claim();
          admission.beforeProviderAttempt();
          providerAttempts += 1;
          admission.beforeProviderAttempt();
          providerAttempts += 1;
          return "ok";
        },
        responseContract: { parse: (raw) => raw },
        reducer: new ResultReducer(),
      }),
      (error) => error instanceof PromptBatchExecutionIncompleteFailure
        && error.cause.code === "PROMPT_CALL_LIMIT_EXCEEDED",
    );
    assert.equal(providerAttempts, 1);
  });

  it("refunds the reserved provider slot when Agent claims a cache hit without transport", async () => {
    const plan = buildPlan({ elements: [element("one", 0, "payload")], maxCharacters: 40 });
    const budget = new PromptExecutionBudget(new PromptExecutionLimit({ maxProviderCallCount: 1 }));
    const result = await new PromptBatchExecutor({ executionBudget: budget }).execute({
      plan,
      callAgent: async (_request, _batch, _retry, _context, admission) => {
        admission.claim();
        return "cached";
      },
      responseContract: { parse: (raw) => raw },
      reducer: new ResultReducer(),
    });
    assert.deepEqual(result, ["cached"]);
    assert.equal(budget.snapshot().providerCallCount, 0);
  });

  it("makes provider admission ownership and settlement single-use invariants", () => {
    const budget = new PromptExecutionBudget(new PromptExecutionLimit({ maxProviderCallCount: 2 }));
    const admission = new PromptProviderCallAdmission(budget);
    admission.claim();
    assert.throws(() => admission.claim(), /already claimed/);
    admission.beforeProviderAttempt();
    admission.settle();
    assert.throws(() => admission.settle(), /already settled/);
    assert.throws(() => admission.beforeProviderAttempt(), /already settled/);
    assert.deepEqual(budget.snapshot(), {
      providerCallCount: 1,
      synthesisCallCount: 0,
      aggregateCharacters: 0,
      aggregateItemCount: 0,
    });
  });

  it("admits a provider attempt atomically across command and group budgets", () => {
    for (const exhaustedScope of ["command", "group"]) {
      const command = new PromptExecutionBudget(new PromptExecutionLimit({ maxProviderCallCount: 2 }));
      const group = new PromptExecutionBudget(new PromptExecutionLimit({ maxProviderCallCount: 2 }));
      const admission = new PromptProviderCallAdmission(command, group);
      admission.claim();
      admission.beforeProviderAttempt();
      const exhausted = exhaustedScope === "command" ? command : group;
      exhausted.consumeProviderCall();
      const before = [command.snapshot(), group.snapshot()];
      assert.throws(() => admission.beforeProviderAttempt(), { code: "PROMPT_CALL_LIMIT_EXCEEDED" });
      assert.deepEqual([command.snapshot(), group.snapshot()], before);
      assert.equal(admission.attemptCount, 1);
      admission.settle();
      assert.throws(() => new PromptProviderCallAdmission(command, group), { code: "PROMPT_CALL_LIMIT_EXCEEDED" });
      assert.deepEqual([command.snapshot(), group.snapshot()], before);
    }
  });

  it("counts unclaimed adapter failures while excluding refunded cache reservations", async () => {
    const plan = buildPlan({ elements: [element("one", 0, "payload")], maxCharacters: 40 });
    const budget = new PromptExecutionBudget(new PromptExecutionLimit({ maxProviderCallCount: 1 }));
    const snapshots = [];
    let calls = 0;
    const completions = await new PromptBatchExecutor({ executionBudget: budget }).executeCompletions({
      plan,
      protocolRetryLimit: new PromptProtocolRetryLimit(2),
      providerAttemptLimit: new PromptProviderAttemptLimit(1),
      callAgent: async (_request, _batch, _retry, _context, admission) => {
        calls += 1;
        if (calls < 3) { admission.claim(); return "cached"; }
        throw Object.assign(new Error("startup failed"), { code: "STARTUP_FAILED" });
      },
      protocolPolicy: { async execute({ call, accounting }) {
        await call(); snapshots.push(accounting.snapshot().toJSON());
        await call(); snapshots.push(accounting.snapshot().toJSON());
        await assert.rejects(call(), (error) => {
          assert.deepEqual(accounting.snapshot().toJSON(), { responseCallCount: 3, providerAttemptCount: 1 });
          return error.code === "STARTUP_FAILED";
        });
        return "completed";
      } },
      responseContract: { parse: (raw) => raw },
    });
    assert.deepEqual(snapshots, [
      { responseCallCount: 1, providerAttemptCount: 0 },
      { responseCallCount: 2, providerAttemptCount: 0 },
    ]);
    assert.deepEqual(completions[0].executionAccounting.toJSON(), { responseCallCount: 3, providerAttemptCount: 1 });
    assert.equal(budget.providerCallCount, 1);
  });

  it("shares the provider cap across batches in the same group and rejects the next adapter call", async () => {
    const plan = buildPlan({ elements: [element("one", 0, "x".repeat(30)), element("two", 1, "y".repeat(30))], maxCharacters: 45 });
    const budget = new PromptExecutionBudget(new PromptExecutionLimit({ maxProviderCallCount: 10 }));
    let calls = 0;
    await assert.rejects(new PromptBatchExecutor({ executionBudget: budget }).executeCompletions({
      plan,
      protocolRetryLimit: new PromptProtocolRetryLimit(1),
      providerAttemptLimit: new PromptProviderAttemptLimit(1),
      callAgent: async () => { calls += 1; return "ok"; },
      responseContract: { parse: (raw) => raw },
    }), (error) => {
      assert.equal(error.cause.code, "PROMPT_CALL_LIMIT_EXCEEDED");
      assert.deepEqual(error.details.executionAccounting, { responseCallCount: 1, providerAttemptCount: 1 });
      assert.equal(error.details.completedBatchDigests.length, 1);
      return error instanceof PromptBatchExecutionIncompleteFailure;
    });
    assert.equal(calls, 1);
    assert.equal(budget.providerCallCount, 1);
  });

  it("preserves immutable adapter and protocol errors while recording executor failure counts", async () => {
    const plan = buildPlan({ elements: [element("one", 0, "payload")], maxCharacters: 40 });
    for (const boundary of ["adapter", "protocol"]) {
      const original = Object.freeze(Object.assign(new Error(`${boundary} failed`), { code: "IMMUTABLE_FAILURE" }));
      const originalKeys = Reflect.ownKeys(original);
      const budget = new PromptExecutionBudget(new PromptExecutionLimit({ maxProviderCallCount: 1 }));
      await assert.rejects(new PromptBatchExecutor({ executionBudget: budget }).executeCompletions({
        plan,
        callAgent: async () => {
          if (boundary === "adapter") throw original;
          return "valid";
        },
        protocolPolicy: { async execute({ call }) {
          await call();
          throw original;
        } },
        responseContract: { parse: (raw) => raw },
      }), (error) => {
        assert.ok(error instanceof PromptBatchExecutionIncompleteFailure);
        assert.equal(error.cause, original);
        assert.equal(error.details.causeCode, "IMMUTABLE_FAILURE");
        assert.deepEqual(error.details.executionAccounting, { responseCallCount: 1, providerAttemptCount: 1 });
        assert.equal(Object.isFrozen(original), true);
        assert.deepEqual(Reflect.ownKeys(original), originalKeys);
        return true;
      });
      assert.equal(budget.providerCallCount, 1);
    }
  });

  it("keeps parallel group attempt limits independent under the shared command cap", async () => {
    const envelope = new TextEnvelope();
    const limit = new PromptRequestLimit({ maxCharacters: 80 });
    const collection = new PromptInputBuilder({ envelope, limit })
      .add(element("one", 0, "one")).add(element("two", 1, "two")).build();
    const topology = new GroupedPromptBatchTopology({ groups: collection.elements.map((entry) =>
      new PromptBatchGroup({ id: entry.id, payloadElements: [entry] })) });
    const plan = PromptBatchPlan.create({ collection, envelope, limit, topology });
    const budget = new PromptExecutionBudget(new PromptExecutionLimit({ maxProviderCallCount: 4, concurrency: 2 }));
    const calls = [];
    const executor = new PromptBatchExecutor({ executionBudget: budget });
    const options = {
      plan,
      protocolRetryLimit: new PromptProtocolRetryLimit(1),
      providerAttemptLimit: new PromptProviderAttemptLimit(2),
      callAgent: async (_request, batch) => { calls.push(batch.groupId); return "ok"; },
      protocolPolicy: { async execute({ call }) { await call(); return call(); } },
      responseContract: { parse: (raw) => raw },
    };
    const completions = await executor.executeCompletions(options);
    assert.equal(calls.filter((id) => id === "one").length, 2);
    assert.equal(calls.filter((id) => id === "two").length, 2);
    assert.deepEqual(completions.map((completion) => completion.executionAccounting.toJSON()), [
      { responseCallCount: 2, providerAttemptCount: 2 },
      { responseCallCount: 2, providerAttemptCount: 2 },
    ]);
    assert.equal(budget.providerCallCount, 4);
    await assert.rejects(executor.executeCompletions(options), { code: "PROMPT_CALL_LIMIT_EXCEEDED" });
    assert.equal(calls.length, 4);
  });

  it("restores spent and unsettled provider reservations without resetting any shared limit", () => {
    const limit = new PromptExecutionLimit({ maxProviderCallCount: 2, maxSynthesisCallCount: 1,
      maxAggregateCharacters: 10, maxAggregateItemCount: 2 });
    const budget = new PromptExecutionBudget(limit);
    const completed = new PromptProviderCallAdmission(budget);
    completed.claim(); completed.beforeProviderAttempt(); completed.settle();
    new PromptProviderCallAdmission(budget); // Crash after reserving, before saving the response.
    budget.consumeSynthesisCalls(1);
    budget.consumeAggregate({ characters: 10, items: 2 });
    const serialized = JSON.parse(JSON.stringify(budget.snapshot()));
    const restored = PromptExecutionBudget.fromSnapshot(limit, serialized);
    assert.deepEqual(restored.snapshot(), serialized);
    assert.throws(() => new PromptProviderCallAdmission(restored), { code: "PROMPT_CALL_LIMIT_EXCEEDED" });
    assert.throws(() => restored.consumeSynthesisCalls(1), { code: "PROMPT_CALL_LIMIT_EXCEEDED" });
    assert.throws(() => restored.consumeAggregate({ characters: 1, items: 0 }), { code: "PROMPT_RESPONSE_TOO_LARGE" });
    assert.deepEqual(restored.snapshot(), serialized);
  });

  it("rejects malformed or over-budget durable accounting at the restore boundary", () => {
    const limit = new PromptExecutionLimit({ maxProviderCallCount: 2 });
    const snapshot = new PromptExecutionBudget(limit).snapshot();
    for (const invalid of [null, {}, { ...snapshot, extra: 0 },
      { ...snapshot, providerCallCount: -1 }, { ...snapshot, aggregateCharacters: 0.5 },
      { ...snapshot, providerCallCount: 3 }]) {
      assert.throws(() => PromptExecutionBudget.fromSnapshot(limit, invalid));
    }
    assert.deepEqual(snapshot, { providerCallCount: 0, synthesisCallCount: 0, aggregateCharacters: 0, aggregateItemCount: 0 });
  });
});

describe("known prompt call costs", () => {
  it("counts decoded documents and every logical instruction component independently of UTF-8 bytes", () => {
    for (const text of ["aaa", "日本語", "😀a"]) {
      const instructions = { systemPrompt: text, userPrompt: text,
        jsonSchema: { description: text }, fmtFallback: text };
      const documentTexts = [JSON.stringify({ text }), JSON.stringify({ repeated: text })];
      const footprint = new PromptCallFootprint({ instructions, documentTexts });
      const expectedInstructions = PromptLogicalFootprint.measure(instructions);
      const expectedDocuments = documentTexts.reduce((total, entry) => total + entry.length, 0);
      assert.deepEqual(footprint.toJSON(), {
        instructionFootprint: expectedInstructions.toJSON(),
        instructionCharacters: expectedInstructions.total,
        documentCharacters: expectedDocuments,
        characters: expectedInstructions.total + expectedDocuments,
        items: 3,
      });
      documentTexts.push("changed after measurement");
      assert.equal(footprint.documentCharacters, expectedDocuments);
      if (text !== "aaa") assert.ok(Buffer.byteLength(text, "utf8") > text.length);
      assert.equal(Object.isFrozen(footprint), true);
    }
  });

  it("projects all remaining input and per-call response allowances without spending restored accounting", () => {
    const calls = [new PromptCallFootprint({ instructions: "ask", documentTexts: ["日本語"] }),
      new PromptCallFootprint({ instructions: "next", documentTexts: ["{}", "[]"] })];
    const responseAllowances = [new PromptResponseAllowance({ characters: 2, items: 1 }),
      new PromptResponseAllowance({ characters: 5, items: 2 })];
    const plan = new PromptCallPlanFootprint({ calls, responseAllowances, synthesisCallCount: 1 });
    const limit = new PromptExecutionLimit({ maxAggregateCharacters: 24, maxAggregateItemCount: 10,
      maxProviderCallCount: 3, maxSynthesisCallCount: 2 });
    const spent = new PromptExecutionBudget(limit);
    spent.consumeProviderCall();
    spent.consumeSynthesisCalls(1);
    spent.consumeAggregate({ characters: 3, items: 2 });
    const budget = PromptExecutionBudget.fromSnapshot(limit, JSON.parse(JSON.stringify(spent.snapshot())));
    const before = budget.snapshot();
    assert.equal(plan.assertFits(budget), plan);
    assert.deepEqual(budget.snapshot(), before);
    assert.deepEqual(plan.toJSON(), { calls: calls.map((call) => call.toJSON()),
      responseAllowances: responseAllowances.map((allowance) => allowance.toJSON()),
      callCount: 2, synthesisCallCount: 1, characters: 21, items: 8 });
    calls.pop(); responseAllowances.pop();
    assert.equal(plan.callCount, 2);
    budget.consumeAggregate(plan);
    assert.equal(budget.aggregateCharacters, 24);
    assert.equal(budget.aggregateItemCount, 10);
  });

  it("rejects projected and actual aggregate overflow identically and atomically", () => {
    for (const cost of [{ characters: 5, items: 0 }, { characters: 0, items: 3 }]) {
      const budget = new PromptExecutionBudget(new PromptExecutionLimit({
        maxAggregateCharacters: 10, maxAggregateItemCount: 5 }));
      budget.consumeAggregate({ characters: 6, items: 3 });
      const before = budget.snapshot();
      let projectedError;
      assert.throws(() => budget.assertCanConsumeAggregate(cost), (error) => {
        projectedError = error;
        return error.code === "PROMPT_RESPONSE_TOO_LARGE";
      });
      assert.throws(() => budget.consumeAggregate(cost), (error) => {
        assert.deepEqual(error.details, projectedError.details);
        return error.code === projectedError.code;
      });
      assert.deepEqual(budget.snapshot(), before);
    }
  });

  it("refuses a plan whose input fits but whose conservative response allowance exhausts aggregate capacity", () => {
    for (const allowance of [{ characters: 6, items: 0 }, { characters: 0, items: 2 }]) {
      const budget = new PromptExecutionBudget(new PromptExecutionLimit({
        maxAggregateCharacters: 10, maxAggregateItemCount: 2 }));
      const call = new PromptCallFootprint({ instructions: "input" });
      budget.assertCanConsumeAggregate(call);
      const plan = new PromptCallPlanFootprint({ calls: [call],
        responseAllowances: [new PromptResponseAllowance(allowance)] });
      const before = budget.snapshot();
      assert.throws(() => plan.assertFits(budget), { code: "PROMPT_RESPONSE_TOO_LARGE" });
      assert.deepEqual(budget.snapshot(), before);
    }
  });

  it("keeps instruction, response, batch, provider and synthesis limits independent from aggregate input", () => {
    const cases = [
      { options: { maxRequestCharacters: 4 }, code: "PROMPT_FIXED_CONTEXT_TOO_LARGE" },
      { options: { maxResponseCharacters: 1 }, code: "PROMPT_RESPONSE_TOO_LARGE" },
      { options: { maxBatchCount: 1 }, code: "PROMPT_BATCH_COUNT_EXCEEDED" },
      { options: { maxProviderCallCount: 1 }, code: "PROMPT_CALL_LIMIT_EXCEEDED" },
      { options: { maxSynthesisCallCount: 1 }, code: "PROMPT_CALL_LIMIT_EXCEEDED" },
    ];
    const call = new PromptCallFootprint({ instructions: "input", documentTexts: ["d".repeat(20)] });
    const allowance = new PromptResponseAllowance({ characters: 2, items: 1 });
    const plan = new PromptCallPlanFootprint({ calls: [call, call],
      responseAllowances: [allowance, allowance], synthesisCallCount: 2 });
    for (const { options, code } of cases) {
      const budget = new PromptExecutionBudget(new PromptExecutionLimit(options));
      const before = budget.snapshot();
      assert.throws(() => plan.assertFits(budget), { code });
      assert.deepEqual(budget.snapshot(), before);
    }
    const budget = new PromptExecutionBudget(new PromptExecutionLimit({ maxRequestCharacters: 5,
      maxResponseCharacters: null }));
    assert.equal(plan.assertFits(budget), plan);
    assert.equal(budget.aggregateCharacters, 0);
  });

  it("requires serialized document text and one typed response allowance for every known call", () => {
    assert.throws(() => new PromptCallFootprint({ instructions: "ask", documentTexts: [{}] }), TypeError);
    assert.throws(() => new PromptCallFootprint(), TypeError);
    const call = new PromptCallFootprint({ instructions: "ask" });
    assert.throws(() => new PromptCallPlanFootprint({ calls: [call], responseAllowances: [] }), TypeError);
    assert.throws(() => new PromptCallPlanFootprint({ calls: [call],
      responseAllowances: [{ characters: 1, items: 1 }] }), TypeError);
    assert.throws(() => new PromptResponseAllowance({ characters: -1, items: 0 }), TypeError);
  });

  it("restores typed call cost projections and rejects inconsistent or malformed serialized costs", () => {
    const call = new PromptCallFootprint({ instructions: { systemPrompt: "sys", userPrompt: "日本語" },
      documentTexts: [JSON.stringify({ text: "😀" })] });
    const allowance = new PromptResponseAllowance({ characters: 6, items: 2 });
    const plan = new PromptCallPlanFootprint({ calls: [call], responseAllowances: [allowance] });
    const serialized = JSON.parse(JSON.stringify(plan));
    const restored = PromptCallPlanFootprint.fromJSON(serialized);
    assert.ok(restored.calls[0] instanceof PromptCallFootprint);
    assert.ok(restored.responseAllowances[0] instanceof PromptResponseAllowance);
    assert.deepEqual(restored.toJSON(), serialized);
    assert.equal(Object.isFrozen(restored), true);
    const callJSON = serialized.calls[0];
    for (const invalid of [null, { ...callJSON, extra: 0 }, { ...callJSON, documentCharacters: null },
      { ...callJSON, items: 0 }, { ...callJSON, items: 1 }, { ...callJSON, characters: callJSON.characters + 1 },
      { ...callJSON, instructionCharacters: callJSON.instructionCharacters + 1 },
      { ...callJSON, instructionFootprint: { ...callJSON.instructionFootprint, total: 0 } }]) {
      assert.throws(() => PromptCallFootprint.fromJSON(invalid), TypeError);
    }
    for (const invalid of [{ ...serialized, characters: serialized.characters + 1 },
      { ...serialized, items: serialized.items + 1 }, { ...serialized, callCount: 2 },
      { ...serialized, responseAllowances: [] }]) {
      assert.throws(() => PromptCallPlanFootprint.fromJSON(invalid), TypeError);
    }
    assert.throws(() => PromptResponseAllowance.fromJSON({ characters: 6, items: 2, extra: 0 }), TypeError);
  });
});

describe("prompt reduction", () => {
  it("inherits coverage and converges through typed completion levels", async () => {
    const initial = [element("a", 0, "aaaa"), element("b", 1, "bbbb")];
    const reduction = new PromptReductionPlan({ initialElements: initial, coverageDigest: "coverage" });
    const final = await reduction.execute({
      isComplete: (elements) => elements.length === 1,
      buildRound: (elements) => buildPlan({ elements, maxCharacters: 40 }),
      executeRound: (plan) => new PromptBatchExecutor().executeCompletions({
        plan,
        callAgent: async () => "x",
        responseContract: { parse: (raw) => raw },
      }),
      toNextLevel: () => new PromptReductionLevel({
        elements: [new AtomicPromptElement({ id: "summary", sourceRevision: "summary-revision", sequence: 0, text: "x" })],
        coverageDigest: "coverage",
      }),
      finalize: (elements, coverageDigest) => ({ text: elements[0].toPromptText(), coverageDigest }),
    });

    assert.deepEqual(final, { text: "x", coverageDigest: "coverage" });
  });

  it("fails closed when reduction loses coverage or reaches a fixed point", async () => {
    const initial = [element("a", 0, "aaaa"), element("b", 1, "bbbb")];
    const callbacks = {
      isComplete: () => false,
      buildRound: (elements) => buildPlan({ elements, maxCharacters: 40 }),
      executeRound: (plan) => new PromptBatchExecutor().executeCompletions({
        plan,
        callAgent: async () => "x",
        responseContract: { parse: (raw) => raw },
      }),
      finalize: () => assert.fail("must not finalize"),
    };
    await assert.rejects(
      () => new PromptReductionPlan({ initialElements: initial, coverageDigest: "coverage" }).execute({
        ...callbacks,
        toNextLevel: () => new PromptReductionLevel({ elements: [element("short", 0, "x")], coverageDigest: "foreign" }),
      }),
      (error) => error.code === "PROMPT_RESPONSE_COVERAGE_INVALID",
    );
    await assert.rejects(
      () => new PromptReductionPlan({ initialElements: initial, coverageDigest: "coverage" }).execute({
        ...callbacks,
        toNextLevel: () => new PromptReductionLevel({ elements: initial, coverageDigest: "coverage" }),
      }),
      (error) => error instanceof PromptReductionDidNotConvergeFailure
        && error.code === "PROMPT_REDUCTION_DID_NOT_CONVERGE",
    );
  });
});
