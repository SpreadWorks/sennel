import { ProcessExecutionRuntime, ProcessExecutionBindingSelection, ProcessExecutionBinding } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { runGit, runGitAsync } from "../../../src/lib/git-helpers.js";
import { GitRepositoryPolicy } from "../../../src/lib/git-repository-environment.js";
import { runCmd } from "../../../src/lib/process.js";
import { NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ProcessExecutionEvent, ProcessExecutionCanonicalAcknowledgement,
  ProcessExecutionRuntimeOnlyDisposition } from "../../../src/lib/process-execution-values.js";
import { FlowProcessEvent, FlowProcessEventWriter } from "../../../src/flow/lib/flow-process-event.js";
import { CanonicalFlowVersionReader, QueryRequest } from "../../../src/flow/query.js";
import { validateFlowQueryResponse } from "../../../src/flow/query-contract.js";
import { FlowActivity } from "../../../src/flow/lib/current-flow-state.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

function setup(t) {
  const root = createTmpDir("process-event-activity-");
  t.after(() => removeQuiescentRuntimeFixture({ mainRoot: root }));
  const manager = makeFlowManager(root);
  const fixture = new CanonicalFlowFixture({ flowManager: manager }).create().activate("branch");
  const state = manager.canonicalState(fixture.specId);
  const binding = { runId: state.runId, specId: state.specId, flowVersionId: state.flowVersionId,
    nodeId: state.attempt.nodeId, attemptId: state.attempt.id, attemptSequence: state.attempt.sequence };
  const executionId = crypto.randomUUID(), callId = crypto.randomUUID();
  const event = (type, sequence, overrides = {}) => new ProcessExecutionEvent({
    eventId: crypto.randomUUID(), executionId, callId, parentCallId: null, rootCallId: callId,
    sequence, type, binding, occurredAt: "2026-10-19T01:00:00.000Z", payload: {}, ...overrides,
  });
  return { root, manager, fixture, state, event, writer: new FlowProcessEventWriter(manager) };
}

test("process events persist their exact origin and replay an unacknowledged publication only once", (t) => {
  const { root, manager, fixture, event, writer } = setup(t);
  const before = manager.activityLedger(fixture.specId);
  const admissionRevision = manager.readCanonicalTransitionView({ specId: fixture.specId, read: (view) => view.dispatchExecutionRevision() });
  const reserved = event("reserved", 1);
  const acknowledgement = writer.write(reserved);
  assert.ok(acknowledgement instanceof ProcessExecutionCanonicalAcknowledgement);
  assert.ok(acknowledgement.matches(reserved));
  const restart = makeFlowManager(root);
  assert.deepEqual(new FlowProcessEventWriter(restart).write(reserved).toJSON(), acknowledgement.toJSON());
  assert.equal(restart.activityLedger(fixture.specId).length, before.length + 1);
  assert.equal(restart.readCanonicalTransitionView({ specId: fixture.specId, read: (view) => view.dispatchExecutionRevision() }), admissionRevision);
  for (const [type, sequence] of [["started", 2], ["exited", 3], ["result-finalized", 4]]) writer.write(event(type, sequence));
  const stored = makeFlowManager(root).activityLedger(fixture.specId).slice(before.length);
  assert.deepEqual(stored.map((entry) => entry.type), ["outbox_process_reserved", "outbox_process_started", "outbox_process_exited", "outbox_process_result_finalized"]);
  assert.deepEqual(stored[0].processEvent, reserved.toJSON());
  assert.equal(Object.hasOwn(new FlowProcessEvent(reserved).publicJSON(), "payload"), false);
  assert.deepEqual(stored.map((entry) => entry.processEvent.sequence), [1, 2, 3, 4]);
  FlowProcessEvent.assertFinalizable(stored.map((entry) => FlowActivity.fromSerialized(entry)));
  for (const original of before) assert.deepEqual(restart.activityLedger(fixture.specId).find((entry) => entry.id === original.id), original);
});

