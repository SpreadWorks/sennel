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
  PromptReductionDidNotConvergeFailure,
  PromptReductionLevel,
  PromptReductionPlan,
  PromptRequestEnvelope,
  PromptRequestLimit,
  PromptResponseTooLargeFailure,
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
