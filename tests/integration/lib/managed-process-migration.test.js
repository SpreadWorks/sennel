import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { ProcessIdentity, ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { RuntimeChildExecution } from "../../../src/lib/runtime-package.js";
import { ManagedMigrationScenario } from "../../support/infrastructure/managed-migration-scenario.js";

function assertStopDiagnostic(scenario, failure, record, call) {
  const member = record.members.find((entry) => entry.pid === scenario.ready.descendantPid);
  assert.ok(failure instanceof ProcessExecutionControlFailure);
  assert.equal(failure.code, "PROCESS_EXECUTION_STOP_UNPROVEN");
  assert.equal(failure.executionId, scenario.runtime.executionId);
  assert.equal(failure.callId, call.callId);
  assert.deepEqual(failure.diagnostic.birth.toJSON(), {
    pid: member.pid, bootIdentity: member.bootIdentity, startFingerprint: member.startFingerprint,
  });
  assert.equal(failure.diagnostic.role, "descendant");
  assert.equal(failure.diagnostic.originalPgid, record.pgid);
  assert.equal(failure.diagnostic.observedPgid, scenario.moved.pgrp);
  assert.equal(failure.diagnostic.observedSid, scenario.moved.sessionId);
  assert.match(failure.diagnostic.operation, /stop.*deadline/);
  assert.equal(failure.primaryCause.code, "PROCESS_EXECUTION_STOP_UNPROVEN");
  assert.equal(failure.primaryCause.executionId, failure.executionId);
  assert.equal(failure.primaryCause.callId, failure.callId);
  assert.deepEqual(call.controlFailure, failure.toJSON(), "public and durable refusals must retain identical provenance");
}

for (const race of [false, true]) {
  test(`captured descendant changes session ${race ? "between enumeration and birth observation" : "before enumeration"} and naturally completes`, async (t) => {
    const scenario = new ManagedMigrationScenario(t, race ? "enumeration-race" : "natural", { race });
    await scenario.start();
    scenario.releaseProvider();
    const waiting = await scenario.waitRecord((record) => record.outcome.code === 0);
    assert.equal(waiting.state, "running", "provider exit cannot complete a live migrated member");
    assert.equal(scenario.finished, false);
    const before = scenario.runtime.inspect();
    assert.equal(before.slot, scenario.runtime.executionId);
    assert.equal(before.executions.at(-1).calls[0].receipt, null);
    await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: scenario.root }),
      (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_BUSY");
    scenario.releaseMember();
    const outcome = await scenario.invocation;
    scenario.evidence(outcome);
    assert.ifError(outcome.error);
    assert.equal(outcome.result.code, 0);
    assert.equal(outcome.result.stdout, "provider completed");
    assert.equal(scenario.readRecord().state, "finished", "fixture teardown cannot stand in for normal launcher exit");
    const receipt = outcome.result.processExecutionStopReceipt;
    assert.equal(receipt.stopEvidence.confirmed, true);
    const member = receipt.members.find((member) => member.pid === scenario.ready.descendantPid);
    assert.ok(member);
    assert.equal(member.startFingerprint, String(scenario.birth.startFingerprint));
    assert.equal(new ProcessIdentitySource().observe(new ProcessIdentity(member)).terminated, true);
    await scenario.runtime.close();
    assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: scenario.root }).slot, null);
  });
}

for (const reason of ["timeout", "abort"]) {
  test(`${reason} signals the original group and waits for a migrated member's natural exit`, async (t) => {
    const scenario = new ManagedMigrationScenario(t, `${reason}-drain`);
    await scenario.start({ timeoutMs: reason === "timeout" ? 2500 : 15000, graceMs: 1500 });
    if (reason === "abort") scenario.abort.abort(new Error("fixture abort"));
    const stopping = await scenario.waitRecord((record) => record.state === "stopping");
    assert.equal(stopping.outcome.finalAction, "SIGTERM");
    assert.equal(fs.existsSync(scenario.file("member-ended")), false);
    assert.equal(new ProcessIdentitySource().observe(new ProcessIdentity(stopping.members.find((member) => member.pid === scenario.ready.descendantPid))).terminated, false);
    assert.equal(scenario.runtime.inspect().executions.at(-1).calls[0].receipt, null);
    scenario.releaseMember();
    const outcome = await scenario.invocation;
    scenario.evidence(outcome);
    assert.ok(outcome.error);
    assert.notEqual(outcome.error.name, "ProcessExecutionControlFailure");
    assert.equal(outcome.error.processExecutionStopReceipt.stopEvidence.confirmed, true);
    assert.equal(scenario.readRecord().state, "finished");
    assert.deepEqual(scenario.signals(), [{ pid: -scenario.captured.pgid, signal: "SIGTERM" }]);
    await scenario.runtime.close();
    assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: scenario.root }).slot, null);
  });
}