test("changed payload, binding, sequence and finalized-call events fail without advancing canonical history", (t) => {
  const { manager, fixture, event, writer } = setup(t);
  const reserved = event("reserved", 1);
  writer.write(reserved);
  const before = manager.activityLedger(fixture.specId);
  for (const invalid of [
    new ProcessExecutionEvent({ ...reserved.toJSON(), payload: { changed: true } }),
    event("started", 2, { binding: { ...reserved.binding.toJSON(), attemptId: "another-attempt" } }),
    event("started", 1),
  ]) {
    assert.throws(() => writer.write(invalid), (error) => error.name === "CurrentFlowStateInvariantError" || error.reason === "observation-save-failed");
    assert.deepEqual(manager.activityLedger(fixture.specId), before);
  }
  assert.throws(() => FlowProcessEvent.assertFinalizable(before.map((entry) => FlowActivity.fromSerialized(entry))),
    (error) => error.reason === "observation-save-failed");
  assert.throws(() => manager.finalizeFlow(fixture.specId), (error) => error.reason === "observation-save-failed");
  assert.deepEqual(manager.activityLedger(fixture.specId), before);
  writer.write(event("spawn-failed", 2));
  writer.write(event("result-finalized", 3));
  const finalized = manager.activityLedger(fixture.specId);
  assert.throws(() => writer.write(event("exited", 4)), (error) => error.reason === "observation-save-failed");
  assert.deepEqual(manager.activityLedger(fixture.specId), finalized);
});

test("stop requested and unconfirmed remain durable facts without authorizing finalization", (t) => {
  const { root, manager, fixture, event, writer } = setup(t);
  for (const [type, sequence] of [["reserved", 1], ["started", 2], ["stop-requested", 3], ["stop-unconfirmed", 4]]) writer.write(event(type, sequence));
  const stored = makeFlowManager(root).activityLedger(fixture.specId).filter((entry) => entry.processEvent);
  assert.deepEqual(stored.map((entry) => entry.type), ["outbox_process_reserved", "outbox_process_started", "outbox_process_stop_requested", "outbox_process_stop_unconfirmed"]);
  assert.throws(() => manager.finalizeFlow(fixture.specId), (error) => error.reason === "observation-save-failed");
  assert.deepEqual(makeFlowManager(root).activityLedger(fixture.specId).filter((entry) => entry.processEvent), stored);
});

test("delayed reservation publication retains its original completed Attempt", (t) => {
  const { manager, fixture, state, event, writer } = setup(t);
  const reserved = event("reserved", 1);
  fixture.settle("branch");
  assert.notEqual(manager.canonicalState(fixture.specId).attempt?.id, state.attempt.id);
  writer.write(reserved);
  writer.write(event("spawn-failed", 2));
  writer.write(event("result-finalized", 3));
  const facts = manager.activityLedger(fixture.specId).filter((entry) => entry.processEvent);
  assert.equal(facts.length, 3);
  assert.ok(facts.every((entry) => entry.processEvent.binding.attemptId === state.attempt.id));
});

test("unbound events stay runtime-only and prior producer Activities round-trip byte-for-byte", (t) => {
  const { manager, fixture, event, writer } = setup(t);
  const before = manager.activityLedger(fixture.specId);
  const unbound = event("reserved", 1, { binding: null });
  const disposition = writer.write(unbound);
  assert.ok(disposition instanceof ProcessExecutionRuntimeOnlyDisposition);
  assert.ok(disposition.matches(unbound));
  assert.deepEqual(manager.activityLedger(fixture.specId), before);
  const historical = path.resolve("tests/fixtures/process-event-additive-v4/activities.jsonl");
  const bytes = fs.readFileSync(historical);
  const provenance = JSON.parse(fs.readFileSync(path.join(path.dirname(historical), "provenance.json"), "utf8"));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), provenance.sha256);
  assert.equal(provenance.producerCommit, "f2b17cd6c4c2bbb1696dd14620d20f29469c944e");
  assert.ok(bytes.length > 0);
  for (const line of bytes.toString("utf8").trim().split("\n")) {
    const original = JSON.parse(line);
    // This immutable prior producer fixture retains the current Activity shape.
    const restored = FlowActivity.fromSerialized(original).toJSON();
    assert.deepEqual(restored, original);
    assert.equal(JSON.stringify(restored), line);
  }
});

