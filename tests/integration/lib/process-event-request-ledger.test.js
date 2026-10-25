import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionBinding, ProcessExecutionBindingSelection, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionCanonicalAcknowledgement, ProcessExecutionEvent, ProcessExecutionRuntimeOnlyDisposition,
  ProcessExecutionEventBatchWriter, executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { managedRequest } from "../../../src/lib/managed-process-protocol.js";
import { FlowProcessEvent, FlowProcessEventWriter } from "../../../src/flow/lib/flow-process-event.js";
import { FlowActivity } from "../../../src/flow/lib/current-flow-state.js";
import { FreshFlowFixture, makeFlowManager, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";
import { RuntimeEventPublicationFailure } from "../../support/infrastructure/runtime-registry-publication-failure.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../../test-environment.js";

class EventRequestScenario {
  constructor(root) { this.root = root; this.owners = []; this.retainUnknown = false; }
  static async create(t, { injectPublicationFailure = false } = {}) {
    const scenario = new this(createTmpDir("process-event-request-ledger-"));
    scenario.fault = injectPublicationFailure ? new RuntimeEventPublicationFailure(scenario.root) : null;
    t.after(async () => {
      if (scenario.retainUnknown) {
        testTemporaryRoot().retainOnUnconfirmedExecution();
        const coordinator = scenario.runtime?.control?.child;
        if (coordinator && coordinator.exitCode === null && coordinator.signalCode === null) {
          const stopped = once(coordinator, "exit"); coordinator.ref(); coordinator.kill(); await stopped;
        }
        return;
      }
      try { for (const owner of [...scenario.owners].reverse()) if (!owner.closed) await owner.close(); }
      finally { removeTmpDir(scenario.root); }
    });
    setupFlowConfig(scenario.root);
    scenario.manager = makeFlowManager(scenario.root);
    scenario.specId = "001-process-event-ledger";
    new FreshFlowFixture({ flowManager: scenario.manager, specId: scenario.specId, runId: "process-event-ledger-run",
      execution: { mode: "direct" } }).create().registerActive();
    scenario.manager.beginNextAction(scenario.specId);
    const state = scenario.manager.canonicalState(scenario.specId);
    scenario.binding = new ProcessExecutionBinding({ runId: state.runId, specId: state.specId,
      flowVersionId: state.flowVersionId, nodeId: state.attempt.nodeId,
      attemptId: state.attempt.id, attemptSequence: state.attempt.sequence });
    scenario.selection = new ProcessExecutionBindingSelection({ runId: state.runId, specId: state.specId, flowVersionId: state.flowVersionId });
    scenario.writer = new FlowProcessEventWriter(scenario.manager);
    scenario.runtime = await scenario.acquire({ fault: scenario.fault });
    return scenario;
  }
  async acquire({ fault = null } = {}) {
    const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: this.root, binding: this.binding,
      runId: this.binding.value.runId, specId: this.specId,
      ...(fault === null ? {} : { environment: fault.environment }) });
    this.owners.push(runtime);
    return runtime;
  }
  async runActualChild(runtime = this.runtime, output = "event-ledger-child") {
    const result = await runtime.withBinding(this.binding, () => executeManagedProcess(process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(output)})`], { runtime: ProcessExecutionRuntime.current(), timeoutMs: 20000 }));
    assert.equal(result.stdout, output);
    assert.ok(result.processExecutionStopReceipt);
    return result;
  }
  events(runtime = this.runtime) {
    return runtime.inspect().executions.find((execution) => execution.executionId === runtime.executionId).events;
  }
  activities(executionId) {
    return this.manager.activityLedger(this.specId).filter((activity) => activity.processEvent?.executionId === executionId);
  }
  async send(runtime, operation, publications, requestId, grant = runtime.remoteGrant()) {
    return runtime.decodeResponse(await managedRequest(grant, operation, { grant, data: { publications: publications.map((entry) => entry.toJSON()) } }, { requestId }));
  }
  requestFile(runtime, requestId) { return runtime.store.requestFile(runtime.executionId, requestId); }
  publicationRequests(runtime = this.runtime) {
    const directory = path.dirname(this.requestFile(runtime, randomUUID()).filePath);
    return fs.readdirSync(directory).map((name) => {
      const file = this.requestFile(runtime, name.slice(0, -5));
      const bytes = file.read();
      return { file, bytes, record: JSON.parse(bytes).payload };
    }).filter(({ record }) => ["ack-events", "dispose-runtime-events"].includes(record.operation));
  }
  async drain(writer, mode = "async") {
    return mode === "sync" ? this.runtime.drainEventsSync(writer, this.selection)
      : this.runtime.drainEvents(writer, this.selection);
  }
}

class TestEventBatchWriter extends ProcessExecutionEventBatchWriter {
  constructor(write) { super(); this.publish = write; this.count = 0; }
  write(event) { return this.publish(event, ++this.count); }
  static failAfterSecondPublication(writer, failure) {
    return new this((event, count) => {
      const publication = writer.write(event);
      if (count === 2) throw failure;
      return publication;
    });
  }
}

test("canonical event ACK replays exactly, reaches a closed unarchived execution, and gates later finalization/history", { timeout: 120000 }, async (t) => {
  const scenario = await EventRequestScenario.create(t);
  const original = scenario.runtime;
  const result = await scenario.runActualChild(original);
  const originalEvents = scenario.events(original);
  assert.deepEqual(originalEvents.map((event) => event.type), ["reserved", "started", "exited", "result-finalized"]);
  await original.close();
  const archivePath = path.join(original.store.archivesAuthority.directory, `${original.executionId}.json`);
  assert.equal(fs.existsSync(archivePath), false, "bound events keep this closed execution in the live registry until canonical acknowledgement");

  const successor = await scenario.acquire();
  assert.equal(fs.existsSync(archivePath), false, "the successor retains this closed execution in the live registry while bound events remain pending");
  const retained = successor.inspect().executions.find((entry) => entry.executionId === original.executionId);
  assert.equal(retained.status, "closed");
  assert.deepEqual(retained.eventAcknowledgements, []);
  const first = ProcessExecutionEvent.fromStored(retained.events[0]);
  const firstPublication = scenario.writer.write(first);
  const requestId = randomUUID(), grant = successor.remoteGrant();
  const requestFile = scenario.requestFile(successor, requestId);
  const data = [firstPublication];
  assert.equal(await scenario.send(successor, "ack-events", data, requestId, grant), null);
  const registryAfterFirstAck = successor.store.file.read();
  const requestBytes = requestFile.read();
  const requestRecord = JSON.parse(requestBytes);
  assert.equal(requestRecord.payload.operation, "ack-events");
  assert.deepEqual(requestRecord.payload.response, { ok: true, value: null });
  assert.deepEqual(successor.inspect().executions.find((entry) => entry.executionId === original.executionId)
    .eventAcknowledgements, [firstPublication.toJSON()]);

  const fresh = await ProcessExecutionRuntime.fromRemoteGrant(JSON.parse(JSON.stringify(grant)));
  scenario.owners.push(fresh);
  assert.equal(await scenario.send(fresh, "ack-events", data, requestId, fresh.remoteGrant()), null);
  assert.deepEqual(successor.store.file.read(), registryAfterFirstAck);
  assert.deepEqual(requestFile.read(), requestBytes);
  const secondPublication = scenario.writer.write(ProcessExecutionEvent.fromStored(retained.events[1]));
  await assert.rejects(scenario.send(fresh, "ack-events", [secondPublication], requestId, fresh.remoteGrant()),
    { code: "PROCESS_EXECUTION_REQUEST_MISMATCH" });
  assert.deepEqual(successor.store.file.read(), registryAfterFirstAck);
  assert.deepEqual(requestFile.read(), requestBytes);
  await fresh.close();

  const publicationOrder = [firstPublication.eventId];
  const drained = await successor.drainEvents((event) => {
    const persisted = successor.inspect().executions.find((entry) => entry.executionId === original.executionId);
    assert.deepEqual(persisted.eventAcknowledgements.map((fact) => fact.eventId), publicationOrder,
      "each callback observes the prior event ACK durably committed before the next event is offered");
    const publication = scenario.writer.write(event);
    assert.ok(publication instanceof ProcessExecutionCanonicalAcknowledgement);
    publicationOrder.push(event.eventId);
    return publication;
  }, scenario.selection);
  assert.deepEqual(drained, retained.events.slice(1).map((event) => event.eventId));
  const acknowledged = successor.inspect().executions.find((entry) => entry.executionId === original.executionId);
  assert.deepEqual(acknowledged.eventAcknowledgements.map((fact) => fact.eventId), retained.events.map((event) => event.eventId));
  assert.deepEqual(scenario.activities(original.executionId).map((activity) => activity.processEvent), retained.events);
  const barrier = await successor.finalizeBinding(scenario.selection, (event) => scenario.writer.write(event));
  FlowProcessEvent.assertFinalization(scenario.manager.canonicalState(scenario.specId),
    scenario.manager.activityLedger(scenario.specId).map((activity) => FlowActivity.fromSerialized(activity)), barrier);
  await successor.close();

  const archiver = await scenario.acquire();
  assert.equal(fs.existsSync(archivePath), true, "a later owner archives the closed execution after every bound event has a canonical ACK");
  const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: scenario.root });
  const archived = historical.executions.find((entry) => entry.executionId === original.executionId);
  assert.equal(archived.status, "closed");
  assert.deepEqual(archived.eventAcknowledgements.map((fact) => fact.eventId), retained.events.map((event) => event.eventId));
  assert.deepEqual(archived.calls[0].receipt, result.processExecutionStopReceipt.toJSON());
  await archiver.close();
});

test("mixed valid and invalid ACK publication is atomic and its UUID cannot be rebound", { timeout: 120000 }, async (t) => {
  const scenario = await EventRequestScenario.create(t);
  const result = await scenario.runActualChild();
  const events = scenario.events();
  const valid = scenario.writer.write(ProcessExecutionEvent.fromStored(events[0]));
  const invalid = new ProcessExecutionCanonicalAcknowledgement({ eventId: randomUUID(), eventDigest: executionValueDigest(events[0]) });
  const requestId = randomUUID(), grant = scenario.runtime.remoteGrant();
  const requestFile = scenario.requestFile(scenario.runtime, requestId);
  const registryBefore = scenario.runtime.store.file.read();
  const publications = [valid, invalid];
  await assert.rejects(scenario.send(scenario.runtime, "ack-events", publications, requestId, grant),
    { code: "PROCESS_EXECUTION_EVENT_MISMATCH" });
  assert.deepEqual(scenario.runtime.store.file.read(), registryBefore);
  assert.deepEqual(scenario.runtime.inspect().executions[0].eventAcknowledgements, []);
  const failedRequestBytes = requestFile.read();
  const failedRequest = JSON.parse(failedRequestBytes);
  assert.equal(failedRequest.payload.response.ok, false);
  assert.equal(failedRequest.payload.response.error.code, "PROCESS_EXECUTION_EVENT_MISMATCH");
  await assert.rejects(scenario.send(scenario.runtime, "ack-events", publications, requestId, grant),
    { code: "PROCESS_EXECUTION_EVENT_MISMATCH" });
  assert.deepEqual(requestFile.read(), failedRequestBytes, "exact UUID replay returns the stored refusal without rewriting its ledger");
  await assert.rejects(scenario.send(scenario.runtime, "ack-events", [valid], requestId, grant),
    { code: "PROCESS_EXECUTION_REQUEST_MISMATCH" });
  assert.deepEqual(scenario.runtime.store.file.read(), registryBefore);
  assert.deepEqual(requestFile.read(), failedRequestBytes);
});

test("runtime-only dispositions use exact replay identity, archive as noncanonical facts, and never satisfy finalization", { timeout: 120000 }, async (t) => {
  const scenario = await EventRequestScenario.create(t);
  await scenario.runActualChild();
  const events = scenario.events();
  const dispositions = events.map((event) => ProcessExecutionRuntimeOnlyDisposition.fromEvent(ProcessExecutionEvent.fromStored(event)));
  const requestId = randomUUID(), grant = scenario.runtime.remoteGrant();
  const requestFile = scenario.requestFile(scenario.runtime, requestId);
  assert.equal(await scenario.send(scenario.runtime, "dispose-runtime-events", dispositions, requestId, grant), null);
  const registryAfter = scenario.runtime.store.file.read(), requestBytes = requestFile.read();
  const execution = scenario.runtime.inspect().executions[0];
  assert.deepEqual(execution.eventAcknowledgements, []);
  assert.deepEqual(execution.runtimeOnlyDispositions, dispositions.map((entry) => entry.toJSON()));
  const fresh = await ProcessExecutionRuntime.fromRemoteGrant(JSON.parse(JSON.stringify(grant)));
  scenario.owners.push(fresh);
  assert.equal(await scenario.send(fresh, "dispose-runtime-events", dispositions, requestId, fresh.remoteGrant()), null);
  assert.deepEqual(scenario.runtime.store.file.read(), registryAfter);
  assert.deepEqual(requestFile.read(), requestBytes);
  await assert.rejects(scenario.send(fresh, "dispose-runtime-events", dispositions.slice(1), requestId, fresh.remoteGrant()),
    { code: "PROCESS_EXECUTION_REQUEST_MISMATCH" });
  assert.deepEqual(scenario.runtime.store.file.read(), registryAfter);
  await fresh.close();
  await assert.rejects(scenario.runtime.finalizeBinding(scenario.selection), { code: "PROCESS_EXECUTION_ACTIVITY_PENDING" });
  await scenario.runtime.close();
  const successor = await scenario.acquire();
  const archived = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: scenario.root }).executions
    .find((entry) => entry.executionId === scenario.runtime.executionId);
  assert.deepEqual(archived.runtimeOnlyDispositions, dispositions.map((entry) => entry.toJSON()));
  await assert.rejects(successor.finalizeBinding(scenario.selection), { code: "PROCESS_EXECUTION_ACTIVITY_PENDING" });
  await successor.close();
});

test("committed canonical ACK remains pending when registry readback fails before request completion", { timeout: 120000 }, async (t) => {
  const scenario = await EventRequestScenario.create(t, { injectPublicationFailure: true });
  await scenario.runActualChild();
  const event = ProcessExecutionEvent.fromStored(scenario.events()[0]);
  const publication = scenario.writer.write(event);
  const requestId = randomUUID(), grant = scenario.runtime.remoteGrant();
  const replayClient = await ProcessExecutionRuntime.fromRemoteGrant(JSON.parse(JSON.stringify(grant)));
  scenario.owners.push(replayClient);
  fs.writeFileSync(scenario.fault.armFile, JSON.stringify({ requestId, eventId: event.eventId, operation: "ack-events" }));
  const requestFile = scenario.requestFile(scenario.runtime, requestId);
  let faultError = null;
  try { await scenario.send(scenario.runtime, "ack-events", [publication], requestId, grant); }
  catch (error) { faultError = error; scenario.retainUnknown = true; }
  assert.ok(faultError instanceof ProcessExecutionControlFailure);
  assert.equal(faultError.code, "PROCESS_EXECUTION_DURABILITY_UNCERTAIN");
  const witness = JSON.parse(fs.readFileSync(scenario.fault.witness, "utf8"));
  assert.deepEqual(witness, { requestId, eventId: event.eventId, operation: "ack-events",
    phase: "global-fact-published-before-request-ledger-completion", errorCode: "EIO" });
  assert.equal(fs.existsSync(scenario.runtime.store.transition.filePath), true);
  const committed = JSON.parse(fs.readFileSync(scenario.runtime.store.file.filePath, "utf8")).payload;
  const fact = committed.executions.find((entry) => entry.events.some((candidate) => candidate.eventId === event.eventId));
  assert.deepEqual(fact.eventAcknowledgements, [publication.toJSON()]);
  const pendingBytes = requestFile.read(), pending = JSON.parse(pendingBytes);
  assert.equal(pending.payload.operation, "ack-events");
  assert.equal(pending.payload.requestId, requestId);
  assert.equal(pending.payload.response, null);
  const beforeReplay = fs.readFileSync(scenario.runtime.store.file.filePath);
  await assert.rejects(scenario.send(replayClient, "ack-events", [publication], requestId, replayClient.remoteGrant()),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_DURABILITY_UNCERTAIN");
  assert.deepEqual(fs.readFileSync(scenario.runtime.store.file.filePath), beforeReplay);
  assert.deepEqual(requestFile.read(), pendingBytes);
  assert.equal(scenario.activities(scenario.runtime.executionId).filter((activity) => activity.processEvent.eventId === event.eventId).length, 1);
  await assert.rejects(ProcessExecutionRuntime.fromRemoteGrant(JSON.parse(JSON.stringify(grant))),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_DURABILITY_UNCERTAIN");
  assert.deepEqual(fs.readFileSync(scenario.runtime.store.file.filePath), beforeReplay);
  assert.deepEqual(requestFile.read(), pendingBytes);
});

test("a typed canonical writer durably acknowledges its ordered publications together and replays the exact batch", { timeout: 120000 }, async (t) => {
  const scenario = await EventRequestScenario.create(t);
  const result = await scenario.runActualChild();
  const events = scenario.events();
  const grant = scenario.runtime.remoteGrant();
  assert.ok(scenario.writer instanceof ProcessExecutionEventBatchWriter);
  assert.deepEqual(await scenario.drain(scenario.writer), events.map((event) => event.eventId));
  const publications = events.map((event) => ProcessExecutionCanonicalAcknowledgement.fromEvent(ProcessExecutionEvent.fromStored(event)));
  const requests = scenario.publicationRequests();
  assert.equal(requests.length, 1, "one durable request accepts the complete independently published group");
  const [accepted] = requests;
  assert.equal(accepted.record.operation, "ack-events");
  assert.equal(accepted.record.payloadDigest, executionValueDigest({ grant, data: { publications: publications.map((entry) => entry.toJSON()) } }));
  assert.deepEqual(accepted.record.response, { ok: true, value: null });
  const registry = scenario.runtime.store.file.read();
  assert.equal(await scenario.send(scenario.runtime, "ack-events", publications, accepted.record.requestId, grant), null);
  assert.deepEqual(scenario.runtime.store.file.read(), registry);
  assert.deepEqual(accepted.file.read(), accepted.bytes);
  await assert.rejects(scenario.send(scenario.runtime, "ack-events", publications.slice(1), accepted.record.requestId, grant),
    { code: "PROCESS_EXECUTION_REQUEST_MISMATCH" });
  assert.deepEqual(scenario.runtime.store.file.read(), registry);
  assert.deepEqual(accepted.file.read(), accepted.bytes);
  const freshActivities = makeFlowManager(scenario.root).activityLedger(scenario.specId)
    .filter((activity) => activity.processEvent?.executionId === scenario.runtime.executionId);
  assert.deepEqual(freshActivities.map((activity) => activity.processEvent), events);
  assert.deepEqual(await scenario.drain(new TestEventBatchWriter(() => assert.fail("Completed publication was offered again"))), []);
  const barrier = await scenario.runtime.finalizeBinding(scenario.selection, scenario.writer);
  assert.deepEqual(barrier.events.map((event) => event.eventId), events.map((event) => event.eventId));
  await scenario.runtime.close();
  const history = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: scenario.root }).executions
    .find((execution) => execution.executionId === scenario.runtime.executionId);
  assert.equal(history.status, "closed");
  assert.deepEqual(history.calls[0].receipt, result.processExecutionStopReceipt.toJSON());
  assert.deepEqual(history.eventAcknowledgements, publications.map((entry) => entry.toJSON()));
});

test("a synchronous typed writer preserves mixed publication runs and reentrant drains without turning dispositions into canonical ACKs", { timeout: 120000 }, async (t) => {
  const scenario = await EventRequestScenario.create(t);
  await scenario.runActualChild();
  const events = scenario.events(), offered = [], publications = [];
  const grant = scenario.runtime.remoteGrant();
  const acknowledged = await scenario.drain(new TestEventBatchWriter((event) => {
    assert.deepEqual(scenario.runtime.drainEventsSync(), []);
    offered.push(event.eventId);
    const publication = event.type === "started" ? ProcessExecutionRuntimeOnlyDisposition.fromEvent(event)
      : scenario.writer.write(event);
    publications.push(publication);
    return publication;
  }), "sync");
  assert.deepEqual(offered, events.map((event) => event.eventId));
  assert.deepEqual(acknowledged, [events[0], events[2], events[3]].map((event) => event.eventId));
  const requests = scenario.publicationRequests();
  const expected = [[publications[0]], [publications[1]], publications.slice(2)];
  assert.equal(requests.length, expected.length);
  for (const group of expected) {
    const operation = group[0] instanceof ProcessExecutionCanonicalAcknowledgement ? "ack-events" : "dispose-runtime-events";
    const payloadDigest = executionValueDigest({ grant, data: { publications: group.map((entry) => entry.toJSON()) } });
    assert.equal(requests.filter(({ record }) => record.operation === operation && record.payloadDigest === payloadDigest
      && record.response.ok === true).length, 1);
  }
  const saved = scenario.runtime.inspect().executions.find((execution) => execution.executionId === scenario.runtime.executionId);
  assert.deepEqual(saved.eventAcknowledgements.map((entry) => entry.eventId), acknowledged);
  assert.deepEqual(saved.runtimeOnlyDispositions, [publications[1].toJSON()]);
  await assert.rejects(scenario.runtime.finalizeBinding(scenario.selection), { code: "PROCESS_EXECUTION_ACTIVITY_PENDING" });
  await scenario.runtime.close();
  const successor = await scenario.acquire();
  const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: scenario.root }).executions
    .find((execution) => execution.executionId === scenario.runtime.executionId);
  assert.deepEqual(historical.eventAcknowledgements, saved.eventAcknowledgements);
  assert.deepEqual(historical.runtimeOnlyDispositions, saved.runtimeOnlyDispositions);
  await successor.close();
});

for (const mode of ["async", "sync"]) {
  test(`${mode} typed writer failure preserves its durable ACK prefix and replays the published failing event exactly once`, { timeout: 120000 }, async (t) => {
    const scenario = await EventRequestScenario.create(t);
    const result = await scenario.runActualChild();
    const events = scenario.events();
    const original = new Error("Writer failed after its second durable publication");
    const writer = TestEventBatchWriter.failAfterSecondPublication(scenario.writer, original);
    await assert.rejects(scenario.drain(writer, mode), (error) => error === original);
    assert.equal(writer.count, 2);
    const partial = scenario.runtime.inspect().executions.find((execution) => execution.executionId === scenario.runtime.executionId);
    assert.deepEqual(partial.eventAcknowledgements.map((entry) => entry.eventId), [events[0].eventId]);
    assert.deepEqual(scenario.activities(scenario.runtime.executionId).map((activity) => activity.processEvent), events.slice(0, 2));
    assert.deepEqual(partial.calls[0].receipt, result.processExecutionStopReceipt.toJSON());
    assert.equal(scenario.publicationRequests().length, 1);
    assert.deepEqual(await scenario.drain(scenario.writer, mode), events.slice(1).map((event) => event.eventId));
    const reloaded = makeFlowManager(scenario.root).activityLedger(scenario.specId)
      .filter((activity) => activity.processEvent?.executionId === scenario.runtime.executionId);
    assert.deepEqual(reloaded.map((activity) => activity.processEvent), events);
    assert.equal(new Set(reloaded.map((activity) => activity.id)).size, events.length);
    assert.deepEqual(await scenario.drain(scenario.writer, mode), []);
    await scenario.runtime.close();
    const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: scenario.root }).executions
      .find((execution) => execution.executionId === scenario.runtime.executionId);
    assert.equal(historical.status, "closed");
    assert.deepEqual(historical.calls[0].receipt, result.processExecutionStopReceipt.toJSON());
    assert.deepEqual(historical.eventAcknowledgements.map((entry) => entry.eventId), events.map((event) => event.eventId));
  });
}

test("a typed writer's invalid publication flushes only its valid prefix and keeps the changed event pending", { timeout: 120000 }, async (t) => {
  const scenario = await EventRequestScenario.create(t);
  await scenario.runActualChild();
  const events = scenario.events();
  await assert.rejects(scenario.drain(new TestEventBatchWriter((event, count) => {
    if (count === 2) return new ProcessExecutionCanonicalAcknowledgement({ eventId: randomUUID(), eventDigest: event.digest });
    return scenario.writer.write(event);
  })), { code: "PROCESS_EXECUTION_EVENT_MISMATCH" });
  const saved = scenario.runtime.inspect().executions.find((execution) => execution.executionId === scenario.runtime.executionId);
  assert.deepEqual(saved.eventAcknowledgements.map((entry) => entry.eventId), [events[0].eventId]);
  assert.deepEqual(scenario.activities(scenario.runtime.executionId).map((activity) => activity.processEvent), events.slice(0, 1));
  assert.deepEqual(await scenario.drain(scenario.writer), events.slice(1).map((event) => event.eventId));
});

test("typed writer failure and uncertain prefix ACK retain both causes and the accepted request without replaying publication", { timeout: 120000 }, async (t) => {
  const scenario = await EventRequestScenario.create(t, { injectPublicationFailure: true });
  const result = await scenario.runActualChild();
  const events = scenario.events(), grant = scenario.runtime.remoteGrant();
  const replayClient = await ProcessExecutionRuntime.fromRemoteGrant(JSON.parse(JSON.stringify(grant)));
  scenario.owners.push(replayClient);
  const original = new Error("Writer failed after its second durable publication");
  const firstPublication = ProcessExecutionCanonicalAcknowledgement.fromEvent(ProcessExecutionEvent.fromStored(events[0]));
  fs.writeFileSync(scenario.fault.armFile, JSON.stringify({ eventId: events[0].eventId, operation: "ack-events" }));
  const writer = TestEventBatchWriter.failAfterSecondPublication(scenario.writer, original);
  let failure;
  try {
    await scenario.drain(writer);
  } catch (error) { failure = error; scenario.retainUnknown = true; }
  assert.ok(failure instanceof ProcessExecutionControlFailure);
  assert.equal(failure.code, "PROCESS_EXECUTION_DURABILITY_UNCERTAIN");
  assert.ok(failure.cause instanceof AggregateError);
  assert.equal(failure.cause.errors[0], original);
  assert.equal(failure.cause.cause, original);
  assert.ok(failure.cause.errors[1] instanceof ProcessExecutionControlFailure);
  assert.equal(failure.cause.errors[1].code, "PROCESS_EXECUTION_DURABILITY_UNCERTAIN");
  const witness = JSON.parse(fs.readFileSync(scenario.fault.witness, "utf8"));
  assert.deepEqual(witness, { eventId: events[0].eventId, operation: "ack-events",
    phase: "global-fact-published-before-request-ledger-completion", errorCode: "EIO" });
  assert.equal(fs.existsSync(scenario.runtime.store.transition.filePath), true);
  const registry = scenario.runtime.store.file.read();
  const committed = JSON.parse(registry).payload.executions.find((execution) => execution.executionId === scenario.runtime.executionId);
  assert.deepEqual(committed.eventAcknowledgements, [firstPublication.toJSON()]);
  assert.deepEqual(committed.calls[0].receipt, result.processExecutionStopReceipt.toJSON());
  assert.deepEqual(scenario.activities(scenario.runtime.executionId).map((activity) => activity.processEvent), events.slice(0, 2));
  const [pending, ...otherRequests] = scenario.publicationRequests();
  assert.deepEqual(otherRequests, []);
  assert.equal(pending.record.response, null);
  await assert.rejects(scenario.send(replayClient, "ack-events", [firstPublication], pending.record.requestId, grant),
    { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  assert.deepEqual(scenario.runtime.store.file.read(), registry);
  assert.deepEqual(pending.file.read(), pending.bytes);
  assert.equal(writer.count, 2, "uncertain acknowledgement must not invoke a writer again");
});
