import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutorIdentity, ProcessOutputState, executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { NodeScriptInvocation } from "../../../src/lib/command-invocation.js";
import { managedRequest } from "../../../src/lib/managed-process-protocol.js";
import { RegisteredChildObservation } from "../../support/infrastructure/registered-child-observation.js";
import { RuntimeRequestEffectFailure } from "../../support/infrastructure/runtime-registry-publication-failure.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../../test-environment.js";

// Request-specific acceptance, effect, replay and retained-failure boundaries.
class ObservationRequestScenario {
  constructor(root, requestId, fault) {
    this.root = root; this.requestId = requestId; this.fault = fault;
    this.maximum = 64; this.retainUnknown = fault !== null;
  }
  static async create(t, mode = null) {
    const root = createTmpDir("observation-request-ledger-"), requestId = randomUUID();
    const fault = mode === null ? null : new RuntimeRequestEffectFailure(root, { requestId, mode });
    const scenario = new this(root, requestId, fault);
    t.after(async () => {
      try {
        if (!scenario.retainUnknown && scenario.runtime !== undefined) await scenario.runtime.close();
      } catch (error) { scenario.retainUnknown = true; throw error; }
      finally {
        if (scenario.retainUnknown) {
          // Only this fixture's actual control-child handle is stopped. No
          // receipt is manufactured and its uncertain filesystem is retained.
          const child = scenario.runtime?.control?.child;
          if (child && child.exitCode === null && child.signalCode === null) {
            const stopped = once(child, "exit"); child.ref(); child.kill(); await stopped;
          }
          testTemporaryRoot().retainOnUnconfirmedExecution();
        }
        removeQuiescentRuntimeFixture({ mainRoot: root });
      }
    });
    scenario.runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root,
      ...(fault === null ? {} : { environment: fault.environment }) });
    scenario.effect = path.join(root, "child-effects");
    const script = path.join(root, "actual-observation.cjs");
    fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(scenario.effect)},'once\\n');process.stdout.write('observed-once')`);
    const invocation = new NodeScriptInvocation({ script, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const producer = await RegisteredChildObservation.produce(scenario.runtime, invocation, async (call, data) => {
      scenario.call = call;
      scenario.startedId = randomUUID();
      scenario.startedData = { call: call.controlTarget(), ...data };
      scenario.startedResult = await scenario.request(scenario.startedData, { requestId: scenario.startedId });
      assert.deepEqual(scenario.startedResult, { status: "running" });
    });
    scenario.producer = producer;
    scenario.call = producer.call; scenario.executor = producer.executor; scenario.permit = producer.permit;
    scenario.observation = producer.observation; scenario.bytes = producer.stdout;
    assert.equal(scenario.observation.code, 0); assert.equal(scenario.observation.signal, null);
    assert.equal(scenario.bytes.toString(), "observed-once"); assert.equal(producer.stderr.length, 0);
    scenario.exitData = { call: scenario.call.controlTarget(), type: "exit", observation: scenario.observation.toJSON() };
    return scenario;
  }
  async request(data = this.exitData, { requestId = this.requestId, client = this.runtime, grant = client.remoteGrant() } = {}) {
    return client.decodeResponse(await managedRequest(grant, "observe", { grant, data }, { requestId }));
  }
  execution() {
    return this.runtime.inspect().executions.find(entry => entry.executionId === this.runtime.executionId);
  }
  ledgerRecord() { return JSON.parse(this.runtime.store.requestFile(this.runtime.executionId, this.requestId).read()); }
  assertWitness(phase) {
    const witness = JSON.parse(fs.readFileSync(this.fault.witness));
    assert.equal(witness.requestId, this.requestId); assert.equal(witness.phase, phase);
    assert.ok(witness.target.startsWith(this.root + path.sep));
    return witness;
  }
  assertUnobservedExit(execution = this.execution()) {
    const call = execution.calls.find(entry => entry.callId === this.call.callId);
    assert.equal(call.status, "running"); assert.equal(call.observation, null);
    assert.equal(call.output, null); assert.equal(call.outcome, null); assert.equal(call.receipt, null);
    assert.deepEqual(execution.events.filter(event => event.callId === call.callId).map(event => event.type), ["reserved", "started"]);
    assert.equal(fs.readFileSync(this.effect, "utf8"), "once\n");
  }
  async assertPendingReplay(firstFailure) {
    return this.fault.assertPendingReplay({ request: () => this.request(), readRecord: () => this.ledgerRecord(),
      grant: this.runtime.remoteGrant(), operation: "observe", data: this.exitData, firstFailure });
  }
  async finish() {
    const stdout = await this.runtime.persistCallOutput(this.call, { executor: this.executor, stream: "stdout", maximum: this.maximum, bytes: this.bytes });
    const stderr = await this.runtime.persistCallOutput(this.call, { executor: this.executor, stream: "stderr", maximum: this.maximum, bytes: Buffer.alloc(0) });
    return this.runtime.finishCall(this.call, { observation: this.observation,
      outcome: { code: 0, output: { maximum: this.maximum, stdout, stderr } },
      output: new ProcessOutputState({ stdoutBytes: this.bytes.length, stderrBytes: 0,
        completion: "complete", cutoffAt: new Date().toISOString() }) });
  }
}

test("real child observations retain atomic inline responses and exact replay through a fresh client and archived receipt", { timeout: 120000 }, async (t) => {
  const scenario = await ObservationRequestScenario.create(t);
  const fresh = await ProcessExecutionRuntime.fromRemoteGrant(JSON.parse(JSON.stringify(scenario.runtime.remoteGrant())));
  assert.deepEqual(await scenario.request(scenario.startedData, { requestId: scenario.startedId, client: fresh }), scenario.startedResult);
  const result = await scenario.request(); assert.deepEqual(result, { status: "exited" });
  const before = scenario.runtime.store.file.read(), execution = scenario.execution();
  const saved = execution.requests.find(request => request.requestId === scenario.requestId);
  assert.equal(saved.operation, "observe"); assert.equal(saved.payloadDigest,
    executionValueDigest({ grant: scenario.runtime.remoteGrant(), data: scenario.exitData }));
  assert.match(saved.authorizationDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(saved.response, { ok: true, value: result });
  const call = execution.calls.find(entry => entry.callId === scenario.call.callId);
  assert.deepEqual(call.observation, scenario.observation.toJSON()); assert.equal(call.status, "exited");
  assert.deepEqual(call.permit, scenario.permit.toJSON());
  assert.deepEqual(execution.events.filter(event => event.callId === call.callId).map(event => event.type), ["reserved", "started", "exited"]);
  assert.deepEqual(await scenario.request(scenario.exitData, { client: fresh }), result);
  await assert.rejects(scenario.request({ ...scenario.exitData, type: "different" }), { code: "PROCESS_EXECUTION_REQUEST_MISMATCH" });
  const forged = { ...scenario.runtime.remoteGrant(), capability: randomUUID() };
  await assert.rejects(scenario.request(scenario.exitData, { grant: forged }), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
  assert.deepEqual(scenario.runtime.store.file.read(), before);
  const receipt = await scenario.finish();
  await fresh.close(); await scenario.runtime.close();
  const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: scenario.root });
  const closed = historical.executions.find(entry => entry.executionId === scenario.runtime.executionId);
  assert.equal(historical.inventory.slot, null); assert.equal(closed.status, "closed");
  assert.deepEqual(closed.calls.find(entry => entry.callId === call.callId).receipt, receipt.toJSON());
  assert.deepEqual(closed.requests.find(request => request.requestId === scenario.requestId), saved);
  assert.equal(closed.events.filter(event => event.callId === call.callId && event.type === "exited").length, 1);
  assert.equal(closed.events.filter(event => event.callId === call.callId && event.type === "result-finalized").length, 1);
  assert.equal(fs.readFileSync(scenario.effect, "utf8"), "once\n");
});

test("observation acceptance readback failure preserves pending identity without publishing the actual exit", { timeout: 120000 }, async (t) => {
  const scenario = await ObservationRequestScenario.create(t, "pending-readback");
  const before = scenario.runtime.store.file.read(); let failure;
  await assert.rejects(scenario.request(), error => {
    failure = error; assert.ok(error instanceof ProcessExecutionControlFailure);
    return error.code === "PROCESS_EXECUTION_DURABILITY_UNCERTAIN";
  });
  scenario.assertWitness("pending-visible-before-readback");
  const pending = scenario.ledgerRecord(); assert.equal(pending.digest, executionValueDigest(pending.payload));
  assert.equal(pending.payload.operation, "observe"); assert.equal(pending.payload.response, null);
  assert.deepEqual(scenario.runtime.store.file.read(), before); scenario.assertUnobservedExit();
  await scenario.assertPendingReplay(failure);
  assert.deepEqual(scenario.runtime.store.file.read(), before); assert.deepEqual(scenario.ledgerRecord(), pending);
  await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: scenario.root }), { code: "PROCESS_EXECUTION_BUSY" });
  assert.equal(removeQuiescentRuntimeFixture({ mainRoot: scenario.root }), false);
});

test("observation dispatch rejects changed fresh registry bytes after durable acceptance without publishing an exit event", { timeout: 120000 }, async (t) => {
  const scenario = await ObservationRequestScenario.create(t, "before-effect-registry-change");
  const before = scenario.runtime.store.file.read(); let failure;
  await assert.rejects(scenario.request(), error => { failure = error; return error.code === "PROCESS_EXECUTION_AUTHORITY_MISMATCH"; });
  scenario.assertWitness("after-pending-before-effect");
  const changed = scenario.runtime.store.file.read(); assert.notDeepEqual(changed, before);
  const record = JSON.parse(changed); assert.equal(record.digest, executionValueDigest(record.payload));
  const pending = scenario.ledgerRecord(); assert.equal(pending.payload.response, null);
  scenario.assertUnobservedExit(); await scenario.assertPendingReplay(failure);
  assert.deepEqual(scenario.runtime.store.file.read(), changed); assert.deepEqual(scenario.ledgerRecord(), pending);
  assert.equal(removeQuiescentRuntimeFixture({ mainRoot: scenario.root }), false);
});

test("a published observation and inline response remain paired when physical readback fails without a false acknowledgement", { timeout: 120000 }, async (t) => {
  const scenario = await ObservationRequestScenario.create(t, "observation-readback");
  await assert.rejects(scenario.request(), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  scenario.assertWitness("observation-effect-and-response-visible-before-readback");
  const bytes = scenario.runtime.store.file.read(), envelope = JSON.parse(bytes);
  assert.equal(envelope.digest, executionValueDigest(envelope.payload));
  const execution = envelope.payload.executions.find(entry => entry.executionId === scenario.runtime.executionId);
  const call = execution.calls.find(entry => entry.callId === scenario.call.callId);
  assert.deepEqual(call.observation, scenario.observation.toJSON()); assert.equal(call.status, "exited");
  assert.equal(call.receipt, null); assert.equal(call.output, null); assert.equal(call.outcome, null);
  assert.deepEqual(execution.requests.find(request => request.requestId === scenario.requestId).response,
    { ok: true, value: { status: "exited" } });
  assert.equal(execution.events.filter(event => event.callId === call.callId && event.type === "exited").length, 1);
  const pending = scenario.ledgerRecord(); assert.equal(pending.payload.response, null);
  assert.throws(() => scenario.runtime.inspect(), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  await assert.rejects(scenario.request(), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  assert.deepEqual(scenario.runtime.store.file.read(), bytes); assert.deepEqual(scenario.ledgerRecord(), pending);
  assert.equal(fs.readFileSync(scenario.effect, "utf8"), "once\n");
  assert.equal(removeQuiescentRuntimeFixture({ mainRoot: scenario.root }), false);
});


test("an observation executor refusal is published inline without changing the call and replays exactly before a valid exit", { timeout: 120000 }, async (t) => {
  const scenario = await ObservationRequestScenario.create(t);
  const original = scenario.execution();
  const wrongExecutor = new ProcessExecutorIdentity({ executorId: randomUUID(), executorSession: randomUUID(), launchClaim: randomUUID() });
  const invalid = { ...scenario.exitData, observation: { ...scenario.exitData.observation, executor: wrongExecutor.toJSON() } };
  const requestId = randomUUID(); let failure;
  await assert.rejects(scenario.request(invalid, { requestId }), error => {
    failure = error; return error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_EXECUTOR_MISMATCH";
  });
  const refused = scenario.execution();
  assert.deepEqual(refused.calls, original.calls); assert.deepEqual(refused.events, original.events);
  const response = refused.requests.find(request => request.requestId === requestId);
  assert.equal(response.operation, "observe");
  assert.equal(response.payloadDigest, executionValueDigest({ grant: scenario.runtime.remoteGrant(), data: invalid }));
  assert.equal(response.response.ok, false);
  assert.deepEqual(response.response.error, failure.cause.toJSON());
  const bytes = scenario.runtime.store.file.read();
  const fresh = await ProcessExecutionRuntime.fromRemoteGrant(JSON.parse(JSON.stringify(scenario.runtime.remoteGrant())));
  await assert.rejects(scenario.request(invalid, { requestId, client: fresh }), error => {
    assert.equal(error.code, failure.code);
    assert.deepEqual(error.cause.toJSON(), response.response.error);
    return true;
  });
  assert.deepEqual(scenario.runtime.store.file.read(), bytes);
  assert.deepEqual(scenario.execution().requests.find(request => request.requestId === requestId), response);
  assert.deepEqual(await scenario.request(), { status: "exited" });
  const receipt = await scenario.finish(); await fresh.close(); await scenario.runtime.close();
  const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: scenario.root });
  assert.equal(historical.inventory.slot, null);
  const closed = historical.executions.find(entry => entry.executionId === scenario.runtime.executionId);
  assert.equal(closed.status, "closed"); assert.deepEqual(closed.calls[0].receipt, receipt.toJSON());
  assert.deepEqual(closed.requests.find(request => request.requestId === requestId), response);
  assert.equal(closed.events.filter(event => event.type === "exited").length, 1);
  assert.equal(fs.readFileSync(scenario.effect, "utf8"), "once\n");
});

test("the post-dispatch fresh guard refuses changed registry bytes without publishing its staged observation", { timeout: 120000 }, async (t) => {
  const scenario = await ObservationRequestScenario.create(t, "after-observation-registry-change");
  const before = scenario.runtime.store.file.read(); let failure;
  await assert.rejects(scenario.request(), error => { failure = error; return error.code === "PROCESS_EXECUTION_AUTHORITY_MISMATCH"; });
  assert.equal(scenario.assertWitness("after-observation-before-completion").freshRegistryReadOrdinal, 2);
  const changed = scenario.runtime.store.file.read(); assert.notDeepEqual(changed, before);
  const envelope = JSON.parse(changed); assert.equal(envelope.digest, executionValueDigest(envelope.payload));
  scenario.assertUnobservedExit();
  const pending = scenario.ledgerRecord(); assert.equal(pending.payload.response, null);
  await scenario.assertPendingReplay(failure);
  assert.deepEqual(scenario.runtime.store.file.read(), changed); assert.deepEqual(scenario.ledgerRecord(), pending);
  assert.equal(removeQuiescentRuntimeFixture({ mainRoot: scenario.root }), false);
});

test("an observation publication failure before visibility leaves the original call and pending identity without an acknowledgement", { timeout: 120000 }, async (t) => {
  const scenario = await ObservationRequestScenario.create(t, "observation-publication");
  const before = scenario.runtime.store.file.read();
  await assert.rejects(scenario.request(), { code: "PROCESS_EXECUTION_REGISTRY_FAILED" });
  scenario.assertWitness("observation-effect-and-response-before-publication");
  assert.deepEqual(scenario.runtime.store.file.read(), before);
  // Direct readback of this owned fixture establishes that neither the actual
  // exit nor its inline response became visible. The transition stays unknown.
  const envelope = JSON.parse(before);
  assert.equal(envelope.digest, executionValueDigest(envelope.payload));
  const execution = envelope.payload.executions.find(entry => entry.executionId === scenario.runtime.executionId);
  scenario.assertUnobservedExit(execution);
  assert.equal(execution.requests.some(request => request.requestId === scenario.requestId), false);
  const pending = scenario.ledgerRecord(); assert.equal(pending.payload.response, null);
  assert.throws(() => scenario.runtime.inspect(), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  await assert.rejects(scenario.request(), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  assert.deepEqual(scenario.runtime.store.file.read(), before); assert.deepEqual(scenario.ledgerRecord(), pending);
  assert.equal(removeQuiescentRuntimeFixture({ mainRoot: scenario.root }), false);
});