test("a missing canonical publication receipt cannot acknowledge a process event", (t) => {
  const { event } = setup(t);
  const reserved = event("reserved", 1);
  for (const returned of [null, undefined, crypto.randomUUID()]) {
    const writer = new FlowProcessEventWriter({ recordProcessEvent: () => returned });
    assert.throws(() => writer.write(reserved), (error) => error.reason === "observation-save-failed");
  }
});


test("query revision 4 exposes process event identities without publishing their raw payload", async (t) => {
  const { root, fixture, event, writer } = setup(t);
  const origin = event("reserved", 1).binding.toJSON();
  const reserved = event("reserved", 1, { binding: { ...origin, privateInput: "private-binding-input" }, payload: { internal: "private-process-input" } });
  writer.write(reserved);
  const request = new QueryRequest({ resource: "activities", condition: { specId: fixture.specId }, page: { limit: 100, after: null } });
  const captured = await new CanonicalFlowVersionReader({ repositoryRoot: root }).read(fixture.specId, 1, request);
  const response = captured.version.response;
  assert.equal(response.schemaRevision, 4);
  const item = response.items.find((entry) => entry.processEvent?.eventId === reserved.eventId);
  assert.ok(item);
  assert.equal(item.activity.type, "outbox_process_reserved");
  assert.equal(item.processEvent.callId, reserved.callId);
  assert.equal(Object.hasOwn(item.processEvent, "payload"), false);
  assert.equal(JSON.stringify(response).includes("private-process-input"), false);
  assert.equal(JSON.stringify(response).includes("private-binding-input"), false);
  validateFlowQueryResponse(response);
});


test("a real child publishes runtime facts through canonical storage and retries only the missing acknowledgement", { timeout: 30000 }, async (t) => {
  const { root, manager, fixture, state, writer } = setup(t);
  const binding = { runId: state.runId, specId: state.specId, flowVersionId: state.flowVersionId,
    nodeId: state.attempt.nodeId, attemptId: state.attempt.id, attemptSequence: state.attempt.sequence };
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root,
    runId: state.runId, specId: state.specId, binding });
  try {
    // A semantically incomplete Flow must be refused before admission is fenced;
    // the following real command must still reserve and complete normally.
    assert.throws(() => runtime.enter(() => manager.finalizeFlow(fixture.specId)),
      (error) => error.name === "CurrentFlowStateInvariantError");
    const result = await runtime.enter(() => executeManagedProcess(new NativeExecutableInvocation({
      executable: process.execPath, args: ["-e", "process.stdout.write('event-test')"], cwd: root,
    }), [], { runtime, timeoutMs: 10000 }));
    assert.equal(result.stdout, "event-test");
    const interruption = new Error("publication completed before acknowledgement");
    await assert.rejects(runtime.drainEvents((event) => { writer.write(event); throw interruption; }), (error) => error === interruption);
    const saved = manager.activityLedger(fixture.specId).filter((entry) => entry.processEvent);
    assert.equal(saved.length, 1);
    const acknowledged = await runtime.drainEvents((event) => writer.write(event));
    assert.equal(acknowledged[0], saved[0].processEvent.eventId);
    assert.deepEqual(await runtime.drainEvents((event) => writer.write(event)), []);
    const reloaded = makeFlowManager(root).activityLedger(fixture.specId).filter((entry) => entry.processEvent);
    assert.deepEqual(reloaded.map((entry) => entry.processEvent.type), ["reserved", "started", "exited", "result-finalized"]);
    assert.equal(new Set(reloaded.map((entry) => entry.id)).size, 4);
    await runtime.enter(() => runtime.withBinding(binding, () => executeManagedProcess(new NativeExecutableInvocation({
      executable: process.execPath, args: ["-e", "process.stdout.write('bound-writer')"], cwd: root,
    }), [], { timeoutMs: 10000 }), { eventWriter: (event) => writer.write(event) }));
    const automaticallyPublished = makeFlowManager(root).activityLedger(fixture.specId).filter((entry) => entry.processEvent);
    assert.equal(automaticallyPublished.length, 8);
    FlowProcessEvent.assertFinalizable(automaticallyPublished.map((entry) => FlowActivity.fromSerialized(entry)));
  } finally { await runtime.close(); }
});

