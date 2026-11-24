import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionBindingSelection, ProcessExecutionFinalizationBarrier } from "../../../src/lib/process-execution-runtime.js";
import { executionValueDigest, ProcessExecutionCanonicalAcknowledgement, ProcessExecutionRuntimeOnlyDisposition } from "../../../src/lib/process-execution-values.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

async function fixture(t) {
  const root = createTmpDir("execution-finalization-");
  const owners = [];
  t.after(async () => {
    try { for (const owner of owners.reverse()) if (!owner.closed) await owner.close(); }
    catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
    removeTmpDir(root);
  });
  const acquire = async () => {
    const owner = await ProcessExecutionRuntime.acquire({ mainRoot: root });
    owners.push(owner);
    return owner;
  };
  const runtime = await acquire();
  const subject = { runId: randomUUID(), specId: "example", flowVersionId: randomUUID() };
  return { root, runtime, subject, selection: new ProcessExecutionBindingSelection(subject), acquire };
}
function writer() {
  const events = new Map();
  return { events, apply(event) {
    const prior = events.get(event.eventId);
    if (prior !== undefined) assert.equal(executionValueDigest(prior), executionValueDigest(event));
    else events.set(event.eventId, event.toJSON());
    return ProcessExecutionCanonicalAcknowledgement.fromEvent(event);
  } };
}

test("selected cutoff survives canonical save before acknowledgement, rejects old binding descendants, and leaves explicit unbound cleanup available", async (t) => {
  const { root, runtime, subject, selection } = await fixture(t);
  await runtime.withBinding({ ...subject, attemptId: randomUUID() }, () => executeManagedProcess(process.execPath,
    ["-e", "process.stdout.write('selected')"], { runtime: ProcessExecutionRuntime.current(), timeoutMs: 10000 }));
  const publication = writer();
  const interrupted = new Error("canonical event saved before acknowledgement");
  let first = true;
  assert.throws(() => runtime.finalizeBindingSync(selection, (event) => {
    publication.apply(event);
    if (first) { first = false; throw interrupted; }
  }), (error) => error === interrupted);
  const saved = runtime.inspect().executions[0];
  const fence = saved.finalizationFences[0];
  assert.equal(fence.barrier, null);
  assert.equal(fence.cutoff.callClosures.length, 1);
  assert.equal(fence.cutoff.events.length, 4);
  assert.equal(saved.eventAcknowledgements.map((fact) => fact.eventId).includes([...publication.events.keys()][0]), false);
  await assert.rejects(runtime.reserveCall({ binding: { ...subject, attemptId: randomUUID() } }), { code: "PROCESS_EXECUTION_REGISTRATION_CLOSED" });
  const barrier = runtime.finalizeBindingSync(selection, (event) => publication.apply(event));
  assert.ok(barrier instanceof ProcessExecutionFinalizationBarrier);
  assert.deepEqual(barrier.selection.toJSON(), selection.toJSON());
  assert.equal(barrier.fenceId, fence.fenceId);
  assert.equal(barrier.evidenceDigest, fence.cutoff.evidenceDigest);
  assert.equal(publication.events.size, 4);
  const finalized = [...publication.events.values()].find((event) => event.type === "result-finalized");
  assert.equal(finalized.payload.closureDigest, barrier.callClosures[0].closureDigest);
  assert.deepEqual(ProcessExecutionFinalizationBarrier.fromStored(JSON.parse(JSON.stringify(barrier))).toJSON(), barrier.toJSON());
  assert.throws(() => ProcessExecutionFinalizationBarrier.fromStored({ ...barrier.toJSON(), acknowledgementDigest: "0".repeat(64) }), /acknowledgement differs/);
  const cleanup = await executeManagedProcess(process.execPath, ["-e", "process.stdout.write('cleanup')"], { runtime, timeoutMs: 10000 });
  assert.equal(cleanup.stdout, "cleanup");
  assert.equal(cleanup.processExecutionStopReceipt.binding.toJSON(), null);
  assert.deepEqual(runtime.finalizeBindingSync(selection, (event) => publication.apply(event)).toJSON(), barrier.toJSON());
  assert.equal(publication.events.size, 4);
  await runtime.close();
  const successor = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  await successor.close();
  assert.deepEqual(ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).executions[0].finalizationFences[0].barrier, barrier.toJSON());
});

