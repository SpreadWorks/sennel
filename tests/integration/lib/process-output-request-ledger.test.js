import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { ProcessOutputState, executionValueDigest } from "../../../src/lib/process-execution-values.js";
import { NodeScriptInvocation } from "../../../src/lib/command-invocation.js";
import { ManagedOutputSnapshot } from "../../../src/lib/managed-process-output.js";
import { managedRequest } from "../../../src/lib/managed-process-protocol.js";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { RuntimeStandaloneRequestDocument } from "../../../src/lib/process-execution-request-block.js";
import { RegisteredChildObservation } from "../../support/infrastructure/registered-child-observation.js";
import { RuntimeRequestEffectFailure } from "../../support/infrastructure/runtime-registry-publication-failure.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../../test-environment.js";

// Compatibility coverage for the output effect's request ledger. All bytes and
// exit observations come from the real owned handle, not constructed receipts.
class OutputRequestScenario {
  constructor(root, requestId, fault) {
    this.root = root; this.requestId = requestId; this.fault = fault;
    this.maximum = 64; this.expected = Buffer.from("prefix-suffix");
    this.retainUnknown = false;
  }
  static async create(t, mode = null) {
    const root = createTmpDir("output-request-ledger-"), requestId = randomUUID();
    const fault = mode === null ? null : new RuntimeRequestEffectFailure(root, { requestId, mode });
    const scenario = new this(root, requestId, fault);
    t.after(async () => {
      try {
        if (!scenario.retainUnknown && scenario.runtime !== undefined) {
          if (scenario.observation !== undefined && scenario.receipt === undefined) await scenario.finish();
          await scenario.runtime.close();
        }
      } finally {
        if (scenario.retainUnknown) {
          // Only the test's exact coordinator handle is cleaned up. This never
          // supplies a child receipt or authorizes removal of unknown state.
          const child = scenario.runtime?.control.child;
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
    const script = path.join(root, "actual-output.cjs");
    scenario.effect = path.join(root, "child-effects");
    fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(scenario.effect)},'once\\n');process.stdout.write(Buffer.from(${JSON.stringify(scenario.expected.toString("base64"))},'base64'))`);
    const invocation = new NodeScriptInvocation({ script, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const producer = await RegisteredChildObservation.produce(scenario.runtime, invocation,
      (call, data) => scenario.runtime.observeCall(call, data));
    scenario.producer = producer;
    scenario.call = producer.call; scenario.executor = producer.executor;
    scenario.observation = producer.observation; scenario.bytes = producer.stdout;
    assert.equal(scenario.observation.code, 0); assert.equal(scenario.observation.signal, null);
    assert.deepEqual(scenario.bytes, scenario.expected); assert.equal(producer.stderr.length, 0);
    await scenario.runtime.observeCall(scenario.call, { type: "exit", observation: scenario.observation.toJSON() });
    scenario.stdoutFile = path.join(scenario.runtime.store.callsAuthority.directory, scenario.call.callId, "stdout.bin");
    return scenario;
  }
  data(offset = 0, bytes = this.bytes) {
    return { call: this.call.controlTarget(), executor: this.executor.toJSON(), stream: "stdout", maximum: this.maximum,
      snapshot: ManagedOutputSnapshot.capture(this.bytes, this.maximum).toJSON(), offset, bytes: bytes.toString("base64") };
  }
  async request(data = this.data(), { requestId = this.requestId, client = this.runtime, grant = client.remoteGrant() } = {}) {
    return client.decodeResponse(await managedRequest(grant, "persist-call-output", { grant, data }, { requestId }));
  }
  async assertPendingReplay(firstFailure, data = this.data()) {
    return this.fault.assertPendingReplay({ request: () => this.request(data), readRecord: () => this.record(),
      grant: this.runtime.remoteGrant(), operation: "persist-call-output", data, firstFailure });
  }
  ledger() { return this.runtime.store.requestFile(this.runtime.executionId, this.requestId); }
  record() { return JSON.parse(this.ledger().read()); }
  storedRecord(envelope) {
    return RuntimeStandaloneRequestDocument.fromEnvelope(this.runtime.executionId, this.requestId, envelope).requestRecord();
  }
  async finish() {
    if (this.receipt !== undefined) return this.receipt;
    const stdout = await this.runtime.persistCallOutput(this.call, { executor: this.executor, stream: "stdout", maximum: this.maximum, bytes: this.bytes });
    const stderr = await this.runtime.persistCallOutput(this.call, { executor: this.executor, stream: "stderr", maximum: this.maximum, bytes: Buffer.alloc(0) });
    this.receipt = await this.runtime.finishCall(this.call, { observation: this.observation,
      outcome: { code: 0, output: { maximum: this.maximum, stdout, stderr } },
      output: new ProcessOutputState({ stdoutBytes: this.bytes.length, stderrBytes: 0, completion: "complete", cutoffAt: new Date().toISOString() }) });
    return this.receipt;
  }
  async assertClosedHistory() {
    const receipt = await this.finish();
    await this.runtime.close();
    const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: this.root });
    const saved = historical.executions.find(entry => entry.executionId === this.runtime.executionId);
    assert.equal(saved.status, "closed"); assert.equal(saved.calls.length, 1);
    assert.deepEqual(saved.calls[0].receipt, receipt.toJSON());
    assert.deepEqual(saved.calls[0].observation, this.observation.toJSON());
    assert.equal(saved.events.filter(event => event.type === "result-finalized").length, 1);
    assert.deepEqual(fs.readFileSync(this.stdoutFile), this.bytes);
    assert.equal(fs.readFileSync(this.effect, "utf8"), "once\n");
  }
  assertWitness(phase) {
    const witness = JSON.parse(fs.readFileSync(this.fault.witness));
    assert.equal(witness.requestId, this.requestId); assert.equal(witness.phase, phase);
    assert.ok(witness.target.startsWith(this.root + path.sep));
    return witness;
  }
  async assertUnknown() {
    const saved = this.runtime.inspect().executions.find(entry => entry.executionId === this.runtime.executionId).calls[0];
    assert.equal(saved.status, "exited"); assert.equal(saved.observation.code, 0);
    assert.equal(saved.receipt, null); assert.equal(saved.output, null); assert.equal(saved.outcome, null);
    assert.equal(this.runtime.stopReceipts().length, 0);
    await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: this.root }), { code: "PROCESS_EXECUTION_BUSY" });
    assert.equal(fs.readFileSync(this.effect, "utf8"), "once\n");
  }
}

test("output chunks retain exact durable acknowledgements across fresh same-epoch clients, refusal and genuine archived closure", { timeout: 120000 }, async (t) => {
  const scenario = await OutputRequestScenario.create(t);
  const { runtime, bytes, maximum } = scenario;
  const before = runtime.store.file.read();
  const first = scenario.data(0, bytes.subarray(0, 6));
  const acknowledged = await scenario.request(first);
  assert.deepEqual(acknowledged, { snapshot: ManagedOutputSnapshot.capture(bytes.subarray(0, 6), maximum).toJSON(), complete: false });
  const ledgerBytes = scenario.ledger().read(), stored = scenario.record();
  assert.equal(stored.payload.version, 9);
  assert.equal(scenario.storedRecord(stored).requestId, scenario.requestId);
  assert.equal(stored.payload.operation, "persist-call-output");
  assert.equal(stored.payload.payloadDigest, executionValueDigest({ grant: runtime.remoteGrant(), data: first }));
  assert.match(stored.payload.authorizationDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(stored.payload.response, { ok: true, value: acknowledged });
  assert.deepEqual(runtime.store.file.read(), before);
  const prefix = fs.readFileSync(scenario.stdoutFile), progress = fs.readFileSync(`${scenario.stdoutFile}.capture`);
  const fresh = await ProcessExecutionRuntime.fromRemoteGrant(JSON.parse(JSON.stringify(runtime.remoteGrant())));
  acknowledged.snapshot.byteLength = 0;
  assert.deepEqual(await scenario.request(first, { client: fresh }), stored.payload.response.value);
  assert.deepEqual(scenario.ledger().read(), ledgerBytes);
  assert.deepEqual(fs.readFileSync(scenario.stdoutFile), prefix); assert.deepEqual(fs.readFileSync(`${scenario.stdoutFile}.capture`), progress);
  await assert.rejects(scenario.request({ ...first, bytes: Buffer.from("altered").toString("base64") }), { code: "PROCESS_EXECUTION_REQUEST_MISMATCH" });
  const forged = { ...runtime.remoteGrant(), capability: randomUUID() };
  await assert.rejects(scenario.request(first, { grant: forged }), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
  assert.deepEqual(scenario.ledger().read(), ledgerBytes); assert.deepEqual(runtime.store.file.read(), before);
  const final = await scenario.request(scenario.data(6, bytes.subarray(6)), { requestId: randomUUID(), client: fresh });
  assert.deepEqual(final, { snapshot: ManagedOutputSnapshot.capture(bytes, maximum).toJSON(), complete: true });
  assert.deepEqual(runtime.store.file.read(), before);
  const oldGrant = runtime.remoteGrant();
  await scenario.assertClosedHistory();
  const next = await ProcessExecutionRuntime.acquire({ mainRoot: scenario.root });
  try {
    assert.equal(next.ownerEpoch, runtime.ownerEpoch + 1);
    const newGrant = next.remoteGrant(), nextRegistry = next.store.file.read();
    // Route to the live new owner. The old endpoint is deliberately not used;
    // its completed UUID is data, never permission in another owner epoch.
    await assert.rejects(managedRequest(newGrant, "persist-call-output", { grant: oldGrant, data: first },
      { requestId: scenario.requestId }), { code: "PROCESS_EXECUTION_DELEGATION_REFUSED" });
    await assert.rejects(managedRequest(newGrant, "persist-call-output", { grant: newGrant, data: first },
      { requestId: scenario.requestId }), { code: "PROCESS_EXECUTION_BINDING_MISMATCH" });
    assert.deepEqual(scenario.ledger().read(), ledgerBytes);
    assert.deepEqual(next.store.file.read(), nextRegistry);
  } finally { await next.close(); }
});

for (const [mode, phase, expectedCode, effect] of [
  ["pending-readback", "pending-visible-before-readback", "PROCESS_EXECUTION_DURABILITY_UNCERTAIN", false],
  ["completion-publication", "after-effect-before-completion", "PROCESS_EXECUTION_REGISTRY_FAILED", true],
]) {
  test(`output request ${mode} retains pending identity without replaying its effect`, { timeout: 120000 }, async (t) => {
    const scenario = await OutputRequestScenario.create(t, mode);
    const before = scenario.runtime.store.file.read();
    let firstFailure;
    await assert.rejects(scenario.request(), error => { firstFailure = error; return error.code === expectedCode; });
    scenario.assertWitness(phase);
    const record = scenario.record();
    assert.equal(scenario.storedRecord(record).requestId, scenario.requestId); assert.equal(record.payload.response, null);
    assert.deepEqual(scenario.runtime.store.file.read(), before);
    assert.equal(fs.existsSync(scenario.stdoutFile), effect);
    const prefix = effect ? fs.readFileSync(scenario.stdoutFile) : null;
    const progress = effect ? fs.readFileSync(`${scenario.stdoutFile}.capture`) : null;
    if (effect) assert.deepEqual(prefix, scenario.bytes);
    await scenario.assertPendingReplay(firstFailure);
    assert.deepEqual(scenario.record(), record); assert.deepEqual(scenario.runtime.store.file.read(), before);
    assert.equal(fs.existsSync(scenario.stdoutFile), effect);
    if (effect) { assert.deepEqual(fs.readFileSync(scenario.stdoutFile), prefix); assert.deepEqual(fs.readFileSync(`${scenario.stdoutFile}.capture`), progress); }
    await scenario.assertUnknown();
    // A new request can transfer/read back the same actual captured bytes. It
    // does not resolve or replay the uncertain UUID or manufacture a stop receipt.
    await scenario.assertClosedHistory();
    assert.deepEqual(scenario.record(), record);
  });
}

test("a later spool publication failure keeps its typed acknowledgement, earlier prefix and unknown child exclusion", { timeout: 120000 }, async (t) => {
  const scenario = await OutputRequestScenario.create(t, "spool-publication");
  scenario.retainUnknown = true;
  const prefixData = scenario.data(0, scenario.bytes.subarray(0, 6));
  assert.equal((await scenario.request(prefixData, { requestId: randomUUID() })).complete, false);
  const prefix = fs.readFileSync(scenario.stdoutFile), progress = fs.readFileSync(`${scenario.stdoutFile}.capture`);
  const before = scenario.runtime.store.file.read();
  const rest = scenario.data(6, scenario.bytes.subarray(6));
  await assert.rejects(scenario.request(rest), { code: "PROCESS_EXECUTION_RECORD_SAVE_FAILED" });
  scenario.assertWitness("later-spool-publication");
  const record = scenario.record();
  assert.equal(record.payload.response.ok, false); assert.equal(record.payload.response.error.code, "PROCESS_EXECUTION_RECORD_SAVE_FAILED");
  assert.equal(scenario.storedRecord(record).requestId, scenario.requestId);
  await assert.rejects(scenario.request(rest), { code: "PROCESS_EXECUTION_RECORD_SAVE_FAILED" });
  await assert.rejects(scenario.request(rest, { requestId: randomUUID() }), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  assert.deepEqual(scenario.record(), record); assert.deepEqual(scenario.runtime.store.file.read(), before);
  assert.deepEqual(fs.readFileSync(scenario.stdoutFile), prefix); assert.deepEqual(fs.readFileSync(`${scenario.stdoutFile}.capture`), progress);
  assert.equal(fs.existsSync(`${scenario.stdoutFile}.transition`), true);
  await scenario.assertUnknown();
  assert.equal(removeQuiescentRuntimeFixture({ mainRoot: scenario.root }), false);
});

for (const [mode, phase, effect] of [
  ["before-effect-registry-change", "after-pending-before-effect", false],
  ["after-effect-registry-change", "after-spool-effect-before-completion", true],
]) {
  test(`output transfer refuses fresh registry changes ${mode} and retains pending ownership`, { timeout: 120000 }, async (t) => {
    const scenario = await OutputRequestScenario.create(t, mode);
    scenario.retainUnknown = true;
    const before = scenario.runtime.store.file.read();
    let firstFailure;
    await assert.rejects(scenario.request(), error => { firstFailure = error; return error.code === "PROCESS_EXECUTION_AUTHORITY_MISMATCH"; });
    scenario.assertWitness(phase);
    const changed = scenario.runtime.store.file.read(); assert.notDeepEqual(changed, before);
    const envelope = JSON.parse(changed); assert.equal(envelope.digest, executionValueDigest(envelope.payload));
    const record = scenario.record(); assert.equal(record.payload.response, null);
    assert.equal(fs.existsSync(scenario.stdoutFile), effect);
    if (effect) assert.deepEqual(fs.readFileSync(scenario.stdoutFile), scenario.bytes);
    await scenario.assertPendingReplay(firstFailure);
    assert.deepEqual(scenario.record(), record); assert.deepEqual(scenario.runtime.store.file.read(), changed);
    await scenario.assertUnknown();
    assert.equal(removeQuiescentRuntimeFixture({ mainRoot: scenario.root }), false);
  });
}