test("an admitted refined Agent binding publishes before later general Git events through the original canonical writer", { timeout: 30000 }, async (t) => {
  const { root, manager, fixture, state, writer } = setup(t);
  const binding = { runId: state.runId, specId: state.specId, flowVersionId: state.flowVersionId,
    nodeId: state.attempt.nodeId, attemptId: state.attempt.id, attemptSequence: state.attempt.sequence,
    commandId: "dispatch" };
  const refined = new ProcessExecutionBinding({ ...binding, executionContractId: "refined-provider-contract",
    executionGeneration: 0, dispatchInvocationId: crypto.randomUUID(), requestDigest: "a".repeat(64),
    commandId: "flow.dispatch.draft" });
  const config = { agent: { default: "test/exec", timeout: 20, retryCount: 0,
    providers: { "test/exec": { command: process.execPath, args: ["-e", "process.stdout.write('refined-provider-output')"] } } } };
  const agent = new Agent({ config, paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ enabled: false }) });
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root,
    runId: state.runId, specId: state.specId, binding });
  try {
    await runtime.enter(() => runtime.withBinding(binding, async () => {
      assert.equal(await agent.call("literal provider input", { cacheMode: "bypass", retryCount: 0,
        processExecutionBinding: refined }), "refined-provider-output");
      const git = runGit(["--version"], { cwd: root });
      assert.equal(git.ok, true);
      assert.match(git.stdout, /^git version /);
    }, { eventWriter: (event) => writer.write(event) }));
    const execution = runtime.inspect().executions.find((entry) => entry.executionId === runtime.executionId);
    assert.equal(execution.calls.length, 2);
    assert.deepEqual(execution.calls[0].binding, refined.toJSON());
    assert.deepEqual(execution.calls[1].binding, binding);
    assert.ok(execution.calls.every((call) => call.receipt?.observation.code === 0));
    const canonical = makeFlowManager(root).activityLedger(fixture.specId)
      .filter((activity) => activity.processEvent?.executionId === runtime.executionId).map((activity) => activity.processEvent);
    assert.deepEqual(canonical.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(canonical, execution.events);
    assert.deepEqual(execution.eventAcknowledgements.map((fact) => fact.eventId), execution.events.map((event) => event.eventId));
    assert.ok(execution.eventAcknowledgements.every((fact) =>
      fact.eventDigest === ProcessExecutionEvent.fromStored(execution.events.find((event) => event.eventId === fact.eventId)).digest));
    assert.deepEqual(await runtime.drainEvents((event) => writer.write(event)), []);
    assert.deepEqual(makeFlowManager(root).activityLedger(fixture.specId)
      .filter((activity) => activity.processEvent?.executionId === runtime.executionId).map((activity) => activity.processEvent), canonical);
    await runtime.close();
    const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).inventory;
    const closed = historical.executions.find((entry) => entry.executionId === runtime.executionId);
    assert.equal(closed.status, "closed");
    assert.deepEqual(closed.events, canonical);
    assert.ok(closed.calls.every((call) => call.receipt !== null));
  } finally { await runtime.close(); }
});