test("unfinished actual child retains a durable subject fence before finalization refuses and later receipt completes the same fence", async (t) => {
  const { runtime, subject, selection } = await fixture(t);
  let fenced = false;
  const result = await runtime.withBinding({ ...subject, attemptId: randomUUID() }, () => executeManagedProcess(process.execPath,
    ["-e", "setTimeout(() => process.stdout.write('done'), 100)"], {
      runtime: ProcessExecutionRuntime.current(), timeoutMs: 10000,
      onSpawn() {
        assert.throws(() => runtime.finalizeBindingSync(selection), { code: "PROCESS_EXECUTION_FINALIZATION_PENDING" });
        const fence = runtime.inspect().executions[0].finalizationFences[0];
        assert.equal(fence.cutoff, null);
        assert.equal(fence.barrier, null);
        fenced = true;
      },
    }));
  assert.equal(fenced, true);
  assert.equal(result.stdout, "done");
  await assert.rejects(runtime.reserveCall({ binding: { ...subject, attemptId: randomUUID() } }), { code: "PROCESS_EXECUTION_REGISTRATION_CLOSED" });
  await assert.rejects(runtime.finalizeBinding(selection), { code: "PROCESS_EXECUTION_ACTIVITY_PENDING" });
  const publication = writer();
  const barrier = await runtime.finalizeBinding(selection, (event) => publication.apply(event));
  assert.equal(barrier.callClosures.length, 1);
  assert.equal(barrier.events.length, 4);
  assert.deepEqual(runtime.inspect().executions[0].finalizationFences[0].barrier, barrier.toJSON());
});


test("a successor replays retained bound events with their original identity and cannot finalize while prior publication is pending", async (t) => {
  const { root, runtime, subject, selection, acquire } = await fixture(t);
  const binding = { ...subject, attemptId: randomUUID() };
  const result = await runtime.withBinding(binding, () => executeManagedProcess(process.execPath, ["-e", "process.stdout.write('first-root-effect')"],
    { runtime: ProcessExecutionRuntime.current(), timeoutMs: 10000 }));
  assert.equal(result.stdout, "first-root-effect");
  const original = runtime.inspect().executions[0];
  assert.equal(original.events.length, 4);
  assert.deepEqual(original.eventAcknowledgements, []);
  await runtime.close();
  const successor = await acquire();
  const publication = new AtomicFile(path.join(root, "published-process-events.json"));
  let refusal = null;
  try { await successor.finalizeBinding(selection); }
  catch (cause) { refusal = cause; }
  const saved = [];
  const acknowledged = await successor.drainEvents((event) => {
    saved.push(event.toJSON()); publication.write(JSON.stringify(saved));
    return ProcessExecutionCanonicalAcknowledgement.fromEvent(event);
  }, selection);
  assert.deepEqual({ finalizationCode: refusal?.code ?? null, events: saved.map((event) => event.eventId), acknowledged },
    { finalizationCode: "PROCESS_EXECUTION_ACTIVITY_PENDING", events: original.events.map((event) => event.eventId), acknowledged: original.events.map((event) => event.eventId) });
  assert.deepEqual(JSON.parse(publication.read()), original.events);
  const retained = successor.inspect().executions.find((execution) => execution.executionId === original.executionId);
  assert.deepEqual(retained.eventAcknowledgements.map((fact) => fact.eventId), original.events.map((event) => event.eventId));
  assert.deepEqual(retained.calls[0].receipt, result.processExecutionStopReceipt.toJSON());
  await successor.finalizeBinding(selection);
  await successor.close();
  const reloaded = await acquire();
  assert.deepEqual(await reloaded.drainEvents(() => assert.fail("An acknowledged retained event must not publish twice")), []);
  assert.equal(reloaded.inspect().executions.filter((execution) => execution.calls.length > 0).length, 1);
});

test("a finalized binding remains fenced after its owning root closes and a fresh coordinator archives that root", async (t) => {
  const { runtime, subject, selection, acquire } = await fixture(t);
  const barrier = await runtime.finalizeBinding(selection);
  await runtime.close();
  const successor = await acquire();
  const prior = successor.inspect().executions.find((execution) => execution.executionId === barrier.executionId);
  assert.deepEqual(prior.finalizationFences[0].barrier, barrier.toJSON());
  await assert.rejects(successor.reserveCall({ binding: { ...subject, attemptId: randomUUID() } }).then(async (unexpected) => {
    await successor.revokeCall(unexpected);
    return unexpected;
  }), { code: "PROCESS_EXECUTION_REGISTRATION_CLOSED" });
  const unrelated = await successor.reserveCall({ binding: null });
  await successor.revokeCall(unrelated);
});


