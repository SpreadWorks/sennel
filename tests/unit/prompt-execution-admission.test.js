import assert from "node:assert/strict";
import { it } from "node:test";
import { PromptBatchExecutor, PromptBatchPlan, PromptExecutionBudget, PromptExecutionLimit,
  PromptInputBuilder, PromptPreparedExecution, PromptPreparedInvocation,
  PromptProtocolRetryLimit, PromptRequestEnvelope, PromptRequestLimit, RangedTextPromptElement } from "../../src/lib/prompt-batching.js";

class Envelope extends PromptRequestEnvelope {
  build(elements) { return { userPrompt: elements.map((entry) => entry.toPromptText()).join("|") }; }
}

function plan() {
  const envelope = new Envelope({ revision: "admission-test" });
  const limit = new PromptRequestLimit({ maxCharacters: 12 });
  const builder = new PromptInputBuilder({ envelope, limit });
  for (const [index, text] of ["abcdefghij", "klmnopqrst"].entries()) {
    builder.add(new RangedTextPromptElement({ id: `item-${index}`, sourceRevision: "revision", sequence: index, text }));
  }
  return PromptBatchPlan.create({ collection: builder.build(), envelope, limit });
}

it("prepares all chosen invocations without dispatch or admission, with distinct execution identities", async () => {
  const selected = plan();
  let admitted = 0;
  const executor = new PromptBatchExecutor({ executionAdmission: {
    async admit() { admitted += 1; }, async beforeProviderAttempt() {},
  } });
  const projected = [];
  const projectInvocation = (request, batch) => ({
    promptCharacterCount: request.userPrompt.length + 1,
    assertWithinLimit(limit) { assert.equal(limit.maxCharacters, 12); projected.push(batch.digest); },
  });
  const prepared = await executor.prepareExecution({ plan: selected, projectInvocation });
  const another = await executor.prepareExecution({ plan: selected, projectInvocation });
  assert.ok(prepared instanceof PromptPreparedExecution);
  assert.ok(prepared.invocations.every((entry) => entry instanceof PromptPreparedInvocation));
  assert.equal(prepared.batchCount, 2);
  assert.equal(prepared.inputCharacters, 22);
  assert.notEqual(prepared.occurrenceId, another.occurrenceId);
  assert.deepEqual(projected, [...selected.batches, ...selected.batches].map((batch) => batch.digest));
  assert.equal(admitted, 0);
  assert.equal(executor.executionBudget.providerCallCount, 0);
});

it("awaits complete-plan admission before workers and preserves budgets when admission refuses", async () => {
  const selected = plan();
  const refusal = new Error("execution denied");
  const budget = new PromptExecutionBudget(new PromptExecutionLimit({ concurrency: 2 }));
  let calls = 0;
  let projections = 0;
  const executor = new PromptBatchExecutor({ executionBudget: budget, executionAdmission: {
    async admit(prepared) { assert.equal(prepared.invocations.length, projections); throw refusal; },
    async beforeProviderAttempt() {},
  } });
  await assert.rejects(executor.executeCompletions({ plan: selected,
    projectInvocation: () => ({ assertWithinLimit() { projections += 1; } }),
    callAgent: () => { calls += 1; return "response"; }, responseContract: { parse: (value) => value },
  }), (error) => error === refusal);
  assert.equal(projections, 2);
  assert.equal(calls, 0);
  assert.deepEqual(budget.snapshot(), { providerCallCount: 0, synthesisCallCount: 0,
    aggregateCharacters: 0, aggregateItemCount: 0 });
});

it("links protocol calls to one occurrence and reserves only the first planned attempt", async () => {
  const selected = PromptBatchPlan.fromRequest({ id: "retry", request: { userPrompt: "input" } });
  const invocations = [];
  const executor = new PromptBatchExecutor({ executionAdmission: {
    async admit(prepared) { assert.equal(prepared.inputCharacters, 5); },
    async beforeProviderAttempt(context) { invocations.push(context.invocation); },
  } });
  await executor.executeCompletions({ plan: selected,
    protocolRetryLimit: new PromptProtocolRetryLimit(1),
    protocolPolicy: { async execute({ call }) { await call(); return call({ userPrompt: "new input" }); } },
    callAgent: async (request, _batch, _index, _attempt, admission) => {
      admission.claim();
      await admission.beforeProviderAttempt({ invocation: admission.invocation });
      admission.settle();
      return request.userPrompt;
    }, responseContract: { parse: (value) => value },
  });
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].occurrenceId, invocations[1].occurrenceId);
  assert.notEqual(invocations[0].logicalInvocationId, invocations[1].logicalInvocationId);
  assert.deepEqual(invocations.map((entry) => [entry.initialPlannedAttempt, entry.inputCharacters]), [[true, 5], [false, 9]]);
  assert.equal(executor.executionBudget.providerCallCount, 2);
});