test("archived process events retain their old Attempt through canonical replay and successor finalization", { timeout: 30000 }, async (t) => {
  const { root, manager, fixture, state, writer } = setup(t);
  const binding = { runId: state.runId, specId: state.specId, flowVersionId: state.flowVersionId,
    nodeId: state.attempt.nodeId, attemptId: state.attempt.id, attemptSequence: state.attempt.sequence };
  const selection = new ProcessExecutionBindingSelection({ runId: state.runId,
    specId: state.specId, flowVersionId: state.flowVersionId });
  const original = await ProcessExecutionRuntime.acquire({ mainRoot: root, binding });
  try {
    await original.enter(() => executeManagedProcess(process.execPath, ["-e", "process.stdout.write('archived')"],
      { timeoutMs: 10000 }));
  } finally { await original.close(); }
  fixture.settle("branch");
  const successor = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  try {
    await assert.rejects(successor.finalizeBinding(selection), { code: "PROCESS_EXECUTION_ACTIVITY_PENDING" });
    const interruption = new Error("canonical old Attempt event saved before acknowledgement");
    assert.throws(() => successor.drainEventsSync((event) => {
      writer.write(event);
      throw interruption;
    }, selection), (error) => error === interruption);
    const restart = makeFlowManager(root);
    const restoredWriter = new FlowProcessEventWriter(restart);
    const barrier = successor.finalizeBindingSync(selection, (event) => restoredWriter.write(event));
    const ledger = restart.activityLedger(fixture.specId);
    const facts = ledger.filter((activity) => activity.processEvent);
    assert.equal(facts.length, 4);
    assert.equal(new Set(facts.map((activity) => activity.id)).size, 4);
    assert.ok(facts.every((activity) => activity.processEvent.executionId === original.executionId
      && activity.processEvent.binding.attemptId === state.attempt.id));
    FlowProcessEvent.assertFinalization(restart.canonicalState(fixture.specId),
      ledger.map((activity) => FlowActivity.fromSerialized(activity)), barrier);
    assert.deepEqual(successor.drainEventsSync((event) => restoredWriter.write(event), selection), []);
    assert.deepEqual(restart.activityLedger(fixture.specId), ledger);
  } finally { await successor.close(); }
});

test("read-only Git hints preserve the selected runtime binding and canonical acknowledgements beside a mutation", { timeout: 30000 }, async (t) => {
  const { root, manager, fixture, state, writer } = setup(t);
  const binding = { runId: state.runId, specId: state.specId, flowVersionId: state.flowVersionId,
    nodeId: state.attempt.nodeId, attemptId: state.attempt.id, attemptSequence: state.attempt.sequence };
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root,
    runId: state.runId, specId: state.specId, binding });
  try {
    const results = await runtime.enter(() => runtime.withBinding(binding, async () => {
      const mutation = runCmd(process.execPath, ["-e", "require('node:fs').writeFileSync('owned-user-change.txt','preserved')"], { cwd: root });
      const gitPolicy = new GitRepositoryPolicy({ repositoryRoot: root, readOnly: true });
      const synchronous = runGit(["--version"], { cwd: root, gitPolicy });
      const asynchronous = await runGitAsync(["--version"], { cwd: root, gitPolicy });
      return [mutation, synchronous, asynchronous];
    }, { eventWriter: (event) => writer.write(event) }));
    for (const result of results) {
      assert.equal(result.ok, true, result.stderr);
      assert.equal(result.processExecutionStopReceipt.executionId, runtime.executionId);
      assert.deepEqual(result.processExecutionStopReceipt.binding.toJSON(), binding);
      assert.equal(result.processExecutionStopReceipt.checkoutIdentity.executionRoot, root);
    }
    assert.equal(fs.readFileSync(path.join(root, "owned-user-change.txt"), "utf8"), "preserved");
    const execution = runtime.inspect().executions.find((entry) => entry.executionId === runtime.executionId);
    assert.equal(execution.calls.length, 3);
    assert.ok(execution.calls.every((call) => call.receipt !== null && call.receipt.observation.code === 0));
    const canonical = makeFlowManager(root).activityLedger(fixture.specId)
      .filter((activity) => activity.processEvent?.executionId === runtime.executionId).map((activity) => activity.processEvent);
    assert.deepEqual(canonical, execution.events);
    assert.equal(canonical.length, 12);
    assert.deepEqual(execution.eventAcknowledgements.map((fact) => fact.eventId), canonical.map((event) => event.eventId));
  } finally { await runtime.close(); }
});
