import assert from "node:assert/strict";
import { test } from "node:test";
import { FreshFlowFixture, makeFlowManager, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { FlowProcessEventWriter } from "../../../src/flow/lib/flow-process-event.js";
import { ProcessExecutionRuntime, ProcessExecutionOwnershipReservation } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionBinding, ProcessExecutionStopReceipt, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-values.js";
import { NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";

class PublicationSignal {
  constructor() { this.promise = new Promise((resolve) => { this.resolve = resolve; }); }
  wait() { return this.promise; }
  release() { this.resolve(); }
}

class PublicationScopeScenario {
  constructor(t) {
    this.root = createTmpDir("process-publication-scope-");
    this.runtime = null;
    t.after(async () => {
      try { if (this.runtime !== null) await this.runtime.close(); }
      finally { removeQuiescentRuntimeFixture({ mainRoot: this.root }); }
    });
    setupFlowConfig(this.root);
    this.manager = makeFlowManager(this.root);
    this.specId = "001-publication-scope";
    new FreshFlowFixture({ flowManager: this.manager, specId: this.specId, runId: "publication-scope-run",
      execution: { mode: "direct" } }).create().registerActive();
    this.manager.beginNextAction(this.specId);
    const state = this.manager.canonicalState(this.specId);
    this.binding = new ProcessExecutionBinding({ runId: state.runId, specId: state.specId,
      flowVersionId: state.flowVersionId, nodeId: state.attempt.nodeId,
      attemptId: state.attempt.id, attemptSequence: state.attempt.sequence });
    this.writer = new FlowProcessEventWriter(this.manager);
    this.publicationFailure = null;
  }
  write(event) {
    const acknowledgement = this.writer.write(event);
    if (this.publicationFailure !== null) throw this.publicationFailure;
    return acknowledgement;
  }
  async acquire({ publish = true } = {}) {
    this.runtime = await ProcessExecutionRuntime.acquire({ mainRoot: this.root, binding: this.binding,
      runId: this.binding.value.runId, specId: this.specId,
      eventWriter: publish ? (event) => this.write(event) : null });
    return this.runtime;
  }
  run(output, runtime = this.runtime, options = {}) {
    return executeManagedProcess(new NativeExecutableInvocation({ executable: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(output)})`], cwd: this.root }), [],
    { ...options, runtime, timeoutMs: 20000 });
  }
  inventory() {
    return this.runtime.inspect().executions.find((entry) => entry.executionId === this.runtime.executionId);
  }
  canonicalEvents() {
    return makeFlowManager(this.root).activityLedger(this.specId)
      .filter((activity) => activity.processEvent?.executionId === this.runtime.executionId);
  }
  assertCompletion(result, output) {
    const call = this.inventory().calls.find((entry) => entry.callId === result.callId);
    assert.equal(result.stdout, output);
    assert.ok(result.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt);
    assert.equal(call.status, "stopped");
    assert.equal(call.observation.kind, "exited");
    assert.equal(call.observation.code, 0);
    assert.equal(call.receipt.output.stdoutBytes, Buffer.byteLength(output));
    assert.deepEqual(result.processExecutionStopReceipt.toJSON(), call.receipt);
  }
  assertPublished(callCount) {
    const saved = this.inventory();
    assert.equal(saved.calls.length, callCount);
    assert.equal(saved.events.length, callCount * 4);
    assert.deepEqual(saved.eventAcknowledgements.map((ack) => ack.eventId), saved.events.map((event) => event.eventId));
    const canonical = this.canonicalEvents();
    assert.deepEqual(canonical.map((activity) => activity.processEvent), saved.events);
    assert.equal(new Set(canonical.map((activity) => activity.id)).size, callCount * 4);
  }
  async close() {
    await this.runtime.close();
    const closed = ProcessExecutionRuntime.inspect({ mainRoot: this.root });
    assert.equal(closed.slot, null);
    assert.equal(closed.executions.find((entry) => entry.executionId === this.runtime.executionId).status, "closed");
  }
}

test("nested publication scopes preserve values, original body errors, and both ordered failure causes", { timeout: 120000 }, async (t) => {
  const scenario = new PublicationScopeScenario(t);
  const runtime = await scenario.acquire();
  const value = Symbol("nested-result");
  assert.equal(await runtime.withDeferredEventPublication(async () => {
    const nested = await runtime.withDeferredEventPublication(async () => {
      const result = await scenario.run("nested-value");
      scenario.assertCompletion(result, "nested-value");
      return runtime.withDeferredEventPublicationSync(() => {
        assert.deepEqual(runtime.drainEventsSync(), []);
        return value;
      });
    });
    assert.equal(nested, value);
    assert.deepEqual(scenario.inventory().eventAcknowledgements, []);
    assert.deepEqual(scenario.canonicalEvents(), []);
    return value;
  }), value);
  scenario.assertPublished(1);

  const original = new Error("nested body failed after physical completion");
  await assert.rejects(runtime.withDeferredEventPublication(async () => {
    await runtime.withDeferredEventPublication(async () => {
      const result = await scenario.run("nested-body-error");
      scenario.assertCompletion(result, "nested-body-error");
    });
    runtime.withDeferredEventPublicationSync(() => { throw original; });
  }), (error) => error === original);
  scenario.assertPublished(2);

  const bodyFailure = new Error("body failure precedes publication failure");
  const publicationFailure = new Error("canonical save completed before acknowledgement failed");
  let lastResult;
  try {
    await assert.rejects(runtime.withDeferredEventPublication(async () => {
      lastResult = await scenario.run("nested-dual-failure");
      scenario.assertCompletion(lastResult, "nested-dual-failure");
      assert.equal(scenario.inventory().eventAcknowledgements.length, 8);
      scenario.publicationFailure = publicationFailure;
      runtime.withDeferredEventPublicationSync(() => { throw bodyFailure; });
    }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [bodyFailure, publicationFailure]);
      assert.equal(error.cause, bodyFailure);
      return true;
    });
  } finally { scenario.publicationFailure = null; }
  scenario.assertCompletion(lastResult, "nested-dual-failure");
  const pending = scenario.inventory().events.filter((event) => event.callId === lastResult.callId);
  assert.deepEqual(pending.map((event) => event.type), ["reserved", "started", "exited", "result-finalized"]);
  assert.equal(scenario.inventory().eventAcknowledgements.length, 8);
  assert.deepEqual(scenario.canonicalEvents().slice(8).map((activity) => activity.processEvent), [pending[0]]);
  const replay = new FlowProcessEventWriter(makeFlowManager(scenario.root));
  assert.deepEqual(await runtime.drainEvents((event) => replay.write(event)), pending.map((event) => event.eventId));
  assert.deepEqual(await runtime.drainEvents((event) => replay.write(event)), []);
  scenario.assertPublished(3);
  await scenario.close();
});

test("concurrent publication scopes retain all physical receipts until the last shared boundary publishes", { timeout: 120000 }, async (t) => {
  const scenario = new PublicationScopeScenario(t);
  const runtime = await scenario.acquire();
  const firstReady = new PublicationSignal(), secondReady = new PublicationSignal();
  const releaseFirst = new PublicationSignal(), releaseSecond = new PublicationSignal();
  const observed = [];
  let first, second, firstResult, secondResult;
  try {
    first = runtime.withDeferredEventPublication(async () => {
      try { firstResult = await scenario.run("concurrent-first"); }
      finally { firstReady.release(); }
      await releaseFirst.wait();
      return firstResult;
    });
    observed.push(Promise.allSettled([first]));
    await Promise.race([firstReady.wait(), first]);
    second = runtime.withBinding(scenario.binding, async () => {
      const bound = ProcessExecutionRuntime.current();
      return bound.withDeferredEventPublication(async () => {
        try { secondResult = await scenario.run("concurrent-second", bound); }
        finally { secondReady.release(); }
        await releaseSecond.wait();
        return secondResult;
      });
    });
    observed.push(Promise.allSettled([second]));
    await Promise.race([secondReady.wait(), second]);
    scenario.assertCompletion(firstResult, "concurrent-first");
    scenario.assertCompletion(secondResult, "concurrent-second");
    assert.deepEqual(scenario.inventory().eventAcknowledgements, []);
    assert.deepEqual(scenario.canonicalEvents(), []);
    releaseFirst.release();
    assert.equal(await first, firstResult);
    assert.deepEqual(scenario.inventory().eventAcknowledgements, []);
    assert.deepEqual(scenario.canonicalEvents(), []);
    releaseSecond.release();
    assert.equal(await second, secondResult);
    scenario.assertPublished(2);
    assert.deepEqual(await runtime.drainEvents(), []);
  } finally {
    releaseFirst.release(); releaseSecond.release();
    await Promise.all(observed);
  }
  await scenario.close();
});

test("an asynchronous publication scope waits for an existing drain before starting its callback or reservation", { timeout: 120000 }, async (t) => {
  const scenario = new PublicationScopeScenario(t);
  const runtime = await scenario.acquire({ publish: false });
  const firstResult = await scenario.run("before-drain");
  scenario.assertCompletion(firstResult, "before-drain");
  assert.deepEqual(scenario.inventory().eventAcknowledgements, []);
  assert.deepEqual(scenario.canonicalEvents(), []);
  const firstEvents = scenario.inventory().events;
  const entered = new PublicationSignal(), release = new PublicationSignal();
  await runtime.withBinding(scenario.binding, async () => {
    const bound = ProcessExecutionRuntime.current();
    let paused = false, bodyStarted = false;
    const observed = [];
    try {
      const drain = bound.drainEvents(async (event) => {
        if (!paused) { paused = true; entered.release(); await release.wait(); }
        return scenario.writer.write(event);
      });
      observed.push(Promise.allSettled([drain]));
      await Promise.race([entered.wait(), drain]);
      assert.equal(paused, true);
      const body = bound.withDeferredEventPublication(async () => {
        bodyStarted = true;
        assert.deepEqual(scenario.inventory().eventAcknowledgements.map((ack) => ack.eventId), firstEvents.map((event) => event.eventId));
        return scenario.run("after-drain", bound);
      });
      observed.push(Promise.allSettled([body]));
      await Promise.resolve();
      assert.equal(bodyStarted, false);
      assert.equal(scenario.inventory().calls.length, 1);
      release.release();
      assert.deepEqual(await drain, firstEvents.map((event) => event.eventId));
      const secondResult = await body;
      assert.equal(bodyStarted, true);
      scenario.assertCompletion(secondResult, "after-drain");
      scenario.assertPublished(2);
      assert.deepEqual(await bound.drainEvents(), []);
    } finally {
      release.release();
      await Promise.all(observed);
    }
  }, { eventWriter: (event) => scenario.write(event) });
  await scenario.close();
});

// Closure attempts own only reservations returned by the real public seal API.
class PublicationClosureAttempt {
  constructor(runtime, operation) { this.runtime = runtime; this.operation = operation; this.reservations = []; }
  async run() {
    if (this.operation === "close") return this.runtime.close();
    const reservation = await this.runtime.sealForCheckoutHandoff();
    this.reservations.push(reservation);
    return reservation;
  }
  release() { for (const reservation of this.reservations) reservation.release(); }
}
function publicationPending(runtime) {
  return (error) => error instanceof ProcessExecutionControlFailure
    && error.code === "PROCESS_EXECUTION_ACTIVITY_PENDING" && error.executionId === runtime.executionId;
}
async function assertCheckoutStillOwned(scenario) {
  await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: scenario.root }).then(async (unexpected) => {
    // An unexpected acquisition must still close naturally before the assertion fails.
    await unexpected.close();
    return unexpected;
  }), (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_BUSY");
}
async function assertPendingPublication(scenario, receipt, output) {
  assert.ok(receipt instanceof ProcessExecutionStopReceipt);
  const saved = scenario.inventory(), call = saved.calls.find((entry) => entry.callId === receipt.callId);
  assert.equal(scenario.runtime.closed, false);
  assert.equal(saved.accepting, false);
  assert.equal(saved.status, "closed");
  assert.equal(call.status, "stopped");
  assert.equal(call.observation.kind, "exited");
  assert.equal(call.observation.code, 0);
  assert.deepEqual(call.receipt, receipt.toJSON());
  assert.equal(call.receipt.output.stdoutBytes, Buffer.byteLength(output));
  assert.deepEqual(saved.events.map((event) => event.type), ["reserved", "started", "exited", "result-finalized"]);
  assert.deepEqual(saved.eventAcknowledgements, []);
  assert.deepEqual(scenario.canonicalEvents(), []);
  await assertCheckoutStillOwned(scenario);
}
async function completePublicationClosure(scenario, attempt) {
  return assertPublicationClosureComplete(scenario, attempt, await attempt.run());
}
async function assertPublicationClosureComplete(scenario, attempt, completion) {
  scenario.assertPublished(1);
  if (attempt.operation === "seal") {
    assert.ok(completion instanceof ProcessExecutionOwnershipReservation);
    assert.equal(completion.executionId, scenario.runtime.executionId);
    assert.equal(completion.released, false);
    await assertCheckoutStillOwned(scenario);
    attempt.release();
  } else assert.equal(completion, undefined);
  await scenario.close();
  const successor = await ProcessExecutionRuntime.acquire({ mainRoot: scenario.root });
  try {
    assert.equal(successor.ownerEpoch, scenario.runtime.ownerEpoch + 1);
    // Re-read the archived original root and canonical ledger after real release.
    scenario.assertPublished(1);
    assert.deepEqual(await successor.drainEvents((event) => scenario.writer.write(event)), []);
  } finally { await successor.close(); }
}

for (const operation of ["close", "seal"]) {
  test(`${operation} refuses pending stop-callback publication and retries after exact receipt delivery`, { timeout: 120000 }, async (t) => {
    const scenario = new PublicationScopeScenario(t), runtime = await scenario.acquire();
    const attempt = new PublicationClosureAttempt(runtime, operation);
    const entered = new PublicationSignal(), release = new PublicationSignal();
    const output = `${operation}-receipt-before-publication`;
    let receipt = null, checkCallbackClosure = false, callbackRefused = false;
    const observed = [];
    let execution;
    try {
      execution = scenario.run(output, runtime, { async onProcessExecutionStop(saved) {
        receipt = saved;
        entered.release();
        await release.wait();
        if (checkCallbackClosure) {
          // Waiting for this very deferred callback would self-deadlock.
          await assert.rejects(attempt.run(), publicationPending(runtime));
          callbackRefused = true;
        }
      } });
      observed.push(Promise.allSettled([execution]));
      await Promise.race([entered.wait(), execution]);
      await assert.rejects(attempt.run(), publicationPending(runtime));
      await assertPendingPublication(scenario, receipt, output);
      checkCallbackClosure = true;
      release.release();
      const result = await execution;
      assert.equal(callbackRefused, true);
      scenario.assertCompletion(result, output);
      assert.deepEqual(result.processExecutionStopReceipt.toJSON(), receipt.toJSON());
      scenario.assertPublished(1);
      assert.deepEqual(await runtime.drainEvents((event) => scenario.writer.write(event)), []);
      await completePublicationClosure(scenario, attempt);
    } finally {
      release.release();
      await Promise.all(observed);
      attempt.release();
    }
  });

  test(`${operation} refuses an existing asynchronous canonical drain and retries after its exact acknowledgements`, { timeout: 120000 }, async (t) => {
    const scenario = new PublicationScopeScenario(t), runtime = await scenario.acquire({ publish: false });
    const attempt = new PublicationClosureAttempt(runtime, operation);
    const output = `${operation}-existing-drain`;
    const result = await scenario.run(output);
    scenario.assertCompletion(result, output);
    const events = scenario.inventory().events;
    const entered = new PublicationSignal(), release = new PublicationSignal();
    const observed = [];
    try {
      await runtime.withBinding(scenario.binding, async () => {
        const bound = ProcessExecutionRuntime.current();
        let paused = false;
        const drain = bound.drainEvents(async (event) => {
          if (!paused) { paused = true; entered.release(); await release.wait(); }
          return scenario.writer.write(event);
        });
        observed.push(Promise.allSettled([drain]));
        await Promise.race([entered.wait(), drain]);
        await assert.rejects(attempt.run(), publicationPending(runtime));
        await assertPendingPublication(scenario, result.processExecutionStopReceipt, output);
        release.release();
        assert.deepEqual(await drain, events.map((event) => event.eventId));
      }, { eventWriter: (event) => scenario.write(event) });
      scenario.assertCompletion(result, output);
      scenario.assertPublished(1);
      assert.deepEqual(await runtime.drainEvents((event) => scenario.writer.write(event)), []);
      await completePublicationClosure(scenario, attempt);
    } finally {
      release.release();
      await Promise.all(observed);
      attempt.release();
    }
  });
}

for (const winnerOperation of ["close", "seal"]) {
  const loserOperation = winnerOperation === "close" ? "seal" : "close";
  test(`${winnerOperation} keeps its terminal mode when concurrent ${loserOperation} arrives during publication`, { timeout: 120000 }, async (t) => {
    const scenario = new PublicationScopeScenario(t), runtime = await scenario.acquire({ publish: false });
    const result = await scenario.run(`${winnerOperation}-mixed-closure`);
    scenario.assertCompletion(result, `${winnerOperation}-mixed-closure`);
    const entered = new PublicationSignal(), release = new PublicationSignal();
    const loser = new PublicationClosureAttempt(runtime, loserOperation), observed = [];
    let winner = null, paused = false;
    try {
      await runtime.withBinding(scenario.binding, async () => {
        // The bound view and owning view must share one closure admission.
        winner = new PublicationClosureAttempt(ProcessExecutionRuntime.current(), winnerOperation);
        const closing = winner.run();
        observed.push(Promise.allSettled([closing]));
        await Promise.race([entered.wait(), closing]);
        await assert.rejects(loser.run(), publicationPending(runtime));
        await assertPendingPublication(scenario, result.processExecutionStopReceipt, `${winnerOperation}-mixed-closure`);
        release.release();
        const completion = await closing;
        // No retry RPC may reset a corrupted handoff mode before this assertion.
        await assertPublicationClosureComplete(scenario, winner, completion);
      }, { eventWriter: async (event) => {
        if (!paused) { paused = true; entered.release(); await release.wait(); }
        return scenario.writer.write(event);
      } });
    } finally {
      release.release();
      await Promise.all(observed);
      winner?.release(); loser.release();
    }
  });
}

test("closure publication failure retains the actual receipt and replays before release", { timeout: 120000 }, async (t) => {
  const scenario = new PublicationScopeScenario(t), runtime = await scenario.acquire({ publish: false });
  const result = await scenario.run("close-publication-failure");
  scenario.assertCompletion(result, "close-publication-failure");
  const events = scenario.inventory().events;
  const attempt = new PublicationClosureAttempt(runtime, "close");
  const failure = new Error("canonical save completed before closure acknowledgement failed");
  scenario.publicationFailure = failure;
  try {
    await runtime.withBinding(scenario.binding, async () => {
      await assert.rejects(attempt.run(), (error) => error === failure);
      assert.equal(runtime.closed, false);
      assert.equal(scenario.inventory().status, "closed");
      assert.deepEqual(scenario.inventory().calls[0].receipt, result.processExecutionStopReceipt.toJSON());
      assert.deepEqual(scenario.inventory().eventAcknowledgements, []);
      assert.deepEqual(scenario.canonicalEvents().map((activity) => activity.processEvent), [events[0]]);
      await assertCheckoutStillOwned(scenario);
      scenario.publicationFailure = null;
      await completePublicationClosure(scenario, attempt);
    }, { eventWriter: (event) => scenario.write(event) });
  } finally { scenario.publicationFailure = null; attempt.release(); }
});