test("a writer result without an exact canonical acknowledgement cannot dispose a bound event", async (t) => {
  const { runtime, subject } = await fixture(t);
  const call = await runtime.reserveCall({ binding: { ...subject, attemptId: randomUUID() } });
  await runtime.revokeCall(call);
  const events = runtime.inspect().executions[0].events;
  for (const invalid of [null, 1, randomUUID(), { eventId: events[0].eventId, eventDigest: "0".repeat(64) },
    new ProcessExecutionCanonicalAcknowledgement({ eventId: events[0].eventId, eventDigest: "0".repeat(64) }),
    new ProcessExecutionCanonicalAcknowledgement({ eventId: randomUUID(), eventDigest: executionValueDigest(events[0]) })]) {
    await assert.rejects(runtime.drainEvents(() => invalid), { code: "PROCESS_EXECUTION_EVENT_MISMATCH" });
    assert.deepEqual(runtime.inspect().executions[0].eventAcknowledgements, []);
  }
});


test("explicit runtime-only disposition survives archive but never authorizes canonical finalization of that binding", async (t) => {
  const { runtime, subject, selection, acquire } = await fixture(t);
  const call = await runtime.reserveCall({ binding: subject });
  await runtime.revokeCall(call);
  const original = runtime.inspect().executions[0];
  assert.deepEqual(await runtime.drainEvents((event) => ProcessExecutionRuntimeOnlyDisposition.fromEvent(event), selection), []);
  const disposed = runtime.inspect().executions[0];
  assert.deepEqual(disposed.eventAcknowledgements, []);
  assert.deepEqual(disposed.runtimeOnlyDispositions.map((fact) => fact.eventId), original.events.map((event) => event.eventId));
  await assert.rejects(runtime.finalizeBinding(selection), { code: "PROCESS_EXECUTION_ACTIVITY_PENDING" });
  await runtime.close();
  const successor = await acquire();
  const archived = successor.inspect().executions.find((execution) => execution.executionId === runtime.executionId);
  assert.deepEqual(archived.runtimeOnlyDispositions, disposed.runtimeOnlyDispositions);
  await assert.rejects(successor.finalizeBinding(selection), { code: "PROCESS_EXECUTION_ACTIVITY_PENDING" });
});

test("scoped retained-root publication preserves old Attempt and excludes a different Flow Version", async (t) => {
  const { root, runtime, subject, selection, acquire } = await fixture(t);
  const oldBinding = { ...subject, attemptId: randomUUID() };
  const foreign = { ...subject, flowVersionId: randomUUID(), attemptId: randomUUID() };
  for (const binding of [oldBinding, foreign]) await runtime.revokeCall(await runtime.reserveCall({ binding }));
  const original = runtime.inspect().executions[0];
  await runtime.close();
  const successor = await acquire();
  const seen = [];
  await successor.drainEvents((event) => {
    seen.push(event.toJSON());
    return ProcessExecutionCanonicalAcknowledgement.fromEvent(event);
  }, selection);
  assert.deepEqual(seen, original.events.filter((event) => event.binding.flowVersionId === subject.flowVersionId));
  assert.ok(seen.every((event) => event.binding.attemptId === oldBinding.attemptId));
  const saved = successor.inspect().executions.find((execution) => execution.executionId === runtime.executionId);
  assert.equal(saved.eventAcknowledgements.length, 2);
  assert.equal(saved.runtimeOnlyDispositions.length, 0);
  const barrier = await successor.finalizeBinding(selection);
  assert.equal(barrier.executionId, successor.executionId);
  const originalBytes = successor.store.file.read();
  for (const change of ["event-content", "older-acknowledgements"]) {
    const envelope = JSON.parse(originalBytes);
    const prior = envelope.payload.executions.find((execution) => execution.executionId === runtime.executionId);
    if (change === "event-content") prior.events[0].occurredAt = "2001-01-01T00:00:00.000Z";
    else prior.eventAcknowledgements = [];
    envelope.digest = executionValueDigest(envelope.payload);
    try {
      successor.store.file.write(JSON.stringify(envelope));
      assert.throws(() => ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }),
        { code: change === "event-content" ? "PROCESS_EXECUTION_REGISTRY_FAILED" : "PROCESS_EXECUTION_RECORD_CORRUPT" });
    } finally { successor.store.file.write(originalBytes); }
  }
  const restored = successor.inspect().executions.find((execution) => execution.executionId === runtime.executionId);
  assert.deepEqual(restored.eventAcknowledgements, saved.eventAcknowledgements);
  for (const fact of restored.eventAcknowledgements) assert.equal(fact.eventDigest, executionValueDigest(restored.events.find((event) => event.eventId === fact.eventId)));
});
