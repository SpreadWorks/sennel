import assert from "node:assert/strict";
import { test } from "node:test";
import { GateProviderCallAdmission } from "../../src/flow/lib/run-gate.js";
import { PromptExecutionBudget, PromptExecutionLimit, PromptProviderCallAdmission } from "../../src/lib/prompt-batching.js";
import { PromptProviderAttemptJournal } from "../../src/lib/prompt-execution-journal.js";

test("Gate admission preserves cache identity and releases the shared provisional reservation", () => {
  const budget = new PromptExecutionBudget(new PromptExecutionLimit({ maxProviderCallCount: 1 }));
  const base = new PromptProviderCallAdmission(budget);
  let guardCalls = 0;
  const admission = new GateProviderCallAdmission(base, () => { guardCalls += 1; });
  admission.claim();
  admission.recordCacheHit({ providerKey: "test", profileKey: "test/exec" });
  assert.equal(admission.reserved, true);
  assert.equal(admission.cacheHit, true);
  assert.equal(admission.cacheIdentity, base.cacheIdentity);
  assert.equal(admission.attemptCount, 0);
  admission.settle();
  assert.equal(budget.snapshot().providerCallCount, 0);
  assert.equal(admission.settled, true);
  assert.equal(guardCalls, 0);
});

test("Gate admission preserves restored transport ordinals and propagates failure-observation persistence errors", async () => {
  const events = [];
  const persistenceError = new Error("failure observation could not be saved");
  class Journal extends PromptProviderAttemptJournal {
    constructor() { super(2); }
    async beforeProviderAttempt(context, count) { events.push({ context, count }); }
    async afterProviderFailure(failure, context) { events.push({ failure, context }); throw persistenceError; }
  }
  const limit = new PromptExecutionLimit({ maxProviderCallCount: 3 });
  const budget = PromptExecutionBudget.fromSnapshot(limit, { providerCallCount: 2,
    synthesisCallCount: 0, aggregateCharacters: 0, aggregateItemCount: 0 });
  const base = new PromptProviderCallAdmission(budget, undefined, new Journal());
  const admission = new GateProviderCallAdmission(base, async (context) => { events.push({ guard: context }); });
  assert.equal(admission.initialAttemptCount, 2);
  assert.equal(admission.durable, true);
  assert.equal(budget.snapshot().providerCallCount, 2);
  admission.claim();
  const context = { attempt: 3, maxAttempts: 3 };
  await admission.beforeProviderAttempt(context);
  assert.deepEqual(events, [{ guard: context }, { context, count: 3 }]);
  assert.equal(admission.attemptCount, 3);
  assert.equal(budget.snapshot().providerCallCount, 3);
  const failure = new Error("confirmed provider failure");
  await assert.rejects(admission.afterProviderFailure(failure, context), (error) => error === persistenceError);
  assert.deepEqual(events.at(-1), { failure, context });
  assert.equal(budget.snapshot().providerCallCount, 3);
});
