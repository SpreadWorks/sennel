import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { ProcessExecutionStartPermit, ProcessExecutionControlObservation } from "../../src/lib/process-execution-values.js";
import { ManagedStopOperation, MANAGED_CLOCK_SESSION_ID } from "../../src/lib/managed-stop-operation.js";

test("control observations own exact JSON and bind their logical cursor to the original call", () => {
  const value = { executionId: randomUUID(), callId: randomUUID(), publicationDigest: "a".repeat(64),
    control: { stopSignal: null, stopRequested: false, stopRemainingMs: null, timedOut: false,
      aborted: false, descendantsSettled: true, status: "running", controlFailure: null } };
  const observed = new ProcessExecutionControlObservation(value);
  value.control.status = "changed";
  assert.equal(observed.control.status, "running");
  const stored = observed.toJSON(); stored.control.status = "changed";
  assert.equal(observed.control.status, "running");
  assert.ok(Object.isFrozen(observed.control));
  assert.equal(observed.matches(value.executionId, value.callId), true);
  assert.equal(observed.matches(value.executionId, randomUUID()), false);
  assert.deepEqual(ProcessExecutionControlObservation.fromStored(observed.toJSON()), observed);
  assert.throws(() => new ProcessExecutionControlObservation({ ...observed.toJSON(), publicationDigest: "invalid" }), TypeError);
  assert.throws(() => new ProcessExecutionControlObservation({ ...observed.toJSON(), unknown: true }), TypeError);
});

test("control wait wakeups retain the original stop signal boundary and clock domain", () => {
  const stop = ManagedStopOperation.begin({ now: 1000, graceMs: 500 });
  assert.equal(stop.signalAt(1000), "SIGTERM");
  assert.equal(stop.nextSignalTransitionAt(1499), 1500);
  assert.equal(stop.signalAt(1500), "SIGKILL");
  assert.equal(stop.nextSignalTransitionAt(1500), Infinity);
  assert.equal(stop.deadline, 4000);
  assert.equal(stop.remainingMs(1500), 2500);
  const foreign = randomUUID(); assert.notEqual(foreign, MANAGED_CLOCK_SESSION_ID);
  assert.throws(() => stop.signalAt(1500, foreign), { code: "PROCESS_EXECUTION_CLOCK_SESSION_UNKNOWN" });
  assert.throws(() => stop.nextSignalTransitionAt(1500, foreign), { code: "PROCESS_EXECUTION_CLOCK_SESSION_UNKNOWN" });
});


test("start permit comparison binds every ownership and call field", () => {
  const original = new ProcessExecutionStartPermit({ executionId: randomUUID(), callId: randomUUID(), ownerEpoch: 1,
    ownerToken: randomUUID(), capability: randomUUID(), bindingDigest: "a".repeat(64) });
  assert.equal(original.matches(new ProcessExecutionStartPermit(original.toJSON())), true);
  assert.equal(original.matches(original.toJSON()), false);
  for (const key of Object.keys(original.toJSON())) {
    const value = key === "ownerEpoch" ? 2 : key === "bindingDigest" ? "b".repeat(64) : randomUUID();
    assert.equal(original.matches(new ProcessExecutionStartPermit({ ...original.toJSON(), [key]: value })), false, key);
  }
});