test("a migrated member surviving original-group KILL refuses proof and keeps its slot", async (t) => {
  const scenario = new ManagedMigrationScenario(t, "abort-unconfirmed");
  await scenario.start({ timeoutMs: 15000, graceMs: 100 });
  scenario.abort.abort(new Error("fixture abort"));
  const outcome = await scenario.invocation;
  scenario.evidence(outcome);
  assert.ok(outcome.error instanceof ProcessExecutionControlFailure);
  assert.equal(outcome.error.code, "PROCESS_EXECUTION_STOP_UNPROVEN");
  const record = scenario.readRecord();
  assert.equal(record.outcome.finalAction, "SIGKILL");
  assert.deepEqual(scenario.signals(), [{ pid: -scenario.captured.pgid, signal: "SIGTERM" },
    { pid: -scenario.captured.pgid, signal: "SIGKILL" }]);
  const member = record.members.find((member) => member.pid === scenario.ready.descendantPid);
  const observation = new ProcessIdentitySource().observe(new ProcessIdentity(member));
  assert.equal(observation.terminated, false, "moved group must never receive the anchor's KILL");
  assert.equal(observation.stat.pgrp, scenario.moved.pgrp);
  const inventory = scenario.runtime.inspect();
  const call = inventory.executions.at(-1).calls[0];
  assert.equal(inventory.slot, scenario.runtime.executionId);
  assert.equal(call.receipt, null);
  const failure = outcome.error;
  assertStopDiagnostic(scenario, failure, record, call);
  await assert.rejects(scenario.runtime.close(), (error) => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.deepEqual(error.diagnostic.toJSON(), failure.diagnostic.toJSON());
    assert.deepEqual(error.primaryCause.toJSON(), failure.primaryCause.toJSON());
    return true;
  });
  const reader = scenario.file("failure-readback.mjs");
  const source = (name) => JSON.stringify(new URL(`../../../src/lib/${name}.js`, import.meta.url).href);
  fs.writeFileSync(reader, `
    import {ProcessExecutionRuntime,ProcessExecutionControlFailure} from ${source("process-execution-runtime")};
    import {Envelope} from ${source("flow-envelope")};
    const inventory=ProcessExecutionRuntime.inspect({mainRoot:process.cwd()});
    const call=inventory.executions.at(-1).calls.find(entry=>entry.callId===${JSON.stringify(call.callId)});
    const failure=ProcessExecutionControlFailure.fromStored(call.controlFailure);
    process.stdout.write(JSON.stringify(Envelope.fail('run','stop-diagnostic',failure.code,failure.message,
      {processExecutionControlFailure:failure.toJSON()}).toJSON()));
  `);
  const readback = await RuntimeChildExecution.runAsync(reader, [], { cwd: scenario.root, timeout: 10000 });
  assert.equal(readback.ok, true, readback.stderr);
  const restored = ProcessExecutionControlFailure.fromEnvelope(JSON.parse(readback.stdout));
  assert.deepEqual(restored.toJSON(), failure.toJSON());
  assert.equal(/ownerToken|capability|stack/.test(readback.stdout), false);
  const pending = scenario.runtime.inspect();
  assert.equal(pending.slot, scenario.runtime.executionId);
  assert.equal(pending.executions.at(-1).calls[0].receipt, null);
});

test("a finite launcher wait deadline retains the same live moved-birth diagnostic", async (t) => {
  const scenario = new ManagedMigrationScenario(t, "launcher-deadline");
  await scenario.start({ timeoutMs: 15000, graceMs: 100 });
  // Advance only the coordinator's wall clock. The real launcher and provider
  // remain alive, exercising its finite wait guard without changing supervision.
  const realNow = Date.now.bind(Date);
  const clock = t.mock.method(Date, "now", () => realNow() + 30000);
  let outcome;
  try { outcome = await scenario.invocation; }
  finally { clock.mock.restore(); }
  const record = scenario.readRecord();
  const inventory = scenario.runtime.inspect();
  const call = inventory.executions.at(-1).calls[0];
  assert.match(outcome.error.message, /launcher exceeded its finite stop deadline/);
  assert.equal(record.state, "running");
  assertStopDiagnostic(scenario, outcome.error, record, call);
  assert.equal(inventory.slot, scenario.runtime.executionId);
  assert.equal(call.receipt, null);
  assert.deepEqual(scenario.signals(), []);
});
