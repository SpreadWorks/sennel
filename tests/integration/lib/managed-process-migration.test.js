import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { ProcessIdentity, ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { ManagedMigrationScenario } from "../../support/infrastructure/managed-migration-scenario.js";

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
  assert.equal(scenario.runtime.inspect().slot, scenario.runtime.executionId);
  assert.equal(scenario.runtime.inspect().executions.at(-1).calls[0].receipt, null);
});
